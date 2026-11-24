/**
 * Split data vs. its transaction: claiming on sign-in (same scope as the transaction, nothing queued) and the linked-transaction lifecycle
 * (delete removes the split, amount edits re-split or require re-entry, category/date follow, direction change removes it).
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import type { IDatabase, Session } from '../../db/types.ts';
import { addTransaction, deleteTransaction, hasSplit, setTransactionServiceAdapter, updateTransactionDetailsDetailed } from '../transactionService.ts';
import { importGuestData } from '../guestModeService.ts';
import { spentPaise } from '../budgetService.ts';
import { SELF, SplitError } from '../splitMath.ts';
import {
  SplitReentryRequired, countGuestSplitData, createContact, createGroup, createSplitExpense, getBalancesWithMe, getSplitExpense, getSplitForTransaction, listContacts, listGroups, listSettlements,
  listSplitExpenses, recordSettlement, type SplitExpenseInput,
} from '../splitService.ts';

let passed = 0;
const test = async (name: string, fn: (db: IDatabase) => Promise<void>) => {
  const db = new NodeSqliteAdapter() as unknown as IDatabase; await runMigrations(db);
  setCustomDatabase(db as never); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  await fn(db); passed += 1; console.log(`✓ ${name}`);
};
const user = (id: string): Session => ({ user: { id, full_name: 'U', email: 'u@x.com' }, access_token: 't', refresh_token: 'r', token_type: 'bearer' });
const U1 = user('user-1');
const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const thisMonth = monthOf(new Date());
const input = (over: Partial<SplitExpenseInput> & Pick<SplitExpenseInput, 'totalPaise' | 'participants' | 'payers'>): SplitExpenseInput =>
  ({ title: 'Dinner', category: 'Food & Dining', expenseDate: new Date().toISOString(), mode: 'equal', ...over });
const rejectsSplit = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof SplitError && re.test(e.message));

async function guestScenario(db: IDatabase, extra: Record<string, unknown> = {}) {
  const t = await addTransaction({ amount: 1200, direction: 'expense', counterparty: 'Beach Shack', category: 'Food & Dining', ...extra } as never, null);
  const a = await createContact(db, null, { name: 'Asha', phone: '+919876500001', upiId: 'asha@okbank' }); const b = await createContact(db, null, { name: 'Bala' });
  const g = await createGroup(db, null, { name: 'Goa trip', memberIds: [a.id, b.id] });
  const split = await createSplitExpense(db, null, input({ groupId: g.id, transactionId: t.id, totalPaise: 120000, participants: [{ party: SELF }, { party: a.id }, { party: b.id }], payers: [{ party: SELF, paidPaise: 120000 }] }));
  await recordSettlement(db, null, { from: a.id, to: SELF, amountPaise: 10000, groupId: g.id });
  return { t, a, b, g, split };
}

// ------------------------------------------------------------------------------------------------------------ claiming
await test('guest -> account: the split moves with its transaction; spending is still only my share; groups and balances survive', async (db) => {
  const { t, g, a } = await guestScenario(db);
  assert.equal(await spentPaise(db, null, thisMonth, null), 40000);
  assert.equal(await countGuestSplitData(db), 3, 'two friends and one split expense are importable guest data');
  const queueBefore = (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM sync_queue`))!.n;

  const result = await importGuestData('user-1', db);
  assert.equal(result.imported, 1);

  assert.equal(await spentPaise(db, 'user-1', thisMonth, null), 40000, 'the transaction still counts only my Rs 400 share');
  assert.equal((await db.getFirstAsync<{ amount_paise: number; user_id: string }>(`SELECT amount_paise, user_id FROM transactions WHERE id = ?`, t.id))!.amount_paise, 120000, 'full bank amount kept');
  assert.equal((await getSplitForTransaction(db, 'user-1', t.id))!.user_id, 'user-1');
  const bal = await getBalancesWithMe(db, 'user-1');
  assert.equal(bal.perParty.get(a.id), 30000, 'balances intact (Rs 400 - Rs 100 settled)');
  assert.deepEqual((await listGroups(db, 'user-1')).map((x) => [x.id, x.name, x.memberIds.length]), [[g.id, 'Goa trip', 2]]);
  assert.equal((await listContacts(db, 'user-1')).length, 2); assert.equal((await listContacts(db, 'user-1'))[0].upi_id, 'asha@okbank', 'UPI id kept (local)');
  assert.equal((await listSettlements(db, 'user-1')).length, 1);

  // guest scope (= signed out) sees neither the transaction nor its split: they never end up in different scopes
  assert.equal(await spentPaise(db, null, thisMonth, null), 0);
  assert.equal((await listSplitExpenses(db, null)).length, 0); assert.equal((await listContacts(db, null)).length, 0); assert.equal((await listGroups(db, null)).length, 0);
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM transactions WHERE user_id IS NULL`))!.n, 0);
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM split_expenses WHERE user_id IS NULL`))!.n, 0);

  // local-only: nothing about splits was queued
  const types = (await db.getAllAsync<{ entity_type: string }>(`SELECT DISTINCT entity_type FROM sync_queue`)).map((r) => r.entity_type);
  assert.deepEqual(types.filter((x) => !['transaction', 'category', 'budget', 'expected_payment'].includes(x)), []);
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM sync_queue`))!.n, queueBefore, 'the claim itself added no queue rows beyond the transaction import');
  void U1;
});

await test('guest -> account when only friends exist: the import is still offered and claims them', async (db) => {
  await createContact(db, null, { name: 'Asha' });
  assert.equal(await countGuestSplitData(db), 1, 'friends alone are enough to offer the import');
  await importGuestData('user-1', db);
  assert.equal((await listContacts(db, 'user-1')).length, 1); assert.equal((await listContacts(db, null)).length, 0);
});

await test('guest -> account when the account already has the same payment: the split follows to the account copy (no double counting)', async (db) => {
  const mine = await addTransaction({ amount: 1200, direction: 'expense', counterparty: 'Beach Shack', category: 'Food & Dining', reference_id: 'UTR123' } as never, U1);
  const { t, split } = await guestScenario(db, { reference_id: 'UTR123' });
  const r = await importGuestData('user-1', db);
  assert.equal(r.skippedDuplicates, 1);
  const moved = (await getSplitExpense(db, 'user-1', split.id))!;
  assert.equal(moved.transaction_id, mine.id, 'now linked to the account transaction');
  assert.equal(await spentPaise(db, 'user-1', thisMonth, null), 40000, 'counted once, as my share');
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM transactions WHERE id = ? AND user_id IS NULL`, t.id))!.n, 1, 'the guest copy stays local');
  assert.equal(await spentPaise(db, null, thisMonth, null), 1200_00, 'and is plain guest spending (no split attached)');
});

await test('guest -> account, duplicate with a different amount: the split stays with its guest transaction (same scope)', async (db) => {
  await addTransaction({ amount: 999, direction: 'expense', counterparty: 'Beach Shack', category: 'Food & Dining', reference_id: 'UTR9' } as never, U1);
  const { t, split } = await guestScenario(db, { reference_id: 'UTR9' });
  await importGuestData('user-1', db);
  assert.equal((await db.getFirstAsync<{ user_id: string | null }>(`SELECT user_id FROM split_expenses WHERE id = ?`, split.id))!.user_id, null, 'split stays guest');
  assert.equal((await db.getFirstAsync<{ user_id: string | null }>(`SELECT user_id FROM transactions WHERE id = ?`, t.id))!.user_id, null, 'with its transaction');
  assert.equal(await spentPaise(db, 'user-1', thisMonth, null), 999_00);
});

// ------------------------------------------------------------------------------------------------------------ lifecycle
await test('deleting a split transaction removes the split too; settlements stay; nothing orphaned counts', async (db) => {
  const { t, a } = await guestScenario(db);
  assert.equal(await hasSplit(t.id), true);
  assert.equal(await spentPaise(db, null, thisMonth, null), 40000);
  await deleteTransaction(t.id, null);
  assert.equal(await hasSplit(t.id), false);
  assert.equal((await listSplitExpenses(db, null)).length, 0);
  assert.equal(await spentPaise(db, null, thisMonth, null), 0, 'no ghost share keeps counting');
  assert.equal((await listSettlements(db, null)).length, 1, 'the settlement record stays');
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(a.id), -10000, 'with the expense gone, the earlier payment shows as owed back');
  assert.equal(await hasSplit('no-such-tx'), false);
});

await test('amount edit, Equal: re-splits automatically and the split total always equals the transaction', async (db) => {
  const { t, a, b } = await guestScenario(db);
  const r = await updateTransactionDetailsDetailed(t.id, { amount: 1500 }, null);
  assert.equal(r.splitPlan.kind, 'resplit');
  const s = (await getSplitForTransaction(db, null, t.id))!;
  assert.equal(s.total_paise, 150000); assert.deepEqual(s.rows.map((x) => x.sharePaise).sort(), [50000, 50000, 50000]);
  assert.equal(s.rows.find((x) => x.party === SELF)!.paidPaise, 150000, 'my payment follows the new amount');
  assert.equal(await spentPaise(db, null, thisMonth, null), 50000);
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(a.id), 50000 - 10000, 'settlement kept, balance follows the new split');
  assert.ok(b);
});

await test('amount edit, Shares and Percent: proportions are kept', async (db) => {
  const t = await addTransaction({ amount: 1000, direction: 'expense', counterparty: 'Cab', category: 'Transportation' } as never, null);
  const a = await createContact(db, null, { name: 'Asha' });
  await createSplitExpense(db, null, input({ transactionId: t.id, totalPaise: 100000, mode: 'shares', participants: [{ party: SELF, value: 1 }, { party: a.id, value: 3 }], payers: [{ party: SELF, paidPaise: 100000 }] }));
  await updateTransactionDetailsDetailed(t.id, { amount: 2000 }, null);
  const s = (await getSplitForTransaction(db, null, t.id))!;
  assert.deepEqual([s.rows.find((x) => x.party === SELF)!.sharePaise, s.rows.find((x) => x.party === a.id)!.sharePaise], [50000, 150000]);
  assert.equal(s.rows.reduce((x, r) => x + r.sharePaise, 0), 200000);
  assert.equal(await spentPaise(db, null, thisMonth, null), 50000);
});

await test('amount edit, Exact: refused until the amounts are re-entered; nothing changes meanwhile', async (db) => {
  const t = await addTransaction({ amount: 1000, direction: 'expense', counterparty: 'Rent', category: 'Rent' } as never, null);
  const a = await createContact(db, null, { name: 'Asha' });
  await createSplitExpense(db, null, input({ transactionId: t.id, totalPaise: 100000, mode: 'exact', participants: [{ party: SELF, value: 70000 }, { party: a.id, value: 30000 }], payers: [{ party: SELF, paidPaise: 100000 }] }));
  await assert.rejects(updateTransactionDetailsDetailed(t.id, { amount: 1200 }, null), (e: unknown) => e instanceof SplitReentryRequired && e.newTotalPaise === 120000 && e.split.mode === 'exact');
  assert.equal((await db.getFirstAsync<{ amount_paise: number }>(`SELECT amount_paise FROM transactions WHERE id = ?`, t.id))!.amount_paise, 100000, 'transaction untouched');
  assert.equal((await getSplitForTransaction(db, null, t.id))!.total_paise, 100000, 'split untouched');
  const bad = input({ transactionId: t.id, totalPaise: 120000, mode: 'exact', participants: [{ party: SELF, value: 80000 }, { party: a.id, value: 30000 }], payers: [{ party: SELF, paidPaise: 120000 }] });
  await rejectsSplit(updateTransactionDetailsDetailed(t.id, { amount: 1200 }, null, bad), /less than the total/);
  assert.equal((await db.getFirstAsync<{ amount_paise: number }>(`SELECT amount_paise FROM transactions WHERE id = ?`, t.id))!.amount_paise, 100000, 'an invalid re-entry changes nothing');
  const good = { ...bad, participants: [{ party: SELF, value: 80000 }, { party: a.id, value: 40000 }] };
  const r = await updateTransactionDetailsDetailed(t.id, { amount: 1200 }, null, good);
  assert.equal(r.transaction.amount_paise, 120000);
  const s = (await getSplitForTransaction(db, null, t.id))!;
  assert.equal(s.total_paise, 120000); assert.equal(await spentPaise(db, null, thisMonth, null), 80000);
  await rejectsSplit(updateTransactionDetailsDetailed(t.id, { amount: 1300 }, null, { ...good, totalPaise: 120000 }), /match the transaction amount/);
});

await test('category and date edits: the split follows (spending moves to the new category and month)', async (db) => {
  const { t } = await guestScenario(db);
  const lastMonth = new Date(); lastMonth.setDate(1); lastMonth.setMonth(lastMonth.getMonth() - 1); lastMonth.setHours(12);
  await updateTransactionDetailsDetailed(t.id, { category: 'Travel', transaction_date: lastMonth.toISOString() }, null);
  const s = (await getSplitForTransaction(db, null, t.id))!;
  assert.equal(s.category, 'Travel'); assert.equal(s.expense_date, lastMonth.toISOString());
  assert.equal(await spentPaise(db, null, monthOf(lastMonth), 'Travel'), 40000);
  assert.equal(await spentPaise(db, null, thisMonth, null), 0);
});

await test('changing an expense into income removes its split', async (db) => {
  const { t } = await guestScenario(db);
  const r = await updateTransactionDetailsDetailed(t.id, { direction: 'income' }, null);
  assert.equal(r.splitPlan.kind, 'remove');
  assert.equal(await hasSplit(t.id), false);
});

await test('tiny amounts: an equal re-split reports who gets zero, and keeps them in the split for later', async (db) => {
  const t = await addTransaction({ amount: 3, direction: 'expense', counterparty: 'Chai', category: 'Food & Dining' } as never, null);
  const a = await createContact(db, null, { name: 'Asha' }); const b = await createContact(db, null, { name: 'Bala' });
  await createSplitExpense(db, null, input({ transactionId: t.id, totalPaise: 300, participants: [{ party: SELF }, { party: a.id }, { party: b.id }], payers: [{ party: SELF, paidPaise: 300 }] }));
  const down = await updateTransactionDetailsDetailed(t.id, { amount: 0.02 }, null);
  assert.equal(down.splitPlan.kind, 'resplit');
  if (down.splitPlan.kind === 'resplit') assert.equal(down.splitPlan.zeroShare.length, 1, 'one person rounds to Rs 0.00');
  let s = (await getSplitForTransaction(db, null, t.id))!;
  assert.deepEqual(s.rows.map((r) => r.sharePaise).sort(), [0, 1, 1]);
  await updateTransactionDetailsDetailed(t.id, { amount: 9 }, null);
  s = (await getSplitForTransaction(db, null, t.id))!;
  assert.deepEqual(s.rows.map((r) => r.sharePaise), [300, 300, 300], 'everyone is back in the split');
});

await test('editing a transaction without a split is unchanged and costs nothing', async (db) => {
  const t = await addTransaction({ amount: 100, direction: 'expense', counterparty: 'Shop', category: 'Groceries' } as never, null);
  const r = await updateTransactionDetailsDetailed(t.id, { amount: 250 }, null);
  assert.equal(r.splitPlan.kind, 'none'); assert.equal(r.transaction.amount_paise, 25000);
});

console.log(`${passed} passed`);
