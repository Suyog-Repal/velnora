/**
 * Balances, pairwise debts and debt simplification. Pure and integer-only (paise).
 *
 * Balances are always DERIVED from expenses and settlements, never cached, so editing or deleting an expense (or a settlement)
 * recomputes them for free.
 *
 * Sign convention: net > 0 means the party is owed money; net < 0 means the party owes money.
 * net(party) = sum(paid - share) over expenses, then settlements: a payment from X to Y raises X's net and lowers Y's.
 * The nets of all parties always add up to exactly zero (asserted by assertBalanced and unit tested).
 */
import { allocateByWeight, SELF, type PartyAmounts } from './splitMath.ts';

export interface LedgerExpense { id: string; groupId: string | null; rows: PartyAmounts[] }
export interface LedgerSettlement { id: string; groupId: string | null; from: string; to: string; amountPaise: number }
export interface Debt { from: string; to: string; paise: number }

/** Restricts to one group, or (groupId === null) to expenses and settlements that belong to no group. undefined = everything. */
export function inScope<T extends { groupId: string | null }>(items: T[], groupId: string | null | undefined): T[] {
  return groupId === undefined ? items : items.filter((i) => i.groupId === groupId);
}

export function netBalances(expenses: LedgerExpense[], settlements: LedgerSettlement[]): Map<string, number> {
  const nets = new Map<string, number>();
  const add = (party: string, n: number) => { nets.set(party, (nets.get(party) ?? 0) + n); };
  for (const e of expenses) for (const r of e.rows) add(r.party, r.paidPaise - r.sharePaise);
  for (const s of settlements) { add(s.from, s.amountPaise); add(s.to, -s.amountPaise); }
  for (const [k, v] of nets) if (v === 0) nets.delete(k);
  return nets;
}

/** Throws if the nets do not add up to zero. A violation means a stored expense or settlement is corrupt. */
export function assertBalanced(nets: Map<string, number>): void {
  let sum = 0;
  for (const v of nets.values()) sum += v;
  if (sum !== 0) throw new Error(`Split balances are inconsistent (off by ${sum} paise).`);
}

/**
 * Who owes whom inside ONE expense. Each party that owes (share > paid) pays the parties that are owed (paid > share),
 * in proportion to how much each of them is owed. With one payer that is exactly "everyone owes the payer their share".
 */
export function expenseDebts(rows: PartyAmounts[]): Debt[] {
  const debtors = rows.filter((r) => r.sharePaise > r.paidPaise).map((r) => ({ party: r.party, owes: r.sharePaise - r.paidPaise }));
  const creditors = rows.filter((r) => r.paidPaise > r.sharePaise).map((r) => ({ party: r.party, owed: r.paidPaise - r.sharePaise }));
  const out: Debt[] = [];
  for (const d of debtors) {
    const parts = allocateByWeight(d.owes, creditors.map((c) => c.owed));
    parts.forEach((paise, i) => { if (paise > 0) out.push({ from: d.party, to: creditors[i].party, paise }); });
  }
  return out;
}

/**
 * Net amount each pair of parties owes one another after every expense and settlement, opposite directions netted.
 * Only non-zero pairs are returned. This is the "before" picture for Simplify debts.
 */
export function pairwiseDebts(expenses: LedgerExpense[], settlements: LedgerSettlement[]): Debt[] {
  const m = new Map<string, number>(); // key "a\u0000b" with a < b; value > 0: a owes b, < 0: b owes a
  const add = (from: string, to: string, n: number) => {
    if (from === to) return;
    if (from < to) { const k = `${from}\u0000${to}`; m.set(k, (m.get(k) ?? 0) + n); }
    else { const k = `${to}\u0000${from}`; m.set(k, (m.get(k) ?? 0) - n); }
  };
  for (const e of expenses) for (const d of expenseDebts(e.rows)) add(d.from, d.to, d.paise);
  for (const s of settlements) add(s.from, s.to, -s.amountPaise); // paying X's debt reduces what X owes
  const out: Debt[] = [];
  for (const [k, v] of m) {
    if (v === 0) continue;
    const [a, b] = k.split('\u0000');
    out.push(v > 0 ? { from: a, to: b, paise: v } : { from: b, to: a, paise: -v });
  }
  return out.sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

/** Signed balance between the device owner and each other party: positive = they owe me, negative = I owe them. */
export function balancesWithMe(debts: Debt[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of debts) {
    if (d.to === SELF) out.set(d.from, (out.get(d.from) ?? 0) + d.paise);
    else if (d.from === SELF) out.set(d.to, (out.get(d.to) ?? 0) - d.paise);
  }
  return out;
}

/** What the owner is owed overall and what the owner owes overall, from per-person balances. */
export function totalsFromBalances(withMe: Map<string, number>): { owedToMePaise: number; iOwePaise: number } {
  let owedToMePaise = 0; let iOwePaise = 0;
  for (const v of withMe.values()) { if (v > 0) owedToMePaise += v; else iOwePaise -= v; }
  return { owedToMePaise, iOwePaise };
}

/**
 * Fewest-payments settlement plan from net balances (greedy: the biggest debtor pays the biggest creditor).
 * Deterministic (ties by party id). Applying the plan leaves every party's net exactly as it was, and it never needs more
 * payments than there are parties with a non-zero balance minus one.
 */
export function simplifyDebts(nets: Map<string, number>): Debt[] {
  const debtors = [...nets].filter(([, v]) => v < 0).map(([party, v]) => ({ party, left: -v }));
  const creditors = [...nets].filter(([, v]) => v > 0).map(([party, v]) => ({ party, left: v }));
  const order = (a: { party: string; left: number }, b: { party: string; left: number }) => b.left - a.left || a.party.localeCompare(b.party);
  const out: Debt[] = [];
  while (debtors.length && creditors.length) {
    debtors.sort(order); creditors.sort(order);
    const d = debtors[0]; const c = creditors[0];
    const paise = Math.min(d.left, c.left);
    out.push({ from: d.party, to: c.party, paise });
    d.left -= paise; c.left -= paise;
    if (d.left === 0) debtors.shift();
    if (c.left === 0) creditors.shift();
  }
  return out;
}

/** Net balances implied by a list of payments (used to prove a simplified plan changes nobody's position). */
export function netsOfPayments(payments: Debt[]): Map<string, number> {
  const nets = new Map<string, number>();
  for (const p of payments) {
    nets.set(p.from, (nets.get(p.from) ?? 0) - p.paise);
    nets.set(p.to, (nets.get(p.to) ?? 0) + p.paise);
  }
  for (const [k, v] of nets) if (v === 0) nets.delete(k);
  return nets;
}

export interface SimplifyPreview { before: Debt[]; after: Debt[]; beforeCount: number; afterCount: number }

/** The "5 payments -> 3" preview for a scope (group or all). */
export function previewSimplify(expenses: LedgerExpense[], settlements: LedgerSettlement[]): SimplifyPreview {
  const before = pairwiseDebts(expenses, settlements);
  const nets = netsOfPayments(before);
  assertBalanced(nets);
  const planned = simplifyDebts(nets);
  // Both plans leave every net unchanged; never offer a "simplification" that needs more payments than doing nothing.
  const after = planned.length <= before.length ? planned : before;
  return { before, after, beforeCount: before.length, afterCount: after.length };
}
