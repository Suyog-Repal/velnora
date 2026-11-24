/**
 * Split math: pure, integer-only (paise), deterministic. No database, no UI.
 *
 * Rules (see also splitBalances.ts):
 * - Shares always sum EXACTLY to the total.
 * - Remainder paise are handed out one by one by largest fractional remainder; ties go to the earlier participant in the
 *   order given. For an equal split that is simply "the first r participants get one extra paisa" (10000 / 3 -> 3334, 3333, 3333).
 * - Percentages are entered with up to 2 decimals and held as integer basis points (100% = 10000), never as floats.
 * - Every function validates its input and throws a SplitError with a message fit to show to the person.
 */

export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares';
export const SELF = 'me';

export class SplitError extends Error {
  constructor(message: string) { super(message); this.name = 'SplitError'; }
}

/** Upper bound that keeps every intermediate product exact (and rejects typos like an extra zero run). */
export const MAX_TOTAL_PAISE = 100_000_000_000; // Rs 100 crore
export const MAX_PARTICIPANTS = 100;
const MAX_WEIGHT = 10_000;

export interface ShareInput {
  party: string;
  /** exact: paise. percent: percent with up to 2 decimals (33.33). shares: positive integer weight. equal: ignored. */
  value?: number;
}

export interface ComputedShare { party: string; sharePaise: number }

function assertTotal(totalPaise: number): void {
  if (!Number.isInteger(totalPaise) || totalPaise <= 0) throw new SplitError('Enter an amount greater than zero.');
  if (totalPaise > MAX_TOTAL_PAISE) throw new SplitError('That amount is too large.');
}

function assertParties(parties: string[]): void {
  if (parties.length === 0) throw new SplitError('Choose at least one person to split with.');
  if (parties.length > MAX_PARTICIPANTS) throw new SplitError(`A split can include at most ${MAX_PARTICIPANTS} people.`);
  if (new Set(parties).size !== parties.length) throw new SplitError('Each person can appear only once.');
  if (parties.some((p) => !p)) throw new SplitError('Every participant needs an id.');
}

/**
 * Largest-remainder allocation of `total` across non-negative integer `weights`. Deterministic: ties go to the lower index.
 * Uses BigInt so the intermediate products are exact for any permitted input.
 */
export function allocateByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (sum === 0n) throw new SplitError('The shares must add up to more than zero.');
  const T = BigInt(total);
  const base = weights.map((w) => (T * BigInt(w)) / sum);
  const rem = weights.map((w) => (T * BigInt(w)) % sum);
  let left = Number(T - base.reduce((s, b) => s + b, 0n));
  const order = weights.map((_, i) => i).sort((a, b) => (rem[a] === rem[b] ? a - b : rem[a] > rem[b] ? -1 : 1));
  const out = base.map((b) => Number(b));
  for (const i of order) {
    if (left <= 0) break;
    if (weights[i] === 0) continue; // a zero weight never receives a leftover paisa
    out[i] += 1; left -= 1;
  }
  return out;
}

/** "33.33" -> 3333 basis points. Rejects more than 2 decimals, negatives and values over 100. */
export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) throw new SplitError('Percentages cannot be negative.');
  const bp = Math.round(percent * 100);
  if (Math.abs(bp - percent * 100) > 1e-6) throw new SplitError('Use at most 2 decimal places for a percentage.');
  if (bp > 10_000) throw new SplitError('A percentage cannot be more than 100.');
  return bp;
}

/**
 * Computes each participant's share in paise. Throws SplitError when the inputs do not describe a valid split:
 * - equal: nothing to enter.
 * - exact: every amount a whole number of paise, adding up to the total.
 * - percent: adding up to exactly 100.
 * - shares: every weight a positive whole number.
 */
