/**
 * Daily "Did we miss anything?" check-in and the quick-add screen's suggestions: day summary counts, wording, when the
 * check-in is skipped, preference handling, and saving a cash entry. Real services and SQLite (node:sqlite); the Android
 * alarm and notification are a mock here, so this says nothing about how a real device behaves.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { addTransaction, setTransactionServiceAdapter } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import {
  DEFAULT_CHECKIN_TIME, checkInLabel, confirmCheckInToday, describeCheckIn, getCheckInPrefs, getDaySummary, runDailyCheckIn,
  setCheckInPort, setCheckInPrefs, summarizeDay, syncCheckInSchedule, type CheckInPort,
} from '../dailyCheckIn.ts';
import { amountChipsFor, parseQuickAmount, rankQuickAdd, saveQuickEntry, getQuickAddOptions } from '../quickAdd.ts';
import { parseReviewLink } from '../reviewLinks.ts';
import { localYmd } from '../dateUtils.ts';
import type { SmsReceivedPayload } from '../../../transactionParser.ts';
import type { IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 't', refresh_token: 'r', token_type: 'bearer' };
const noon = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12, 0, 0).getTime();
const SMS = (body: string, at = noon): SmsReceivedPayload => ({ sender: 'AX-HDFCBK-S', body, receivedAt: at, partCount: 1, source: 'sms' });

class MockCheckIn implements CheckInPort {
  posts: { title: string; body: string }[] = [];
  confirmed: string | null = null;
  allowed = true;
  configured: { enabled: boolean; time: string }[] = [];
  canNotify() { return this.allowed; }
  post(title: string, body: string) { this.posts.push({ title, body }); return true; }
  confirmedDay() { return this.confirmed; }
  markConfirmed(day: string) { this.confirmed = day; }
  configure(enabled: boolean, time: string) { this.configured.push({ enabled, time }); }
}

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  const port = new MockCheckIn();
  setCheckInPort(port);
  return { db: db as unknown as IDatabase, port };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); await settle(); passed += 1; console.log(`✓ ${name}`); }

await test('summarizeDay counts every row and totals only spending; duplicates and own transfers do not count as spending', () => {
  const s = summarizeDay([
    { amount_paise: 45000, direction: 'expense' },
    { amount_paise: 20000, direction: 'expense', txn_kind: 'cash_withdrawal' },
    { amount_paise: 99900, direction: 'expense', txn_kind: 'transfer' },
    { amount_paise: 500000, direction: 'income' },
    { amount_paise: 45000, direction: 'expense', possible_duplicate_of: 'x' },
  ]);
  assert.deepEqual(s, { count: 4, spentPaise: 65000 });
  assert.deepEqual(summarizeDay([]), { count: 0, spentPaise: 0 });
});

await test('wording: normal day, one transaction, income-only day, and a day with nothing captured', () => {
  assert.equal(describeCheckIn({ count: 3, spentPaise: 125050 }).body, 'Velnora captured 3 transactions today (₹1,250.5 total). Anything missed?');
  assert.equal(describeCheckIn({ count: 1, spentPaise: 9900 }).body, 'Velnora captured 1 transaction today (₹99 total). Anything missed?');
  assert.equal(describeCheckIn({ count: 2, spentPaise: 0 }).body, 'Velnora captured 2 transactions today. Anything missed?');
  const none = describeCheckIn({ count: 0, spentPaise: 0 });
  assert.match(none.body, /didn't capture any transactions today/);
  assert.equal(none.title, 'Did we miss anything?');
});

await test('getDaySummary counts only today\'s automatically captured transactions for this scope', async () => {
  const { db } = await fresh();
  await processIncomingSms(SMS('Rs.450.00 debited from A/c XX1234 to RAHUL KUMAR Ref 412345678901'), A, [await import('../../../transactionParser.ts').then((m) => m.DEFAULT_SMS_RULE)]);
  await addTransaction({ amount: 80, direction: 'expense', counterparty: 'Cash', category: 'Food & Dining', source: 'manual', capture_source: 'manual' }, A);
  const old = new Date(noon - 3 * 86_400_000).toISOString();
  await addTransaction({ amount: 10, direction: 'expense', counterparty: 'Old', category: 'Food & Dining', source: 'sms', capture_source: 'sms', transaction_date: old }, A);
  const mine = await getDaySummary(db, A.user.id, noon);
  assert.equal(mine.count, 1, 'manual entries and other days are not "captured today"');
  assert.equal(mine.spentPaise, 45000);
  assert.deepEqual(await getDaySummary(db, 'someone-else', noon), { count: 0, spentPaise: 0 });
  assert.deepEqual(await getDaySummary(db, null, noon), { count: 0, spentPaise: 0 }, 'guest scope is separate');
});

await test('preferences: on by default at 9:00 PM, persisted, invalid times ignored, pushed to the native schedule', async () => {
  const { db, port } = await fresh();
  assert.deepEqual(await getCheckInPrefs(db), { enabled: true, time: DEFAULT_CHECKIN_TIME });
  assert.equal(DEFAULT_CHECKIN_TIME, '21:00');
  await setCheckInPrefs(db, { time: '07:30' });
  await setCheckInPrefs(db, { time: '25:99' });
  assert.equal((await getCheckInPrefs(db)).time, '07:30');
  await setCheckInPrefs(db, { enabled: false });
  await syncCheckInSchedule(db);
  assert.deepEqual(port.configured.at(-1), { enabled: false, time: '07:30' });
  assert.equal(checkInLabel({ enabled: false, time: '07:30' }), 'Off');
  assert.equal(checkInLabel({ enabled: true, time: '21:00' }), 'Daily at 9:00 PM');
  assert.equal(checkInLabel({ enabled: true, time: '00:05' }), 'Daily at 12:05 AM');
});

await test('runDailyCheckIn posts counts, and still posts on a day with nothing captured', async () => {
  const { db, port } = await fresh();
  assert.equal(await runDailyCheckIn(db, A.user.id, { now: noon }), 'posted');
  assert.match(port.posts[0].body, /didn't capture any/);
  await addTransaction({ amount: 120, direction: 'expense', counterparty: 'Cafe', category: 'Food & Dining', source: 'sms', capture_source: 'sms' }, A);
  assert.equal(await runDailyCheckIn(db, A.user.id, { now: Date.now() }), 'posted');
  assert.match(port.posts[1].body, /captured 1 transaction today \(₹120 total\)/);
});

await test('runDailyCheckIn is skipped when disabled, already confirmed today, or notifications are blocked', async () => {
  const { db, port } = await fresh();
  const now = Date.now();
  port.confirmed = localYmd(new Date(now));
  assert.equal(await runDailyCheckIn(db, A.user.id, { now }), 'already_confirmed');
  port.confirmed = localYmd(new Date(now - 86_400_000));
  assert.equal(await runDailyCheckIn(db, A.user.id, { now }), 'posted', 'yesterday\'s confirmation does not count today');
  port.posts.length = 0; port.allowed = false;
  assert.equal(await runDailyCheckIn(db, A.user.id, { now }), 'no_permission');
  port.allowed = true;
  await setCheckInPrefs(db, { enabled: false });
  assert.equal(await runDailyCheckIn(db, A.user.id, { now }), 'disabled');
  assert.equal(port.posts.length, 0);
  setCheckInPort(null);
  assert.equal(await runDailyCheckIn(db, A.user.id, { now }), 'unavailable');
});

await test('confirming (Nothing missed or a quick-add save) records today for the next alarm', async () => {
  const { port } = await fresh();
  confirmCheckInToday(noon);
  assert.equal(port.confirmed, localYmd(new Date(noon)));
});

await test('quick-add ranks categories by use, counting hand-entered spends more, and pads with cash-style categories', () => {
  const allowed = ['Food & Dining', 'Transportation', 'Groceries', 'Shopping', 'Entertainment', 'Bills & Utilities', 'Other Expenses', 'Transfer'];
  const rows = [
    ...Array.from({ length: 4 }, () => ({ category: 'Groceries', amount_paise: 123456, manual: false })),
    { category: 'Transportation', amount_paise: 5000, manual: true },
    { category: 'Transportation', amount_paise: 5000, manual: true },
    { category: 'Transportation', amount_paise: 3000, manual: true },
    { category: 'food & dining', amount_paise: 2000, manual: true },
    { category: 'Deleted Category', amount_paise: 100, manual: true },
  ];
  const o = rankQuickAdd(rows, allowed);
  assert.deepEqual(o.categories.slice(0, 3), ['Transportation', 'Groceries', 'Food & Dining']);
  assert.ok(!o.categories.includes('Other Expenses') && !o.categories.includes('Transfer') && !o.categories.includes('Deleted Category'));
  assert.ok(o.categories.length >= 6, 'padded so the row is never nearly empty');
  assert.deepEqual(o.amountsByCategory['transportation'], [50, 30]);
  assert.deepEqual(amountChipsFor(o, 'Transportation').slice(0, 2), [50, 30]);
  assert.ok(!amountChipsFor(o, 'Groceries').includes(1234.56), 'a bank debit is not a shortcut amount');
  assert.deepEqual(rankQuickAdd([], allowed).fallbackAmounts, [20, 50, 100, 200], 'starter amounts when there is no history');
  assert.equal(rankQuickAdd([], allowed).categories[0], 'Food & Dining');
});

await test('amounts: only whole or two-decimal numbers above zero', () => {
  assert.equal(parseQuickAmount('50'), 50);
  assert.equal(parseQuickAmount('1,250.5'), 1250.5);
  for (const bad of ['', '0', '-5', '1.234', 'abc', '5 0']) assert.equal(parseQuickAmount(bad), null);
});

await test('saveQuickEntry stores a manual cash expense that shows in the ledger and queues sync for signed-in accounts and stays in guest scope otherwise', async () => {
  const { db } = await fresh();
  const bad = await saveQuickEntry({ amount: '0', category: 'Food & Dining' }, A);
  assert.equal(bad.ok, false);
  const saved = await saveQuickEntry({ amount: '60', category: 'Transportation', note: 'auto fare' }, A);
  assert.ok(saved.ok);
  const row = await db.getFirstAsync<{ counterparty: string; category: string; source: string; capture_source: string; payment_method: string; amount_paise: number; description: string; verification_status: string }>(
    'SELECT * FROM transactions WHERE id = ?', saved.ok ? saved.transaction.id : '');
  assert.equal(row?.counterparty, 'Cash');
  assert.equal(row?.category, 'Transportation');
  assert.equal(row?.source, 'manual');
  assert.equal(row?.payment_method, 'cash');
  assert.equal(row?.amount_paise, 6000);
  assert.equal(row?.description, 'auto fare');
  assert.notEqual(row?.verification_status, 'needs_review', 'a hand-entered cash spend never lands in the review queue');
  const queued = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?", row ? (saved.ok ? saved.transaction.id : '') : '');
  assert.equal(queued?.n, 1);
  const guest = await saveQuickEntry({ amount: '20', category: 'Food & Dining' }, null);
  assert.ok(guest.ok);
  const guestRow = await db.getFirstAsync<{ user_id: string | null }>('SELECT user_id FROM transactions WHERE id = ?', guest.ok ? guest.transaction.id : '');
  assert.equal(guestRow?.user_id, null, 'guest entries stay in the guest scope, on this device');
});

await test('a saved quick entry feeds the next quick-add suggestions', async () => {
  const { db } = await fresh();
  for (let i = 0; i < 3; i += 1) await saveQuickEntry({ amount: '40', category: 'Food & Dining' }, A);
  const o = await getQuickAddOptions(db, A.user.id);
  assert.equal(o.categories[0], 'Food & Dining');
  assert.deepEqual(amountChipsFor(o, 'Food & Dining')[0], 40);
});

await test('the check-in "Add expense" link opens quick-add and nothing else', () => {
  assert.deepEqual(parseReviewLink('velnora://quick-add'), { kind: 'quick-add' });
  assert.equal(parseReviewLink('velnora://quick-add/../x'), null);
  assert.equal(parseReviewLink('velnora://quick-addx'), null);
});

console.log(`\n${passed} tests passed`);
