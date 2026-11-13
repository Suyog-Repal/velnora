/**
 * "Fill in from receipt" review rules, kept free of React so they can be tested.
 *
 *  - A field starts from the receipt ONLY where the receipt actually showed a value. Where it showed nothing, the field
 *    keeps what the form already had (a manual entry is never blanked or replaced by a guess).
 *  - Where the form had a value the person entered and the receipt shows a DIFFERENT one, the receipt value is suggested
 *    but the conflict is reported, so the screen can show both and offer "Keep <entered value>".
 *  - A receipt date without a time of day never resets the time to midnight: the form's time is kept.
 */
import type { ReceiptSuggestion } from './receiptParser.ts';
import { formatDateInput, formatTimeInput } from './transactionDetails.ts';
import type { Direction } from '../db/types.ts';

/** What the transaction form already holds. Empty string = not entered by the person (defaults count as not entered). */
export interface ReceiptFormValues {
  direction: Direction; merchant: string; amount: string; date: string; time: string; category: string;
  /**
   * Which of these the person actually entered. Pre-filled defaults (today's date, the first category) are still used as
   * fallbacks but are not "entered", so they are not reported as conflicts. Omitted = every non-empty value was entered
   * (an existing transaction's saved values).
   */
  entered?: Partial<Record<ConflictField, boolean>>;
}

export interface ReviewValues extends ReceiptFormValues { reference: string }

export type ConflictField = 'merchant' | 'amount' | 'date' | 'time' | 'category';
export interface ReviewConflict { field: ConflictField; entered: string; read: string }

type CategoryLike = { name: string; type: Direction };

const amountText = (paise: number) => String(paise / 100);
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameAmount = (a: string, b: string) => Number(a) === Number(b) && Number.isFinite(Number(a));

/** Starting values of the review screen. */
export function initialReviewValues(
  s: ReceiptSuggestion | null, current: ReceiptFormValues, categories: CategoryLike[], nowIso: string = new Date().toISOString(),
): ReviewValues {
  const direction: Direction = s?.direction ?? current.direction;
  const matchCategory = (name: string | null | undefined) =>
    name ? categories.find((c) => c.type === direction && sameText(c.name, name))?.name : undefined;
  return {
    direction,
    merchant: s?.merchant ?? current.merchant,
    amount: s?.amountPaise ? amountText(s.amountPaise) : current.amount,
    date: s?.date ? formatDateInput(s.date) : current.date || formatDateInput(nowIso),
    time: s?.date && s.hasTime ? formatTimeInput(s.date) : current.time || formatTimeInput(nowIso),
    category: matchCategory(s?.categoryHint) ?? matchCategory(current.category) ?? '',
    reference: s?.referenceId ?? '',
  };
}

/** Fields where the person had entered a value and the receipt shows a different one. */
export function reviewConflicts(s: ReceiptSuggestion | null, current: ReceiptFormValues, categories: CategoryLike[]): ReviewConflict[] {
  if (!s) return [];
  const isEntered = (f: ConflictField) => !current.entered || current.entered[f] === true;
  const out: ReviewConflict[] = [];
  const all = collectConflicts(s, current, categories, out);
  return all.filter((c) => isEntered(c.field));
}

function collectConflicts(s: ReceiptSuggestion, current: ReceiptFormValues, categories: CategoryLike[], out: ReviewConflict[]): ReviewConflict[] {
  if (current.merchant.trim() && s.merchant && !sameText(current.merchant, s.merchant)) {
    out.push({ field: 'merchant', entered: current.merchant.trim(), read: s.merchant });
  }
  if (current.amount.trim() && s.amountPaise && !sameAmount(current.amount, amountText(s.amountPaise))) {
    out.push({ field: 'amount', entered: current.amount.trim(), read: amountText(s.amountPaise) });
  }
  if (current.date && s.date && current.date !== formatDateInput(s.date)) {
    out.push({ field: 'date', entered: current.date, read: formatDateInput(s.date) });
  }
  if (current.time && s.date && s.hasTime && current.time !== formatTimeInput(s.date)) {
    out.push({ field: 'time', entered: current.time, read: formatTimeInput(s.date) });
  }
  const direction: Direction = s.direction ?? current.direction;
  const hint = s.categoryHint ? categories.find((c) => c.type === direction && sameText(c.name, s.categoryHint!))?.name : undefined;
  const entered = current.category ? categories.find((c) => c.type === direction && sameText(c.name, current.category))?.name : undefined;
  if (hint && entered && hint !== entered) out.push({ field: 'category', entered, read: hint });
  return out;
}
