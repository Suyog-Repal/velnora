/**
 * Edit Transaction: turns the edit form into the update of ONE existing transaction. Free of React so it can be tested.
 *
 *  - Only fields the person actually changed are written. An untouched form writes nothing (no needless sync update), and
 *    the stored timestamp keeps its exact instant unless the date or time was changed.
 *  - Everything is applied by "Save changes" and nothing before it: location, note and "mark as reviewed" are part of the
 *    same plan, so Cancel / close / Android back discard them with the rest.
 *  - The plan never carries an id: it is always applied to the transaction being edited, so editing cannot create a record.
 */
import { buildMerchantPhone, formatDateInput, formatTimeInput, parseLocalDateTime, validateLocation, type DetailsPatch, type LocationInput } from './transactionDetails.ts';
import type { Direction, TransactionEntity, TransactionKind, UpdateTransactionInput } from '../db/types.ts';

export interface EditFormState {
  direction: Direction;
  merchant: string;
  amount: string;
  date: string;
  time: string;
  category: string;
  /** Resolved by the form from its category list (null for a built-in category). */
  categoryId: string | null;
  payment: string | null;
  phone: string;
  dial: string;
  note: string;
  kind: TransactionKind;
  bank: string;
  last4: string;
  /** undefined = location untouched, null = remove it, value = set it. */
  location?: LocationInput | null;
  /** The person chose "Mark as reviewed" in this edit. */
  markReviewed: boolean;
}

export type LedgerPatch = Pick<UpdateTransactionInput, 'txn_kind' | 'verification_status' | 'account_last4' | 'bank_name'>;
export interface EditPlan { details: DetailsPatch | null; ledger: LedgerPatch | null }
export type EditPlanResult = { ok: true; plan: EditPlan; changed: boolean } | { ok: false; error: string };

/** The form values that represent the saved transaction (prefill, and what Cancel returns to). */
export function formFromTransaction(t: TransactionEntity, dialCodes: readonly string[] = ['+91']): EditFormState {
  const p = t.merchant_phone ?? '';
  const known = [...dialCodes].sort((a, b) => b.length - a.length).find((c) => p.startsWith(c));
  return {
    direction: t.direction, merchant: t.counterparty, amount: String(t.amount_paise / 100),
    date: formatDateInput(t.transaction_date), time: formatTimeInput(t.transaction_date),
    category: t.category, categoryId: t.category_id ?? null, payment: t.payment_method ?? null,
    dial: p && known ? known : '+91', phone: !p ? '' : known ? p.slice(known.length) : p,
    note: t.description ?? '', kind: t.txn_kind ?? 'payment', bank: t.bank_name ?? '', last4: t.account_last4 ?? '',
    location: undefined, markReviewed: false,
  };
}

const sameLocation = (t: TransactionEntity, loc: LocationInput) =>
  t.location_lat === loc.lat && t.location_lng === loc.lng && (t.location_name ?? null) === (loc.name ?? null) && (t.location_address ?? null) === (loc.address ?? null);

export function planEdit(t: TransactionEntity, f: EditFormState): EditPlanResult {
  const value = Number(f.amount);
  if (!f.merchant.trim()) return { ok: false, error: 'Merchant cannot be empty.' };
  if (!f.amount.trim() || !Number.isFinite(value) || value <= 0) return { ok: false, error: 'Enter an amount greater than zero.' };
  if (Math.round(value * 100) !== Math.round(value * 1000) / 10) return { ok: false, error: 'Enter the amount with at most two decimal places.' };
  const whenChanged = f.date !== formatDateInput(t.transaction_date) || f.time !== formatTimeInput(t.transaction_date);
  const iso = whenChanged ? parseLocalDateTime(f.date, f.time) : null;
  if (whenChanged && !iso) return { ok: false, error: 'Select a valid date and time.' };
  if (!f.category.trim()) return { ok: false, error: 'Choose a category.' };
  const phone = buildMerchantPhone(f.phone, f.dial);
  if (!phone.ok) return { ok: false, error: phone.error };
  const last4 = f.last4.trim();
  if (last4 && !/^\d{3,4}$/.test(last4)) return { ok: false, error: 'Account: enter only the last 3 or 4 digits.' };
  if (f.location) { const bad = validateLocation(f.location); if (bad) return { ok: false, error: bad }; }

  const details: DetailsPatch = {};
  if (f.direction !== t.direction) details.direction = f.direction;
  if (f.merchant.trim() !== t.counterparty) details.counterparty = f.merchant.trim();
  if (Math.round(value * 100) !== t.amount_paise) details.amount = value;
  if (iso) details.transaction_date = iso;
  if (f.category !== t.category || f.direction !== t.direction) {
    details.category = f.category;
    details.category_id = f.categoryId;
  }
  if ((f.payment ?? null) !== (t.payment_method ?? null)) details.payment_method = f.payment;
  if ((phone.value ?? null) !== (t.merchant_phone ?? null)) details.merchantPhone = { number: f.phone, dialCode: f.dial };
  if (f.note.trim() !== (t.description ?? '').trim()) details.description = f.note.trim();
  if (f.location === null) {
    if (t.location_lat != null || t.location_lng != null) details.location = null;
  } else if (f.location && !sameLocation(t, f.location)) {
    details.location = f.location;
  }

  const ledger: LedgerPatch = {};
  if (f.kind !== (t.txn_kind ?? 'payment')) ledger.txn_kind = f.kind;
  if ((f.bank.trim() || null) !== (t.bank_name ?? null)) ledger.bank_name = f.bank.trim() || null;
  if ((last4 || null) !== (t.account_last4 ?? null)) ledger.account_last4 = last4 || null;
  if (f.markReviewed && t.verification_status !== 'verified') ledger.verification_status = 'verified';

  const plan: EditPlan = { details: Object.keys(details).length ? details : null, ledger: Object.keys(ledger).length ? ledger : null };
  return { ok: true, plan, changed: !!(plan.details || plan.ledger) };
}

/** True when the form differs from the saved transaction (used to decide whether leaving discards anything). */
export function isEditDirty(t: TransactionEntity, f: EditFormState): boolean {
  const r = planEdit(t, f);
  return r.ok ? r.changed : true;
}
