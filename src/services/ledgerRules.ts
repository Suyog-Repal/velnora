import type { CaptureSource, DetectionSource, TransactionKind, VerificationStatus } from '../db/types.ts';

/**
 * The one definition of how a ledger row counts towards money totals. SQL and in-memory versions must stay equivalent:
 * - possible duplicates count nowhere until the person resolves them
 * - internal transfers are neither income nor expense
 * - refunds and reversals are money back, not income
 * - cash withdrawals count as spending (money left the bank for cash)
 * Failed and pending bank messages never become rows at all (see the parser).
 */
const NOT_DUPLICATE = 'possible_duplicate_of IS NULL';
const KIND = "COALESCE(txn_kind, 'payment')";

export const SQL_COUNTS_AS_EXPENSE = `(direction = 'expense' AND ${KIND} != 'transfer' AND ${NOT_DUPLICATE})`;
export const SQL_COUNTS_AS_INCOME = `(direction = 'income' AND ${KIND} NOT IN ('transfer', 'refund', 'reversal') AND ${NOT_DUPLICATE})`;
export const SQL_COUNTS_AS_REFUND = `(direction = 'income' AND ${KIND} IN ('refund', 'reversal') AND ${NOT_DUPLICATE})`;

type Countable = { direction: string; txn_kind?: TransactionKind; possible_duplicate_of?: string | null };

export function countsAsExpense(t: Countable): boolean {
  return t.direction === 'expense' && (t.txn_kind ?? 'payment') !== 'transfer' && !t.possible_duplicate_of;
}

export function countsAsIncome(t: Countable): boolean {
  return t.direction === 'income' && !['transfer', 'refund', 'reversal'].includes(t.txn_kind ?? 'payment') && !t.possible_duplicate_of;
}

/** Refunds and reversals: money back. Not income, but included in net cash flow (mirrors SQL_COUNTS_AS_REFUND). */
export function countsAsRefund(t: Countable): boolean {
  return t.direction === 'income' && ['refund', 'reversal'].includes(t.txn_kind ?? 'payment') && !t.possible_duplicate_of;
}

export const KIND_LABELS: Record<TransactionKind, string> = {
  payment: 'Payment', refund: 'Refund', reversal: 'Reversal', transfer: 'Own transfer', cash_withdrawal: 'Cash withdrawal',
};

export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  detected: 'Detected', needs_review: 'Needs review', verified: 'Verified', reconciled: 'Reconciled',
};

const CAPTURE_LABELS: Record<CaptureSource, string> = {
  manual: 'Manual', sms: 'SMS', notification: 'Notification', csv_import: 'Statement',
};

/** Short uppercase origin for list rows: where the row came from, plus the other channels that confirmed it. */
export function sourceLabel(t: { source: string; capture_source?: CaptureSource | null; detected_via?: DetectionSource[]; payment_app?: string | null }): string {
  if (t.source === 'manual' && !t.detected_via?.length) return 'MANUAL';
  const via = t.detected_via ?? [];
  const parts: string[] = [];
  if (via.includes('sms')) parts.push('SMS');
  if (via.includes('truecaller_notification')) parts.push('TRUECALLER');
  if (via.includes('payment_notification')) parts.push((t.payment_app ?? 'APP').toUpperCase());
  if (via.includes('csv_import')) parts.push('STATEMENT');
  if (parts.length) return parts.join(' + ');
  return CAPTURE_LABELS[t.capture_source ?? (t.source === 'sms' ? 'sms' : 'manual')].toUpperCase();
}

/**
 * The ONE source of "what counts as my spending" (defined in migration 11). Same columns as `transactions`, so a spending query only
 * swaps its FROM: an expense that is split counts only the owner's share, and a split expense a friend paid for (no bank transaction)
 * counts the owner's share on its own date and category. Settlements are not in it. Cash balance (money actually moved) must keep
 * reading `transactions`, because the bank saw the full amount.
 */
export const SPEND_VIEW = 'v_spend';

/**
 * The CASH view of spending: money that actually left the account, full transaction amounts (a split bill counts in full).
 * Used by Home, Profile and the recorded balance, which must agree with the bank SMS. Budgets, Analytics and the monthly report use
 * SPEND_VIEW (own share) instead. This is the in-memory twin of the SQL in cashFlowService, and a test keeps the two equal.
 */
export function cashSpentInMonth(rows: ReadonlyArray<Countable & { amount_paise: number; transaction_date: string; deleted_at?: string | null }>, now: Date = new Date()): number {
  let total = 0;
  for (const t of rows) {
    if (t.deleted_at || !countsAsExpense(t)) continue;
    const d = new Date(t.transaction_date);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) total += t.amount_paise;
  }
  return total;
}
