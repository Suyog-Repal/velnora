/**
 * Two views of spending, each consistent with itself:
 *   own share (v_spend): Analytics, Budgets, daily/monthly series, monthly report: a split bill counts only my part;
 *   cash (transactions): Home income/expenses/Today, Profile, recorded balance: the full amount that left the account.
 * Settlements must never move any of them.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import type { IDatabase } from '../../db/types.ts';
import { categoryBreakdown } from '../analyticsService.ts';
import { currentMonth, getBudgetProgress, monthRange, saveBudget, spentPaise } from '../budgetService.ts';
import { getCashFlowSummary, getLedgerHealth, profileCashFigures } from '../cashFlowService.ts';
import { loadPoints, buildDaily } from '../cashFlowSeries.ts';
import { buildMonthlyReport, listReportMonths, verifyReport } from '../monthlyReportService.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SELF } from '../splitMath.ts';
import { createContact, createSplitExpense, deleteSplitExpense, recordSettlement } from '../splitService.ts';

let seq = 0;
async function tx(db: IDatabase, paise: number, category: string, date: Date, direction: 'income' | 'expense' = 'expense') {
  const id = `t${++seq}`; const iso = date.toISOString();
  await db.runAsync(
    `INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, description, transaction_date, source, sync_status, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, 'Shop', ?, '', ?, 'manual', 'synced', ?, ?)`, id, paise / 100, paise, direction, category, iso, iso, iso);
  return id;
}

const db = (() => new NodeSqliteAdapter() as unknown as IDatabase)();
await runMigrations(db);
// The clock is injected, so "today" and "this month" do not depend on when the test runs.
const now = new Date(2026, 5, 15, 18, 0, 0); const month = currentMonth(now);
const day = new Date(2026, 5, 15, 12, 0, 0);
const a = await createContact(db, null, { name: 'Asha' }); const b = await createContact(db, null, { name: 'Bala' });

await tx(db, 500000, 'Salary', day, 'income');           // income Rs 5000
const dinner = await tx(db, 120000, 'Food & Dining', day); // Rs 1200 paid by me, split 3 ways -> my share 400
await tx(db, 30000, 'Groceries', day);                    // Rs 300 unsplit
await saveBudget(db, null, { category: 'Food & Dining', amountPaise: 100000 });
await saveBudget(db, null, { category: 'Travel', amountPaise: 100000 });
const split = (over: object) => ({ title: 'x', category: 'Food & Dining', expenseDate: day.toISOString(), mode: 'equal' as const, ...over });

const before = {
  cash: await getCashFlowSummary(db, null, now), spent: await spentPaise(db, null, month, null),
};
assert.equal(before.spent, 150000); assert.equal(before.cash.monthExpensePaise, 150000);

await createSplitExpense(db, null, split({ transactionId: dinner, totalPaise: 120000, participants: [{ party: SELF }, { party: a.id }, { party: b.id }], payers: [{ party: SELF, paidPaise: 120000 }] }));
// a friend paid for a Travel booking, my share Rs 250, no bank transaction
await createSplitExpense(db, null, split({ category: 'Travel', totalPaise: 50000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: a.id, paidPaise: 50000 }] }));

const EXPECT_SPEND = 40000 + 30000 + 25000; // dinner share + groceries + travel share
assert.equal(await spentPaise(db, null, month, null), EXPECT_SPEND, 'budget spend overall');
assert.equal(await spentPaise(db, null, month, 'Food & Dining'), 40000);
assert.equal(await spentPaise(db, null, month, 'Travel'), 25000, 'friend-paid expense counts in its own category');
const progress = await getBudgetProgress(db, null, month);
assert.equal(progress.find((p) => p.budget.category === 'Travel')!.spentPaise, 25000, 'and in that category budget');

const breakdown = await categoryBreakdown(db, null, monthRange(month));
assert.equal(breakdown.totalPaise, EXPECT_SPEND);
assert.deepEqual(Object.fromEntries(breakdown.slices.map((s) => [s.category, s.totalPaise])), { 'Food & Dining': 40000, Groceries: 30000, Travel: 25000 });

const CASH_SPEND = 120000 + 30000; // the full Rs 1200 dinner and the Rs 300 groceries left the account; the friend-paid trip never did
const cash = await getCashFlowSummary(db, null, now);
assert.equal(cash.monthExpensePaise, CASH_SPEND, 'Home monthly expenses = money that actually left the account');
assert.equal(cash.monthIncomePaise, 500000);
assert.equal(cash.balancePaise, 500000 - 120000 - 30000, 'cash balance is money that actually left the bank: the full Rs 1200, not the share');
const health = await getLedgerHealth(db, null, now);
assert.equal(health.todayExpensePaise, CASH_SPEND, 'Home Today Out is cash too: the full bill, not my share');
assert.equal((await getLedgerHealth(db, null, new Date(2026, 5, 16, 9, 0, 0))).todayExpensePaise, 0, 'and only that day counts as today');
assert.deepEqual(profileCashFigures(cash, health), { spentPaise: CASH_SPEND, transactionCount: 3 }, 'Profile shows Home\'s spending and the transaction total');
assert.ok(cash.monthExpensePaise > EXPECT_SPEND, 'cash is larger than my share while friends owe me');
assert.equal(cash.monthExpensePaise - EXPECT_SPEND, 120000 - 40000 - 25000, 'the gap is what friends owe back, less the trip share a friend paid');

const points = await loadPoints(db, null, month, month);
const daily = buildDaily(points, month);
assert.equal(daily.reduce((s, d) => s + d.expensePaise, 0), EXPECT_SPEND, 'daily bars agree');

const report = await buildMonthlyReport(db, null, month, now);
assert.equal(report.summary.expensePaise, EXPECT_SPEND, 'monthly report agrees');
assert.deepEqual(verifyReport(report), [], 'report is internally consistent');
assert.ok((await listReportMonths(db, null)).includes(month));

// every screen shows the same number
assert.equal(breakdown.totalPaise, EXPECT_SPEND); assert.equal(EXPECT_SPEND, report.summary.expensePaise);
assert.equal(report.summary.expensePaise, await spentPaise(db, null, month, null));

// settlements move nobody's spending
await recordSettlement(db, null, { from: a.id, to: SELF, amountPaise: 20000 });
await recordSettlement(db, null, { from: SELF, to: a.id, amountPaise: 5000 });
assert.equal(await spentPaise(db, null, month, null), EXPECT_SPEND);
assert.equal((await getCashFlowSummary(db, null, now)).monthExpensePaise, CASH_SPEND);
assert.equal((await buildMonthlyReport(db, null, month, now)).summary.expensePaise, EXPECT_SPEND);
assert.equal((await getCashFlowSummary(db, null, now)).balancePaise, cash.balancePaise, 'settlements are not income or expense');

// a split whose share is zero (I only paid for others) contributes nothing, and is not a stray zero row in the report
await createSplitExpense(db, null, split({ category: 'Shopping', totalPaise: 10000, participants: [{ party: b.id }], payers: [{ party: SELF, paidPaise: 10000 }] }));
const zeroTx = await tx(db, 10000, 'Shopping', day);
const rowsWithFullTx = (await buildMonthlyReport(db, null, month, now)).transactions.length; // the unsplit Rs 100 row is listed
await createSplitExpense(db, null, split({ transactionId: zeroTx, category: 'Shopping', totalPaise: 10000, participants: [{ party: b.id }], payers: [{ party: SELF, paidPaise: 10000 }] }));
assert.equal((await buildMonthlyReport(db, null, month, now)).transactions.length, rowsWithFullTx - 1, 'once split with a zero share it is no longer listed as my spending');
assert.equal(await spentPaise(db, null, month, 'Shopping'), 0);

// unsplitting restores the full bank amount everywhere
const e = (await db.getFirstAsync<{ id: string }>(`SELECT id FROM split_expenses WHERE transaction_id = ?`, dinner))!;
await deleteSplitExpense(db, null, e.id);
assert.equal(await spentPaise(db, null, month, 'Food & Dining'), 120000);

// More rows than one load returns (getAll stops at 500): Profile's figure and count still equal Home's and the true values.
{
  const big = (() => new NodeSqliteAdapter() as unknown as IDatabase)();
  await runMigrations(big);
  const friend = await createContact(big, null, { name: 'Asha' });
  const MANY = 620;
  for (let i = 0; i < MANY; i += 1) await tx(big, 1000, 'Groceries', new Date(2026, 5, 1 + (i % 15), 12, 0, 0));
  const bill = await tx(big, 90000, 'Food & Dining', day);
  await createSplitExpense(big, null, split({ transactionId: bill, totalPaise: 90000, participants: [{ party: SELF }, { party: friend.id }], payers: [{ party: SELF, paidPaise: 90000 }] }));
  await tx(big, 7000, 'Groceries', new Date(2026, 4, 20, 12, 0, 0)); // last month: counted as a transaction, not as this month's spending
  const gone = await tx(big, 5000, 'Groceries', day);
  await big.runAsync('UPDATE transactions SET deleted_at = ? WHERE id = ?', now.toISOString(), gone);
  const theirs = await tx(big, 4000, 'Groceries', day);
  await big.runAsync(`UPDATE transactions SET user_id = 'someone-else' WHERE id = ?`, theirs);

  const TRUE_COUNT = MANY + 2; // the split bill and last month's row; not the deleted one or the other account's
  const TRUE_SPEND = MANY * 1000 + 90000;
  assert.equal((await new TransactionRepository(big).getAll({ userId: null })).length, 500, 'the cap really is in play');
  const home = await getCashFlowSummary(big, null, now);
  const homeHealth = await getLedgerHealth(big, null, now);
  const profile = profileCashFigures(home, homeHealth);
  assert.equal(home.monthExpensePaise, TRUE_SPEND);
  assert.equal(profile.spentPaise, home.monthExpensePaise, 'Profile spending equals Home');
  assert.equal(profile.transactionCount, homeHealth.totalCount, 'Profile count equals Home');
  assert.equal(profile.transactionCount, TRUE_COUNT);
  assert.equal(await spentPaise(big, null, month, null), TRUE_SPEND - 45000, 'budgets still count only my share of the split');
}

console.log('split spending tests passed');
