/**
 * Decides whether two observations describe the same money movement. Pure, so every rule is unit-tested.
 *
 * exact  - the same bank reference. The same transaction, whatever the channels.
 * strong - everything available agrees and the timing fits. Detected channels are merged automatically by the
 *          repository; a statement row is shown as "matched" for the person to confirm.
 * weak   - could be the same, not enough to say. Kept as its own row and flagged for review, never merged.
 * none   - different transactions.
 *
 * Equal amounts alone never match. A contradiction on reference, account, balance, direction or kind is always 'none'.
 * One channel reports each payment once, so two rows from the same channel are different payments unless identical
 * (identical replays are stopped earlier by the reference and fingerprint keys).
 */
export type MatchOutcome = 'exact' | 'strong' | 'weak' | 'none';

export interface MatchSide {
  amountPaise: number;
  direction: string;
  kind?: string;
  /** Epoch ms. */
  at: number;
  counterparty: string;
  referenceId?: string | null;
  accountLast4?: string | null;
  balance?: number;
  /** Detection channels that saw it; empty for a manual entry. */
  channels: string[];
  /** True when only the calendar day is known (bank statements). */
  dayPrecision?: boolean;
}

export interface MatchResult { outcome: MatchOutcome; score: number; reasons: string[] }

const MINUTE = 60_000;
export const STRONG_WINDOW_MS = 5 * MINUTE;
export const WEAK_WINDOW_MS = 24 * 60 * MINUTE;

const GENERIC = /^(?:upi payment|upi credit|card payment|atm withdrawal|.+ (?:debit|credit))$/i;
const LEGAL_SUFFIX = /\b(?:pvt|private|ltd|limited|llp|inc|technologies|technology|india|payments?)\b/g;
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();

export const isGenericMerchant = (name: string): boolean => GENERIC.test(name.trim());

export type MerchantRelation = 'same' | 'generic' | 'different';

export function relateMerchants(a: string, b: string): MerchantRelation {
  if (GENERIC.test(a.trim()) || GENERIC.test(b.trim())) return 'generic';
  const x = norm(a); const y = norm(b);
  if (!x || !y) return 'generic';
  const cx = x.replace(/ /g, ''); const cy = y.replace(/ /g, '');
  // "rahulsharma" (from a UPI id) and "Rahul Sharma" are the same payee; a truncated name is contained in the full one.
  return cx === cy || cx.includes(cy) || cy.includes(cx) ? 'same' : 'different';
}

const refund = (kind?: string) => kind === 'refund' || kind === 'reversal';

export function scoreMatch(a: MatchSide, b: MatchSide): MatchResult {
  const none = (reason: string): MatchResult => ({ outcome: 'none', score: 0, reasons: [reason] });
  if (a.amountPaise !== b.amountPaise) return none('amount differs');
  if (a.direction !== b.direction) return none('direction differs');

  const refA = a.referenceId?.trim() || ''; const refB = b.referenceId?.trim() || '';
  if (refA && refB) return refA === refB ? { outcome: 'exact', score: 100, reasons: ['same reference'] } : none('reference differs');

  if (refund(a.kind) !== refund(b.kind)) return none('refund versus payment');
  if (a.accountLast4 && b.accountLast4 && a.accountLast4 !== b.accountLast4) return none('account differs');
  if (a.balance !== undefined && b.balance !== undefined && Math.abs(a.balance - b.balance) > 0.005) return none('balance differs');
  if (a.channels.some((c) => b.channels.includes(c))) return none('same channel reports each payment once');

  const relation = relateMerchants(a.counterparty, b.counterparty);
  const gap = Math.abs(a.at - b.at);
  const reasons = [`amount and direction match`, `merchant ${relation}`];
  if (a.accountLast4 && a.accountLast4 === b.accountLast4) reasons.push('same account');

  const dayOnly = a.dayPrecision || b.dayPrecision;
  if (dayOnly) {
    if (gap > WEAK_WINDOW_MS) return none('different day');
    return relation === 'different' ? { outcome: 'weak', score: 40, reasons } : { outcome: 'strong', score: 75, reasons };
  }
  if (gap <= STRONG_WINDOW_MS) {
    return relation === 'different' ? { outcome: 'weak', score: 45, reasons } : { outcome: 'strong', score: 85, reasons };
  }
  if (gap <= WEAK_WINDOW_MS && relation !== 'different') return { outcome: 'weak', score: 35, reasons };
  return none('too far apart for these merchants');
}
