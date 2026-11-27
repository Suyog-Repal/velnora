/**
 * Home's "You'll pay" card: pending expected payments the owner will make. Pure and read-only. Money owed TO the owner is not
 * here, and neither are split balances (the Split dues card has those).
 */
import { isOverdue, outstandingPaise, type ExpectedPayment } from './expectedPaymentService.ts';
import { formatDay } from './upiLinks.ts';

export const PAYABLE_ROWS = 3;

export const isPayable = (e: ExpectedPayment): boolean => e.direction === 'pay' && e.status === 'pending' && outstandingPaise(e) > 0;

/** Overdue first, then by due date (earliest first), then the ones with no date. Same overdue rule as the Expected tab. */
export function payables(items: readonly ExpectedPayment[], now: Date = new Date()): ExpectedPayment[] {
  return items.filter(isPayable).sort((a, b) =>
    Number(isOverdue(b, now)) - Number(isOverdue(a, now))
    || Number(!a.due_date) - Number(!b.due_date)
    || (a.due_date ?? '').localeCompare(b.due_date ?? '')
    || a.created_at.localeCompare(b.created_at)
    || a.id.localeCompare(b.id));
}

/** "Overdue since 26 Nov" / "Due 3 Dec" / "No due date". The year is shown only when it is not the current one. */
export function payableStatus(e: ExpectedPayment, now: Date = new Date()): string {
  if (!e.due_date) return 'No due date';
  const day = formatDay(e.due_date).replace(new RegExp(` ${now.getFullYear()}$`), '');
  return isOverdue(e, now) ? `Overdue since ${day}` : `Due ${day}`;
}

export interface PayableRow { id: string; person: string; amountPaise: number; status: string; overdue: boolean }
export interface PayableCard { rows: PayableRow[]; total: number; action: string }

/** What the card shows, or null when there is nothing to pay (the card is then hidden). */
export function payableCard(items: readonly ExpectedPayment[], now: Date = new Date()): PayableCard | null {
  const all = payables(items, now);
  if (!all.length) return null;
  return {
    rows: all.slice(0, PAYABLE_ROWS).map((e) => ({ id: e.id, person: e.person, amountPaise: outstandingPaise(e), status: payableStatus(e, now), overdue: isOverdue(e, now) })),
    total: all.length,
    action: all.length > PAYABLE_ROWS ? `See all ${all.length}` : 'Open',
  };
}
