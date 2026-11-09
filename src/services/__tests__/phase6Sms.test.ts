/**
 * Phase 6: durable SMS staging/drain, atomicity, user isolation, local data deletion.
 * FakeStagingStore mirrors the Kotlin VelnoraSmsStagingStore state machine (the Kotlin side is compile-checked only).
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations, getCurrentSchemaVersion } from '../../db/migrations.ts';
import { MIGRATIONS } from '../../db/schema.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { setTransactionServiceAdapter } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { drainStagedSms, MAX_ATTEMPTS, retryDelayMs } from '../smsStagingService.ts';
import { getLocalDataSummary, deleteUserLocalData } from '../localDataService.ts';
import { loadSmsStagingStatus } from '../smsStagingStatus.ts';
import { LocalDataDeletionController } from '../localDataController.ts';
import type { SmsStagingStore, StagedSms, StagingCounts } from '../smsStagingTypes.ts';
import type { IDatabase, Session } from '../../db/types.ts';

const mk = (id: string): Session => ({ user: { id, full_name: id, email: `${id}@x.com` }, access_token: `t-${id}`, refresh_token: `r-${id}`, token_type: 'bearer' });
const A = mk('user-A');
const B = mk('user-B');

type Row = { id: number; key: string; sender: string; body: string; receivedAt: number; partCount: number; owner: string | null; state: string; attempts: number; next: number; lease: number };
class FakeStagingStore implements SmsStagingStore {
  rows: Row[] = [];
  hint: string | null = null;
  seq = 0;
  /** Simulates the native receiver (works with no JS running). */
  receive(sender: string, body: string, receivedAt: number, partCount = 1): number {
    const key = `${sender}:${receivedAt}:${partCount}`;
    if (this.rows.some((r) => r.key === key)) return -1;
    this.rows.push({ id: ++this.seq, key, sender, body, receivedAt, partCount, owner: this.hint, state: 'STAGED', attempts: 0, next: 0, lease: 0 });
    return this.seq;
  }
  async setOwnerHint(u: string) { this.hint = u; }
  async clearOwnerHint() { this.hint = null; }
  async claim(owner: string | null, limit: number, now: number, leaseMs: number, max: number): Promise<StagedSms[]> {
    const due = (r: Row) => r.owner === owner && ((['STAGED', 'RETRY'].includes(r.state) && r.next <= now) || (r.state === 'PROCESSING' && r.lease < now));
    this.rows.filter((r) => due(r) && r.attempts >= max).forEach((r) => { r.state = 'DEAD'; });
    const out = this.rows.filter(due).sort((a, b) => a.receivedAt - b.receivedAt).slice(0, limit);
    out.forEach((r) => { r.state = 'PROCESSING'; r.attempts += 1; r.lease = now + leaseMs; });
    return out.map((r) => ({ id: r.id, sender: r.sender, body: r.body, receivedAt: r.receivedAt, partCount: r.partCount, attempts: r.attempts }));
  }
  private get(id: number) { return this.rows.find((r) => r.id === id)!; }
  async complete(id: number) { const r = this.get(id); r.state = 'COMPLETED'; r.body = ''; r.sender = ''; }
  async scheduleRetry(id: number, _e: string, at: number) { const r = this.get(id); r.state = 'RETRY'; r.next = at; r.lease = 0; }
  async markDead(id: number) { this.get(id).state = 'DEAD'; }
  async counts(owner: string | null): Promise<StagingCounts> {
    const pend = (r: Row) => ['STAGED', 'PROCESSING', 'RETRY'].includes(r.state);
    return {
      pending: this.rows.filter((r) => pend(r) && r.owner === owner).length,
      dead: this.rows.filter((r) => r.state === 'DEAD' && r.owner === owner).length,
      heldForOthers: this.rows.filter((r) => pend(r) && r.owner !== null && r.owner !== owner).length,
      ownerless: this.rows.filter((r) => pend(r) && r.owner === null).length,
    };
  }
  async purgeOwner(owner: string) { this.rows = this.rows.filter((r) => r.owner !== owner); }
}

const SMS = (ref0: string, amt = '450.00', merchant = 'Swiggy') =>
  `Your account was debited INR ${amt} at ${merchant} on 02/11/2026. Ref: ${ref0.padEnd(6, '0')}.`;
const T = Date.parse('2026-11-02T14:30:00.000Z');

