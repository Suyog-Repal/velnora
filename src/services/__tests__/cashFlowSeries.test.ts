/** Spending Overview series: daily / weekly / monthly aggregation agrees with the existing cash-flow summary. */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { addTransaction, deleteTransaction, setTransactionServiceAdapter } from '../transactionService.ts';
import { getCashFlowSummary } from '../cashFlowService.ts';
import { buildDaily, buildMonthly, buildWeekly, daysInMonth, hasActivity, loadPoints, niceScale, shiftMonth, totalsOf } from '../cashFlowSeries.ts';
import type { Direction, IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  return db as unknown as IDatabase;
}
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const add = (direction: Direction, amount: number, transaction_date: string, s: Session | null = null) =>
  addTransaction({ amount, direction, counterparty: `Shop ${Math.random().toString(36).slice(2, 6)}`, category: direction === 'income' ? 'Salary' : 'Food & Dining', transaction_date } as never, s);

// 1. Month lengths and zero fill.
{
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(daysInMonth('2026-04'), 30);
  assert.equal(daysInMonth('2026-01'), 31);
  for (const [m, n] of [['2026-02', 28], ['2024-02', 29], ['2026-04', 30], ['2026-01', 31]] as const) {
    const d = buildDaily([], m);
    assert.equal(d.length, n); assert.ok(d.every((b) => b.incomePaise === 0 && b.expensePaise === 0 && b.netPaise === 0));
    assert.equal(hasActivity(d), false);
  }
  assert.equal(shiftMonth('2026-01', -1), '2025-12'); assert.equal(shiftMonth('2026-12', 1), '2027-01');
}

// 2. Day boundaries are local: 00:00 and 23:59 land on their own day.
{
  const pts = [
    { date: at(2026, 11, 8, 0, 0), direction: 'expense', paise: 1000 },
    { date: at(2026, 11, 8, 23, 59), direction: 'expense', paise: 500 },
    { date: at(2026, 11, 9, 0, 0), direction: 'income', paise: 7000 },
    { date: at(2026, 10, 31, 23, 59), direction: 'expense', paise: 99 }, // other month: ignored
  ];
  const d = buildDaily(pts, '2026-11');
  assert.equal(d[7].expensePaise, 1500); assert.equal(d[7].netPaise, -1500);
  assert.equal(d[8].incomePaise, 7000); assert.equal(d[8].netPaise, 7000);
  assert.equal(totalsOf(d).expensePaise, 1500);
}

// 3. Daily agrees with getCashFlowSummary on real stored rows; deleted rows, other scopes and other months are excluded.
{
  const db = await fresh();
  await add('expense', 50, at(2026, 11, 8));
  await add('expense', 258, at(2026, 11, 7));
  const gone = await add('expense', 999, at(2026, 11, 3));
  await deleteTransaction(gone.id, null);
  await add('income', 1200.5, at(2026, 11, 1));
  await add('expense', 77, at(2026, 10, 30));          // previous month
  await add('expense', 11, at(2026, 11, 8), A);         // other scope
  const pts = await loadPoints(db, null, '2026-11', '2026-11');
  const daily = buildDaily(pts, '2026-11');
  const flow = await getCashFlowSummary(db, null, new Date(2026, 10, 15));
  const t = totalsOf(daily);
  assert.equal(t.incomePaise, flow.monthIncomePaise); assert.equal(t.expensePaise, flow.monthExpensePaise); assert.equal(t.netPaise, flow.netPaise);
  assert.equal(t.expensePaise, 30800); assert.equal(t.incomePaise, 120050);
  assert.equal(daily[7].expensePaise, 5000); assert.equal(daily[6].expensePaise, 25800); assert.equal(daily[0].incomePaise, 120050);

  // 4. Weekly (Mon–Sun, clipped to the month): Nov 2026 starts on a Sunday.
  const weekly = buildWeekly(pts, '2026-11');
  assert.deepEqual(weekly.map((w) => w.label), ['1', '2–8', '9–15', '16–22', '23–29', '30']);
  assert.equal(weekly.reduce((s, w) => s + w.expensePaise, 0), t.expensePaise);
  assert.equal(weekly.reduce((s, w) => s + w.incomePaise, 0), t.incomePaise);
  assert.equal(weekly[0].incomePaise, 120050); assert.equal(weekly[1].expensePaise, 30800);

  // 5. Monthly: leading empty months are dropped, October is a real (non-zero) bucket, selected month is last.
  const mpts = await loadPoints(db, null, shiftMonth('2026-11', -5), '2026-11');
  const monthly = buildMonthly(mpts, '2026-11');
  assert.deepEqual(monthly.map((b) => b.key), ['2026-10', '2026-11']);
  assert.equal(monthly[0].expensePaise, 7700); assert.equal(monthly[1].expensePaise, 30800);
  // Scope isolation.
  const a = await loadPoints(db, A.user.id, '2026-11', '2026-11');
  assert.equal(totalsOf(buildDaily(a, '2026-11')).expensePaise, 1100);

  // 6. Chart data follows add / delete after the fact.
  const extra = await add('income', 10, at(2026, 11, 8));
  let again = buildDaily(await loadPoints(db, null, '2026-11', '2026-11'), '2026-11');
  assert.equal(again[7].incomePaise, 1000);
  await deleteTransaction(extra.id, null);
  again = buildDaily(await loadPoints(db, null, '2026-11', '2026-11'), '2026-11');
  assert.equal(again[7].incomePaise, 0);
}

// 7. Empty month and empty history.
{
  const db = await fresh();
  const pts = await loadPoints(db, null, '2026-11', '2026-11');
  assert.equal(hasActivity(buildDaily(pts, '2026-11')), false);
  const m = buildMonthly(pts, '2026-11');
  assert.equal(m.length, 1); assert.equal(m[0].key, '2026-11'); // selected month is always present
}

// 8. Weekly always partitions every day exactly once, for every month length.
for (const month of ['2026-02', '2024-02', '2026-04', '2026-01', '2026-11']) {
  const w = buildWeekly([], month);
  assert.equal(w[0].from.d, 1); assert.equal(w[w.length - 1].to.d, daysInMonth(month));
  for (let i = 1; i < w.length; i += 1) assert.equal(w[i].from.d, w[i - 1].to.d + 1);
}

// 9. Axis scale covers the largest value and starts at zero.
for (const v of [1, 99, 500, 12345, 1_000_000, 987_654_321]) {
  const s = niceScale(v, 3);
  assert.ok(s.max >= v, `${v}`); assert.equal(s.ticks[0], 0); assert.equal(s.ticks.length, 4);
}
assert.deepEqual(niceScale(0).ticks, [0]);

console.log('cashFlowSeries tests passed');
