import { MetadataRepository } from '../db/repositories/metadataRepository.ts';
import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { localYmd, parseHm, rangeToIsoInterval } from './dateUtils.ts';

/**
 * End-of-day "Did we miss anything?" check-in. The Android side owns the alarm and the notification; this file decides
 * what the notification says and whether it should be shown at all. Counts come from the local ledger only and the
 * text carries a count and a total, never a merchant, a bank or any message text.
 *
 * Pure decisions are exported separately so they are unit-tested without a device.
 */
export const CHECKIN_ENABLED_KEY = 'daily_checkin_enabled';
export const CHECKIN_TIME_KEY = 'daily_checkin_time';
export const DEFAULT_CHECKIN_TIME = '21:00';

export interface CheckInPrefs { enabled: boolean; time: string }

export interface CheckInPort {
  canNotify(): boolean;
  post(title: string, body: string): boolean;
  /** Local day (YYYY-MM-DD) the person last confirmed, or null. Stored natively so "Nothing missed" works with the app closed. */
  confirmedDay(): string | null;
  markConfirmed(day: string): void;
  /** Hands the schedule to Android's alarm. */
  configure(enabled: boolean, time: string): void;
}

let port: CheckInPort | null = null;
export function setCheckInPort(next: CheckInPort | null): void { port = next; }
export function getCheckInPort(): CheckInPort | null { return port; }

export async function getCheckInPrefs(db: IDatabase): Promise<CheckInPrefs> {
  const meta = new MetadataRepository(db);
  const [enabled, time] = await Promise.all([meta.get(CHECKIN_ENABLED_KEY), meta.get(CHECKIN_TIME_KEY)]);
  return { enabled: enabled !== '0', time: time && parseHm(time) ? time : DEFAULT_CHECKIN_TIME };
}

export async function setCheckInPrefs(db: IDatabase, prefs: Partial<CheckInPrefs>): Promise<CheckInPrefs> {
  const meta = new MetadataRepository(db);
  if (prefs.enabled !== undefined) await meta.set(CHECKIN_ENABLED_KEY, prefs.enabled ? '1' : '0');
  if (prefs.time !== undefined && parseHm(prefs.time)) await meta.set(CHECKIN_TIME_KEY, prefs.time);
  return getCheckInPrefs(db);
}

/** Pushes the saved setting to the native alarm. Call at app start and after every change; it is idempotent. */
export async function syncCheckInSchedule(db: IDatabase): Promise<CheckInPrefs> {
  const prefs = await getCheckInPrefs(db);
  port?.configure(prefs.enabled, prefs.time);
  return prefs;
}

export function checkInLabel(prefs: CheckInPrefs, canNotify = true): string {
  if (!prefs.enabled) return 'Off';
  const { hour, minute } = parseHm(prefs.time) ?? { hour: 21, minute: 0 };
  const time = `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
  return canNotify ? `Daily at ${time}` : 'Allow Velnora notifications to receive this';
}

export interface DaySummary { count: number; spentPaise: number }

export interface DayRow { amount_paise: number; direction: string; txn_kind?: string | null; possible_duplicate_of?: string | null }

/** Same counting rule as every other total: duplicates and own transfers do not count as spending. */
export function summarizeDay(rows: DayRow[]): DaySummary {
  let count = 0;
  let spentPaise = 0;
  for (const row of rows) {
    if (row.possible_duplicate_of) continue;
    count += 1;
    if (row.direction === 'expense' && (row.txn_kind ?? 'payment') !== 'transfer') spentPaise += row.amount_paise;
  }
  return { count, spentPaise };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function describeCheckIn(summary: DaySummary): { title: string; body: string } {
  const title = 'Did we miss anything?';
  if (summary.count === 0) return { title, body: "Velnora didn't capture any transactions today. Spent cash or paid some other way? Add it now." };
  const noun = summary.count === 1 ? 'transaction' : 'transactions';
  const total = summary.spentPaise > 0 ? ` (${rupees(summary.spentPaise)} total)` : '';
  return { title, body: `Velnora captured ${summary.count} ${noun} today${total}. Anything missed?` };
}

/** Automatically captured (SMS or payment-app) transactions dated today, in device-local time, for this scope. */
export async function getDaySummary(db: IDatabase, scope: Scope, now: number = Date.now()): Promise<DaySummary> {
  const day = localYmd(new Date(now));
  const interval = rangeToIsoInterval(day, day);
  if (!interval) return { count: 0, spentPaise: 0 };
  const rows = await db.getAllAsync<DayRow>(
    `SELECT amount_paise, direction, txn_kind, possible_duplicate_of FROM transactions
     WHERE deleted_at IS NULL AND capture_source IN ('sms', 'notification')
       AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
       AND transaction_date >= ? AND transaction_date <= ?`,
    scope, scope, interval.start, interval.end,
  );
  return summarizeDay(rows);
}

export type CheckInOutcome = 'posted' | 'disabled' | 'already_confirmed' | 'no_permission' | 'failed' | 'unavailable';

/** What the headless alarm task runs. Skips quietly when the person already confirmed today. */
export async function runDailyCheckIn(db: IDatabase, scope: Scope, options: { now?: number } = {}): Promise<CheckInOutcome> {
  const notifier = port;
  if (!notifier) return 'unavailable';
  const now = options.now ?? Date.now();
  const prefs = await getCheckInPrefs(db);
  if (!prefs.enabled) return 'disabled';
  if (notifier.confirmedDay() === localYmd(new Date(now))) return 'already_confirmed';
  if (!notifier.canNotify()) return 'no_permission';
  const { title, body } = describeCheckIn(await getDaySummary(db, scope, now));
  return notifier.post(title, body) ? 'posted' : 'failed';
}

/** A saved quick-add entry settles today's check-in: the person has just told Velnora what was missing. */
export function confirmCheckInToday(now: number = Date.now()): void {
  port?.markConfirmed(localYmd(new Date(now)));
}
