/**
 * "Complete your transaction" notifications: completeness rules, one-notification-per-transaction, permissions,
 * link handling, analytics. Real parser, services, migrations and SQLite (node:sqlite); the Android notification API
 * is a recording mock, so this says nothing about how a real device delivers, displays or opens a notification.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { getCurrentSchemaVersion, runMigrations } from '../../db/migrations.ts';
import { MIGRATIONS } from '../../db/schema.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { addTransaction, completeTransactionReview, deleteTransaction, getReviewDetails, getReviewQueue, resolvePossibleDuplicate, setTransactionServiceAdapter, updateLedgerFields, updateTransactionDetails } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { getCashFlowSummary, getLedgerHealth } from '../cashFlowService.ts';
import { createAccount } from '../accountService.ts';
import { applyStatement, parseStatementCsv, previewStatement } from '../statementImport.ts';
import { evaluateCompleteness } from '../transactionCompleteness.ts';
import { GROUP_WINDOW_MS } from '../notificationGrouping.ts';
import { describeReview, MAX_INDIVIDUAL_NOTIFICATIONS, REVIEW_SETTLE_MS, clearReviewNotifications, runReviewPass, setReviewNotifierPort, setReviewPref, type ReviewNotification, type ReviewNotifierPort } from '../reviewNotifications.ts';
import { createReviewLinkRouter, parseReviewLink, resolveReviewTarget, type ReviewLink } from '../reviewLinks.ts';
import type { SmsReceivedPayload } from '../../../transactionParser.ts';
import type { IDatabase, Session, TransactionEntity } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 't', refresh_token: 'r', token_type: 'bearer' };
const B: Session = { user: { id: 'user-B', full_name: 'B', email: 'b@x.com' }, access_token: 't', refresh_token: 'r', token_type: 'bearer' };
const now = new Date();
const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
const later = () => Date.now() + REVIEW_SETTLE_MS + 60_000;
const SMS = (body: string, at = base, sender = 'AX-HDFCBK-S'): SmsReceivedPayload => ({ sender, body, receivedAt: at, partCount: 1, source: 'sms' });
const APP = (body: string, at = base, app = 'Google Pay'): SmsReceivedPayload => ({ sender: app, body, receivedAt: at, partCount: 1, source: 'payment_notification', sourceApp: app });
const NO_CATEGORY = 'Rs.450.00 debited from A/c XX1234 to RAHUL KUMAR Ref 412345678901';
const COMPLETE = 'Rs.450.00 debited from A/c XX1234 to ZOMATO Ref 412345678902';

class MockNotifier implements ReviewNotifierPort {
  allowed = true;
  active = new Map<string, ReviewNotification>();
  posts: ReviewNotification[] = [];
  summaries: number[] = [];
  summaryActive = false;
  canNotify() { return this.allowed; }
  post(n: ReviewNotification) { this.posts.push(n); this.active.set(n.transactionId, n); return true; }
  postSummary(c: number) { this.summaries.push(c); this.summaryActive = true; return true; }
  cancel(id: string) { this.active.delete(id); }
  cancelSummary() { this.summaryActive = false; }
}

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  const notifier = new MockNotifier();
  setReviewNotifierPort(notifier);
  return { db: db as unknown as IDatabase, notifier };
}
const rows = (db: IDatabase) => db.getAllAsync<TransactionEntity>('SELECT * FROM transactions WHERE deleted_at IS NULL ORDER BY created_at');
const pass = (db: IDatabase, scope: string | null = A.user.id) => runReviewPass(db, scope, { now: later() });
// Pending fire-and-forget passes must finish before a test looks at the mock.
const settle = () => new Promise((r) => setTimeout(r, 20));

let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); await settle(); passed += 1; console.log(`✓ ${name}`); }

async function main() {
  // Classification
  await test('1. a complete transaction is saved and does not notify', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(COMPLETE), A); await pass(db);
    assert.equal((await rows(db))[0].verification_status, 'detected');
    assert.equal(notifier.posts.length, 0);
  });
  await test('2. missing category: saved, flagged, exact field recorded, notified', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    const [tx] = await rows(db);
    assert.equal(tx.verification_status, 'needs_review');
    assert.deepEqual((await getReviewDetails(tx.id, A))!.missing, ['category']);
    assert.equal(notifier.posts[0].title, 'Complete your transaction');
    assert.equal(notifier.posts[0].body, '₹450 payment detected at RAHUL KUMAR. Add a category to complete your transaction.');
    assert.equal(notifier.posts[0].transactionId, tx.id);
  });
  await test('3. unknown merchant triggers review for a payment, not for a cash withdrawal', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS('Rs 1,200 debited via UPI'), A); await pass(db);
    assert.deepEqual((await getReviewDetails((await rows(db))[0].id, A))!.missing.includes('merchant'), true);
    assert.equal(notifier.posts.length, 1);
    assert.ok(!notifier.posts[0].body.includes('UPI payment'), 'a placeholder is not presented as a merchant');
    assert.deepEqual(evaluateCompleteness({ amount_paise: 200000, direction: 'expense', counterparty: 'ATM withdrawal', category: 'Cash Withdrawal', transaction_date: new Date(base).toISOString(), txn_kind: 'cash_withdrawal' }).missing, []);
  });
  await test('4. unknown account asks only when there is a real choice, and is never invented', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(APP('You paid ₹450 to Zomato'), A); await pass(db);
    assert.equal(notifier.posts.length, 0, 'one or no confirmed accounts: optional');
    await createAccount(db, A.user.id, { bankName: 'HDFC Bank', last4: '1111' });
    await createAccount(db, A.user.id, { bankName: 'SBI', last4: '2222' });
    await processIncomingSms(APP('You paid ₹999 to Zomato', base + 7200_000), A); await pass(db);
    assert.equal(notifier.posts.length, 1);
    assert.equal(notifier.posts[0].title, 'Confirm the payment account');
    const row = (await rows(db))[1];
    assert.equal(row.bank_name, null); assert.equal(row.account_last4, null);
  });
  await test('5. an uncertain duplicate is kept and asks for confirmation', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(COMPLETE.replace(' Ref 412345678902', '')), A);
    await processIncomingSms(APP('You paid ₹450 to Bundl Foods', base + 60_000), A); await pass(db);
    assert.equal((await rows(db)).length, 2);
    assert.equal(notifier.posts.length, 1);
    assert.equal(notifier.posts[0].title, 'Check possible duplicate transaction');
  });
  await test('6. a failed payment creates nothing and notifies nobody', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS('Your payment of Rs 450 to RAHUL has failed.'), A); await pass(db);
    assert.equal((await rows(db)).length, 0); assert.equal(notifier.posts.length, 0);
  });
  await test('notification text carries no message body, full number or OTP', async () => {
    const tx = { amount_paise: 45000, direction: 'expense', counterparty: 'A/C 123456789012' } as TransactionEntity;
    const text = JSON.stringify(describeReview(tx, ['category']));
    assert.ok(!text.includes('123456789012'));
  });

  // Deduplication
  await test('7. SMS and payment app for one payment: one notification', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    await processIncomingSms(APP('You paid ₹450 to Rahul Kumar', base + 20_000), A); await pass(db); await pass(db);
    assert.equal((await rows(db)).length, 1);
    assert.equal(notifier.posts.length, 1);
    assert.equal(notifier.active.size, 1);
  });
  await test('a second source that completes the payment before the settle window prevents the notification', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS('Rs.450.00 debited from A/c XX1234 via UPI'), A);
    assert.equal((await rows(db))[0].verification_status, 'needs_review');
    await processIncomingSms(APP('You paid ₹450 to Zomato', base + 20_000), A); await pass(db);
    const [tx] = await rows(db);
    assert.equal(tx.counterparty, 'Zomato'); assert.equal(tx.verification_status, 'verified'); assert.equal(notifier.posts.length, 0);
  });
  await test('a second source completing it after the notification cancels it', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS('Rs.450.00 debited from A/c XX1234 via UPI'), A); await pass(db);
    assert.equal(notifier.active.size, 1);
    await processIncomingSms(APP('You paid ₹450 to Zomato', base + 20_000), A); await pass(db);
    assert.equal(notifier.active.size, 0);
  });
  await test('8. a replayed SMS and repeated passes do not notify again', async () => {
    const { db, notifier } = await fresh();
    for (let i = 0; i < 3; i += 1) { await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db); }
    assert.equal(notifier.posts.length, 1);
  });
  await test('swiping a notification away does not bring it back', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    notifier.active.clear(); await pass(db);
    assert.equal(notifier.posts.length, 1);
  });
  const dated = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  await test('9. statement import and re-import never notify', async () => {
    const { db, notifier } = await fresh();
    const csv = `Date,Narration,Withdrawal Amt,Deposit Amt\n${dated},ACME STORES,700.00,\n${dated},UNKNOWN PAYEE,900.00,\n`;
    for (let i = 0; i < 2; i += 1) {
      await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, parseStatementCsv(csv).rows), () => true);
      await pass(db);
    }
    assert.equal((await rows(db)).length, 2); assert.equal(notifier.posts.length, 0);
  });
  await test('10. different payments with the same amount each get their own notification', async () => {
    const { db, notifier } = await fresh();
    const body = 'Rs.450.00 debited from A/c XX1234 to RAHUL KUMAR';
    // Arriving minutes apart (outside the grouping window), so each is announced on its own.
    await processIncomingSms(SMS(body, base), A); await runReviewPass(db, A.user.id, { now: later() });
    await processIncomingSms(SMS(body, base + 3 * 60_000), A); await runReviewPass(db, A.user.id, { now: later() + GROUP_WINDOW_MS + 1000 });
    assert.equal((await rows(db)).length, 2);
    assert.equal(new Set(notifier.posts.map((p) => p.transactionId)).size, 2);
    assert.equal(notifier.summaries.length, 0);
  });
  await test('10b. a second payment inside the grouping window replaces the first single notification with one summary', async () => {
    const { db, notifier } = await fresh();
    const body = 'Rs.450.00 debited from A/c XX1234 to RAHUL KUMAR';
    await processIncomingSms(SMS(body, base), A); await runReviewPass(db, A.user.id, { now: later() });
    assert.equal(notifier.active.size, 1);
    await processIncomingSms(SMS(body, base + 3 * 60_000), A); await runReviewPass(db, A.user.id, { now: later() + 30_000 });
    assert.deepEqual(notifier.summaries, [2]);
    assert.equal(notifier.active.size, 0, 'the single notification (and its buttons) is gone; the summary opens the list');
    await runReviewPass(db, A.user.id, { now: later() + 40_000 });
    assert.deepEqual(notifier.summaries, [2], 'no repeat');
  });
  await test('11+12. completing updates the same row, cancels the notification, and does not notify again', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    const [tx] = await rows(db);
    await completeTransactionReview(tx.id, { category: 'Rent' }, A); await settle(); await pass(db);
    const all = await rows(db);
    assert.equal(all.length, 1); assert.equal(all[0].id, tx.id); assert.equal(all[0].category, 'Rent'); assert.equal(all[0].verification_status, 'verified');
    assert.equal(notifier.active.size, 0); assert.equal(notifier.posts.length, 1);
    assert.deepEqual(await getReviewQueue(A), []);
  });
  await test('editing through the transaction sheet also resolves it', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    const [tx] = await rows(db);
    await updateTransactionDetails(tx.id, { category: 'Rent' }, A); await settle(); await pass(db);
    assert.equal((await rows(db))[0].verification_status, 'verified'); assert.equal(notifier.active.size, 0);
  });
  await test('resolving a duplicate cancels its notification; deleting a transaction cancels too', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(COMPLETE.replace(' Ref 412345678902', '')), A);
    await processIncomingSms(APP('You paid ₹450 to Bundl Foods', base + 60_000), A); await pass(db);
    await resolvePossibleDuplicate((await rows(db))[1].id, 'merge', A); await settle(); await pass(db);
    assert.equal(notifier.active.size, 0); assert.equal((await rows(db)).length, 1);
    await processIncomingSms(SMS(NO_CATEGORY, base + 7200_000), A); await pass(db);
    assert.equal(notifier.active.size, 1);
    await deleteTransaction((await rows(db))[1].id, A); await settle();
    assert.equal(notifier.active.size, 0);
  });
  await test('a transaction that needs review again may be announced again', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    const [tx] = await rows(db);
    await completeTransactionReview(tx.id, { category: 'Rent' }, A); await settle(); await pass(db);
    await updateLedgerFields(tx.id, { verification_status: 'needs_review' }, A); await settle(); await pass(db);
    assert.equal(notifier.posts.length, 2);
  });
  await test('resolved on another device (arrives by sync): notification cleared by the next pass', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    await db.runAsync("UPDATE transactions SET verification_status = 'verified'");
    await pass(db);
    assert.equal(notifier.active.size, 0);
  });
  await test('nothing is announced inside the settle window', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    await runReviewPass(db, A.user.id, { now: Date.now() + 1000 });
    assert.equal(notifier.posts.length, 0);
  });
  await test('many at once become one summary, cleared when all are resolved', async () => {
    const { db, notifier } = await fresh();
    for (let i = 0; i <= MAX_INDIVIDUAL_NOTIFICATIONS; i += 1) await processIncomingSms(SMS(`Rs.${100 + i}.00 debited from A/c XX1234 to RAHUL KUMAR`, base + i * 7200_000), A);
    await pass(db); await pass(db);
    assert.equal(notifier.posts.length, 0); assert.deepEqual(notifier.summaries, [MAX_INDIVIDUAL_NOTIFICATIONS + 1]);
    for (const tx of await rows(db)) await completeTransactionReview(tx.id, { category: 'Rent' }, A);
    await settle(); await pass(db);
    assert.equal(notifier.summaryActive, false);
  });

  // Permissions and preferences
  await test('13+16. permission denied: still saved, in the queue, not notified, never lost', async () => {
    const { db, notifier } = await fresh();
    notifier.allowed = false;
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db); await pass(db);
    assert.equal(notifier.posts.length, 0);
    assert.equal((await getReviewQueue(A)).length, 1);
    assert.equal((await db.getAllAsync('SELECT * FROM review_notifications')).length, 0);
  });
  await test('14. permission granted later: waiting items are announced once, a backlog as one summary', async () => {
    const { db, notifier } = await fresh();
    notifier.allowed = false;
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    notifier.allowed = true; await pass(db); await pass(db);
    assert.equal(notifier.posts.length, 1);

    const second = await fresh();
    second.notifier.allowed = false;
    for (let i = 0; i < 10; i += 1) await processIncomingSms(SMS(`Rs.${200 + i}.00 debited from A/c XX1234 to RAHUL KUMAR`, base + i * 7200_000), A);
    second.notifier.allowed = true; await pass(second.db);
    assert.equal(second.notifier.posts.length, 0); assert.deepEqual(second.notifier.summaries, [10]);
  });
  await test('15. permission revoked: capture continues, nothing further is posted or re-posted', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    notifier.allowed = false;
    await processIncomingSms(SMS('Rs.99.00 debited from A/c XX1234 to ASHA RAO', base + 7200_000), A); await pass(db);
    assert.equal(notifier.posts.length, 1); assert.equal((await getReviewQueue(A)).length, 2);
  });
  await test('preference: off cancels and stops; duplicates-only filters', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    await setReviewPref(db, 'off'); await pass(db);
    assert.equal(notifier.active.size, 0);
    await processIncomingSms(SMS('Rs.99.00 debited from A/c XX1234 to ASHA RAO', base + 7200_000), A); await pass(db);
    assert.equal(notifier.posts.length, 1);
    await setReviewPref(db, 'duplicates'); await pass(db);
    assert.equal(notifier.posts.length, 1, 'category questions stay in the app');
  });
  await test('notifications are per account and cleared on sign-out', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db, B.user.id);
    assert.equal(notifier.posts.length, 0, "another account's pass does not announce it");
    await pass(db);
    await clearReviewNotifications(db, A.user.id);
    assert.equal(notifier.active.size, 0);
  });
  await test('no notifier (older native build): capture is unaffected', async () => {
    const { db } = await fresh();
    setReviewNotifierPort(null);
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    assert.equal((await rows(db))[0].verification_status, 'needs_review');
  });

  // Links
  await test('link parsing accepts only well-formed review links', () => {
    assert.deepEqual(parseReviewLink('velnora://review/4f2c9a10-aaaa-4bbb-8ccc-123456789abc'), { kind: 'transaction', id: '4f2c9a10-aaaa-4bbb-8ccc-123456789abc' });
    assert.deepEqual(parseReviewLink('velnora://review'), { kind: 'queue' });
    for (const bad of ['https://x.com/review/abc', 'velnora://review/../../x', 'velnora://review/a', null, '']) assert.equal(parseReviewLink(bad), null);
  });
  await test('17+18. a tap while running opens that exact transaction immediately', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    const seen: ReviewLink[] = [];
    const router = createReviewLinkRouter((l) => seen.push(l));
    router.setReady(true); router.receive(`velnora://review/${tx.id}`);
    assert.deepEqual(seen, [{ kind: 'transaction', id: tx.id }]);
    const target = await resolveReviewTarget(db, A.user.id, tx.id);
    assert.equal(target.status, 'needs_review');
    const details = (await getReviewDetails(tx.id, A))!;
    assert.equal(details.transaction.amount_paise, 45000); assert.deepEqual(details.transaction.detected_via, ['sms']);
  });
  await test('19. cold start: the link waits until the app is ready, and is delivered once', () => {
    const seen: ReviewLink[] = [];
    const router = createReviewLinkRouter((l) => seen.push(l));
    router.receive('velnora://review/4f2c9a10-aaaa');
    assert.equal(seen.length, 0);
    router.setReady(true); router.setReady(true);
    assert.equal(seen.length, 1);
  });
  await test('20. already resolved: shown as resolved, not as a new task', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    await completeTransactionReview(tx.id, { category: 'Rent' }, A);
    assert.equal((await resolveReviewTarget(db, A.user.id, tx.id)).status, 'resolved');
  });
  await test("21. deleted, unknown or another account's transaction: missing, and nothing is created", async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    assert.equal((await resolveReviewTarget(db, B.user.id, tx.id)).status, 'missing');
    assert.equal(await getReviewDetails(tx.id, B), null);
    assert.equal((await resolveReviewTarget(db, A.user.id, 'no-such-transaction')).status, 'missing');
    await deleteTransaction(tx.id, A);
    assert.equal((await resolveReviewTarget(db, A.user.id, tx.id)).status, 'missing');
    assert.equal((await db.getAllAsync('SELECT * FROM transactions')).length, 1, 'only the tombstone');
  });

  // Learning
  await test('a correction teaches future payments from that merchant only, and flags stop', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    const other = await processIncomingSms(SMS('Rs.75.00 debited from A/c XX1234 to ASHA RAO', base + 3600_000), A);
    await completeTransactionReview(tx.id, { category: 'Rent' }, A);
    await processIncomingSms(SMS('Rs.900.00 debited from A/c XX1234 to RAHUL KUMAR Ref 412345678999', base + 7200_000), A);
    const all = await rows(db);
    assert.equal(all[2].category, 'Rent'); assert.equal(all[2].verification_status, 'detected');
    assert.equal(all.find((t) => t.id === other.transaction!.id)!.category, 'Other Expenses', 'unrelated history untouched');
  });
  await test('a placeholder merchant is never learned', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS('Rs 1,200 debited via UPI'), A);
    await completeTransactionReview((await rows(db))[0].id, { counterparty: 'Landlord', category: 'Rent' }, A);
    assert.equal((await db.getAllAsync('SELECT * FROM merchant_aliases')).length, 0);
  });

  // Analytics
  await test('22+23. review rows are unconfirmed, not verified; resolving updates the figures', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    let h = await getLedgerHealth(db, A.user.id, new Date(base));
    assert.deepEqual([h.verifiedCount, h.needsReviewCount, h.monthUnverifiedExpensePaise], [0, 1, 45000]);
    await completeTransactionReview((await rows(db))[0].id, { category: 'Rent' }, A);
    h = await getLedgerHealth(db, A.user.id, new Date(base));
    assert.deepEqual([h.verifiedCount, h.needsReviewCount, h.monthUnverifiedExpensePaise], [1, 0, 0]);
  });
  await test('uncertain duplicates are not counted twice; notification delivery never touches totals', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(COMPLETE.replace(' Ref 412345678902', '')), A);
    await processIncomingSms(APP('You paid ₹450 to Bundl Foods', base + 60_000), A);
    const before = await getCashFlowSummary(db, A.user.id, new Date(base));
    await pass(db);
    assert.equal(notifier.posts.length, 1);
    assert.deepEqual(await getCashFlowSummary(db, A.user.id, new Date(base)), before);
    assert.equal(before.monthExpensePaise, 45000);
  });
  await test('24+25. transfers stay out; refunds stay out of income and raise no question', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS('Rs 2000 transferred to own account XX9999 from A/c XX1234', base), A);
    await processIncomingSms(SMS('Refund of Rs 450 credited to A/c XX1234 from AMAZON Ref 412345678903', base + 60_000), A);
    await pass(db);
    const s = await getCashFlowSummary(db, A.user.id, new Date(base));
    assert.deepEqual([s.monthExpensePaise, s.monthIncomePaise, s.monthRefundPaise], [0, 0, 45000]);
    assert.equal(notifier.posts.length, 0);
  });
  await test('manual entries never trigger a review', async () => {
    const { db, notifier } = await fresh();
    await addTransaction({ amount: 50, direction: 'expense', counterparty: 'UPI payment', category: 'Other Expenses', transaction_date: new Date(base).toISOString() }, A);
    await pass(db);
    assert.equal(notifier.posts.length, 0);
    assert.equal((await rows(db))[0].verification_status, 'verified');
  });

  // Storage
  await test('completing a review queues one sync update for the same id', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    await completeTransactionReview(tx.id, { category: 'Rent' }, A);
    const q = await db.getAllAsync<{ payload: string }>("SELECT payload FROM sync_queue WHERE entity_type = 'transaction' AND entity_id = ?", tx.id);
    assert.equal(q.length, 1);
    assert.equal(JSON.parse(q[0].payload).verification_status, 'verified');
  });
  await test('migration 8 is additive and keeps existing rows', async () => {
    const db = new NodeSqliteAdapter() as unknown as IDatabase;
    await db.execAsync('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 7)) { await db.execAsync(m.up); await db.runAsync('INSERT INTO schema_migrations VALUES (?, ?)', m.version, 'x'); }
    const t = new Date(base).toISOString();
    await db.runAsync(`INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, transaction_date, source, sync_status, verification_status, capture_source, created_at, updated_at) VALUES ('old', 'u', 10, 1000, 'expense', 'X', 'Y', ?, 'sms', 'synced', 'needs_review', 'sms', ?, ?)`, t, t, t);
    assert.equal(await runMigrations(db), MIGRATIONS.length - 7);
    assert.equal(await getCurrentSchemaVersion(db), MIGRATIONS[MIGRATIONS.length - 1].version);
    assert.equal((await db.getAllAsync('SELECT * FROM transactions')).length, 1);
    assert.equal((await db.getAllAsync('SELECT * FROM review_notifications')).length, 0);
  });

  console.log(`\n${passed} review notification tests passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
