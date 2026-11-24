import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { monthRange } from './budgetService.ts';
import { SPEND_VIEW, SQL_COUNTS_AS_EXPENSE, SQL_COUNTS_AS_INCOME } from './ledgerRules.ts';

/**
 * Income-vs-expense series for the Spending Overview chart (daily / weekly / monthly).
 *
 * Uses the same source of truth and filters as `getCashFlowSummary` (local SQLite, scope-aware, deleted rows excluded,
 * only `income` / `expense` directions, amount in exact integer paise, bucketed by the transaction date in local time),
 * so the chart and the summary figures can never disagree. Pure aggregation is separated from the query for testing.
 */
export type SeriesView = 'daily' | 'weekly' | 'monthly';

export interface TxnPoint { date: string; direction: string; paise: number }

export interface SeriesBucket {
  key: string;
  /** Short axis label ("1", "1–7", "Nov"). */
  label: string;
  /** Long label for the selected-bucket detail ("Sun, 8 Nov", "1–7 Nov", "November 2026"). */
  detail: string;
  incomePaise: number;
  expensePaise: number;
  netPaise: number;
  /** Local-calendar first/last day (inclusive) covered, used to list that bucket's transactions. */
  from: { y: number; m: number; d: number };
  to: { y: number; m: number; d: number };
}

export interface SeriesTotals { incomePaise: number; expensePaise: number; netPaise: number; count: number }

const PAISE = 'COALESCE(amount_paise, CAST(ROUND(amount * 100) AS INTEGER))';
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseMonth(month: string): { y: number; m: number } {
  const r = /^(\d{4})-(\d{2})$/.exec(month);
  if (!r || Number(r[2]) < 1 || Number(r[2]) > 12) throw new Error('Invalid month');
  return { y: Number(r[1]), m: Number(r[2]) - 1 };
}

export function formatMonthKey(y: number, m: number): string {
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month: string, delta: number): string {
  const { y, m } = parseMonth(month);
  return formatMonthKey(y, m + delta);
}

export function daysInMonth(month: string): number {
  const { y, m } = parseMonth(month);
  return new Date(y, m + 1, 0).getDate();
}

export function monthLabel(month: string): string {
  const { y, m } = parseMonth(month);
  return `${MONTHS_LONG[m]} ${y}`;
}

