import type { Session, TransactionEntity, UpdateTransactionInput } from '../db/types.ts';

export type PhoneResult = { ok: true; value: string | null } | { ok: false; error: string };

export const DEFAULT_DIAL_CODE = '+91';

/**
 * Builds a canonical E.164 merchant number from an optional dial code and the typed number.
 * - Empty input is valid and means "no number" (null): the field is optional.
 * - Accepts spaces, dashes, dots and parentheses.
 * - A number typed with its own '+' (or '00') prefix wins over the selected dial code, so any international number works.
 * - For +91 a national number must be a 10-digit Indian mobile (starts 6-9); other countries allow 7-14 national digits.
 */
export function buildMerchantPhone(rawNumber: string | null | undefined, dialCode: string = DEFAULT_DIAL_CODE): PhoneResult {
  const typed = (rawNumber ?? '').trim();
  if (!typed) return { ok: true, value: null };
  if (/[^\d\s\-.()+]/.test(typed)) return { ok: false, error: 'Use digits only (spaces, dashes and a leading + are allowed).' };

  let digits = typed.replace(/[^\d+]/g, '');
  let dial: string;
  if (digits.startsWith('+')) {
    if (digits.lastIndexOf('+') > 0) return { ok: false, error: 'Enter a valid mobile number.' };
    return fullInternational(digits.slice(1));
  }
  if (digits.startsWith('00')) return fullInternational(digits.slice(2));

  dial = (dialCode || DEFAULT_DIAL_CODE).trim();
  if (!/^\+\d{1,4}$/.test(dial)) return { ok: false, error: 'Choose a valid country code.' };
  const dialDigits = dial.slice(1);
  digits = digits.replace(/^0+/, '');
  if (dial === '+91') {
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (!/^[6-9]\d{9}$/.test(digits)) return { ok: false, error: 'Enter a valid 10-digit Indian mobile number.' };
  } else if (!/^\d{7,14}$/.test(digits)) {
    return { ok: false, error: 'Enter a valid mobile number (7–14 digits).' };
  }
  if (dialDigits.length + digits.length > 15) return { ok: false, error: 'That number is too long.' };
  return { ok: true, value: `+${dialDigits}${digits}` };
}

function fullInternational(digits: string): PhoneResult {
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, error: 'Enter a valid international number (8–15 digits after +).' };
  if (digits.startsWith('91') && !/^91[6-9]\d{9}$/.test(digits)) return { ok: false, error: 'Enter a valid 10-digit Indian mobile number.' };
  return { ok: true, value: `+${digits}` };
}

export type LocationInput = { lat: number; lng: number; name?: string | null; address?: string | null; confirmed?: boolean };

export function validateLocation(loc: LocationInput): string | null {
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return 'Location coordinates are invalid.';
  if (loc.lat < -90 || loc.lat > 90 || loc.lng < -180 || loc.lng > 180) return 'Location coordinates are out of range.';
  return null;
}

/** A user may only touch their own records; guest records (no owner) are editable only without a session. */
export function canEditTransaction(tx: Pick<TransactionEntity, 'user_id'>, session: Session | null): boolean {
  return (tx.user_id ?? null) === (session?.user.id ?? null);
}

export type DetailsPatch = {
  amount?: number;
  counterparty?: string;
  category?: string;
  category_id?: string | null;
  description?: string;
  transaction_date?: string;
  payment_method?: string | null;
  /** raw text as typed; '' clears. Validated into E.164. */
  merchantPhone?: { number: string; dialCode?: string };
  location?: LocationInput | null; // null clears
};

/** Validates a bottom-sheet patch and converts it into repository updates. Throws Error(message) on invalid input. */
export function toUpdateInput(patch: DetailsPatch): UpdateTransactionInput {
  const out: UpdateTransactionInput = {};
  if (patch.amount !== undefined) {
    if (!Number.isFinite(patch.amount) || patch.amount <= 0) throw new Error('Enter an amount greater than zero.');
    out.amount = patch.amount;
  }
  if (patch.counterparty !== undefined) {
    if (!patch.counterparty.trim()) throw new Error('Merchant cannot be empty.');
    out.counterparty = patch.counterparty;
  }
  if (patch.category !== undefined) out.category = patch.category;
  if (patch.category_id !== undefined) out.category_id = patch.category_id;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.transaction_date !== undefined) {
    if (Number.isNaN(new Date(patch.transaction_date).getTime())) throw new Error('Enter a valid date.');
    out.transaction_date = patch.transaction_date;
  }
  if (patch.payment_method !== undefined) out.payment_method = patch.payment_method?.trim() || null;
  if (patch.merchantPhone) {
    const res = buildMerchantPhone(patch.merchantPhone.number, patch.merchantPhone.dialCode);
    if (!res.ok) throw new Error(res.error);
    out.merchant_phone = res.value;
  }
  if (patch.location !== undefined) {
    if (patch.location === null) {
      out.location_lat = null; out.location_lng = null; out.location_name = null; out.location_address = null; out.location_confirmed = 0;
    } else {
      const err = validateLocation(patch.location);
      if (err) throw new Error(err);
      out.location_lat = patch.location.lat; out.location_lng = patch.location.lng;
      out.location_name = patch.location.name?.trim() || null; out.location_address = patch.location.address?.trim() || null;
      out.location_confirmed = patch.location.confirmed === false ? 0 : 1;
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatDateInput = (iso: string): string => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const formatTimeInput = (iso: string): string => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** Parses "YYYY-MM-DD" + "HH:mm" (device local time). Returns null for impossible dates, e.g. 2026-02-31. */
export function parseLocalDateTime(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec((time || '00:00').trim());
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  const out = new Date(y, mo - 1, da, h, mi);
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== da || h > 23 || mi > 59) return null;
  return out.toISOString();
}
