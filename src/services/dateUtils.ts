/**
 * Calendar-date helpers shared by the date picker, transaction entry, the Transactions filter and Analytics.
 *
 * A "calendar date" is a plain 'YYYY-MM-DD' string in the device's local time. Keeping dates as strings (never as
 * UTC instants) means picking, comparing and filtering days can never shift by a timezone offset. Stored transaction
 * timestamps stay ISO instants exactly as before (see transactionDetails.parseLocalDateTime).
 */
export type Ymd = string;

const pad = (n: number) => String(n).padStart(2, '0');
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const toYmd = (year: number, month0: number, day: number): Ymd => `${year}-${pad(month0 + 1)}-${pad(day)}`;

/** Parses 'YYYY-MM-DD'; null for malformed or impossible dates (e.g. 2026-02-31). */
export function parseYmd(value: string | null | undefined): { year: number; month0: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;
  const [year, month0, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const check = new Date(year, month0, day);
  if (check.getFullYear() !== year || check.getMonth() !== month0 || check.getDate() !== day) return null;
  return { year, month0, day };
}

/** The device's local calendar date for an instant (default: now). */
export function localYmd(date: Date = new Date()): Ymd { return toYmd(date.getFullYear(), date.getMonth(), date.getDate()); }

/** 'HH:mm' (24h, device local) for an instant (default: now). */
export function localHm(date: Date = new Date()): string { return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }

export const daysInMonth = (year: number, month0: number): number => new Date(year, month0 + 1, 0).getDate();

/** Cells for a month grid: leading nulls for the weekday offset (Sunday first), then 1..N. Length is a multiple of 7. */
export function monthCells(year: number, month0: number): (number | null)[] {
  const lead = new Date(year, month0, 1).getDay();
  const cells: (number | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= daysInMonth(year, month0); d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function shiftMonth(year: number, month0: number, delta: number): { year: number; month0: number } {
  const index = year * 12 + month0 + delta;
  return { year: Math.floor(index / 12), month0: ((index % 12) + 12) % 12 };
}

/** 'DD Mon YYYY', e.g. 07 Nov 2026. Returns '' for an invalid value. */
export function formatDisplayDate(value: string | null | undefined): string {
  const p = parseYmd(value);
  return p ? `${pad(p.day)} ${MONTH_SHORT[p.month0]} ${p.year}` : '';
}

/** '07:05 PM' for 'HH:mm'. Returns '' for an invalid value. */
export function formatDisplayTime(hm: string | null | undefined): string {
  const t = parseHm(hm);
  if (!t) return '';
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${pad(h12)}:${pad(t.minute)} ${t.hour < 12 ? 'AM' : 'PM'}`;
}

export function parseHm(value: string | null | undefined): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  return hour > 23 || minute > 59 ? null : { hour, minute };
}

export const toHm = (hour: number, minute: number): string => `${pad(hour)}:${pad(minute)}`;

/** True when `value` lies within [min, max] (inclusive, either bound optional). Lexicographic compare is exact for YYYY-MM-DD. */
export function isWithin(value: Ymd, min?: Ymd | null, max?: Ymd | null): boolean {
  return (!min || value >= min) && (!max || value <= max);
}

/** The local calendar date a stored transaction timestamp falls on. */
export function transactionDay(iso: string): Ymd { return localYmd(new Date(iso)); }

/**
 * Inclusive date-range test on the transaction's own date (local day). `from` and `to` are calendar dates; a
 * transaction at 23:59 on `to` is included, and one at 00:00 on `from` is included.
 */
export function inDateRange(iso: string, from?: Ymd | null, to?: Ymd | null): boolean {
  if (!from && !to) return true;
  return isWithin(transactionDay(iso), from, to);
}

export type RangeCheck = { ok: true } | { ok: false; error: string };
export function validateRange(from: Ymd | null, to: Ymd | null): RangeCheck {
  if (!from || !to) return { ok: false, error: 'Select both a start and an end date.' };
  if (!parseYmd(from) || !parseYmd(to)) return { ok: false, error: 'Select valid dates.' };
  if (to < from) return { ok: false, error: 'The end date cannot be before the start date.' };
  return { ok: true };
}

/** Converts an inclusive calendar range into the half-open ISO interval [startOfFrom, startOfDayAfterTo) the analytics queries use. */
export function rangeToIsoInterval(from: Ymd, to: Ymd): { start: string; end: string } | null {
  const a = parseYmd(from); const b = parseYmd(to);
  if (!a || !b) return null;
  return { start: new Date(a.year, a.month0, a.day).toISOString(), end: new Date(b.year, b.month0, b.day + 1).toISOString() };
}

/** Compact label for a range, e.g. '01 Nov 2026 – 07 Nov 2026'. */
export function formatRange(from?: Ymd | null, to?: Ymd | null): string {
  if (from && to) return `${formatDisplayDate(from)} – ${formatDisplayDate(to)}`;
  if (from) return `From ${formatDisplayDate(from)}`;
  if (to) return `Until ${formatDisplayDate(to)}`;
  return 'All dates';
}
