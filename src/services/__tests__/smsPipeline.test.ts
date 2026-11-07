/**
 * End-to-end SMS pipeline (staged event -> drain -> parse -> SQLite -> dashboard -> sync queue), for a signed-in account
 * and for guest mode, using the real parser, services and migrations. No network: a failing fetch proves sync is only
 * attempted in the background and the local save never depends on it.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { setTransactionServiceAdapter } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { drainStagedSms } from '../smsStagingService.ts';
import { getCashFlowSummary } from '../cashFlowService.ts';
import type { SmsStagingStore, StagedSms, StagingCounts } from '../smsStagingTypes.ts';
import type { IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };

// Minimal stand-in for the native staging store (same contract as VelnoraSmsStagingStore).
class Store implements SmsStagingStore {
  rows: { id: number; sender: string; body: string; at: number; owner: string | null; state: string; attempts: number; next: number }[] = [];
  hint: string | null = null;
  receive(sender: string, body: string, at: number) { this.rows.push({ id: this.rows.length + 1, sender, body, at, owner: this.hint, state: 'STAGED', attempts: 0, next: 0 }); }
  async setOwnerHint(u: string) { this.hint = u; }
  async clearOwnerHint() { this.hint = null; }
  async claim(owner: string | null, limit: number): Promise<StagedSms[]> {
    const due = this.rows.filter((r) => r.owner === owner && ['STAGED', 'RETRY'].includes(r.state)).slice(0, limit);
    due.forEach((r) => { r.state = 'PROCESSING'; r.attempts += 1; });
    return due.map((r) => ({ id: r.id, sender: r.sender, body: r.body, receivedAt: r.at, partCount: 1, attempts: r.attempts }));
  }
  async complete(id: number) { const r = this.rows.find((x) => x.id === id)!; r.state = 'COMPLETED'; r.body = ''; }
  async scheduleRetry(id: number) { this.rows.find((x) => x.id === id)!.state = 'RETRY'; }
  async markDead(id: number) { this.rows.find((x) => x.id === id)!.state = 'DEAD'; }
  async counts(): Promise<StagingCounts> { return { pending: 0, dead: 0, heldForOthers: 0, ownerless: 0 }; }
  async purgeOwner() {}
}

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  return db as unknown as IDatabase;
}

// Dates in the CURRENT month so the Home totals include them.
const now = new Date();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()];
const today = `${String(now.getDate()).padStart(2, '0')}-${MON}-${String(now.getFullYear()).slice(2)}`;
const at = now.getTime();

const DEBIT = `Sent Rs.250.00 From HDFC Bank A/C *1234 To ZOMATO On ${today} Ref 412345678901 Not You? Call 18002586161 To Report`;
const CREDIT = `Update! INR 5,000.00 deposited in HDFC Bank A/c XX1234 on ${today} for UPI-998877665544-RAHUL KUMAR-ICIC0001234. Avl bal INR 25,432.10.`;
const ATM_NO_REF = `Rs 1,000.00 withdrawn at ATM from A/c XX1234 on ${today}. Avl Bal Rs 24,432.10`;

async function accountFlow() {
  const db = await fresh();
  const store = new Store(); await store.setOwnerHint(A.user.id);
  store.receive('AX-HDFCBK-S', DEBIT, at); store.receive('VM-HDFCBK-S', CREDIT, at + 1000); store.receive('AX-HDFCBK-S', ATM_NO_REF, at + 2000);
  store.receive('DM-PROMO', 'Flat 50% discount on shoes! Use coupon CODE50.', at + 3000);
  store.receive('AX-HDFCBK-S', 'Your OTP for NetBanking login is 849201.', at + 4000);

  const s = await drainStagedSms(store, A, undefined, { now: () => at + 10_000 });
  assert.deepEqual({ saved: s.saved, rejected: s.rejected, duplicates: s.duplicates }, { saved: 3, rejected: 2, duplicates: 0 });
  assert.ok(store.rows.every((r) => r.state === 'COMPLETED' && r.body === ''), 'every event completed, raw SMS bodies wiped from staging');

  const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM transactions ORDER BY amount_paise');
  assert.equal(rows.length, 3);
  const byAmount = Object.fromEntries(rows.map((r) => [Number(r.amount_paise), r]));
  const debit = byAmount[25000]; const credit = byAmount[500000]; const atm = byAmount[100000];
  assert.equal(debit.direction, 'expense'); assert.equal(debit.counterparty, 'ZOMATO'); assert.equal(debit.reference_id, '412345678901');
  assert.equal(credit.direction, 'income'); assert.equal(credit.counterparty, 'RAHUL KUMAR'); assert.equal(credit.payment_method, 'UPI');
  assert.match(String(credit.description), /Avl bal INR 25432\.10/); assert.match(String(credit.description), /A\/c XX1234/);
  assert.equal(atm.counterparty, 'ATM withdrawal'); assert.equal(atm.payment_method, 'Cash'); assert.equal(atm.reference_id, null, 'no reference -> NULL, not an empty string');
  assert.ok(rows.every((r) => r.user_id === A.user.id && r.source === 'sms'));
  for (const r of rows) assert.equal(new Date(String(r.transaction_date)).getDate(), now.getDate(), 'dated from the SMS');

  // dashboard figures come straight from SQLite and are right immediately
  const flow = await getCashFlowSummary(db, A.user.id);
  assert.equal(flow.monthIncomePaise, 500000); assert.equal(flow.monthExpensePaise, 125000); assert.equal(flow.balancePaise, 375000);

  // offline-first: every saved SMS is queued for sync (the fetch above fails, yet nothing was lost)
  const queued = await db.getAllAsync<{ operation: string; payload: string }>("SELECT operation, payload FROM sync_queue WHERE entity_type = 'transaction' ORDER BY created_at");
  assert.equal(queued.length, 3); assert.ok(queued.every((q) => q.operation === 'create'));
  const sample = JSON.parse(queued.find((q) => JSON.parse(q.payload).amount_paise === 25000)!.payload);
  assert.deepEqual({ direction: sample.direction, counterparty: sample.counterparty, category: sample.category, amount: sample.amount, ref: sample.reference_id, user: sample.user_id },
    { direction: 'expense', counterparty: 'ZOMATO', category: 'Other Expenses', amount: 250, ref: '412345678901', user: A.user.id });
  assert.ok(rows.every((r) => r.sync_status === 'pending_create'), 'not marked synced before the server confirms');

  // the raw SMS text is never persisted in the app database
  const dump = JSON.stringify(await db.getAllAsync('SELECT * FROM transactions')) + JSON.stringify(queued);
  assert.ok(!dump.includes('Not You'), 'raw SMS body not stored'); assert.ok(!dump.includes('18002586161'));

  // re-delivery of the same alerts (duplicate broadcast, app restart, 2nd sender route) creates nothing new
  store.receive('AX-HDFCBK-S', DEBIT, at + 20_000); store.receive('VM-HDFCBK-S', ATM_NO_REF, at + 21_000);
  const again = await drainStagedSms(store, A, undefined, { now: () => at + 30_000 });
  assert.deepEqual({ saved: again.saved, duplicates: again.duplicates }, { saved: 0, duplicates: 2 });
  assert.equal((await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) c FROM transactions'))!.c, 3);

  // a genuinely different purchase with the same amount/merchant but another balance IS recorded
  const second = await processIncomingSms({ sender: 'AX-HDFCBK-S', receivedAt: at + 40_000, partCount: 1, body: ATM_NO_REF.replace('24,432.10', '23,432.10') }, A);
  assert.equal(second.action, 'saved');
  console.log('✓ account: SMS -> SQLite -> dashboard totals -> sync queue; no raw SMS stored; duplicates ignored; 2nd purchase kept');
}

async function guestFlow() {
  const db = await fresh();
  const store = new Store();                                   // guest: no owner hint
  store.receive('AX-HDFCBK-S', DEBIT, at); store.receive('VM-HDFCBK-S', CREDIT, at + 1000);
  const s = await drainStagedSms(store, null, undefined, { now: () => at + 10_000 });
  assert.equal(s.saved, 2);
  const rows = await db.getAllAsync<{ user_id: string | null }>('SELECT user_id FROM transactions');
  assert.ok(rows.length === 2 && rows.every((r) => r.user_id === null), 'guest transactions are local-only (no owner)');
  const flow = await getCashFlowSummary(db, null);
  assert.equal(flow.monthIncomePaise, 500000); assert.equal(flow.monthExpensePaise, 25000);
  assert.equal((await getCashFlowSummary(db, A.user.id)).balancePaise, 0, 'guest data never appears in an account');
  console.log('✓ guest mode: SMS captured locally, dashboard updates, nothing attributed to an account');
}

async function main() {
  await accountFlow();
  await guestFlow();
  console.log('\nSMS pipeline tests passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
