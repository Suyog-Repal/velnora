/** Income/expense classification through every local layer, and the Home cash-flow summary derived from it. */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { addTransaction, deleteTransaction, setTransactionServiceAdapter, updateTransactionDetails } from '../transactionService.ts';
import { toUpdateInput } from '../transactionDetails.ts';
import { getCashFlowSummary, summarize } from '../cashFlowService.ts';
import type { Direction, IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  // No network in tests: make any background sync attempt fail fast and harmlessly.
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  return db as unknown as IDatabase;
}
const add = (direction: Direction, amount: number, s: Session | null = null, over: Record<string, unknown> = {}) =>
  addTransaction({ amount, direction, counterparty: 'Grocery Store', category: direction === 'income' ? 'Salary' : 'Food & Dining', ...over } as never, s);
const stored = async (db: IDatabase, id: string) => (await new TransactionRepository(db).getById(id))!;
const lastQueued = async (db: IDatabase, id: string) => {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM sync_queue WHERE entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', id);
  return JSON.parse(row!.payload) as { direction: Direction; amount: number };
};

async function emptyHistory() {
  const db = await fresh();
  const s = await getCashFlowSummary(db, null);
  assert.deepEqual(s, { monthIncomePaise: 0, monthExpensePaise: 0, netPaise: 0, balancePaise: 0, expenseRatioPercent: null, monthRefundPaise: 0 }, 'empty history is all zero, no ratio');
}

async function expenseStaysExpense() {
  const db = await fresh();
  const tx = await add('expense', 500);
  assert.equal(tx.direction, 'expense');
  assert.equal((await stored(db, tx.id)).direction, 'expense', 'persisted as expense in SQLite');
  assert.equal((await lastQueued(db, tx.id)).direction, 'expense', 'sync payload carries expense');
  const s = await getCashFlowSummary(db, null);
  assert.equal(s.monthExpensePaise, 50000); assert.equal(s.monthIncomePaise, 0);
  assert.equal(s.balancePaise, -50000); assert.equal(s.netPaise, -50000);
  assert.equal(s.expenseRatioPercent, null, 'no income: ratio is not shown as 0%');
}

async function incomeStaysIncome() {
  const db = await fresh();
  await add('expense', 500);
  const tx = await add('income', 2000);
  assert.equal((await stored(db, tx.id)).direction, 'income');
  const s = await getCashFlowSummary(db, null);
  assert.equal(s.monthIncomePaise, 200000); assert.equal(s.monthExpensePaise, 50000);
  assert.equal(s.netPaise, 150000); assert.equal(s.balancePaise, 150000);
  assert.equal(s.expenseRatioPercent, 25);
}

async function editAmountAndType() {
  const db = await fresh();
  await add('income', 10000);
  const exp = await add('expense', 3500);
  let s = await getCashFlowSummary(db, null);
  assert.equal(s.netPaise, 650000, '10,000 - 3,500 = 6,500');

  await updateTransactionDetails(exp.id, { amount: 4000 }, null);
  assert.equal((await stored(db, exp.id)).direction, 'expense', 'editing the amount keeps the type');
  s = await getCashFlowSummary(db, null);
  assert.equal(s.monthExpensePaise, 400000); assert.equal(s.netPaise, 600000);

  await updateTransactionDetails(exp.id, { direction: 'income', category: 'Other Income' }, null);
  const flipped = await stored(db, exp.id);
  assert.equal(flipped.direction, 'income'); assert.equal(flipped.amount_paise, 400000); assert.equal(flipped.category, 'Other Income');
  assert.equal((await lastQueued(db, exp.id)).direction, 'income', 'type change is queued for sync');
  s = await getCashFlowSummary(db, null);
  assert.equal(s.monthExpensePaise, 0); assert.equal(s.monthIncomePaise, 1400000); assert.equal(s.balancePaise, 1400000);

  await updateTransactionDetails(exp.id, { direction: 'expense' }, null);
  s = await getCashFlowSummary(db, null);
  assert.equal(s.monthExpensePaise, 400000); assert.equal(s.monthIncomePaise, 1000000);

  assert.throws(() => toUpdateInput({ direction: 'refund' as never }), /income or expense/);
  assert.equal(toUpdateInput({ amount: 5 }).direction, undefined, 'a patch without a type never changes the type');
}

async function deleteMonthAndScope() {
  const db = await fresh();
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).toISOString();
  await add('income', 1000, null, { transaction_date: lastMonth });
  await add('expense', 300, null, { transaction_date: lastMonth });
  const doomed = await add('expense', 200);
  await add('expense', 50);
  await add('income', 999, A); // another scope: must not leak into guest totals

  let s = await getCashFlowSummary(db, null);
  assert.equal(s.monthIncomePaise, 0, 'last month income excluded from this month');
  assert.equal(s.monthExpensePaise, 25000);
  assert.equal(s.balancePaise, 100000 - 30000 - 25000, 'balance is all-time');

  await deleteTransaction(doomed.id, null);
  s = await getCashFlowSummary(db, null);
  assert.equal(s.monthExpensePaise, 5000, 'deleted transaction no longer counted');

  const a = await getCashFlowSummary(db, A.user.id);
  assert.equal(a.monthIncomePaise, 99900); assert.equal(a.monthExpensePaise, 0);

  // Month boundary uses the transaction date: an expense dated "next month" is not in this month.
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 1).toISOString();
  await add('expense', 70, null, { transaction_date: nextMonth });
  assert.equal((await getCashFlowSummary(db, null)).monthExpensePaise, 5000);
}

function ratios() {
  assert.equal(summarize(100000, 135000, 0).netPaise, -35000, 'negative net when expenses exceed income');
  assert.equal(summarize(100000, 135000, 0).expenseRatioPercent, 135);
  assert.equal(summarize(0, 0, 0).expenseRatioPercent, null);
}

await emptyHistory();
await expenseStaysExpense();
await incomeStaysIncome();
await editAmountAndType();
await deleteMonthAndScope();
ratios();
console.log('cash flow tests passed');
