/**
 * One-tap category actions on review notifications: which categories are offered, and what applying a tapped choice does
 * to the ledger. Real services, migrations and SQLite (node:sqlite); the Android side (buttons, receiver, native queue)
 * is a mock here, so this says nothing about how a real device behaves.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { addTransaction, applyNotificationCategory, deleteTransaction, setTransactionServiceAdapter } from '../transactionService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { getCategorySuggestions } from '../categorySuggestions.ts';
import { drainReviewActions, type PendingReviewAction, type ReviewActionStore } from '../reviewActionDrain.ts';
import { REVIEW_SETTLE_MS, reviewPrefLabel, runReviewPass, setReviewNotifierPort, type ReviewNotification, type ReviewNotifierPort } from '../reviewNotifications.ts';
import type { SmsReceivedPayload } from '../../../transactionParser.ts';
import type { IDatabase, Session, TransactionEntity } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 't', refresh_token: 'r', token_type: 'bearer' };
const B: Session = { user: { id: 'user-B', full_name: 'B', email: 'b@x.com' }, access_token: 't', refresh_token: 'r', token_type: 'bearer' };
const now = new Date();
const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
const later = () => Date.now() + REVIEW_SETTLE_MS + 60_000;
const SMS = (body: string, at = base): SmsReceivedPayload => ({ sender: 'AX-HDFCBK-S', body, receivedAt: at, partCount: 1, source: 'sms' });
const NO_CATEGORY = 'Rs.450.00 debited from A/c XX1234 to RAHUL KUMAR Ref 412345678901';

class MockNotifier implements ReviewNotifierPort {
  posts: ReviewNotification[] = [];
  summaries: number[] = [];
  cancelled: string[] = [];
  canNotify() { return true; }
  post(n: ReviewNotification) { this.posts.push(n); return true; }
  postSummary(c: number) { this.summaries.push(c); return true; }
  cancel(id: string) { this.cancelled.push(id); }
  cancelSummary() {}
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
const settle = () => new Promise((r) => setTimeout(r, 20));
const spend = (session: Session | null, counterparty: string, category: string, daysAgo = 1) =>
  addTransaction({ amount: 100, direction: 'expense', counterparty, category, transaction_date: new Date(base - daysAgo * 86_400_000).toISOString() }, session);
const queued = (db: IDatabase, id: string) => db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ? AND operation = 'update'", id).then((r) => r?.n ?? 0);

let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); await settle(); passed += 1; console.log(`✓ ${name}`); }

class FakeStore implements ReviewActionStore {
  completed: number[] = []; released: number[] = [];
  pending: PendingReviewAction[];
  constructor(pending: PendingReviewAction[]) { this.pending = pending; }
  async claim(limit: number) { const out = this.pending.splice(0, limit); return out; }
  async complete(id: number) { this.completed.push(id); }
  async release(id: number) { this.released.push(id); }
}

async function main() {
  await test('notification offers the merchant\'s own category first, then most-used, never the catch-all buckets', async () => {
    const { db, notifier } = await fresh();
    await spend(A, 'RAHUL KUMAR', 'Groceries', 3);
    for (let i = 0; i < 4; i += 1) await spend(A, `Cafe ${i}`, 'Food & Dining', 2 + i);
    await spend(A, 'Misc', 'Other Expenses', 1);
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    assert.deepEqual(notifier.posts[0].categories, ['Groceries', 'Food & Dining']);
  });
  await test('a different merchant\'s history does not leak in; a fresh ledger offers nothing but still notifies', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A); await pass(db);
    assert.equal(notifier.posts.length, 1);
    assert.deepEqual(notifier.posts[0].categories, []);
  });
  await test('guest scope gets suggestions from guest history only', async () => {
    const { db, notifier } = await fresh();
    await spend(null, 'RAHUL KUMAR', 'Groceries'); await spend(A, 'RAHUL KUMAR', 'Gym');
    await processIncomingSms(SMS(NO_CATEGORY), null); await pass(db, null);
    assert.deepEqual(notifier.posts[0].categories, ['Groceries']);
  });
  await test('income and kind-based categories are not offered for an expense', async () => {
    const { db } = await fresh();
    await addTransaction({ amount: 5, direction: 'income', counterparty: 'RAHUL KUMAR', category: 'Salary', transaction_date: new Date(base).toISOString() }, A);
    const [tx] = await rows(db);
    assert.deepEqual(await getCategorySuggestions(db, A.user.id, { id: 'x', counterparty: 'RAHUL KUMAR', direction: 'expense' }), []);
    assert.equal(tx.direction, 'income');
  });
  await test('a possible duplicate carries no category buttons; a summary never does', async () => {
    const { db, notifier } = await fresh();
    await spend(A, 'RAHUL KUMAR', 'Groceries');
    for (let i = 0; i < 4; i += 1) await processIncomingSms(SMS(`Rs.${100 + i}.00 debited from A/c XX1234 to RAHUL KUMAR`, base + i * 7200_000), A);
    await pass(db);
    assert.equal(notifier.posts.length, 0); assert.equal(notifier.summaries.length, 1);
  });

  await test('applying a choice: local update, sync queued, verified, notification cancelled', async () => {
    const { db, notifier } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    assert.equal(await applyNotificationCategory(tx.id, 'Groceries', A), 'applied');
    const after = (await rows(db))[0];
    assert.equal(after.category, 'Groceries'); assert.equal(after.category_id, 'cat-groceries');
    assert.equal(after.verification_status, 'verified');
    assert.equal(after.sync_status, 'pending_create'); // not yet uploaded: still the create op, now carrying the category
    assert.ok(notifier.cancelled.includes(tx.id));
  });
  await test('applying twice is harmless', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    assert.equal(await applyNotificationCategory(tx.id, 'Groceries', A), 'applied');
    const queueSize = (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM sync_queue'))!.n;
    assert.equal(await applyNotificationCategory(tx.id, 'Groceries', A), 'already_handled');
    assert.equal((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM sync_queue'))!.n, queueSize);
  });
  await test('a category the person set in the app first wins over a late button tap', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    await db.runAsync("UPDATE transactions SET category = 'Gym', verification_status = 'verified' WHERE id = ?", tx.id);
    assert.equal(await applyNotificationCategory(tx.id, 'Groceries', A), 'already_handled');
    assert.equal((await rows(db))[0].category, 'Gym');
  });
  await test('gone, other account, and unknown category are refused without changes', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    const [tx] = await rows(db);
    assert.equal(await applyNotificationCategory(tx.id, 'Groceries', B), 'other_scope');
    assert.equal(await applyNotificationCategory(tx.id, 'Salary', A), 'invalid_category'); // income category on an expense
    assert.equal(await applyNotificationCategory(tx.id, 'Nonsense', A), 'invalid_category');
    assert.equal((await rows(db))[0].verification_status, 'needs_review');
    await deleteTransaction(tx.id, A);
    assert.equal(await applyNotificationCategory(tx.id, 'Groceries', A), 'gone');
    assert.equal(await applyNotificationCategory('no-such-id-123', 'Groceries', A), 'gone');
  });
  await test('guest: applied locally, nothing uploaded for it', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), null);
    const [tx] = await rows(db);
    assert.equal(tx.user_id, null);
    assert.equal(await applyNotificationCategory(tx.id, 'Groceries', null), 'applied');
    assert.equal((await rows(db))[0].category, 'Groceries');
  });

  await test('drain: applies each queued choice once, completes it, defers another account\'s', async () => {
    const { db } = await fresh();
    await processIncomingSms(SMS(NO_CATEGORY), A);
    await processIncomingSms(SMS('Rs.99.00 debited from A/c XX1234 to PRIYA', base + 7200_000), A);
    await processIncomingSms(SMS('Rs.77.00 debited from A/c XX1234 to OTHERS', base + 2 * 7200_000), B);
    const [one, two] = (await rows(db)).filter((r) => r.user_id === A.user.id);
    const theirs = (await rows(db)).find((r) => r.user_id === B.user.id)!;
    const store = new FakeStore([
      { id: 1, transactionId: one.id, category: 'Groceries' },
      { id: 2, transactionId: one.id, category: 'Groceries' }, // replayed
      { id: 3, transactionId: two.id, category: 'Transportation' },
      { id: 4, transactionId: theirs.id, category: 'Groceries' },
      { id: 5, transactionId: 'gone-transaction-id', category: 'Groceries' },
    ]);
    const summary = await drainReviewActions(store, A);
    assert.deepEqual(summary, { applied: 2, dropped: 2, deferred: 1, failed: 0 });
    assert.deepEqual(store.completed.sort(), [1, 2, 3, 5]);
    assert.deepEqual(store.released, [4]);
    const final = await rows(db);
    assert.equal(final.find((r) => r.id === one.id)!.category, 'Groceries');
    assert.equal(final.find((r) => r.id === two.id)!.category, 'Transportation');
    assert.equal(final.find((r) => r.id === theirs.id)!.verification_status, 'needs_review');
  });
  await test('drain: an apply error leaves the row queued', async () => {
    const store = new FakeStore([{ id: 9, transactionId: 'abcdefgh-1', category: 'Groceries' }]);
    const summary = await drainReviewActions(store, A, { apply: async () => { throw new Error('db busy'); } });
    assert.deepEqual(summary, { applied: 0, dropped: 0, deferred: 0, failed: 1 });
    assert.deepEqual(store.completed, []);
  });

  await test('settings label says what to do when reminders are on but Android blocks notifications', () => {
    assert.equal(reviewPrefLabel('all', false), 'Allow Velnora notifications to receive these');
    assert.equal(reviewPrefLabel('off', false), 'Off · review inside the app');
    assert.equal(reviewPrefLabel('all'), 'On · when a payment needs you');
  });

  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
