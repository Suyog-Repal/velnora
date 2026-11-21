/** Transactions date calendar: day marks (dots), month list, single-day vs range selection, summary and label. */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { addTransaction, deleteTransaction, setTransactionServiceAdapter } from '../transactionService.ts';
import {
  EMPTY_SELECTION, foldBuckets, formatSelection, isSingleDay, loadDayBuckets, monthsBack, oldestDay, selectDate, summarizeSelection,
  type BucketRow,
} from '../calendarMarks.ts';
import { inDateRange, localYmd } from '../dateUtils.ts';
import type { Direction, IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };
const TODAY = '2026-11-21';
const ORIGINAL_TZ = process.env.TZ;

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  return db as unknown as IDatabase;
}
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const add = (direction: Direction, amount: number, transaction_date: string, s: Session | null = null) =>
  addTransaction({ amount, direction, counterparty: `Shop ${Math.random().toString(36).slice(2, 6)}`, category: direction === 'income' ? 'Salary' : 'Food & Dining', transaction_date } as never, s);
const row = (iso: string, direction: string, n = 1, paise = 100): BucketRow => ({ bucket: iso.slice(0, 16), direction, n, paise });

// 1. Folding: dots per local day, expense-only / income-only / both / none.
{
  const marks = foldBuckets([
    row(at(2026, 11, 8, 10, 0), 'expense', 2, 5000),
    row(at(2026, 11, 9, 10, 0), 'income', 1, 7000),
    row(at(2026, 11, 10, 9, 0), 'expense', 1, 100), row(at(2026, 11, 10, 18, 0), 'income', 1, 900),
    { bucket: null, direction: 'expense', n: 3, paise: 1 }, { bucket: 'garbage', direction: 'expense', n: 3, paise: 1 },
  ]);
  const d8 = marks.get('2026-11-08')!; assert.equal(d8.expenseCount, 2); assert.equal(d8.incomeCount, 0);
  const d9 = marks.get('2026-11-09')!; assert.equal(d9.expenseCount, 0); assert.equal(d9.incomeCount, 1);
  const d10 = marks.get('2026-11-10')!; assert.ok(d10.expenseCount > 0 && d10.incomeCount > 0);
  assert.equal(marks.has('2026-11-11'), false); assert.equal(marks.size, 3);
  assert.equal(oldestDay(marks), '2026-11-08'); assert.equal(oldestDay(new Map()), null);
}

// 2. Local day is used consistently: the same UTC instants land on different local days in different timezones,
//    and the bucket fold always agrees with the list filter (inDateRange).
{
  const instants = ['2026-11-20T18:29:00.000Z', '2026-11-20T18:30:00.000Z', '2026-11-20T23:59:00.000Z', '2026-11-21T00:00:00.000Z', '2026-11-21T10:15:00.000Z'];
  for (const tz of ['Asia/Kolkata', 'America/Los_Angeles', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'UTC']) {
    process.env.TZ = tz;
    const marks = foldBuckets(instants.map((i) => row(i, 'expense')));
    for (const [day, m] of marks) {
      const expected = instants.filter((i) => inDateRange(i, day, day)).length;
      assert.equal(m.expenseCount, expected, `${tz} ${day}`);
    }
    assert.equal([...marks.values()].reduce((s, m) => s + m.expenseCount, 0), instants.length, tz);
  }
  process.env.TZ = 'Asia/Kolkata';
  const ist = foldBuckets([row('2026-11-20T18:29:00.000Z', 'expense'), row('2026-11-20T18:30:00.000Z', 'expense')]);
  assert.equal(ist.get('2026-11-20')!.expenseCount, 1); // 23:59 IST
  assert.equal(ist.get('2026-11-21')!.expenseCount, 1); // 00:00 IST, the next local day
  process.env.TZ = ORIGINAL_TZ;
}

// 3. Month list: current month back to the oldest month; a first-day user sees just this month; years roll over.
{
  assert.deepEqual(monthsBack(TODAY, null), [{ year: 2026, month0: 10 }]);
  assert.deepEqual(monthsBack(TODAY, TODAY), [{ year: 2026, month0: 10 }]);
  assert.deepEqual(monthsBack(TODAY, '2026-09-30').map((m) => m.month0), [10, 9, 8]);
  const long = monthsBack('2026-02-10', '2025-11-01');
  assert.deepEqual(long.map((m) => `${m.year}-${m.month0}`), ['2026-1', '2026-0', '2025-11', '2025-10']);
  assert.deepEqual(monthsBack(TODAY, '2026-11-02').length, 1);
  assert.equal(monthsBack(TODAY, '2026-10-01', '2026-06-15').length, 6); // selection older than the oldest transaction stays reachable
  assert.deepEqual(monthsBack(TODAY, '2027-03-01').length, 1); // a future-dated oldest never extends past the current month
  assert.deepEqual(monthsBack('garbage', null), []);
}

