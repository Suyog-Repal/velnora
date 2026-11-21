import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { MONTH_SHORT, formatDisplayDate, localYmd, parseYmd, type Ymd } from './dateUtils.ts';
import { SQL_COUNTS_AS_EXPENSE, SQL_COUNTS_AS_INCOME } from './ledgerRules.ts';

/**
 * Data and selection rules behind the Transactions date calendar. Everything that decides a result is a pure
 * function (folding, month list, tap handling, summary, label) so it is unit-tested without a device.
 *
 * Local dates: stored timestamps are UTC ISO instants. The database query groups them into 15-minute UTC buckets
 * (timezone-independent, so the cached rows stay valid when the device timezone changes), and `foldBuckets` converts
 * each bucket to the device's local calendar day with the same JS `Date` logic the list filter (`inDateRange`) uses.
 * Fifteen minutes is the finest real UTC offset granularity (e.g. +05:45), so a bucket never straddles local midnight.
 */

export interface BucketRow { bucket: string | null; direction: string; n: number; paise: number }

/** What happened on one local day. Counts drive the dots; `*Paise` use the ledger rules (same as Home and Analytics). */
export interface DayMark { expenseCount: number; incomeCount: number; expensePaise: number; incomePaise: number }
export type DayMarks = Map<Ymd, DayMark>;

const PAISE = 'COALESCE(amount_paise, CAST(ROUND(amount * 100) AS INTEGER))';
// 'YYYY-MM-DDTHH:' + minute rounded down to a quarter hour, e.g. 2026-11-21T18:30
const BUCKET = `strftime('%Y-%m-%dT%H:', transaction_date) || printf('%02d', (CAST(strftime('%M', transaction_date) AS INTEGER) / 15) * 15)`;

/**
 * One grouped query: every non-deleted income/expense row of the scope (signed-in user, or guest when scope is null),
 * grouped by direction and UTC quarter hour. Rows are bounded by the number of distinct active quarter hours, so it
 * stays small and fast on a large ledger, and it reads only local SQLite (works offline).
 */
export async function loadDayBuckets(db: IDatabase, scope: Scope): Promise<BucketRow[]> {
  const rows = await db.getAllAsync<{ bucket: string | null; direction: string; n: number; paise: number | null }>(
    `SELECT ${BUCKET} AS bucket, direction, COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN ${SQL_COUNTS_AS_EXPENSE} OR ${SQL_COUNTS_AS_INCOME} THEN ${PAISE} ELSE 0 END), 0) AS paise
       FROM transactions
      WHERE deleted_at IS NULL AND direction IN ('income', 'expense')
        AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
      GROUP BY bucket, direction`,
    scope, scope,
  );
  return rows.map((r) => ({ bucket: r.bucket, direction: r.direction, n: Number(r.n), paise: Number(r.paise ?? 0) }));
}

const BUCKET_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/; // Date.parse is lenient about junk, so check the shape first

/** Folds UTC quarter-hour buckets into per-local-day marks. Unparseable buckets are skipped. */
export function foldBuckets(rows: BucketRow[]): DayMarks {
  const marks: DayMarks = new Map();
  for (const r of rows) {
    if (!r.bucket || !BUCKET_FORMAT.test(r.bucket)) continue;
    const at = new Date(`${r.bucket}:00Z`);
    if (Number.isNaN(at.getTime())) continue;
    const day = localYmd(at);
    const m = marks.get(day) ?? { expenseCount: 0, incomeCount: 0, expensePaise: 0, incomePaise: 0 };
    if (r.direction === 'expense') { m.expenseCount += r.n; m.expensePaise += r.paise; }
    else if (r.direction === 'income') { m.incomeCount += r.n; m.incomePaise += r.paise; }
    marks.set(day, m);
  }
  return marks;
}

/** Earliest local day with any transaction, or null when there are none. */
export function oldestDay(marks: DayMarks): Ymd | null {
  let min: Ymd | null = null;
  for (const day of marks.keys()) if (min === null || day < min) min = day;
  return min;
}

export interface MonthRef { year: number; month0: number }

/**
 * Months to list, newest first: the month of `today` back to the month of `oldest` (or `today` when there is no
 * history yet, e.g. on a first day of use). `extendTo` keeps an older already-selected date reachable.
 */
export function monthsBack(today: Ymd, oldest: Ymd | null, extendTo?: Ymd | null): MonthRef[] {
  const t = parseYmd(today);
  if (!t) return [];
  const candidates = [oldest, extendTo].map((v) => parseYmd(v)).filter((p): p is NonNullable<typeof p> => !!p);
  const index = (p: { year: number; month0: number }) => p.year * 12 + p.month0;
  const last = Math.min(index(t), ...candidates.map(index));
  const out: MonthRef[] = [];
  for (let i = index(t); i >= last; i -= 1) out.push({ year: Math.floor(i / 12), month0: i % 12 });
  return out;
}

export interface DateSelection { from: Ymd | null; to: Ymd | null }
export const EMPTY_SELECTION: DateSelection = { from: null, to: null };
export const isSingleDay = (s: DateSelection): boolean => !!s.from && s.from === s.to;

/**
 * Tap handling. First tap = that exact day. Second tap = range with both days included, earlier first (tapping the
 * same day again keeps the single day). Third tap starts over with a single day. Future days are ignored.
 */
export function selectDate(sel: DateSelection, tapped: Ymd, today: Ymd): DateSelection {
  if (!parseYmd(tapped) || tapped > today) return sel;
  if (!sel.from || !sel.to) return { from: tapped, to: tapped };
  if (sel.from === sel.to) return tapped < sel.from ? { from: tapped, to: sel.from } : { from: sel.from, to: tapped };
  return { from: tapped, to: tapped };
}

export interface SelectionSummary { count: number; spentPaise: number; receivedPaise: number }

/** Totals for the selected days (inclusive). Count is every non-deleted income/expense row, matching the list below. */
export function summarizeSelection(marks: DayMarks, sel: DateSelection): SelectionSummary {
  const out: SelectionSummary = { count: 0, spentPaise: 0, receivedPaise: 0 };
  if (!sel.from || !sel.to) return out;
  for (const [day, m] of marks) {
    if (day < sel.from || day > sel.to) continue;
    out.count += m.expenseCount + m.incomeCount;
    out.spentPaise += m.expensePaise;
    out.receivedPaise += m.incomePaise;
  }
  return out;
}

/** Chip text: '21 Nov 2026' for one day, '10 Nov to 21 Nov' for a range in the current year, with years otherwise. */
export function formatSelection(sel: { from?: Ymd | null; to?: Ymd | null }, today: Ymd = localYmd()): string {
  const { from, to } = sel;
  if (!from && !to) return 'All dates';
  if (!from || !to || from === to) return formatDisplayDate(from ?? to);
  const a = parseYmd(from); const b = parseYmd(to); const now = parseYmd(today);
  if (!a || !b) return '';
  if (now && a.year === now.year && b.year === now.year) return `${String(a.day).padStart(2, '0')} ${MONTH_SHORT[a.month0]} to ${String(b.day).padStart(2, '0')} ${MONTH_SHORT[b.month0]}`;
  return `${formatDisplayDate(from)} to ${formatDisplayDate(to)}`;
}
