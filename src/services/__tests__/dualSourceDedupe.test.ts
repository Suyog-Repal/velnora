/**
 * Dual-source (SMS + Truecaller notification) detection: zero-duplicate guarantees.
 * Real parser, services, migrations and SQLite (node:sqlite). The native Android pieces (receiver, notification
 * listener, staging DB) are NOT exercised here; a staging-store stand-in with the same contract is used.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { initTransactionService, setTransactionServiceAdapter } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { drainStagedSms } from '../smsStagingService.ts';
import { getCashFlowSummary } from '../cashFlowService.ts';
import type { SmsStagingStore, StagedSms, StagingCounts } from '../smsStagingTypes.ts';
import type { IDatabase, Session } from '../../db/types.ts';
import type { SmsReceivedPayload } from '../../../transactionParser.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  return db as unknown as IDatabase;
}

const now = new Date();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()];
const today = `${String(now.getDate()).padStart(2, '0')}-${MON}-${String(now.getFullYear()).slice(2)}`;
// Keep all events well inside "today" so day-rollover can't make the test flaky.
const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
const MIN = 60_000;

const SMS = (body: string, at: number, sender = 'AX-HDFCBK-S'): SmsReceivedPayload => ({ sender, body, receivedAt: at, partCount: 1, source: 'sms' });
// Truecaller shows the bank message under the bank's name, posted a few seconds later.
const TC = (body: string, at: number, title = 'HDFC Bank'): SmsReceivedPayload => ({ sender: title, body, receivedAt: at, partCount: 1, source: 'truecaller_notification' });

const WITH_REF = `Sent Rs.250.00 From HDFC Bank A/C *1234 To ZOMATO On ${today} Ref 412345678901 Not You? Call 18002586161 To Report`;
const WITH_BAL = `Update! INR 5,000.00 deposited in HDFC Bank A/c XX1234 on ${today} for UPI-998877665544-RAHUL KUMAR-ICIC0001234. Avl bal INR 25,432.10.`;
const NO_REF_NO_BAL = (amount: string, who: string) => `Rs ${amount} debited from A/c XX1234 and paid to ${who}.`;

async function count(db: IDatabase, table = 'transactions') {
  return (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`))!.n;
}
async function sourcesOf(db: IDatabase) {
  return db.getAllAsync<{ source: string; seen_count: number }>('SELECT source, seen_count FROM transaction_sources ORDER BY source');
}

// Staging stand-in (same contract as the native store) used for the "app closed" / restart scenarios.
class Store implements SmsStagingStore {
  rows: { id: number; ev: SmsReceivedPayload; owner: string | null; state: string; attempts: number; next: number }[] = [];
  stage(ev: SmsReceivedPayload, owner: string | null) { this.rows.push({ id: this.rows.length + 1, ev, owner, state: 'STAGED', attempts: 0, next: 0 }); }
  async setOwnerHint() {}
  async claim(owner: string | null, limit: number, nowMs: number): Promise<StagedSms[]> {
    const due = this.rows.filter((r) => r.owner === owner && ['STAGED', 'RETRY'].includes(r.state) && r.next <= nowMs).slice(0, limit);
    due.forEach((r) => { r.state = 'PROCESSING'; r.attempts += 1; });
    return due.map((r) => ({ id: r.id, sender: r.ev.sender, body: r.ev.body, receivedAt: r.ev.receivedAt, partCount: 1, attempts: r.attempts, source: r.ev.source }));
  }
  async complete(id: number) { this.rows.find((x) => x.id === id)!.state = 'COMPLETED'; }
  async scheduleRetry(id: number, _e: string, nextMs: number) { const r = this.rows.find((x) => x.id === id)!; r.state = 'RETRY'; r.next = nextMs; }
  async markDead(id: number) { this.rows.find((x) => x.id === id)!.state = 'DEAD'; }
  async counts(): Promise<StagingCounts> { return { pending: 0, dead: 0, heldForOthers: 0, ownerless: 0 }; }
  async purgeOwner() {}
}

async function main() {
  // 1. SMS first, then Truecaller (reference present)
  { const db = await fresh();
    const a = await processIncomingSms(SMS(WITH_REF, base), A);
    const b = await processIncomingSms(TC(WITH_REF, base + 4000), A);
    assert.equal(a.action, 'saved'); assert.equal(b.action, 'duplicate_ignored');
    assert.equal(await count(db), 1);
    assert.deepEqual((await sourcesOf(db)).map((s) => s.source), ['sms', 'truecaller_notification']);
    assert.equal(await count(db, 'sync_queue'), 1, 'one sync-queue entry');
    console.log('✓ 1 SMS then Truecaller -> one transaction, two sources'); }

  // 2. Truecaller first, then SMS
  { const db = await fresh();
    const a = await processIncomingSms(TC(WITH_REF, base + 4000), A);
    const b = await processIncomingSms(SMS(WITH_REF, base), A);
    assert.equal(a.action, 'saved'); assert.equal(b.action, 'duplicate_ignored');
    assert.equal(await count(db), 1);
    assert.equal((await sourcesOf(db)).length, 2);
    console.log('✓ 2 Truecaller then SMS -> one transaction, two sources'); }

  // 3. Both simultaneously (reference, balance-only, and the weakest no-reference/no-balance case)
  for (const body of [WITH_REF, WITH_BAL, NO_REF_NO_BAL('75.00', 'CHAI POINT')]) {
    const db = await fresh();
    const results = await Promise.all([processIncomingSms(SMS(body, base), A), processIncomingSms(TC(body, base + 1500), A)]);
    assert.equal(results.filter((r) => r.action === 'saved').length, 1, 'exactly one writer wins');
    assert.equal(await count(db), 1);
    assert.equal((await sourcesOf(db)).length, 2);
  }
  console.log('✓ 3 simultaneous SMS + Truecaller -> exactly one row (ref / balance / bare)');

  // 4. Same amount, genuinely different transactions stay separate
  { const db = await fresh();
    await processIncomingSms(SMS(NO_REF_NO_BAL('100.00', 'CHAI POINT'), base), A);
    await processIncomingSms(TC(NO_REF_NO_BAL('100.00', 'CHAI POINT'), base + 2000), A);
    await processIncomingSms(SMS(NO_REF_NO_BAL('100.00', 'CHAI POINT'), base + 2 * MIN), A);   // 2nd identical purchase, 2 min later
    await processIncomingSms(TC(NO_REF_NO_BAL('100.00', 'CHAI POINT'), base + 2 * MIN + 2000), A);
    assert.equal(await count(db), 2, 'two identical bare purchases 2 minutes apart are two transactions');
    assert.deepEqual((await sourcesOf(db)).map((s) => s.source), ['sms', 'sms', 'truecaller_notification', 'truecaller_notification']);
    // different references, same amount/merchant
    await processIncomingSms(SMS(WITH_REF, base + 30 * MIN), A);
    await processIncomingSms(SMS(WITH_REF.replace('412345678901', '412345678902'), base + 31 * MIN), A);
    await processIncomingSms(TC(WITH_REF.replace('412345678901', '412345678902'), base + 31 * MIN + 3000), A);
    assert.equal(await count(db), 4);
    // same amount, different balance, same minute
    const bal = (b: string) => `Rs 500.00 debited from A/c XX1234 on ${today} to SWIGGY. Avl bal Rs ${b}.`;
    await processIncomingSms(SMS(bal('9,000.00'), base + 60 * MIN), A);
    await processIncomingSms(SMS(bal('8,500.00'), base + 60 * MIN + 5000), A);
    await processIncomingSms(TC(bal('8,500.00'), base + 60 * MIN + 9000), A);
    assert.equal(await count(db), 6);
    // same amount but different payee is never merged across sources
    await processIncomingSms(SMS(NO_REF_NO_BAL('333.00', 'ALPHA STORE'), base + 90 * MIN), A);
    await processIncomingSms(TC(NO_REF_NO_BAL('333.00', 'BETA CAFE'), base + 90 * MIN + 2000), A);
    assert.equal(await count(db), 8);
    console.log('✓ 4 same amount, different transactions stay separate'); }

  // 5. Notification updated / repeated / re-delivered
  { const db = await fresh();
    const first = await processIncomingSms(TC(WITH_REF, base), A);
    for (let i = 0; i < 4; i++) await processIncomingSms(TC(WITH_REF, base + (i + 1) * 20_000), A);
    assert.equal(first.action, 'saved'); assert.equal(await count(db), 1);
    const s = await sourcesOf(db);
    assert.deepEqual(s.map((x) => [x.source, x.seen_count]), [['truecaller_notification', 5]]);
    // repeated bare notification posted twice (update), SMS arrives in between
    const db2 = await fresh();
    await processIncomingSms(TC(NO_REF_NO_BAL('60.00', 'METRO CARD'), base), A);
    await processIncomingSms(SMS(NO_REF_NO_BAL('60.00', 'METRO CARD'), base + 3000), A);
    await processIncomingSms(TC(NO_REF_NO_BAL('60.00', 'METRO CARD'), base + 6000), A);   // update of the notification
    assert.equal(await count(db2), 1, 'late notification update must not create a second row');
    console.log('✓ 5 repeated/updated notifications do not add rows'); }

  // 6 + 7. App closed -> events wait in durable staging; restart (fresh repositories) -> drained once, replays ignored
  { const db = await fresh();
    const store = new Store();
    store.stage(SMS(WITH_REF, base), A.user.id);               // staged by the native receiver while the app was closed
    store.stage(TC(WITH_REF, base + 5000), A.user.id);         // staged by the notification listener while the app was closed
    store.stage(SMS(WITH_BAL, base + MIN), A.user.id);
    store.stage(TC(WITH_BAL, base + MIN + 4000), A.user.id);
    assert.equal(await count(db), 0, 'nothing written while the app is closed');
    const s1 = await drainStagedSms(store, A, undefined, { now: () => base + 10 * MIN });
    assert.deepEqual({ saved: s1.saved, duplicates: s1.duplicates }, { saved: 2, duplicates: 2 });
    assert.equal(await count(db), 2);
    // "restart": drop all in-memory repositories and rebuild them on the same database; native staging re-delivers
    setTransactionServiceAdapter(null); setTransactionServiceAdapter(db as never); await initTransactionService();
    store.stage(SMS(WITH_REF, base), A.user.id); store.stage(TC(WITH_BAL, base + MIN + 4000), A.user.id);
    const s2 = await drainStagedSms(store, A, undefined, { now: () => base + 11 * MIN });
    assert.deepEqual({ saved: s2.saved, duplicates: s2.duplicates }, { saved: 0, duplicates: 2 });
    assert.equal(await count(db), 2);
    console.log('✓ 6/7 staged while closed, drained once; restart replays add nothing'); }

  // 8. No reference at all (fingerprint / cross-source path), and truncated notification text vs full SMS
  { const db = await fresh();
    const full = `Rs 1,000.00 withdrawn at ATM from A/c XX1234 on ${today}. Avl Bal Rs 24,432.10`;
    await processIncomingSms(SMS(full, base), A);
    await processIncomingSms(TC(full, base + 2000), A);
    assert.equal(await count(db), 1);
    // notification clipped before the balance: different fingerprint, same account/amount/time, other source
    const db2 = await fresh();
    const clipped = `Rs 1,000.00 withdrawn at ATM from A/c XX1234 on ${today}.`;
    await processIncomingSms(SMS(full, base), A);
    await processIncomingSms(TC(clipped, base + 3000), A);
    assert.equal(await count(db2), 1, 'clipped notification of the same withdrawal merges (same account, amount, time)');
    // ...but a clipped notification must not swallow a different-account withdrawal
    const db3 = await fresh();
    await processIncomingSms(SMS(full, base), A);
    await processIncomingSms(TC(clipped.replace('XX1234', 'XX9999'), base + 3000), A);
    assert.equal(await count(db3), 2, 'different account is a different transaction');
    console.log('✓ 8 no UPI reference handled'); }

  // 9. Historical rescan: replaying previously-seen messages (any source) never inserts
  { const db = await fresh();
    const history = [SMS(WITH_REF, base), SMS(WITH_BAL, base + MIN), SMS(NO_REF_NO_BAL('42.00', 'KIRANA'), base + 2 * MIN)];
    for (const h of history) await processIncomingSms(h, A);
    assert.equal(await count(db), 3);
    for (let pass = 0; pass < 3; pass++) for (const h of history) { const r = await processIncomingSms(h, A); assert.equal(r.action, 'duplicate_ignored'); }
    assert.equal(await count(db), 3); assert.equal(await count(db, 'sync_queue'), 3);
    console.log('✓ 9 historical rescan is idempotent'); }

  // 10. Backend/database retries: failure after the commit is retried; a rolled-back attempt leaves nothing behind
  { const db = await fresh();
    const store = new Store(); store.stage(SMS(WITH_REF, base), A.user.id);
    let calls = 0;
    const flaky = async (ev: SmsReceivedPayload, session: Session | null, rules: never) => {
      const r = await processIncomingSms(ev, session, rules);
      if (++calls === 1) return { success: false, action: 'error' as const, reason: 'crash after commit' };   // staging thinks it failed
      return r;
    };
    const s1 = await drainStagedSms(store, A, undefined, { processor: flaky as never, now: () => base });
    assert.equal(s1.retried, 1); assert.equal(await count(db), 1);
    const s2 = await drainStagedSms(store, A, undefined, { processor: flaky as never, now: () => base + 3_600_000 });
    assert.equal(s2.duplicates, 1); assert.equal(await count(db), 1, 'retry of an already-committed event is a no-op');
    assert.equal(await count(db, 'sync_queue'), 1);
    // a failing attempt rolls back completely (keys / source rows included)
    const origRun = db.runAsync.bind(db);
    let armed = true;
    (db as unknown as { runAsync: unknown }).runAsync = async (sql: string, ...p: unknown[]) => {
      if (armed && /INSERT INTO transaction_sources/.test(sql)) { armed = false; throw new Error('disk error'); }
      return origRun(sql, ...p);
    };
    const failed = await processIncomingSms(SMS(WITH_BAL, base + MIN), A);
    assert.equal(failed.action, 'error'); assert.equal(await count(db), 1, 'rolled back: no transaction, key or source row');
    assert.equal(await count(db, 'transaction_keys'), 1);
    const retried = await processIncomingSms(SMS(WITH_BAL, base + MIN), A);
    assert.equal(retried.action, 'saved'); assert.equal(await count(db), 2);
    console.log('✓ 10 retries and rolled-back attempts are safe'); }

  // DB-level guarantee: the unique key constraint itself refuses a second owner of the same identity
  { const db = await fresh();
    const r = await processIncomingSms(SMS(WITH_REF, base), A);
    await assert.rejects(
      db.runAsync("INSERT INTO transaction_keys (scope, key, transaction_id, created_at) VALUES ('user-A', 'ref:412345678901', 'other', 'x')"),
      /UNIQUE|constraint/i,
    );
    await assert.rejects(
      db.runAsync("INSERT INTO transaction_sources (transaction_id, source, detected_at, processed_at) VALUES (?, 'sms', 'x', 'x')", r.transaction!.id),
      /UNIQUE|constraint/i,
    );
    console.log('✓ unique constraints enforce identity at the database level'); }

  // Dashboard/analytics: totals count a doubly-detected payment once
  { const db = await fresh();
    await processIncomingSms(SMS(WITH_REF, base), A); await processIncomingSms(TC(WITH_REF, base + 3000), A);
    await processIncomingSms(SMS(WITH_BAL, base + MIN), A); await processIncomingSms(TC(WITH_BAL, base + MIN + 3000), A);
    const flow = await getCashFlowSummary(db, A.user.id, new Date(base + 5 * MIN));
    assert.equal(flow.monthExpensePaise, 25000); assert.equal(flow.monthIncomePaise, 500000);
    console.log('✓ dashboard totals count each payment once'); }

  // Legacy rows (before migration 6) keep deduplicating
  { const db = new NodeSqliteAdapter(); await runMigrations(db);
    setCustomDatabase(db); setTransactionServiceAdapter(db);
    (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
    await db.runAsync('DROP TABLE transaction_keys'); await db.runAsync('DROP TABLE transaction_sources');
    await db.runAsync("DELETE FROM schema_migrations WHERE version = 6");
    await db.runAsync(
      `INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, transaction_date, source, reference_id, fingerprint, sync_status, created_at, updated_at)
       VALUES ('legacy-1', 'user-A', 250, 25000, 'expense', 'ZOMATO', 'Other Expenses', ?, 'sms', '412345678901', 'sms-old', 'synced', 'x', 'x')`,
      new Date(base).toISOString(),
    );
    assert.equal(await runMigrations(db as unknown as IDatabase), 1);
    const r = await processIncomingSms(TC(WITH_REF, base + 2000), A);
    assert.equal(r.action, 'duplicate_ignored'); assert.equal(await count(db as unknown as IDatabase), 1);
    console.log('✓ pre-existing transactions are backfilled and still deduplicated'); }

  // Not every notification is a transaction
  { const db = await fresh();
    for (const body of ['Missed call from +91 98765 43210', 'Spam alert: this number was reported 12 times', 'Your Truecaller verification code is 482913', 'Rs 499 offer: recharge now and get 2GB extra']) {
      const r = await processIncomingSms(TC(body, base), A);
      assert.equal(r.action, 'unsupported_or_invalid', body);
    }
    assert.equal(await count(db), 0);
    console.log('✓ non-transaction Truecaller notifications are ignored'); }

  console.log('\nDual-source dedupe tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