// 4. Selection: single day, then range (earlier first), then start over; future and invalid days are ignored.
{
  let s = selectDate(EMPTY_SELECTION, '2026-11-10', TODAY);
  assert.deepEqual(s, { from: '2026-11-10', to: '2026-11-10' }); assert.equal(isSingleDay(s), true);
  const second = selectDate(s, '2026-11-21', TODAY);
  assert.deepEqual(second, { from: '2026-11-10', to: '2026-11-21' }); assert.equal(isSingleDay(second), false);
  assert.deepEqual(selectDate(s, '2026-11-02', TODAY), { from: '2026-11-02', to: '2026-11-10' }); // earlier second tap: reordered
  assert.deepEqual(selectDate(s, '2026-11-10', TODAY), s);                                          // same day twice: still that day
  assert.deepEqual(selectDate(second, '2026-11-15', TODAY), { from: '2026-11-15', to: '2026-11-15' }); // third tap restarts
  assert.deepEqual(selectDate(s, '2026-11-22', TODAY), s);                                          // future ignored
  assert.deepEqual(selectDate(EMPTY_SELECTION, '2026-11-22', TODAY), EMPTY_SELECTION);
  assert.deepEqual(selectDate(s, '2026-02-31', TODAY), s);                                          // impossible date ignored
  assert.deepEqual(selectDate(selectDate(EMPTY_SELECTION, TODAY, TODAY), '2025-12-31', TODAY), { from: '2025-12-31', to: TODAY }); // across years
}

// 5. Summary and label.
{
  const marks = foldBuckets([
    row(at(2026, 11, 8, 10), 'expense', 2, 5000), row(at(2026, 11, 9, 10), 'income', 1, 7000), row(at(2026, 11, 12, 10), 'expense', 1, 300),
  ]);
  assert.deepEqual(summarizeSelection(marks, { from: '2026-11-08', to: '2026-11-08' }), { count: 2, spentPaise: 5000, receivedPaise: 0 });
  assert.deepEqual(summarizeSelection(marks, { from: '2026-11-08', to: '2026-11-12' }), { count: 4, spentPaise: 5300, receivedPaise: 7000 });
  assert.deepEqual(summarizeSelection(marks, { from: '2026-11-13', to: '2026-11-20' }), { count: 0, spentPaise: 0, receivedPaise: 0 });
  assert.deepEqual(summarizeSelection(marks, EMPTY_SELECTION), { count: 0, spentPaise: 0, receivedPaise: 0 });

  assert.equal(formatSelection({ from: '2026-11-21', to: '2026-11-21' }, TODAY), '21 Nov 2026');
  assert.equal(formatSelection({ from: '2026-11-10', to: '2026-11-21' }, TODAY), '10 Nov to 21 Nov');
  assert.equal(formatSelection({ from: '2025-12-30', to: '2026-01-02' }, TODAY), '30 Dec 2025 to 02 Jan 2026');
  assert.equal(formatSelection({ from: '2025-03-01', to: '2025-03-05' }, TODAY), '01 Mar 2025 to 05 Mar 2025');
  assert.equal(formatSelection({ from: null, to: null }, TODAY), 'All dates');
}

// 6. The grouped SQL query: scope, soft deletes, midnight boundaries, offline; agrees with the list filter.
{
  const db = await fresh();
  await add('expense', 50, at(2026, 11, 8, 0, 0));
  await add('expense', 25.5, at(2026, 11, 8, 23, 59));
  await add('income', 1000, at(2026, 11, 9, 0, 0));
  const gone = await add('expense', 999, at(2026, 11, 3));
  await deleteTransaction(gone.id, null);
  await add('expense', 11, at(2026, 11, 8), A);              // other scope
  await add('income', 40, at(2025, 12, 31, 23, 59));          // previous year, same query
  await add('expense', 70, at(2026, 11, 1, 12), null);

  const marks = foldBuckets(await loadDayBuckets(db, null));
  assert.equal(marks.get('2026-11-08')!.expenseCount, 2); assert.equal(marks.get('2026-11-08')!.expensePaise, 7550);
  assert.equal(marks.get('2026-11-08')!.incomeCount, 0);
  assert.equal(marks.get('2026-11-09')!.incomeCount, 1); assert.equal(marks.get('2026-11-09')!.expenseCount, 0);
  assert.equal(marks.has('2026-11-03'), false, 'soft-deleted row leaves no dot');
  assert.equal(marks.get('2025-12-31')!.incomeCount, 1);
  assert.equal(oldestDay(marks), '2025-12-31');
  assert.equal(summarizeSelection(marks, { from: '2026-11-08', to: '2026-11-09' }).count, 3);

  const acct = foldBuckets(await loadDayBuckets(db, 'user-A'));
  assert.equal(acct.size, 1); assert.equal(acct.get('2026-11-08')!.expenseCount, 1); // only the account's own row

  // Same answers under another timezone with the same stored rows (no restart needed).
  process.env.TZ = 'Pacific/Kiritimati';
  const shifted = foldBuckets(await loadDayBuckets(db, null));
  const all = (await db.getAllAsync<{ transaction_date: string; direction: string }>('SELECT transaction_date, direction FROM transactions WHERE deleted_at IS NULL AND user_id IS NULL'));
  for (const [day, m] of shifted) {
    assert.equal(m.expenseCount + m.incomeCount, all.filter((t) => inDateRange(t.transaction_date, day, day)).length, `kiritimati ${day}`);
  }
  assert.equal([...shifted.values()].reduce((s, m) => s + m.expenseCount + m.incomeCount, 0), all.length);
  process.env.TZ = ORIGINAL_TZ;

  // Empty scope: no marks, no history.
  const none = foldBuckets(await loadDayBuckets(db, 'nobody'));
  assert.equal(none.size, 0); assert.deepEqual(monthsBack(localYmd(), oldestDay(none)).length, 1);
}

console.log('calendarMarks tests passed');
