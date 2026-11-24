/**
 * What the People tab shows: friends with their balances, groups with theirs, and the detail of one group or friend.
 * Pure (contacts, groups and the ledger go in; plain numbers and labels come out), so every figure on those screens is unit tested.
 * Sign convention everywhere: balance > 0 = they owe the owner; balance < 0 = the owner owes them.
 */
import { SELF } from './splitMath.ts';
import { balancesWithMe, inScope, netBalances, pairwiseDebts, previewSimplify, totalsFromBalances, type LedgerExpense, type LedgerSettlement, type SimplifyPreview } from './splitBalances.ts';
import type { IDatabase } from '../db/types.ts';
import { contactLabels, listContacts, listGroups, loadLedger, type Contact, type SplitGroup } from './splitService.ts';

export interface Ledger { expenses: LedgerExpense[]; settlements: LedgerSettlement[] }

export interface FriendRow { contact: Contact; label: string; balancePaise: number }
export interface GroupRow { group: SplitGroup; /** including the owner */ memberCount: number; netPaise: number; owedToMePaise: number; iOwePaise: number }
export interface Overview {
  labels: Map<string, string>;
  friends: FriendRow[];
  groups: GroupRow[];
  archivedGroups: GroupRow[];
  /** Across friends AND groups: positive = the owner is owed overall. */
  netPaise: number;
  owedToMePaise: number;
  iOwePaise: number;
}

const byOpenThenSize = (a: { balancePaise: number; label: string }, b: { balancePaise: number; label: string }) =>
  (b.balancePaise !== 0 ? 1 : 0) - (a.balancePaise !== 0 ? 1 : 0) || Math.abs(b.balancePaise) - Math.abs(a.balancePaise) || a.label.localeCompare(b.label);

/** Labels for every person ever involved (deleted friends keep their name in history), 'You' for the owner, disambiguated duplicates. */
export function labelsFor(allContacts: Contact[]): Map<string, string> {
  const m = contactLabels(allContacts);
  m.set(SELF, 'You');
  return m;
}

export function buildOverview(activeContacts: Contact[], allContacts: Contact[], groups: SplitGroup[], ledger: Ledger): Overview {
  const labels = labelsFor(allContacts);
  const withMe = balancesWithMe(pairwiseDebts(ledger.expenses, ledger.settlements));
  const { owedToMePaise, iOwePaise } = totalsFromBalances(withMe);
  const friends: FriendRow[] = activeContacts.map((c) => ({ contact: c, label: labels.get(c.id) ?? c.name, balancePaise: withMe.get(c.id) ?? 0 })).sort(byOpenThenSize);
  const groupRow = (g: SplitGroup): GroupRow => {
    const t = totalsFromBalances(balancesWithMe(pairwiseDebts(inScope(ledger.expenses, g.id), inScope(ledger.settlements, g.id))));
    return { group: g, memberCount: g.memberIds.length + 1, netPaise: t.owedToMePaise - t.iOwePaise, owedToMePaise: t.owedToMePaise, iOwePaise: t.iOwePaise };
  };
  const rows = groups.map(groupRow);
  const order = (a: GroupRow, b: GroupRow) => (b.netPaise !== 0 ? 1 : 0) - (a.netPaise !== 0 ? 1 : 0) || Math.abs(b.netPaise) - Math.abs(a.netPaise) || a.group.name.localeCompare(b.group.name);
  return {
    labels, friends,
    groups: rows.filter((r) => !r.group.archived_at).sort(order),
    archivedGroups: rows.filter((r) => !!r.group.archived_at).sort(order),
    netPaise: owedToMePaise - iOwePaise, owedToMePaise, iOwePaise,
  };
}

export interface MemberRow { id: string; label: string; balancePaise: number }
export interface GroupDetail {
  members: MemberRow[];
  netPaise: number; owedToMePaise: number; iOwePaise: number;
  /** Everyone's position in the group (not just the owner's): drives "Simplify debts". */
  simplify: SimplifyPreview;
  settled: boolean;
}

