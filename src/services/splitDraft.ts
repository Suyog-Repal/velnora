/**
 * The split form's state and its evaluation. Pure (no React, no database), so every rule the form shows is unit tested.
 * The service layer validates again when saving; this is what makes the form live and its errors inline.
 */
import { SELF, SplitError, buildPartyAmounts, computeShares, percentToBasisPoints, type PartyAmounts, type ShareInput, type SplitMode } from './splitMath.ts';
import type { SplitExpense, SplitExpenseInput } from './splitService.ts';

export interface SplitDraft {
  enabled: boolean;
  groupId: string | null;
  /** Everyone sharing the cost, in the order remainder paise are handed out. Includes SELF when the owner shares it. */
  participants: string[];
  payer: string;
  mode: SplitMode;
  /** Per-person text as typed: rupees (exact), percent, or share count. Ignored for equal. */
  values: Record<string, string>;
}

export const emptyDraft = (): SplitDraft => ({ enabled: false, groupId: null, participants: [SELF], payer: SELF, mode: 'equal', values: {} });

/** "1,25,000.5" -> 12500050. Null when it is not a valid amount with at most 2 decimals. */
export function parseMoneyToPaise(text: string): number | null {
  const t = text.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const paise = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

export const paiseToInput = (paise: number): string => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

export interface DraftEvaluation {
  ok: boolean;
  error: string | null;
  /** Live share per person; null while it cannot be computed yet. */
  perPerson: { party: string; sharePaise: number | null }[];
  /** What this expense counts as in the owner's spending: their own share (0 when they are not part of the split). */
  ownSharePaise: number | null;
  paidByMe: boolean;
  /** Exact: paise still to assign (negative = over). Percent: hundredths of a percent still to assign. Null otherwise. */
  remaining: { unit: 'paise' | 'percent'; amount: number } | null;
  /** Equal split where the amount is too small to give everyone a paisa: these people get 0. */
  zeroShare: string[];
  input: Pick<SplitExpenseInput, 'mode' | 'participants' | 'payers'> | null;
}

export function evaluateDraft(d: SplitDraft, totalPaise: number | null): DraftEvaluation {
  const base: DraftEvaluation = { ok: false, error: null, perPerson: d.participants.map((party) => ({ party, sharePaise: null })), ownSharePaise: null, paidByMe: d.payer === SELF, remaining: null, zeroShare: [], input: null };
  if (!totalPaise || totalPaise <= 0) return { ...base, error: 'Enter the amount first.' };
  if (d.participants.length === 0) return { ...base, error: 'Choose at least one person to split with.' };
  if (d.participants.length === 1 && d.participants[0] === SELF && d.payer === SELF) return { ...base, error: 'Add at least one other person to split with.' };

  const inputs: ShareInput[] = d.participants.map((party) => ({ party }));
  if (d.mode !== 'equal') {
    let missing = false;
    inputs.forEach((i) => {
      const raw = (d.values[i.party] ?? '').trim();
      if (d.mode === 'exact') { const v = raw === '' ? null : parseMoneyToPaise(raw); if (v === null) missing = true; else i.value = v; }
      else { const v = raw === '' ? NaN : Number(raw); if (!Number.isFinite(v)) missing = true; else i.value = v; }
    });
    // progress, even while incomplete
    if (d.mode === 'exact') base.remaining = { unit: 'paise', amount: totalPaise - inputs.reduce((s, i) => s + (i.value ?? 0), 0) };
    if (d.mode === 'percent') {
      let bp = 0; try { bp = inputs.reduce((s, i) => s + (i.value === undefined ? 0 : percentToBasisPoints(i.value)), 0); } catch { bp = NaN; }
      base.remaining = Number.isNaN(bp) ? null : { unit: 'percent', amount: 10_000 - bp };
    }
    if (missing) return { ...base, error: d.mode === 'exact' ? 'Enter an amount for everyone (0 is fine).' : d.mode === 'percent' ? 'Enter a percentage for everyone (0 is fine).' : 'Enter a share count for everyone.' };
  }
  try {
    const shares = computeShares(d.mode, totalPaise, inputs);
    const payers = [{ party: d.payer, paidPaise: totalPaise }];
    const rows: PartyAmounts[] = buildPartyAmounts(totalPaise, shares, payers);
    const own = shares.find((s) => s.party === SELF)?.sharePaise ?? 0;
    return {
      ...base, ok: true, error: null, perPerson: shares.map((s) => ({ party: s.party, sharePaise: s.sharePaise })), ownSharePaise: own,
      zeroShare: d.mode === 'equal' ? rows.filter((r) => r.sharePaise === 0 && r.paidPaise === 0).map((r) => r.party) : [],
      input: { mode: d.mode, participants: inputs, payers },
    };
  } catch (e) {
    if (e instanceof SplitError) return { ...base, error: e.message };
    throw e;
  }
}

/** Toggles a person in the split. The payer is kept valid: if they are removed and are not the owner, the owner pays. */
export function toggleParticipant(d: SplitDraft, party: string): SplitDraft {
  const has = d.participants.includes(party);
  const participants = has ? d.participants.filter((p) => p !== party) : [...d.participants, party];
  const values = { ...d.values }; if (has) delete values[party];
  const payer = d.payer === party && has && party !== SELF ? SELF : d.payer;
  return { ...d, participants, values, payer };
}

export function setGroup(d: SplitDraft, groupId: string | null, memberIds: string[]): SplitDraft {
  if (!groupId) return { ...d, groupId: null };
  return { ...d, groupId, participants: [SELF, ...memberIds], payer: d.payer === SELF || memberIds.includes(d.payer) ? d.payer : SELF, values: {} };
}

/** Prefills the form from a stored split. Percent and shares splits reopen as exact amounts (their original entries are not kept; the amounts are). */
export function draftFromSplit(s: Pick<SplitExpense, 'mode' | 'rows' | 'group_id'>): SplitDraft {
  const parts = s.rows.filter((r) => r.sharePaise > 0 || r.paidPaise === 0);
  const payer = [...s.rows].sort((a, b) => b.paidPaise - a.paidPaise)[0]?.party ?? SELF;
  const mode: SplitMode = s.mode === 'equal' ? 'equal' : 'exact';
  const values: Record<string, string> = {};
  if (mode === 'exact') parts.forEach((r) => { values[r.party] = paiseToInput(r.sharePaise); });
  return { enabled: true, groupId: s.group_id, participants: parts.map((r) => r.party), payer, mode, values };
}