export function computeShares(mode: SplitMode, totalPaise: number, inputs: ShareInput[]): ComputedShare[] {
  assertTotal(totalPaise);
  assertParties(inputs.map((i) => i.party));
  const parties = inputs.map((i) => i.party);

  if (mode === 'equal') {
    return allocateByWeight(totalPaise, parties.map(() => 1)).map((sharePaise, i) => ({ party: parties[i], sharePaise }));
  }

  const values = inputs.map((i) => i.value);
  if (values.some((v) => v === undefined || v === null || Number.isNaN(v as number))) throw new SplitError('Enter a value for every person.');
  const nums = values as number[];

  if (mode === 'exact') {
    if (nums.some((v) => !Number.isInteger(v) || v < 0)) throw new SplitError('Amounts must be zero or more, in whole paise.');
    const sum = nums.reduce((s, v) => s + v, 0);
    if (sum !== totalPaise) throw new SplitError(sum > totalPaise ? 'The amounts add up to more than the total.' : 'The amounts add up to less than the total.');
    return nums.map((sharePaise, i) => ({ party: parties[i], sharePaise }));
  }

  if (mode === 'percent') {
    const bps = nums.map(percentToBasisPoints);
    const sum = bps.reduce((s, v) => s + v, 0);
    if (sum !== 10_000) throw new SplitError('The percentages must add up to 100.');
    return allocateByWeight(totalPaise, bps).map((sharePaise, i) => ({ party: parties[i], sharePaise }));
  }

  // shares
  if (nums.some((v) => !Number.isInteger(v) || v <= 0)) throw new SplitError('Each share must be a whole number of at least 1.');
  if (nums.some((v) => v > MAX_WEIGHT)) throw new SplitError('That share is too large.');
  return allocateByWeight(totalPaise, nums).map((sharePaise, i) => ({ party: parties[i], sharePaise }));
}

export interface PayerInput { party: string; paidPaise: number }

/** Payers must be whole paise, each positive, and add up to exactly the total. A payer need not be a participant. */
export function validatePayers(totalPaise: number, payers: PayerInput[]): void {
  assertTotal(totalPaise);
  if (payers.length === 0) throw new SplitError('Choose who paid.');
  if (new Set(payers.map((p) => p.party)).size !== payers.length) throw new SplitError('Each payer can appear only once.');
  if (payers.some((p) => !Number.isInteger(p.paidPaise) || p.paidPaise <= 0)) throw new SplitError('Each payer must have paid more than zero.');
  const sum = payers.reduce((s, p) => s + p.paidPaise, 0);
  if (sum !== totalPaise) throw new SplitError(sum > totalPaise ? 'The amounts paid add up to more than the total.' : 'The amounts paid add up to less than the total.');
}

export interface PartyAmounts { party: string; paidPaise: number; sharePaise: number }

/**
 * Merges payers and participants into one row per party (paid and share). A payer who is not a participant gets share 0;
 * a participant who did not pay gets paid 0. The result is what is stored and what balances are derived from.
 */
export function buildPartyAmounts(totalPaise: number, shares: ComputedShare[], payers: PayerInput[]): PartyAmounts[] {
  validatePayers(totalPaise, payers);
  const shareSum = shares.reduce((s, x) => s + x.sharePaise, 0);
  if (shareSum !== totalPaise) throw new SplitError('The shares do not add up to the total.');
  const map = new Map<string, PartyAmounts>();
  for (const s of shares) map.set(s.party, { party: s.party, paidPaise: 0, sharePaise: s.sharePaise });
  for (const p of payers) {
    const cur = map.get(p.party);
    if (cur) cur.paidPaise = p.paidPaise; else map.set(p.party, { party: p.party, paidPaise: p.paidPaise, sharePaise: 0 });
  }
  return [...map.values()];
}

/** The device owner's own share of a set of party rows (0 when not a participant). */
export function ownSharePaise(rows: Pick<PartyAmounts, 'party' | 'sharePaise'>[]): number {
  return rows.find((r) => r.party === SELF)?.sharePaise ?? 0;
}