export function buildGroupDetail(group: SplitGroup, labels: Map<string, string>, ledger: Ledger): GroupDetail {
  const expenses = inScope(ledger.expenses, group.id); const settlements = inScope(ledger.settlements, group.id);
  const withMe = balancesWithMe(pairwiseDebts(expenses, settlements));
  const t = totalsFromBalances(withMe);
  const members: MemberRow[] = group.memberIds.map((id) => ({ id, label: labels.get(id) ?? 'Removed person', balancePaise: withMe.get(id) ?? 0 }))
    .sort((a, b) => byOpenThenSize({ balancePaise: a.balancePaise, label: a.label }, { balancePaise: b.balancePaise, label: b.label }));
  const nets = netBalances(expenses, settlements);
  return { members, netPaise: t.owedToMePaise - t.iOwePaise, owedToMePaise: t.owedToMePaise, iOwePaise: t.iOwePaise, simplify: previewSimplify(expenses, settlements), settled: [...nets.values()].every((v) => v === 0) };
}

export interface FriendScopeRow { groupId: string | null; groupName: string | null; balancePaise: number }
export interface FriendDetail { balancePaise: number; scopes: FriendScopeRow[] }

/** The owner's balance with one friend: overall, and split by group / outside any group. */
export function buildFriendDetail(friendId: string, groups: SplitGroup[], ledger: Ledger): FriendDetail {
  const ids = new Set<string | null>([null, ...ledger.expenses.map((e) => e.groupId), ...ledger.settlements.map((s) => s.groupId)]);
  const scopes: FriendScopeRow[] = [];
  for (const id of ids) {
    const bal = balancesWithMe(pairwiseDebts(inScope(ledger.expenses, id), inScope(ledger.settlements, id))).get(friendId) ?? 0;
    if (bal !== 0) scopes.push({ groupId: id, groupName: id === null ? null : groups.find((g) => g.id === id)?.name ?? 'Deleted group', balancePaise: bal });
  }
  scopes.sort((a, b) => Math.abs(b.balancePaise) - Math.abs(a.balancePaise) || (a.groupName ?? '').localeCompare(b.groupName ?? ''));
  return { balancePaise: scopes.reduce((s, r) => s + r.balancePaise, 0), scopes };
}

/** "owes you", "you owe" or "settled up", for a signed balance. */
export function balanceWord(balancePaise: number): 'owes_you' | 'you_owe' | 'settled' {
  return balancePaise > 0 ? 'owes_you' : balancePaise < 0 ? 'you_owe' : 'settled';
}

/**
 * How a payment between the owner and a friend is split over the places the debt lives (each group, and outside groups), so that
 * every group view shrinks too and the friend balance and the group balances never disagree. Settles the largest amounts first;
 * anything beyond what is owed goes to "outside groups" (the balance flips).
 */
export function allocateFriendPayment(scopes: FriendScopeRow[], direction: 'they_pay' | 'i_pay', amountPaise: number): { groupId: string | null; paise: number }[] {
  const sign = direction === 'they_pay' ? 1 : -1;
  const open = scopes.filter((s) => s.balancePaise * sign > 0).sort((a, b) => Math.abs(b.balancePaise) - Math.abs(a.balancePaise) || (a.groupName ?? '').localeCompare(b.groupName ?? ''));
  const out: { groupId: string | null; paise: number }[] = [];
  let left = amountPaise;
  for (const s of open) {
    if (left <= 0) break;
    const paise = Math.min(left, Math.abs(s.balancePaise));
    out.push({ groupId: s.groupId, paise }); left -= paise;
  }
  if (left > 0) {
    const existing = out.find((o) => o.groupId === null);
    if (existing) existing.paise += left; else out.push({ groupId: null, paise: left });
  }
  return out;
}

/** Everything the People tab needs, read from the local database in one go. */
export async function loadOverview(db: IDatabase, scope: string | null): Promise<{ overview: Overview; ledger: Ledger; allGroups: SplitGroup[]; allContacts: Contact[] }> {
  const [active, allContacts, allGroups, ledger] = await Promise.all([listContacts(db, scope), listContacts(db, scope, { includeDeleted: true }), listGroups(db, scope, { includeArchived: true }), loadLedger(db, scope)]);
  return { overview: buildOverview(active, allContacts, allGroups, ledger), ledger, allGroups, allContacts };
}
