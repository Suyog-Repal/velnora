/**
 * Multi-source ledger: parser boundaries, duplicate matching, review flow, statement import, totals, migration.
 * Real parser, services, migrations and SQLite (node:sqlite). Sample data is invented. Native Android is not exercised.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { MIGRATIONS } from '../../db/schema.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { addTransaction, initTransactionService, resolvePossibleDuplicate, setTransactionServiceAdapter, updateLedgerFields } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { getCashFlowSummary, getLedgerHealth } from '../cashFlowService.ts';
import { categoryBreakdown } from '../analyticsService.ts';
import { relateMerchants, scoreMatch, type MatchSide } from '../duplicateMatcher.ts';
import { suggestCategory } from '../transactionClassifier.ts';
import { sourceLabel } from '../ledgerRules.ts';
import { applyStatement, parseCsvRows, parseStatementAmount, parseStatementCsv, parseStatementDate, previewStatement } from '../statementImport.ts';
import { confirmAccount, listAccounts, mergeAccounts, recordAccountEvidence } from '../accountService.ts';
import { pendingPermissionSteps, revokedSince } from '../smsPermissionPolicy.ts';
import { isOtpMessage, isPromotionalMessage, parseSmsTransaction, type SmsReceivedPayload } from '../../../transactionParser.ts';
import type { IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 't', refresh_token: 'r', token_type: 'bearer' };
const now = new Date();
const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
const MIN = 60_000;
const SMS = (body: string, at = base, sender = 'AX-HDFCBK-S'): SmsReceivedPayload => ({ sender, body, receivedAt: at, partCount: 1, source: 'sms' });
const APP = (body: string, at = base, app = 'Google Pay'): SmsReceivedPayload => ({ sender: app, body, receivedAt: at, partCount: 1, source: 'payment_notification', sourceApp: app });
const parse = (body: string) => parseSmsTransaction(SMS(body));

async function fresh(): Promise<IDatabase> {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  return db as unknown as IDatabase;
}
const rows = (db: IDatabase) => db.getAllAsync<Record<string, unknown>>('SELECT * FROM transactions WHERE deleted_at IS NULL ORDER BY created_at');
let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); passed += 1; console.log(`✓ ${name}`); }

async function main() {
  // ── parser ──
  await test('OTP messages are never transactions, even with an amount', () => {
    assert.equal(parse('Use OTP 482913 to complete your purchase of Rs 500 at Amazon. Valid 5 min.'), null);
    assert.equal(parse('482913 is your OTP for txn of INR 2,000.00 debited on card XX1234'), null);
    assert.equal(isOtpMessage('Rs.500 debited from A/c XX1234. Never share your OTP with anyone. Call 18001234'), false);
    assert.ok(parse('Rs.500 debited from A/c XX1234 to ZOMATO. Never share your OTP with anyone.'));
  });
  await test('promotions are rejected; real credits mentioning cashback are kept', () => {
    assert.equal(parse('Get Rs 500 cashback on your next purchase. Apply now!'), null);
    assert.equal(parse('You won Rs 1000! Click here to get it credited.'), null);
    assert.equal(parse('Pre-approved loan of Rs 2,00,000 will be credited instantly.'), null);
    assert.equal(isPromotionalMessage('Rs 50 cashback credited to your A/c XX1234 on 01-Nov-26'), false);
  });
  await test('balance-only, failed, pending, due and missing-amount messages make no transaction', () => {
    assert.equal(parse('Available balance in A/c XX1234 is Rs 5,000.00 as on today.'), null);
    assert.equal(parse('Your payment of Rs 500 to ZOMATO has failed.'), null);
    assert.equal(parse('Txn of Rs 500 declined due to insufficient funds.'), null);
    assert.equal(parse('Your payment of Rs 500 is pending.'), null);
    assert.equal(parse('Your credit card bill of Rs 3,000 is due on 12-Nov-26.'), null);
    assert.equal(parse('Your account was debited today.'), null);
  });
  await test('debit, credit, UPI and Indian number formatting', () => {
    const d = parse('Rs.1,25,000.50 debited from A/c XX4321 on 05-Nov-26 to ACME RENT Ref 412345678901')!;
    assert.equal(d.amount, 125000.5); assert.equal(d.direction, 'expense'); assert.equal(d.accountLast4, '4321');
    assert.equal(d.referenceId, '412345678901'); assert.equal(d.bankName, 'HDFC Bank');
    const c = parse('INR 5,000.00 credited to A/c XX1234 on 05/11/2026 by SALARY ACME CORP. Avl bal INR 25,000.00')!;
    assert.equal(c.direction, 'income'); assert.equal(c.balance, 25000);
    assert.equal(parse('₹250 paid to rahul@okaxis via UPI on 2026-11-05')!.paymentMethod, 'UPI');
  });
  await test('missing date or account still parses, with lower confidence', () => {
    const p = parse('Rs 99 debited via UPI')!;
    assert.equal(p.accountLast4, undefined); assert.equal(p.merchant, 'UPI payment');
    assert.ok(p.confidence < 0.5);
  });
  await test('refunds and completed reversals are money back; promised ones are ignored', () => {
    const r = parse('Refund of Rs 450 credited to A/c XX1234 from AMAZON on 01-Nov-26')!;
    assert.equal(r.kind, 'refund'); assert.equal(r.direction, 'income'); assert.equal(r.category, 'Refund');
    const v = parse('Your failed txn of Rs 300 has been reversed to A/c XX1234 on 01-Nov-26')!;
    assert.equal(v.kind, 'reversal'); assert.equal(v.direction, 'income');
    assert.equal(parse('Rs 300 will be reversed to your account in 5 days'), null);
    assert.equal(parse('Refund of Rs 450 initiated by AMAZON'), null);
  });
  await test('cash withdrawals and own transfers are labelled', () => {
    assert.equal(parse('Rs 2000 withdrawn at ATM from A/c XX1234 on 01-Nov-26')!.kind, 'cash_withdrawal');
    assert.equal(parse('Rs 2000 transferred to own account XX9999 from A/c XX1234 on 01-Nov-26')!.kind, 'transfer');
  });
  await test('payment-app wording; the app is never recorded as the bank', () => {
    const paid = parseSmsTransaction(APP('You paid ₹250 to Swiggy'))!;
    assert.equal(paid.direction, 'expense'); assert.equal(paid.merchant, 'Swiggy'); assert.equal(paid.paymentApp, 'Google Pay'); assert.equal(paid.bankName, undefined);
    const got = parseSmsTransaction(APP('Asha Rao paid you ₹500', base, 'PhonePe'))!;
    assert.equal(got.direction, 'income'); assert.equal(got.merchant, 'Asha Rao');
    const ok = parseSmsTransaction(APP('Payment of ₹120 to Metro successful', base, 'Paytm'))!;
    assert.equal(ok.direction, 'expense');
    assert.equal(parseSmsTransaction(APP('Asha requested ₹500 from you')), null);
    assert.equal(parseSmsTransaction(APP('₹250 from your SBI a/c paid to Swiggy', base, 'PhonePe'))!.bankName, 'SBI');
  });
  await test('category suggestions', () => {
    assert.equal(suggestCategory({ merchant: 'SWIGGY', body: '', direction: 'expense', kind: 'payment' }), 'Food & Dining');
    assert.equal(suggestCategory({ merchant: 'Rahul', body: '', direction: 'expense', kind: 'payment' }), 'Other Expenses');
    assert.equal(suggestCategory({ merchant: 'ACME', body: 'SALARY for Oct', direction: 'income', kind: 'payment' }), 'Salary');
    assert.equal(suggestCategory({ merchant: 'Rahul', body: '', direction: 'income', kind: 'payment' }), 'Other Income');
  });

  // ── matcher ──
  const side = (o: Partial<MatchSide>): MatchSide => ({ amountPaise: 25000, direction: 'expense', at: base, counterparty: 'Swiggy', channels: ['sms'], ...o });
  await test('matcher: reference decides; contradictions are never matched', () => {
    assert.equal(scoreMatch(side({ referenceId: 'R1' }), side({ referenceId: 'R1', channels: ['payment_notification'], at: base + 3 * 3600_000 })).outcome, 'exact');
    assert.equal(scoreMatch(side({ referenceId: 'R1' }), side({ referenceId: 'R2', channels: ['payment_notification'] })).outcome, 'none');
    assert.equal(scoreMatch(side({ accountLast4: '1111' }), side({ accountLast4: '2222', channels: ['x'] })).outcome, 'none');
    assert.equal(scoreMatch(side({ balance: 10 }), side({ balance: 20, channels: ['x'] })).outcome, 'none');
    assert.equal(scoreMatch(side({ kind: 'refund', direction: 'income' }), side({ kind: 'payment', direction: 'income', channels: ['x'] })).outcome, 'none');
    assert.equal(scoreMatch(side({ amountPaise: 1 }), side({ channels: ['x'] })).outcome, 'none');
    assert.equal(scoreMatch(side({}), side({ direction: 'income', channels: ['x'] })).outcome, 'none');
  });
  await test('matcher: equal amounts alone are not enough', () => {
    assert.equal(scoreMatch(side({}), side({ at: base + 60_000 })).outcome, 'none'); // same channel
    assert.equal(scoreMatch(side({}), side({ counterparty: 'Zomato', channels: ['x'], at: base + 2 * 3600_000 })).outcome, 'none');
    assert.equal(scoreMatch(side({}), side({ counterparty: 'Zomato', channels: ['x'], at: base + 60_000 })).outcome, 'weak');
    assert.equal(scoreMatch(side({}), side({ channels: ['x'], at: base + 60_000 })).outcome, 'strong');
    assert.equal(scoreMatch(side({}), side({ channels: ['x'], at: base + 2 * 3600_000 })).outcome, 'weak');
    assert.equal(relateMerchants('rahulsharma', 'Rahul Sharma'), 'same');
    assert.equal(relateMerchants('Swiggy Limited', 'SWIGGY'), 'same');
    assert.equal(relateMerchants('UPI payment', 'Anything'), 'generic');
  });

  // ── pipeline ──
  const BANK = 'Rs.250.00 debited from A/c XX1234 to SWIGGY via UPI';
  await test('SMS + payment notification = one row, both sources, verified', async () => {
    const db = await fresh();
    await processIncomingSms(SMS(BANK), A);
    const second = await processIncomingSms(APP('You paid ₹250 to Swiggy', base + 20_000), A);
    assert.equal(second.action, 'duplicate_ignored');
    const all = await rows(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].verification_status, 'verified'); assert.equal(all[0].payment_app, 'Google Pay'); assert.equal(all[0].bank_name, 'HDFC Bank');
    assert.equal((await db.getAllAsync('SELECT * FROM transaction_sources')).length, 2);
    assert.equal(sourceLabel({ source: 'sms', detected_via: ['sms', 'payment_notification'], payment_app: 'Google Pay' }), 'SMS + GOOGLE PAY');
  });
  await test('notification first, then SMS: reference and account are filled in', async () => {
    const db = await fresh();
    await processIncomingSms(APP('You paid ₹250 to Swiggy'), A);
    await processIncomingSms(SMS('Rs.250.00 debited from A/c XX1234 to SWIGGY Ref 412345678901', base + 15_000), A);
    const [row, ...rest] = await rows(db);
    assert.equal(rest.length, 0); assert.equal(row.reference_id, '412345678901'); assert.equal(row.account_last4, '1234');
  });
  await test('repeated SMS and repeated notification are idempotent', async () => {
    const db = await fresh();
    for (let i = 0; i < 3; i += 1) await processIncomingSms(SMS(BANK), A);
    for (let i = 0; i < 3; i += 1) await processIncomingSms(APP('You paid ₹250 to Swiggy', base + 5000), A);
    assert.equal((await rows(db)).length, 1);
  });
  await test('two genuine same-amount payments on one channel stay separate and both count', async () => {
    const db = await fresh();
    await processIncomingSms(SMS(BANK, base), A);
    await processIncomingSms(SMS(BANK, base + 3 * MIN), A);
    assert.equal((await rows(db)).length, 2);
    assert.equal((await getCashFlowSummary(db, A.user.id, new Date(base))).monthExpensePaise, 50000);
  });
  await test('different payee, same amount, close in time: kept, flagged, out of totals until resolved', async () => {
    const db = await fresh();
    await processIncomingSms(SMS(BANK), A);
    const r = await processIncomingSms(APP('You paid ₹250 to Bundl Foods', base + MIN), A);
    assert.equal(r.action, 'saved');
    const flagged = (await rows(db))[1];
    assert.equal(flagged.verification_status, 'needs_review'); assert.ok(flagged.possible_duplicate_of);
    assert.equal((await getCashFlowSummary(db, A.user.id, new Date(base))).monthExpensePaise, 25000);
    await resolvePossibleDuplicate(flagged.id as string, 'keep', A);
    assert.equal((await getCashFlowSummary(db, A.user.id, new Date(base))).monthExpensePaise, 50000);
  });
  await test('merging a possible duplicate keeps one row and every source', async () => {
    const db = await fresh();
    await processIncomingSms(SMS(BANK), A);
    await processIncomingSms(APP('You paid ₹250 to Bundl Foods', base + MIN), A);
    const flagged = (await rows(db))[1];
    await resolvePossibleDuplicate(flagged.id as string, 'merge', A);
    const left = await rows(db);
    assert.equal(left.length, 1); assert.equal(left[0].verification_status, 'verified');
    assert.equal((await db.getAllAsync('SELECT * FROM transaction_sources WHERE transaction_id = ?', left[0].id)).length, 2);
    assert.equal((await db.getAllAsync("SELECT * FROM sync_queue WHERE entity_id = ? AND operation = 'delete'", flagged.id)).length, 0); // never reached the server
  });
  await test('a detected payment matching a manual entry is flagged, not merged', async () => {
    const db = await fresh();
    await addTransaction({ amount: 250, direction: 'expense', counterparty: 'Swiggy', category: 'Food & Dining', transaction_date: new Date(base).toISOString() }, A);
    await processIncomingSms(SMS(BANK, base + MIN), A);
    const all = await rows(db);
    assert.equal(all.length, 2); assert.equal(all[1].verification_status, 'needs_review'); assert.equal(all[1].possible_duplicate_of, all[0].id);
  });
  await test('deleting the original releases a row waiting on it', async () => {
    const db = await fresh();
    await processIncomingSms(SMS(BANK), A);
    await processIncomingSms(APP('You paid ₹250 to Bundl Foods', base + MIN), A);
    const [first] = await rows(db);
    const { transactionRepository } = await initTransactionService();
    await transactionRepository.delete(first.id as string);
    assert.equal((await rows(db))[0].possible_duplicate_of, null);
  });
  await test('a refund never merges with its original payment', async () => {
    const db = await fresh();
    await processIncomingSms(SMS(BANK), A);
    await processIncomingSms(SMS('Refund of Rs.250.00 credited to A/c XX1234 from SWIGGY', base + MIN), A);
    assert.equal((await rows(db)).length, 2);
  });

  // ── totals ──
  await test('transfers, refunds and uncertain rows never distort totals; a manual correction is honoured', async () => {
    const db = await fresh();
    const add = (amount: number, direction: 'income' | 'expense', txn_kind: 'payment' | 'refund' | 'transfer', counterparty: string) =>
      addTransaction({ amount, direction, counterparty, category: 'Other', txn_kind, transaction_date: new Date(base).toISOString() }, A);
    await add(1000, 'income', 'payment', 'Salary');
    await add(100, 'income', 'refund', 'Amazon');
    await add(300, 'expense', 'payment', 'Shop');
    const moved = await add(500, 'expense', 'payment', 'My other account');
    let s = await getCashFlowSummary(db, A.user.id, new Date(base));
    assert.deepEqual([s.monthIncomePaise, s.monthRefundPaise, s.monthExpensePaise], [100000, 10000, 80000]);
    await updateLedgerFields(moved.id, { txn_kind: 'transfer' }, A);
    s = await getCashFlowSummary(db, A.user.id, new Date(base));
    assert.equal(s.monthExpensePaise, 30000); assert.equal(s.netPaise, 80000); assert.equal(s.balancePaise, 80000);
    assert.equal((await categoryBreakdown(db, A.user.id, { start: new Date(base - 3600_000).toISOString(), end: new Date(base + 3600_000).toISOString() })).totalPaise, 30000);
    const h = await getLedgerHealth(db, A.user.id, new Date(base));
    assert.deepEqual([h.todayIncomePaise, h.todayExpensePaise, h.todayNetPaise, h.totalCount, h.verifiedCount], [100000, 30000, 80000, 4, 4]);
  });
  await test('detected spending is reported separately from confirmed', async () => {
    const db = await fresh();
    await processIncomingSms(SMS('Rs.250.00 debited from A/c XX1234 to SWIGGY Ref 412345678901'), A);
    const h = await getLedgerHealth(db, A.user.id, new Date(base));
    assert.equal(h.detectedCount, 1); assert.equal(h.verifiedCount, 0); assert.equal(h.monthUnverifiedExpensePaise, 25000);
  });

  // ── accounts ──
  await test('accounts come from evidence, merge sticks, and unknowns stay unknown', async () => {
    const db = await fresh();
    await processIncomingSms(SMS('Rs.250.00 debited from A/c XX1234 to SWIGGY Ref 412345678901'), A);
    await processIncomingSms(APP('You paid ₹99 to Metro', base + 2 * 3600_000), A);
    const accounts = await listAccounts(db, A.user.id, new Date(base));
    assert.equal(accounts.length, 1); assert.equal(accounts[0].bank_name, 'HDFC Bank'); assert.equal(accounts[0].status, 'suggested'); assert.equal(accounts[0].monthSpentPaise, 25000);
    const appRow = (await rows(db))[1];
    assert.equal(appRow.bank_name, null); assert.equal(appRow.account_last4, null); assert.equal(appRow.payment_app, 'Google Pay');
    await confirmAccount(db, A.user.id, accounts[0].id);
    await recordAccountEvidence(db, A.user.id, 'HDFC', '1234');
    const [hdfc, dupe] = [(await listAccounts(db, A.user.id)).find((x) => x.bank_name === 'HDFC Bank')!, (await listAccounts(db, A.user.id)).find((x) => x.bank_name === 'HDFC')!];
    await mergeAccounts(db, A.user.id, dupe.id, hdfc.id);
    assert.deepEqual(await recordAccountEvidence(db, A.user.id, 'HDFC', '1234'), { bankName: 'HDFC Bank', last4: '1234' });
    assert.equal((await listAccounts(db, A.user.id)).length, 1);
    assert.deepEqual(await recordAccountEvidence(db, A.user.id, 'SBI', null), { bankName: 'SBI', last4: null });
    assert.equal((await listAccounts(db, A.user.id)).length, 1);
  });

  // ── statements ──
  await test('CSV parsing: quotes, bank header offset, date and amount formats', () => {
    assert.deepEqual(parseCsvRows('a,"b,c","d""e"\r\n1,2,3'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
    assert.equal(parseStatementDate('31/02/2026'), null);
    assert.equal(parseStatementDate('05-Nov-26')!.getDate(), 5);
    assert.equal(parseStatementDate('5/11/2026')!.getMonth(), 10); // day first
    assert.equal(parseStatementAmount('1,25,000.50'), 125000.5);
    assert.equal(parseStatementAmount('(500.00)'), 500);
    assert.equal(parseStatementAmount('abc'), null);
    const r = parseStatementCsv('Bank of Example\nAccount XX1234\n\nDate,Narration,Ref No,Withdrawal Amt,Deposit Amt,Closing Balance\n05/11/26,"UPI/412345678901/SWIGGY",412345678901,250.00,,"9,750.00"\n06/11/26,SALARY ACME,,,"50,000.00","59,750.00"\nbad-date,x,,1,,2\nEnd of statement,,,,,\n');
    assert.equal(r.headerFound, true); assert.equal(r.rows.length, 2); assert.equal(r.rows[0].direction, 'expense'); assert.equal(r.rows[1].direction, 'income');
    assert.equal(r.errors.length, 2); assert.equal(parseStatementCsv('name,age\nx,1').headerFound, false);
    const single = parseStatementCsv('Date,Description,Amount,Dr/Cr\n05/11/26,SHOP,100.00,DR\n05/11/26,SHOP,100.00,DR\n05/11/26,PAY,50,CR\n');
    assert.deepEqual(single.rows.map((x) => x.direction), ['expense', 'expense', 'income']);
    assert.notEqual(single.rows[0].fingerprint, single.rows[1].fingerprint);
  });
  const day = new Date(base); const dd = String(day.getDate()).padStart(2, '0'); const mm = String(day.getMonth() + 1).padStart(2, '0');
  const dated = `${dd}/${mm}/${day.getFullYear()}`;
  await test('statement: matches by reference, adds the missing, re-import adds nothing', async () => {
    const db = await fresh();
    await processIncomingSms(SMS('Rs.250.00 debited from A/c XX1234 to SWIGGY Ref 412345678901', base - 3600_000), A);
    const csv = `Date,Narration,Ref No,Withdrawal Amt,Deposit Amt\n${dated},UPI/SWIGGY,412345678901,250.00,\n${dated},ACME STORES,,700.00,\n`;
    const first = await previewStatement(db, A.user.id, parseStatementCsv(csv).rows);
    assert.deepEqual(first.map((p) => p.status), ['matched', 'new']);
    assert.equal((await rows(db)).length, 1, 'preview writes nothing');
    const done = await applyStatement(db, A.user.id, first, () => true);
    assert.deepEqual([done.found, done.added, done.matched], [2, 1, 1]);
    const all = await rows(db);
    assert.equal(all.length, 2); assert.equal(all[0].verification_status, 'reconciled');
    const again = await previewStatement(db, A.user.id, parseStatementCsv(csv).rows);
    assert.deepEqual(again.map((p) => p.status), ['already_imported', 'already_imported']);
    assert.equal((await applyStatement(db, A.user.id, again, () => true)).added, 0);
    assert.equal((await rows(db)).length, 2);
  });
  await test('statement: no reference and same day matches a notification; a different narration is a possible duplicate; left-out rows are not added', async () => {
    const db = await fresh();
    await processIncomingSms(APP('You paid ₹250 to Swiggy'), A);
    await processIncomingSms(APP('You paid ₹700 to Metro', base + 2 * 3600_000), A);
    const csv = `Date,Narration,Withdrawal Amt,Deposit Amt\n${dated},UPI-SWIGGY LTD,250.00,\n${dated},UPI-BLUELINE,700.00,\n${dated},ACME,900.00,\n`;
    const p = await previewStatement(db, A.user.id, parseStatementCsv(csv).rows);
    assert.deepEqual(p.map((x) => x.status), ['matched', 'possible', 'new']);
    const done = await applyStatement(db, A.user.id, p, (x) => x.status === 'possible');
    assert.deepEqual([done.added, done.matched, done.needsReview], [1, 1, 1]);
    assert.equal((await rows(db)).length, 3);
  });

  // ── offline / sync ──
  await test('new ledger fields are queued locally for sync', async () => {
    const db = await fresh();
    await processIncomingSms(SMS('Refund of Rs.250.00 credited to A/c XX1234 from SWIGGY Ref 412345678901'), A);
    const q = await db.getFirstAsync<{ payload: string }>("SELECT payload FROM sync_queue WHERE entity_type = 'transaction'");
    const payload = JSON.parse(q!.payload);
    assert.equal(payload.txn_kind, 'refund'); assert.equal(payload.account_last4, '1234'); assert.equal(payload.capture_source, 'sms');
    assert.ok(!JSON.stringify(payload).includes('credited to A/c'), 'raw message text is not queued');
  });
  await test('migration 7 keeps existing rows and classifies them honestly', async () => {
    const db = new NodeSqliteAdapter() as unknown as IDatabase;
    await db.execAsync('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) { await db.execAsync(m.up); await db.runAsync('INSERT INTO schema_migrations VALUES (?, ?)', m.version, 'x'); }
    const t = new Date(base).toISOString();
    const insert = (id: string, source: string) => db.runAsync(`INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, transaction_date, source, sync_status, created_at, updated_at) VALUES (?, 'u', 10, 1000, 'expense', 'X', 'Y', ?, ?, 'synced', ?, ?)`, id, t, source, t, t);
    await insert('m1', 'manual'); await insert('s1', 'sms');
    await db.runAsync(`INSERT INTO transaction_sources (transaction_id, source, detected_at, processed_at) VALUES ('s1', 'truecaller_notification', ?, ?)`, t, t);
    assert.equal(await runMigrations(db), MIGRATIONS.length - 6);
    const [m, s] = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM transactions ORDER BY id');
    assert.deepEqual([m.verification_status, m.capture_source, m.txn_kind], ['verified', 'manual', 'payment']);
    assert.deepEqual([s.verification_status, s.capture_source], ['detected', 'notification']);
    assert.equal((await db.getAllAsync('SELECT * FROM transaction_sources')).length, 1);
    await db.runAsync(`INSERT INTO transaction_sources (transaction_id, source, detected_at, processed_at) VALUES ('s1', 'payment_notification', ?, ?)`, t, t);
  });

  // ── permissions ──
  await test('setup asks each access once, in order; revocation is noticed', () => {
    const none = { sms: false, app_notifications: false, notification_access: false };
    const all = { sms: true, app_notifications: true, notification_access: true };
    assert.deepEqual(pendingPermissionSteps({ available: all, granted: none, answered: none }), ['sms', 'app_notifications', 'notification_access']);
    assert.deepEqual(pendingPermissionSteps({ available: all, granted: none, answered: { ...none, sms: true } }), ['app_notifications', 'notification_access']);
    assert.deepEqual(pendingPermissionSteps({ available: { ...all, notification_access: false }, granted: { ...none, sms: true }, answered: none }), ['app_notifications']);
    assert.deepEqual(revokedSince({ ...none, notification_access: true }, none), ['notification_access']);
    assert.deepEqual(revokedSince(null, none), []);
  });

  console.log(`\n${passed} unified ledger tests passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
