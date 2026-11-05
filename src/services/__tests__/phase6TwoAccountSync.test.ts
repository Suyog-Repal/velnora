/**
 * Phase 6: two-account integration through the REAL SyncEngine (triggerSync → pushPendingChanges / pullRemoteChanges
 * → syncApi → fetch), real SQLite repositories and real SMS processing, against a stateful in-process fake of the
 * backend's /api/v1/sync endpoints.
 *
 * What is real: SyncEngine, SyncQueueRepository, TransactionRepository, processIncomingSms, SQLite (node:sqlite), syncApi.
 * What is simulated: only the HTTP server. It authenticates the bearer token, stores records PER TOKEN OWNER (never trusting
 * any client-supplied owner), and logs every uploaded entity so the test can prove exactly who uploaded what.
 * The real FastAPI/Postgres isolation is covered by backend/app/test_phase4_sync.py (Scenario I) in `npm run api:test`.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { setTransactionServiceAdapter } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { SyncEngine } from '../syncEngine.ts';
import type { Session } from '../../db/types.ts';

const mk = (id: string): Session => ({ user: { id, full_name: id, email: `${id}@x.com` }, access_token: `tok-${id}`, refresh_token: `r-${id}`, token_type: 'bearer' });
const A = mk('user-A');
const B = mk('user-B');
const TOKEN_OWNER: Record<string, string> = { [A.access_token]: A.user.id, [B.access_token]: B.user.id };

type Upload = { token: string; owner: string; entityId: string; reference: string | null };
class FakeBackend {
  records = new Map<string, Map<string, Record<string, unknown>>>(); // owner -> entityId -> record
  uploads: Upload[] = [];
  online = true;
  pushCalls = 0;

  handler = async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (!this.online) throw new TypeError('network down');
    const url = new URL(String(input));
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    const owner = TOKEN_OWNER[token];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (!owner) return json(401, { detail: 'Invalid token' });
    const mine = this.records.get(owner) ?? this.records.set(owner, new Map()).get(owner)!;
    const now = new Date().toISOString();

    if (url.pathname === '/api/v1/sync/push') {
      this.pushCalls += 1;
      const body = JSON.parse(String(init?.body));
      const results = [];
      for (const it of body.items) {
        this.uploads.push({ token, owner, entityId: it.entity_id, reference: it.payload?.reference_id ?? null });
        if (!mine.has(it.entity_id)) {
          mine.set(it.entity_id, {
            id: it.entity_id, user_id: owner, amount: it.payload.amount, amount_paise: Math.round(it.payload.amount * 100),
            direction: it.payload.direction, counterparty: it.payload.counterparty, category: it.payload.category,
            category_id: null, description: it.payload.description ?? '', transaction_date: it.payload.transaction_date,
            source: it.payload.source, reference_id: it.payload.reference_id ?? null, fingerprint: it.payload.fingerprint ?? null,
            server_version: 1, deleted_at: null, created_at: now, updated_at: now,
          });
        }
        results.push({ operation_id: it.operation_id, entity_id: it.entity_id, operation: it.operation, status: 'synced', server_version: 1, updated_at: now });
      }
      return json(200, { results, server_time: now });
    }
    if (url.pathname === '/api/v1/sync/pull') {
      return json(200, { transactions: [...mine.values()], categories: [], server_time: now, next_cursor: null, has_more: false, total_active_count: mine.size });
    }
    return json(404, { detail: 'not found' });
  };
}

async function main() {
  console.log('--- Phase 6 two-account SyncEngine integration ---');
  const db = new NodeSqliteAdapter();
  const prevFetch = globalThis.fetch;
  const backend = new FakeBackend();
  globalThis.fetch = backend.handler as typeof fetch;
  try {
    await runMigrations(db);
    setCustomDatabase(db);
    setTransactionServiceAdapter(db);
    const engine = new SyncEngine(db);                 // one shared on-device DB, one engine, accounts switch over time
    const repo = new TransactionRepository(db);
    const queue = new SyncQueueRepository(db);
    const smsA1 = { sender: 'HDFC-BANK', receivedAt: Date.parse('2026-11-02T10:00:00Z'), partCount: 1, body: 'Your account was debited INR 450.00 at Swiggy on 02/11/2026. Ref: AAA111.' };
    const smsA2 = { sender: 'HDFC-BANK', receivedAt: Date.parse('2026-11-02T11:00:00Z'), partCount: 1, body: 'Your account was debited INR 450.00 at Swiggy on 02/11/2026. Ref: AAA222.' }; // same amount+merchant, different ref
    const expireBackoff = () => db.runAsync('UPDATE sync_queue SET next_retry_at = NULL');

    // 1. A is signed in and OFFLINE: two SMS transactions are saved locally and queued; sync fails without loss.
    backend.online = false;
    assert.equal((await processIncomingSms(smsA1, A)).action, 'saved');
    assert.equal((await processIncomingSms(smsA2, A)).action, 'saved');
    const offline = await engine.triggerSync(A);
    assert.ok(offline.errors.length > 0, 'offline sync reports an error');
    assert.equal(backend.uploads.length, 0);
    assert.equal((await queue.peek(10)).length, 2, 'A queue preserved offline');
    assert.equal((await repo.getAll({ userId: A.user.id })).length, 2);

    // 2. Account switch (A signs out, B signs in) on the same device, network back.
    backend.online = true;
    await expireBackoff();
    const bTx = await repo.create({ id: 'tx-B-1', amount: 75, direction: 'expense', counterparty: 'Chai', category: 'Food', user_id: B.user.id, source: 'manual' });
    assert.equal((await repo.getAll({ userId: B.user.id })).length, 1, 'B sees only own records');
    assert.ok((await repo.getAll({ userId: B.user.id })).every((t) => t.user_id === B.user.id));
    const syncB = await engine.triggerSync(B);
    assert.deepEqual(syncB.errors, []);
    assert.equal(syncB.pushed, 1);
    assert.deepEqual(backend.uploads.map((u) => [u.owner, u.entityId]), [[B.user.id, bTx.id]], 'only B’s entity uploaded under B’s token');
    assert.equal(backend.uploads.some((u) => u.token === B.access_token && u.reference?.startsWith('AAA')), false, 'no A reference ever sent with B token');
    assert.equal(backend.records.get(A.user.id)?.size ?? 0, 0, 'server has nothing for A yet');
    // B pulled nothing belonging to A; A's local rows are untouched and still pending
    assert.equal((await repo.getAll({ userId: B.user.id })).length, 1);
    const aPending = await db.getAllAsync<{ sync_status: string }>("SELECT sync_status FROM transactions WHERE user_id = ?", A.user.id);
    assert.deepEqual(aPending.map((r) => r.sync_status), ['pending_create', 'pending_create']);
    assert.equal((await queue.peek(10)).length, 2, "A's queue items survive B's session");

    // 3. Tampered/forged queue rows must not be uploaded by B.
    //    (a) payload says B but the transaction row belongs to A; (b) queue row for a transaction that doesn't exist; (c) ownerless transaction.
    const aTx = (await repo.getAll({ userId: A.user.id }))[0];
    await db.runAsync("UPDATE sync_queue SET payload = json_set(payload, '$.user_id', ?) WHERE entity_id = ?", B.user.id, aTx.id);
    await db.runAsync(
      "INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, created_at) VALUES ('q-ghost','transaction','tx-ghost','create', ?, 0, ?)",
      JSON.stringify({ id: 'tx-ghost', user_id: B.user.id, amount: 1, direction: 'expense', counterparty: 'x', category: 'x', transaction_date: new Date().toISOString(), source: 'manual' }), new Date().toISOString());
    await db.runAsync(
      "INSERT INTO transactions (id,user_id,amount,amount_paise,direction,counterparty,category,description,transaction_date,source,sync_status,server_version,created_at,updated_at) VALUES ('tx-orphan',NULL,2,200,'expense','o','c','',?, 'manual','pending_create',1,?,?)",
      new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    await db.runAsync(
      "INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, created_at) VALUES ('q-orphan','transaction','tx-orphan','create', ?, 0, ?)",
      JSON.stringify({ id: 'tx-orphan', user_id: B.user.id }), new Date().toISOString());
    await expireBackoff();
    const before = backend.uploads.length;
    const syncB2 = await engine.triggerSync(B);
    assert.equal(syncB2.pushed, 0);
    assert.equal(backend.uploads.length, before, 'tampered / ownerless / ghost queue rows are not uploaded');
    assert.equal(backend.records.get(B.user.id)?.size, 1);
    assert.equal((await queue.peek(50)).filter((q) => ['q-ghost', 'q-orphan'].includes(q.id)).length, 2, 'rejected rows are preserved, not dequeued');
    assert.equal((await db.getFirstAsync<{ sync_status: string }>("SELECT sync_status FROM transactions WHERE id='tx-orphan'"))!.sync_status, 'pending_create');

    // 4. Remove test tampering, then A signs back in: A uploads exactly her own two, nothing lost, no duplicates.
    await db.runAsync("DELETE FROM sync_queue WHERE id IN ('q-ghost','q-orphan')");
    await db.runAsync("DELETE FROM transactions WHERE id = 'tx-orphan'");
    await db.runAsync("UPDATE sync_queue SET payload = json_set(payload, '$.user_id', ?) WHERE entity_id = ?", A.user.id, aTx.id);
    await expireBackoff();
    const syncA = await engine.triggerSync(A);
    assert.deepEqual(syncA.errors, []);
    assert.equal(syncA.pushed, 2);
    const aUploads = backend.uploads.filter((u) => u.owner === A.user.id);
    assert.equal(aUploads.length, 2);
    assert.deepEqual(new Set(aUploads.map((u) => u.reference)), new Set(['AAA111', 'AAA222']));
    assert.equal(backend.records.get(A.user.id)!.size, 2);
    assert.equal(backend.records.get(B.user.id)!.size, 1, 'B’s server data unchanged by A');
    const aLocal = await repo.getAll({ userId: A.user.id });
    assert.equal(aLocal.length, 2, 'no loss, no duplicate after pull echoes A’s records back');
    assert.ok(aLocal.every((t) => t.sync_status === 'synced'));
    assert.equal((await queue.peek(10)).length, 0, 'queue drained only after server ack');

    // 5. Idempotent re-sync and cross-visibility.
    const uploadsBefore = backend.uploads.length;
    await engine.triggerSync(A);
    await engine.triggerSync(B);
    assert.equal(backend.uploads.length, uploadsBefore, 'nothing is re-uploaded');
    const total = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) c FROM transactions');
    assert.equal(total!.c, 3, 'exactly A×2 + B×1 on device');
    assert.ok((await repo.getAll({ userId: A.user.id })).every((t) => t.user_id === A.user.id));
    assert.ok((await repo.getAll({ userId: B.user.id })).every((t) => t.user_id === B.user.id));
    // A bad token is rejected by the server and does not wipe or fail local data
    const bad = await engine.triggerSync({ ...A, access_token: 'forged' });
    assert.ok(bad.errors.length > 0);
    assert.equal((await repo.getAll({ userId: A.user.id })).length, 2);

    console.log('✓ two-account SyncEngine: isolation, tamper rejection, switching, no loss/duplication');
  } finally {
    globalThis.fetch = prevFetch;       // cleanup: restore fetch, drop DB handles, reset service singletons
    setTransactionServiceAdapter(null);
    setCustomDatabase(null);
    db.close();
  }
  console.log('--- PHASE 6 TWO-ACCOUNT SYNC TEST PASSED ---');
}

main().catch((e) => { console.error(e); process.exit(1); });