/** Rows for [start of `fromMonth`, end of `toMonth`) — one query, then aggregated in memory. */
export async function loadPoints(db: IDatabase, scope: Scope, fromMonth: string, toMonth: string): Promise<TxnPoint[]> {
  const start = monthRange(fromMonth).start;
  const end = monthRange(toMonth).end;
  const rows = await db.getAllAsync<{ date: string; direction: string; paise: number | null }>(
    `SELECT transaction_date AS date, direction, ${PAISE} AS paise
       FROM ${SPEND_VIEW}
      WHERE deleted_at IS NULL AND (${SQL_COUNTS_AS_INCOME} OR ${SQL_COUNTS_AS_EXPENSE})
        AND transaction_date >= ? AND transaction_date < ?
        AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    start, end, scope, scope,
  );
  return rows.map((r) => ({ date: r.date, direction: r.direction, paise: Number(r.paise ?? 0) }));
}

function emptyBucket(key: string, label: string, detail: string, from: SeriesBucket['from'], to: SeriesBucket['to']): SeriesBucket {
  return { key, label, detail, incomePaise: 0, expensePaise: 0, netPaise: 0, from, to };
}

function add(b: SeriesBucket, p: TxnPoint): void {
  if (p.direction === 'income') b.incomePaise += p.paise;
  else if (p.direction === 'expense') b.expensePaise += p.paise;
  b.netPaise = b.incomePaise - b.expensePaise;
}

/** One bucket per calendar day of `month` (28–31), zero-filled. */
export function buildDaily(points: TxnPoint[], month: string): SeriesBucket[] {
  const { y, m } = parseMonth(month);
  const n = daysInMonth(month);
  const buckets: SeriesBucket[] = [];
  for (let d = 1; d <= n; d += 1) {
    const wd = WEEKDAYS[new Date(y, m, d).getDay()];
    const at = { y, m, d };
    buckets.push(emptyBucket(`${month}-${String(d).padStart(2, '0')}`, String(d), `${wd}, ${d} ${MONTHS_SHORT[m]} ${y}`, at, at));
  }
  for (const p of points) {
    const dt = new Date(p.date);
    if (Number.isNaN(dt.getTime()) || dt.getFullYear() !== y || dt.getMonth() !== m) continue;
    add(buckets[dt.getDate() - 1], p);
  }
  return buckets;
}

/** Calendar weeks (Monday–Sunday) clipped to the month, so the first/last week may be partial. */
export function buildWeekly(points: TxnPoint[], month: string): SeriesBucket[] {
  const { y, m } = parseMonth(month);
  const n = daysInMonth(month);
  const buckets: SeriesBucket[] = [];
  const weekOfDay: number[] = [];
  let startDay = 1;
  while (startDay <= n) {
    const dow = (new Date(y, m, startDay).getDay() + 6) % 7; // Monday = 0
    const endDay = Math.min(n, startDay + (6 - dow));
    const label = startDay === endDay ? String(startDay) : `${startDay}–${endDay}`;
    buckets.push(emptyBucket(`${month}-w${buckets.length + 1}`, label, `${label} ${MONTHS_SHORT[m]} ${y}`, { y, m, d: startDay }, { y, m, d: endDay }));
    for (let d = startDay; d <= endDay; d += 1) weekOfDay[d] = buckets.length - 1;
    startDay = endDay + 1;
  }
  for (const p of points) {
    const dt = new Date(p.date);
    if (Number.isNaN(dt.getTime()) || dt.getFullYear() !== y || dt.getMonth() !== m) continue;
    add(buckets[weekOfDay[dt.getDate()]], p);
  }
  return buckets;
}

/**
 * Up to `count` months ending at `endMonth`. Months before the first recorded transaction in the window are dropped
 * (nothing was recorded, so nothing is shown); the selected month is always present. Months after that with no
 * transactions are genuine zeros.
 */
export function buildMonthly(points: TxnPoint[], endMonth: string, count = 6): SeriesBucket[] {
  const all: SeriesBucket[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const key = shiftMonth(endMonth, -i);
    const { y, m } = parseMonth(key);
    const last = new Date(y, m + 1, 0).getDate();
    all.push(emptyBucket(key, MONTHS_SHORT[m], `${MONTHS_LONG[m]} ${y}`, { y, m, d: 1 }, { y, m, d: last }));
  }
  const index = new Map(all.map((b, i) => [b.key, i]));
  for (const p of points) {
    const dt = new Date(p.date);
    if (Number.isNaN(dt.getTime())) continue;
    const i = index.get(formatMonthKey(dt.getFullYear(), dt.getMonth()));
    if (i !== undefined) add(all[i], p);
  }
  const firstWithData = all.findIndex((b) => b.incomePaise > 0 || b.expensePaise > 0);
  const from = firstWithData === -1 ? all.length - 1 : Math.min(firstWithData, all.length - 1);
  return all.slice(from);
}

export function totalsOf(buckets: SeriesBucket[], points: TxnPoint[] = []): SeriesTotals {
  let incomePaise = 0; let expensePaise = 0;
  for (const b of buckets) { incomePaise += b.incomePaise; expensePaise += b.expensePaise; }
  return { incomePaise, expensePaise, netPaise: incomePaise - expensePaise, count: points.length };
}

export function hasActivity(buckets: SeriesBucket[]): boolean {
  return buckets.some((b) => b.incomePaise > 0 || b.expensePaise > 0);
}

/** "Nice" axis ceiling and ticks (in paise) so bars scale cleanly: 1/2/5 × 10^k. */
export function niceScale(maxPaise: number, ticks = 3): { max: number; ticks: number[] } {
  if (maxPaise <= 0) return { max: 100, ticks: [0] };
  const rupees = maxPaise / 100;
  const pow = 10 ** Math.floor(Math.log10(rupees / ticks));
  const unit = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((u) => u * ticks >= rupees) ?? 10 * pow;
  const out: number[] = [];
  for (let i = 0; i <= ticks; i += 1) out.push(Math.round(unit * i * 100));
  return { max: out[out.length - 1], ticks: out };
}
