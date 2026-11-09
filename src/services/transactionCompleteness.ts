import { isGenericMerchant } from './duplicateMatcher.ts';
import type { CaptureSource, Direction, TransactionKind } from '../db/types.ts';

/**
 * The one definition of "does a person need to look at this detected transaction?". Pure, so every rule is unit-tested.
 *
 * Required: a valid amount, direction and date, a settled identity (no open duplicate question), and enough to classify
 * it. Optional: reference, payment app and, normally, the account.
 * - category: missing when a payment out landed in the default bucket. Credits are not asked: "Other Income" is a real
 *   answer for most money received, and the classifier can only otherwise say Salary.
 * - merchant: required for ordinary payments only. "ATM withdrawal", refunds and transfers are identified by what they are.
 * - account: required only when the person has confirmed two or more accounts, so "which one?" is a real question.
 *   It is never guessed, and a payment app is never treated as an account.
 */
export type ReviewField = 'duplicate' | 'amount' | 'direction' | 'date' | 'merchant' | 'category' | 'account';

export interface CompletenessInput {
  amount_paise: number;
  direction: Direction | string;
  counterparty: string;
  category: string;
  transaction_date: string;
  txn_kind?: TransactionKind;
  possible_duplicate_of?: string | null;
  account_last4?: string | null;
}

export interface CompletenessContext {
  /** Accounts the person has confirmed in this scope. */
  confirmedAccounts?: number;
  /** The person saved a category for this merchant, even if it is a default bucket. */
  categoryConfirmed?: boolean;
}

export interface CompletenessResult { complete: boolean; missing: ReviewField[] }

const DEFAULT_EXPENSE_CATEGORY = /^other expenses?$/i;

export function evaluateCompleteness(tx: CompletenessInput, context: CompletenessContext = {}): CompletenessResult {
  const missing: ReviewField[] = [];
  const kind = tx.txn_kind ?? 'payment';
  if (tx.possible_duplicate_of) missing.push('duplicate');
  if (!Number.isFinite(tx.amount_paise) || tx.amount_paise <= 0) missing.push('amount');
  if (tx.direction !== 'income' && tx.direction !== 'expense') missing.push('direction');
  if (Number.isNaN(new Date(tx.transaction_date).getTime())) missing.push('date');
  if (kind === 'payment' && (!tx.counterparty?.trim() || isGenericMerchant(tx.counterparty))) missing.push('merchant');
  if (kind === 'payment' && tx.direction === 'expense' && !context.categoryConfirmed && (!tx.category?.trim() || DEFAULT_EXPENSE_CATEGORY.test(tx.category.trim()))) missing.push('category');
  if (!tx.account_last4 && (context.confirmedAccounts ?? 0) >= 2) missing.push('account');
  return { complete: missing.length === 0, missing };
}

export const REVIEW_FIELD_LABELS: Record<ReviewField, string> = {
  duplicate: 'Possible duplicate', amount: 'Amount', direction: 'Money in or out', date: 'Date', merchant: 'Merchant', category: 'Category', account: 'Account',
};

/** Only channels that detect payments unattended are flagged and notified. The person is present for manual entry and imports. */
export function isAutoDetected(capture: CaptureSource | null | undefined): boolean {
  return capture === 'sms' || capture === 'notification';
}