async function freshDb() {
  const db = new NodeSqliteAdapter();
  await runMigrations(db);
  setCustomDatabase(db);
  setTransactionServiceAdapter(db);
  return db;
}
const count = async (db: IDatabase, sql: string, ...p: unknown[]) => (await db.getFirstAsync<{ c: number }>(sql, ...p))!.c;

async function main() {
  console.log('--- Phase 6 tests ---');

  // 1. Migrations: Phase 6 needs none (staging is native). Existing chain stays intact and idempotent.
  {
    const db = new NodeSqliteAdapter();
    assert.equal(await runMigrations(db), MIGRATIONS.length);
    assert.equal(await runMigrations(db), 0);
    assert.equal(await getCurrentSchemaVersion(db), 8);
    console.log('✓ migrations, idempotent (fresh DB reaches v6)');
  }

  // 2. Receive with no JS/bridge → staged → drained later (app recreation) → persisted + queued, body wiped
  {
    const db = await freshDb();
    const store = new FakeStagingStore();
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('REF1'), T);             // arrives while JS is not running
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 0);
    const s = await drainStagedSms(store, A, undefined, { now: () => T });
    assert.equal(s.saved, 1);
    const tx = await db.getFirstAsync<{ user_id: string; amount_paise: number }>('SELECT * FROM transactions');
    assert.equal(tx!.user_id, A.user.id);
    assert.equal(tx!.amount_paise, 45000);
    assert.equal(await count(db, "SELECT COUNT(*) c FROM sync_queue WHERE operation='create'"), 1);
    assert.equal(store.rows[0].state, 'COMPLETED');
    assert.equal(store.rows[0].body, '');
    // duplicate broadcast (native dedupe) and re-drain create nothing
    assert.equal(store.receive('HDFC-BANK', SMS('REF1'), T), -1);
    const again = await drainStagedSms(store, A, undefined, { now: () => T });
    assert.equal(again.processed, 0);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 1);
    console.log('✓ staged without JS, drained once, body wiped, native dedupe');
  }

  // 3. Crash after commit but before ack: lease expires, reprocess is idempotent (dup ignored, no 2nd txn)
  {
    const db = await freshDb();
    const store = new FakeStagingStore();
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('REF2'), T);
    const [claimed] = await store.claim(A.user.id, 5, T, 1000, MAX_ATTEMPTS);
    await processIncomingSms({ sender: claimed.sender, receivedAt: claimed.receivedAt, partCount: 1, body: claimed.body }, A);
    // process dies here: never acked, row still PROCESSING
    assert.equal((await store.claim(A.user.id, 5, T + 500, 1000, MAX_ATTEMPTS)).length, 0, 'live lease not stolen');
    const s = await drainStagedSms(store, A, undefined, { now: () => T + 5000 });
    assert.equal(s.duplicates, 1);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 1);
    assert.equal(store.rows[0].state, 'COMPLETED');
    console.log('✓ crash between commit and ack is idempotent');
  }

  // 4. Atomic rollback: sync_queue insert fails → no transaction row, event kept for retry, then succeeds
  {
    const inner = await freshDb();
    let failQueue = true;
    const flaky: IDatabase = {
      execAsync: (s) => inner.execAsync(s),
      getFirstAsync: (s, ...p) => inner.getFirstAsync(s, ...p),
      getAllAsync: (s, ...p) => inner.getAllAsync(s, ...p),
      runAsync: (s, ...p) => {
        if (failQueue && /INSERT INTO sync_queue/.test(s)) return Promise.reject(new Error('disk I/O'));
        return inner.runAsync(s, ...p);
      },
    };
    setCustomDatabase(flaky);
    setTransactionServiceAdapter(flaky);
    const store = new FakeStagingStore();
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('REF3'), T);
    let s = await drainStagedSms(store, A, undefined, { now: () => T });
    assert.equal(s.retried, 1);
    assert.equal(await count(inner, 'SELECT COUNT(*) c FROM transactions'), 0, 'rolled back');
    assert.equal(await count(inner, 'SELECT COUNT(*) c FROM sync_queue'), 0);
    assert.equal(store.rows[0].state, 'RETRY');
    assert.ok(store.rows[0].body.length > 0, 'event preserved');
    s = await drainStagedSms(store, A, undefined, { now: () => T + 1000 });   // backoff not elapsed
    assert.equal(s.processed, 0);
    failQueue = false;
    s = await drainStagedSms(store, A, undefined, { now: () => T + retryDelayMs(1) + 1 });
    assert.equal(s.saved, 1);
    assert.equal(await count(inner, 'SELECT COUNT(*) c FROM transactions'), 1);
    assert.equal(await count(inner, 'SELECT COUNT(*) c FROM sync_queue'), 1);
    console.log('✓ atomic rollback, event retained, retry succeeds');
  }

  // 5. Permanent failure stops at MAX_ATTEMPTS (DEAD), retained, no infinite loop
  {
    await freshDb();
    const store = new FakeStagingStore();
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('REF4'), T);
    let now = T;
    const failing = async () => ({ success: false, action: 'error' as const });
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      now += 2 * 60 * 60 * 1000;
      await drainStagedSms(store, A, undefined, { processor: failing, now: () => now });
    }
    assert.equal(store.rows[0].state, 'DEAD');
    assert.equal(store.rows[0].attempts, MAX_ATTEMPTS);
    assert.ok(store.rows[0].body.length > 0);
    console.log('✓ bounded retries → DEAD (retained)');
  }

  // 6. Non-financial/malformed/OTP are completed (body wiped) and create nothing
  {
    const db = await freshDb();
    const store = new FakeStagingStore();
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', 'Your OTP is 482913. Do not share it.', T);
    store.receive('HDFC-BANK', 'Flat 50% off today!', T + 1);
    store.receive('HDFC-BANK', 'Debited INR but amount missing', T + 2);
    const s = await drainStagedSms(store, A, undefined, { now: () => T + 10 });
    assert.equal(s.rejected, 3);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 0);
    assert.ok(store.rows.every((r) => r.state === 'COMPLETED' && r.body === ''));
    console.log('✓ OTP / promo / malformed rejected safely');
  }

  // 7. Legitimate separate purchases preserved; same ref deduped
  {
    const db = await freshDb();
    const store = new FakeStagingStore();
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('R10'), T);
    store.receive('HDFC-BANK', SMS('R11'), T + 60_000);       // same merchant & amount, different ref
    store.receive('AXIS-BANK', SMS('R10'), T + 120_000);       // same ref re-sent by another sender id
    const s = await drainStagedSms(store, A, undefined, { now: () => T + 200_000 });
    assert.equal(s.saved, 2);
    assert.equal(s.duplicates, 1);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 2);
    console.log('✓ legit repeated purchases kept, duplicate ref ignored');
  }

  // 8. Guest scope: events with no owner are processed in guest mode as LOCAL guest transactions; an account never adopts them.
  {
    const db = await freshDb();
    const store = new FakeStagingStore();
    store.receive('HDFC-BANK', SMS('R20'), T);                  // no owner hint ever set (guest / fresh install)
    let s = await drainStagedSms(store, A, undefined, { now: () => T });
    assert.equal(s.processed, 0, 'ownerless event is not adopted by whoever logs in');
    assert.equal(store.rows[0].state, 'STAGED');
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 0);
    s = await drainStagedSms(store, null, undefined, { now: () => T });   // guest mode drains the guest scope
    assert.equal(s.saved, 1);
    assert.equal(store.rows[0].state, 'COMPLETED');
    assert.equal(store.rows[0].body, '', 'body wiped after processing');
    const r = await processIncomingSms({ sender: 'HDFC-BANK', receivedAt: T, partCount: 1, body: SMS('R21') }, null);
    assert.equal(r.action, 'saved');
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions WHERE user_id IS NULL'), 2, 'guest rows have no owner');
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions WHERE user_id IS NOT NULL'), 0, 'nothing leaks into an account');
    // the guest SMS is idempotent too
    const dup = await processIncomingSms({ sender: 'HDFC-BANK', receivedAt: T, partCount: 1, body: SMS('R21') }, null);
    assert.equal(dup.action, 'duplicate_ignored');
    // guest scope never claims an account's events, and clearing the hint makes new events guest-owned
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('R22', '10.00', 'Tea'), T + 1000);
    assert.equal((await drainStagedSms(store, null, undefined, { now: () => T + 2000 })).processed, 0, 'guest does not claim account A events');
    await store.clearOwnerHint();
    store.receive('HDFC-BANK', SMS('R23', '11.00', 'Tea'), T + 3000);
    assert.equal((await drainStagedSms(store, null, undefined, { now: () => T + 4000 })).saved, 1);
    console.log('✓ guest-scope SMS saved locally (user_id NULL), idempotent, isolated from accounts');
  }

  // 9. Account switching: A's SMS (received while B is signed in/after logout) stays A's
  {
    const db = await freshDb();
    const store = new FakeStagingStore();
    await store.setOwnerHint(A.user.id);                         // A used the device; A logs out
    store.receive('HDFC-BANK', SMS('R30'), T);                   // arrives while logged out
    await store.setOwnerHint(B.user.id);                         // B logs in
    store.receive('HDFC-BANK', SMS('R31', '99.00', 'Zomato'), T + 1000);
    const sB = await drainStagedSms(store, B, undefined, { now: () => T + 5000 });
    assert.equal(sB.saved, 1);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions WHERE user_id = ?', B.user.id), 1);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions WHERE user_id = ?', A.user.id), 0);
    assert.deepEqual(await store.counts(B.user.id), { pending: 0, dead: 0, heldForOthers: 1, ownerless: 0 });
    // A returns: gets own event
    const sA = await drainStagedSms(store, A, undefined, { now: () => T + 6000 });
    assert.equal(sA.saved, 1);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions WHERE user_id = ?', A.user.id), 1);
    // same bank ref under different users is NOT cross-user deduped
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('SHARE1'), T + 9000);        // bank references always contain digits
    await drainStagedSms(store, A, undefined, { now: () => T + 10000 });
    await store.setOwnerHint(B.user.id);
    store.receive('ICICI-BANK', SMS('SHARE1'), T + 11000);
    await drainStagedSms(store, B, undefined, { now: () => T + 12000 });
    assert.equal(await count(db, "SELECT COUNT(*) c FROM transactions WHERE reference_id='SHARE1'"), 2);
    console.log('✓ per-user ownership of staged SMS; no cross-user dedupe');
  }

  // 10. Queue items are stamped with their owner (the upload ownership gate itself is Phase 5 Scenario M)
  {
    const db = await freshDb();
    const repo = new TransactionRepository(db);
    await repo.create({ amount: 10, direction: 'expense', counterparty: 'X', category: 'Other Expenses', user_id: A.user.id, source: 'sms', reference_id: 'Q1' });
    const q = await db.getAllAsync<{ payload: string }>('SELECT payload FROM sync_queue');
    assert.equal(JSON.parse(q[0].payload).user_id, A.user.id);
    console.log('✓ queue items carry owner A (upload gate: Phase 5 Scenario M, still passing)');
  }

  // 11. Deletion: scoped, atomic, confirm/cancel, errors, logout-independent
  {
    const db = await freshDb();
    const repo = new TransactionRepository(db);
    const a1 = await repo.create({ amount: 5, direction: 'expense', counterparty: 'A1', category: 'c', user_id: A.user.id, reference_id: 'DA1' });
    await repo.create({ amount: 6, direction: 'expense', counterparty: 'A2', category: 'c', user_id: A.user.id, reference_id: 'DA2' });
    await repo.updateSyncStatus(a1.id, 'synced');
    await repo.create({ amount: 7, direction: 'expense', counterparty: 'B1', category: 'c', user_id: B.user.id, reference_id: 'DB1' });
    await db.runAsync("INSERT INTO app_metadata (key,value,updated_at) VALUES ('last_sync_cursor_user-A','1','x'),('last_sync_cursor_user-B','2','x'),('theme','dark','x')");

    const sum = await getLocalDataSummary(A.user.id, db);
    assert.equal(sum.totalCount, 2);
    assert.equal(sum.unsyncedCount, 1, 'user-scoped unsynced count (a1 synced)');
    assert.equal((await getLocalDataSummary(B.user.id, db)).unsyncedCount, 1);

    let purged = '';
    const c = new LocalDataDeletionController(A.user.id, { database: db, afterCommit: async (u) => { purged = u; } });
    assert.equal(await c.confirm(), false, 'cannot confirm before request');
    await c.request();
    assert.equal(c.phase, 'confirming');
    c.cancel();
    assert.equal(c.phase, 'idle');
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 3, 'cancel leaves data');

    // failure → rollback, nothing deleted
    const failing: IDatabase = { ...db, execAsync: (s) => db.execAsync(s), getFirstAsync: (s, ...p) => db.getFirstAsync(s, ...p), getAllAsync: (s, ...p) => db.getAllAsync(s, ...p),
      runAsync: (s, ...p) => /DELETE FROM transactions/.test(s) ? Promise.reject(new Error('boom')) : db.runAsync(s, ...p) };
    const queueBefore = await count(db, 'SELECT COUNT(*) c FROM sync_queue');
    const cf = new LocalDataDeletionController(A.user.id, { database: failing });
    await cf.request();
    assert.equal(await cf.confirm(), false);
    assert.equal(cf.phase, 'error');
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 3);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM sync_queue'), queueBefore, 'queue untouched after rollback');

    await c.request();
    assert.equal(await c.confirm(), true);
    assert.equal(purged, A.user.id);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions WHERE user_id = ?', A.user.id), 0);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions WHERE user_id = ?', B.user.id), 1);
    const q = await db.getAllAsync<{ entity_id: string }>('SELECT entity_id FROM sync_queue');
    const bTx = await db.getFirstAsync<{ id: string }>('SELECT id FROM transactions WHERE user_id = ?', B.user.id);
    assert.deepEqual(q.map((r) => r.entity_id), [bTx!.id], "only B's queue item remains");
    assert.equal(await count(db, "SELECT COUNT(*) c FROM app_metadata WHERE key IN ('last_sync_cursor_user-B','theme')"), 2);
    assert.equal(await count(db, "SELECT COUNT(*) c FROM app_metadata WHERE key = 'last_sync_cursor_user-A'"), 0);

    // summary read error is surfaced, not shown as 0
    const broken = new LocalDataDeletionController(A.user.id, { database: { ...db, getFirstAsync: () => Promise.reject(new Error('x')) } as IDatabase });
    await broken.request();
    assert.equal(broken.phase, 'error');
    await assert.rejects(() => deleteUserLocalData('  ', db));
    console.log('✓ deletion: scoped, atomic, cancel safe, errors surfaced');
  }

  // 12. Concurrent writers don't collide on BEGIN
  {
    const db = await freshDb();
    const repo = new TransactionRepository(db);
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      repo.create({ amount: i + 1, direction: 'expense', counterparty: `C${i}`, category: 'c', user_id: A.user.id, reference_id: `CC${i}` })));
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM transactions'), 10);
    assert.equal(await count(db, 'SELECT COUNT(*) c FROM sync_queue'), 10);
    console.log('✓ concurrent writes serialized');
  }

  // 13. Profile status: counts only, accurate across processing, retry, switching and deletion
  {
    await freshDb();
    const store = new FakeStagingStore();
    assert.deepEqual(await loadSmsStagingStatus(null, A.user.id), { available: false, dead: 0, heldForOtherAccounts: 0, ownerless: 0, isEmpty: true });
    let st = await loadSmsStagingStatus(store, A.user.id);
    assert.ok(st.available && st.isEmpty, 'empty state');
    store.receive('HDFC-BANK', SMS('S00001'), T);                 // no owner hint yet -> ownerless
    st = await loadSmsStagingStatus(store, A.user.id);
    assert.equal(st.ownerless, 1);
    await store.setOwnerHint(B.user.id);
    store.receive('HDFC-BANK', SMS('S00002'), T + 1);             // owned by B
    st = await loadSmsStagingStatus(store, A.user.id);
    assert.deepEqual([st.ownerless, st.heldForOtherAccounts, st.dead], [1, 1, 0]);
    // switching account changes the view: B sees own as pending (not held), ownerless still held
    st = await loadSmsStagingStatus(store, B.user.id);
    assert.deepEqual([st.ownerless, st.heldForOtherAccounts], [1, 0]);
    // processing B's event leaves nothing for B except ownerless
    await drainStagedSms(store, B, undefined, { now: () => T + 10 });
    st = await loadSmsStagingStatus(store, A.user.id);
    assert.deepEqual([st.ownerless, st.heldForOtherAccounts], [1, 0], 'completed events no longer counted');
    // DEAD after repeated failures is reported for the owner only
    await store.setOwnerHint(A.user.id);
    store.receive('HDFC-BANK', SMS('S00003'), T + 2);
    let now = T;
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      now += 2 * 60 * 60 * 1000;
      await drainStagedSms(store, A, undefined, { processor: async () => ({ success: false, action: 'error' as const }), now: () => now });
    }
    st = await loadSmsStagingStatus(store, A.user.id);
    assert.equal(st.dead, 1);
    assert.equal((await loadSmsStagingStatus(store, B.user.id)).dead, 0);
    assert.ok(!st.isEmpty);
    // deletion purges the user's staged events
    await store.purgeOwner(A.user.id);
    st = await loadSmsStagingStatus(store, A.user.id);
    assert.equal(st.dead, 0);
    // no sensitive fields in the view model
    assert.deepEqual(Object.keys(st).sort(), ['available', 'dead', 'heldForOtherAccounts', 'isEmpty', 'ownerless']);
    console.log('✓ profile SMS status counts (dead / held / ownerless), counts-only');
  }

  console.log('--- ALL PHASE 6 TESTS PASSED ---');
}

main().catch((e) => { console.error(e); process.exit(1); });
