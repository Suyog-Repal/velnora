/**
 * Split payments: contacts (friends), groups, split expenses, settlements. LOCAL ONLY (v1): these tables have no sync columns
 * and nothing here ever touches the sync queue. Phone numbers and UPI ids never leave the device.
 *
 * Balances are derived from the stored records (see splitBalances.ts), so edits and deletes need no recomputation step.
 * 'me' (SELF) is the device owner; every other party id is a contacts.id.
 */
import { withWriteLock } from '../db/writeLock.ts';
import { generateUUID } from '../db/repositories/syncQueueRepository.ts';
import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { normalizeMerchantKey } from './merchantAliasService.ts';
import { listExpected, type ExpectedPayment } from './expectedPaymentService.ts';
import {
  SELF, SplitError, allocateByWeight, buildPartyAmounts, computeShares, type PartyAmounts, type PayerInput, type ShareInput, type SplitMode,
} from './splitMath.ts';
import {
  balancesWithMe, inScope, netBalances, pairwiseDebts, previewSimplify, totalsFromBalances,
  type Debt, type LedgerExpense, type LedgerSettlement, type SimplifyPreview,
} from './splitBalances.ts';

const scopeWhere = (alias = '') => `(${alias}user_id = ? OR (${alias}user_id IS NULL AND ? IS NULL))`;

export interface Contact { id: string; user_id: string | null; name: string; name_key: string; phone: string | null; upi_id: string | null; created_at: string; updated_at: string }
export interface SplitGroup { id: string; user_id: string | null; name: string; archived_at: string | null; created_at: string; updated_at: string; memberIds: string[] }
export interface SplitExpense {
  id: string; user_id: string | null; group_id: string | null; transaction_id: string | null; title: string; category: string; total_paise: number;
  expense_date: string; mode: SplitMode; note: string | null; created_at: string; updated_at: string; rows: PartyAmounts[];
}
export interface Settlement { id: string; user_id: string | null; group_id: string | null; from_party: string; to_party: string; amount_paise: number; settled_on: string; note: string | null; created_at: string }

const now = () => new Date().toISOString();

export async function inTransaction<T>(db: IDatabase, fn: () => Promise<T>): Promise<T> {
  return withWriteLock(async () => {
    await db.execAsync('BEGIN TRANSACTION');
    try { const r = await fn(); await db.execAsync('COMMIT'); return r; } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
}

function cleanName(name: string, what = 'name'): string {
  const n = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new SplitError(`Enter a ${what}.`);
  if (n.length > 80) throw new SplitError(`The ${what} is too long.`);
  return n;
}
function cleanPhone(phone?: string | null): string | null {
  const p = (phone ?? '').replace(/[\s()-]/g, '');
  if (!p) return null;
  if (!/^\+?\d{7,15}$/.test(p)) throw new SplitError('Enter a valid phone number, digits only (with country code if you can).');
  return p;
}
function cleanUpi(upi?: string | null): string | null {
  const u = (upi ?? '').trim();
  if (!u) return null;
  if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(u)) throw new SplitError('Enter a valid UPI ID, like name@bank.');
  return u;
}
function cleanDate(d: string): string {
  if (!d || Number.isNaN(new Date(d).getTime())) throw new SplitError('Enter a valid date.');
  return d;
}

// ------------------------------------------------------------------------------------------------------------- contacts
export async function listContacts(db: IDatabase, scope: Scope, opts: { includeDeleted?: boolean } = {}): Promise<Contact[]> {
  return db.getAllAsync<Contact>(
    `SELECT id, user_id, name, name_key, phone, upi_id, created_at, updated_at FROM contacts WHERE ${opts.includeDeleted ? '1 = 1' : 'deleted_at IS NULL'} AND ${scopeWhere()} ORDER BY name_key, created_at`,
    scope, scope);
}

export async function getContact(db: IDatabase, scope: Scope, id: string): Promise<Contact | null> {
  return db.getFirstAsync<Contact>(`SELECT id, user_id, name, name_key, phone, upi_id, created_at, updated_at FROM contacts WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere()}`, id, scope, scope);
}

/** Two contacts may share a name (they are different people): ids are the identity. See contactLabels for display. */
export async function createContact(db: IDatabase, scope: Scope, input: { name: string; phone?: string | null; upiId?: string | null }): Promise<Contact> {
  const name = cleanName(input.name);
  const c: Contact = { id: generateUUID(), user_id: scope, name, name_key: normalizeMerchantKey(name) || name.toLowerCase(), phone: cleanPhone(input.phone), upi_id: cleanUpi(input.upiId), created_at: now(), updated_at: now() };
  await inTransaction(db, async () => {
    await db.runAsync(`INSERT INTO contacts (id, user_id, name, name_key, phone, upi_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, scope, c.name, c.name_key, c.phone, c.upi_id, c.created_at, c.updated_at);
  });
  return c;
}

export async function updateContact(db: IDatabase, scope: Scope, id: string, patch: { name?: string; phone?: string | null; upiId?: string | null }): Promise<Contact> {
  return inTransaction(db, async () => {
    const cur = await getContact(db, scope, id);
    if (!cur) throw new SplitError('That person was not found.');
    const next: Contact = { ...cur, updated_at: now() };
    if (patch.name !== undefined) { next.name = cleanName(patch.name); next.name_key = normalizeMerchantKey(next.name) || next.name.toLowerCase(); }
    if (patch.phone !== undefined) next.phone = cleanPhone(patch.phone);
    if (patch.upiId !== undefined) next.upi_id = cleanUpi(patch.upiId);
    await db.runAsync(`UPDATE contacts SET name = ?, name_key = ?, phone = ?, upi_id = ?, updated_at = ? WHERE id = ?`, next.name, next.name_key, next.phone, next.upi_id, next.updated_at, id);
    return next;
  });
}

/**
 * Display names that stay unique: a second "Rohan" shows as "Rohan (…4567)" using the phone's last digits, else "Rohan (2)".
 * Pure: pass the contacts to label.
 */
export function contactLabels(contacts: Pick<Contact, 'id' | 'name' | 'name_key' | 'phone'>[]): Map<string, string> {
  const byKey = new Map<string, typeof contacts>();
  for (const c of contacts) byKey.set(c.name_key, [...(byKey.get(c.name_key) ?? []), c]);
  const out = new Map<string, string>();
  for (const list of byKey.values()) {
    list.forEach((c, i) => {
      if (list.length === 1) { out.set(c.id, c.name); return; }
      const tail = c.phone ? c.phone.slice(-4) : '';
      const phoneUnique = tail && list.filter((o) => (o.phone ?? '').slice(-4) === tail).length === 1;
      out.set(c.id, phoneUnique ? `${c.name} (…${tail})` : `${c.name} (${i + 1})`);
    });
  }
  return out;
}

/** Legacy Expected rows for this contact, matched by normalised name only. Read-only: legacy data is never migrated or changed. */
export async function expectedForContact(db: IDatabase, scope: Scope, contact: Pick<Contact, 'name_key'>): Promise<ExpectedPayment[]> {
  return (await listExpected(db, scope)).filter((e) => e.person_key === contact.name_key);
}

// -------------------------------------------------------------------------------------------------------------- ledger
export async function loadLedger(db: IDatabase, scope: Scope): Promise<{ expenses: LedgerExpense[]; settlements: LedgerSettlement[] }> {
  const exp = await db.getAllAsync<{ id: string; group_id: string | null }>(`SELECT id, group_id FROM split_expenses WHERE deleted_at IS NULL AND ${scopeWhere()}`, scope, scope);
  const shares = await db.getAllAsync<{ expense_id: string; party_id: string; paid_paise: number; share_paise: number }>(
    `SELECT s.expense_id, s.party_id, s.paid_paise, s.share_paise FROM split_shares s JOIN split_expenses e ON e.id = s.expense_id WHERE e.deleted_at IS NULL AND ${scopeWhere('e.')}`, scope, scope);
  const byExp = new Map<string, PartyAmounts[]>();
  for (const s of shares) byExp.set(s.expense_id, [...(byExp.get(s.expense_id) ?? []), { party: s.party_id, paidPaise: s.paid_paise, sharePaise: s.share_paise }]);
  const st = await db.getAllAsync<{ id: string; group_id: string | null; from_party: string; to_party: string; amount_paise: number }>(
    `SELECT id, group_id, from_party, to_party, amount_paise FROM settlements WHERE deleted_at IS NULL AND ${scopeWhere()}`, scope, scope);
  return {
    expenses: exp.map((e) => ({ id: e.id, groupId: e.group_id, rows: byExp.get(e.id) ?? [] })),
    settlements: st.map((s) => ({ id: s.id, groupId: s.group_id, from: s.from_party, to: s.to_party, amountPaise: s.amount_paise })),
  };
}

/** Pairwise debts in a scope: groupId = a group, null = outside any group, undefined = everything. */
export async function getDebts(db: IDatabase, scope: Scope, groupId?: string | null): Promise<Debt[]> {
  const l = await loadLedger(db, scope);
  return pairwiseDebts(inScope(l.expenses, groupId), inScope(l.settlements, groupId));
}

/** Per-person signed balance with the owner (positive = they owe me) plus the overall totals. */
export async function getBalancesWithMe(db: IDatabase, scope: Scope, groupId?: string | null): Promise<{ perParty: Map<string, number>; owedToMePaise: number; iOwePaise: number }> {
  const perParty = balancesWithMe(await getDebts(db, scope, groupId));
  return { perParty, ...totalsFromBalances(perParty) };
}

export async function getSimplifyPreview(db: IDatabase, scope: Scope, groupId: string): Promise<SimplifyPreview> {
  const l = await loadLedger(db, scope);
  return previewSimplify(inScope(l.expenses, groupId), inScope(l.settlements, groupId));
}

async function partyHasOpenBalance(db: IDatabase, scope: Scope, party: string, groupId?: string): Promise<boolean> {
  const l = await loadLedger(db, scope);
  const nets = netBalances(groupId ? inScope(l.expenses, groupId) : l.expenses, groupId ? inScope(l.settlements, groupId) : l.settlements);
  return (nets.get(party) ?? 0) !== 0;
}

/** Blocked while the person is owed or owes anything (never silently lose a debt). Otherwise removed from groups and hidden. */
export async function deleteContact(db: IDatabase, scope: Scope, id: string): Promise<void> {
  if (await partyHasOpenBalance(db, scope, id)) throw new SplitError('This person has an unsettled balance. Settle up first, then delete.');
  await inTransaction(db, async () => {
    const t = now();
    await db.runAsync(`DELETE FROM group_members WHERE contact_id = ?`, id);
    await db.runAsync(`UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND ${scopeWhere()}`, t, t, id, scope, scope);
  });
}

// --------------------------------------------------------------------------------------------------------------- groups
export async function listGroups(db: IDatabase, scope: Scope, opts: { includeArchived?: boolean } = {}): Promise<SplitGroup[]> {
  const groups = await db.getAllAsync<Omit<SplitGroup, 'memberIds'>>(
    `SELECT id, user_id, name, archived_at, created_at, updated_at FROM split_groups WHERE deleted_at IS NULL AND ${scopeWhere()} ${opts.includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY created_at DESC, id`, scope, scope);
  const members = await db.getAllAsync<{ group_id: string; contact_id: string }>(
    `SELECT m.group_id, m.contact_id FROM group_members m JOIN split_groups g ON g.id = m.group_id WHERE g.deleted_at IS NULL AND ${scopeWhere('g.')} ORDER BY m.added_at, m.contact_id`, scope, scope);
  return groups.map((g) => ({ ...g, memberIds: members.filter((m) => m.group_id === g.id).map((m) => m.contact_id) }));
}

async function requireGroup(db: IDatabase, scope: Scope, id: string): Promise<SplitGroup> {
  const g = (await listGroups(db, scope, { includeArchived: true })).find((x) => x.id === id);
  if (!g) throw new SplitError('That group was not found.');
  return g;
}

async function requireContacts(db: IDatabase, scope: Scope, ids: string[]): Promise<void> {
  const have = new Set((await listContacts(db, scope)).map((c) => c.id));
  if (ids.some((i) => !have.has(i))) throw new SplitError('One of the people was not found.');
}

export async function createGroup(db: IDatabase, scope: Scope, input: { name: string; memberIds: string[] }): Promise<SplitGroup> {
  const name = cleanName(input.name, 'group name');
  const memberIds = [...new Set(input.memberIds)];
  await requireContacts(db, scope, memberIds);
  const id = generateUUID(); const t = now();
  await inTransaction(db, async () => {
    await db.runAsync(`INSERT INTO split_groups (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, id, scope, name, t, t);
    for (const c of memberIds) await db.runAsync(`INSERT INTO group_members (group_id, contact_id, added_at) VALUES (?, ?, ?)`, id, c, t);
  });
  return { id, user_id: scope, name, archived_at: null, created_at: t, updated_at: t, memberIds };
}

export async function renameGroup(db: IDatabase, scope: Scope, id: string, name: string): Promise<void> {
  const n = cleanName(name, 'group name');
  await requireGroup(db, scope, id);
  await inTransaction(db, async () => { await db.runAsync(`UPDATE split_groups SET name = ?, updated_at = ? WHERE id = ?`, n, now(), id); });
}

export async function addGroupMember(db: IDatabase, scope: Scope, groupId: string, contactId: string): Promise<void> {
  await requireGroup(db, scope, groupId); await requireContacts(db, scope, [contactId]);
  await inTransaction(db, async () => { await db.runAsync(`INSERT OR IGNORE INTO group_members (group_id, contact_id, added_at) VALUES (?, ?, ?)`, groupId, contactId, now()); });
}

/** Blocked while the member has an unsettled balance in the group. */
export async function removeGroupMember(db: IDatabase, scope: Scope, groupId: string, contactId: string): Promise<void> {
  await requireGroup(db, scope, groupId);
  if (await partyHasOpenBalance(db, scope, contactId, groupId)) throw new SplitError('This person has an unsettled balance in the group. Settle up first.');
  await inTransaction(db, async () => { await db.runAsync(`DELETE FROM group_members WHERE group_id = ? AND contact_id = ?`, groupId, contactId); });
}

/** A group with any unsettled balance can be neither deleted nor archived. */
export async function archiveGroup(db: IDatabase, scope: Scope, id: string): Promise<void> {
  await assertGroupSettled(db, scope, id);
  await inTransaction(db, async () => { const t = now(); await db.runAsync(`UPDATE split_groups SET archived_at = ?, updated_at = ? WHERE id = ?`, t, t, id); });
}

export async function unarchiveGroup(db: IDatabase, scope: Scope, id: string): Promise<void> {
  await requireGroup(db, scope, id);
  await inTransaction(db, async () => { await db.runAsync(`UPDATE split_groups SET archived_at = NULL, updated_at = ? WHERE id = ?`, now(), id); });
}

export async function deleteGroup(db: IDatabase, scope: Scope, id: string): Promise<void> {
  await assertGroupSettled(db, scope, id);
  await inTransaction(db, async () => {
    const t = now();
    await db.runAsync(`UPDATE split_groups SET deleted_at = ?, updated_at = ? WHERE id = ?`, t, t, id);
    // its expenses and settlements go with it, so no orphan can keep counting in spending
    await db.runAsync(`UPDATE split_expenses SET deleted_at = ?, updated_at = ? WHERE group_id = ? AND deleted_at IS NULL`, t, t, id);
    await db.runAsync(`UPDATE settlements SET deleted_at = ?, updated_at = ? WHERE group_id = ? AND deleted_at IS NULL`, t, t, id);
  });
}

async function assertGroupSettled(db: IDatabase, scope: Scope, id: string): Promise<void> {
  await requireGroup(db, scope, id);
  const l = await loadLedger(db, scope);
  const nets = netBalances(inScope(l.expenses, id), inScope(l.settlements, id));
  if ([...nets.values()].some((v) => v !== 0)) throw new SplitError('This group has unsettled balances. Settle up first.');
}

// ---------------------------------------------------------------------------------------------------- split expenses
export interface SplitExpenseInput {
  groupId?: string | null;
  /** Link to an existing transaction ("Split this"). Its amount must equal totalPaise. */
  transactionId?: string | null;
  title: string; category: string; totalPaise: number; expenseDate: string; note?: string | null;
  mode: SplitMode;
  /** Who shares the cost, in the order remainder paise are handed out. Use SELF for the device owner. */
  participants: ShareInput[];
  /** Who paid (one or several). A payer need not be a participant. */
  payers: PayerInput[];
}

async function prepare(db: IDatabase, scope: Scope, input: SplitExpenseInput, selfId?: string): Promise<{ rows: PartyAmounts[]; title: string; category: string; date: string; note: string | null }> {
  const title = cleanName(input.title, 'title');
  const category = cleanName(input.category, 'category');
  const date = cleanDate(input.expenseDate);
  const shares = computeShares(input.mode, input.totalPaise, input.participants);
  const rows = buildPartyAmounts(input.totalPaise, shares, input.payers);
  const others = rows.map((r) => r.party).filter((p) => p !== SELF);
  await requireContacts(db, scope, others);
  if (input.groupId) {
    const g = await requireGroup(db, scope, input.groupId);
    if (others.some((p) => !g.memberIds.includes(p))) throw new SplitError('Everyone in a group expense must be a member of the group.');
  }
  if (input.transactionId) {
    const tx = await db.getFirstAsync<{ amount_paise: number | null; amount: number; direction: string }>(
      `SELECT amount_paise, amount, direction FROM transactions WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere()}`, input.transactionId, scope, scope);
    if (!tx) throw new SplitError('That transaction was not found.');
    if (tx.direction !== 'expense') throw new SplitError('Only an expense can be split.');
    if ((tx.amount_paise ?? Math.round(tx.amount * 100)) !== input.totalPaise) throw new SplitError('The split total must match the transaction amount.');
    const dup = await db.getFirstAsync<{ id: string }>(`SELECT id FROM split_expenses WHERE transaction_id = ? AND deleted_at IS NULL AND id != ?`, input.transactionId, selfId ?? '');
    if (dup) throw new SplitError('This transaction is already split.');
  }
  return { rows, title, category, date, note: input.note?.trim() || null };
}

async function writeRows(db: IDatabase, id: string, rows: PartyAmounts[]): Promise<void> {
  await db.runAsync(`DELETE FROM split_shares WHERE expense_id = ?`, id);
  for (const r of rows) await db.runAsync(`INSERT INTO split_shares (expense_id, party_id, paid_paise, share_paise) VALUES (?, ?, ?, ?)`, id, r.party, r.paidPaise, r.sharePaise);
}

export async function createSplitExpense(db: IDatabase, scope: Scope, input: SplitExpenseInput): Promise<SplitExpense> {
  const p = await prepare(db, scope, input);
  const id = generateUUID(); const t = now();
  await inTransaction(db, async () => {
    await db.runAsync(
      `INSERT INTO split_expenses (id, user_id, group_id, transaction_id, title, category, total_paise, expense_date, mode, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, scope, input.groupId ?? null, input.transactionId ?? null, p.title, p.category, input.totalPaise, p.date, input.mode, p.note, t, t);
    await writeRows(db, id, p.rows);
  });
  return { id, user_id: scope, group_id: input.groupId ?? null, transaction_id: input.transactionId ?? null, title: p.title, category: p.category, total_paise: input.totalPaise, expense_date: p.date, mode: input.mode, note: p.note, created_at: t, updated_at: t, rows: p.rows };
}

/** Replaces an expense's total, split and payers in one step. Balances follow automatically (they are derived). */
export async function updateSplitExpense(db: IDatabase, scope: Scope, id: string, input: SplitExpenseInput): Promise<void> {
  const cur = await getSplitExpense(db, scope, id);
  if (!cur) throw new SplitError('That expense was not found.');
  const p = await prepare(db, scope, { ...input, groupId: cur.group_id, transactionId: cur.transaction_id }, id);
  await inTransaction(db, async () => {
    await db.runAsync(`UPDATE split_expenses SET title = ?, category = ?, total_paise = ?, expense_date = ?, mode = ?, note = ?, updated_at = ? WHERE id = ?`,
      p.title, p.category, input.totalPaise, p.date, input.mode, p.note, now(), id);
    await writeRows(db, id, p.rows);
  });
}

/**
 * New participant inputs when only the TOTAL of an existing expense changes (the amount-edited-after-splitting rule):
 * equal / percent / shares re-split automatically, keeping the same proportions; exact amounts must be re-entered.
 */
export function resplitInputs(expense: Pick<SplitExpense, 'mode' | 'rows'>, newTotalPaise: number): { participants: ShareInput[]; mode: SplitMode } {
  if (expense.mode === 'exact') throw new SplitError('The amount changed. Enter the exact amounts again.');
  // A participant is anyone with a share, or who neither paid nor owes (a tiny amount can round a share to zero): they stay in the
  // split, so growing the amount later gives them their part. Only a payer-only row (paid, no share) is not a participant.
  const parts = expense.rows.filter((r) => r.sharePaise > 0 || r.paidPaise === 0);
  if (expense.mode === 'equal') return { mode: 'equal', participants: parts.map((r) => ({ party: r.party })) };
  // percent and shares: same proportions, expressed as exact amounts so the result needs no further rounding choices
  const exact = allocateByWeight(newTotalPaise, parts.map((r) => r.sharePaise));
  return { mode: 'exact', participants: parts.map((r, i) => ({ party: r.party, value: exact[i] })) };
}

/** Participants whose share is 0 in an equal split (the amount is too small to give everyone a paisa). For an inline notice. */
export function zeroSharePeople(rows: PartyAmounts[], mode: SplitMode): string[] {
  return mode === 'equal' ? rows.filter((r) => r.sharePaise === 0 && r.paidPaise === 0).map((r) => r.party) : [];
}

export async function getSplitExpense(db: IDatabase, scope: Scope, id: string): Promise<SplitExpense | null> {
  const e = await db.getFirstAsync<Omit<SplitExpense, 'rows'>>(`SELECT id, user_id, group_id, transaction_id, title, category, total_paise, expense_date, mode, note, created_at, updated_at FROM split_expenses WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere()}`, id, scope, scope);
  if (!e) return null;
  return { ...e, rows: await rowsOf(db, id) };
}

export async function getSplitForTransaction(db: IDatabase, scope: Scope, transactionId: string): Promise<SplitExpense | null> {
  const e = await db.getFirstAsync<{ id: string }>(`SELECT id FROM split_expenses WHERE transaction_id = ? AND deleted_at IS NULL AND ${scopeWhere()}`, transactionId, scope, scope);
  return e ? getSplitExpense(db, scope, e.id) : null;
}

async function rowsOf(db: IDatabase, id: string): Promise<PartyAmounts[]> {
  const rows = await db.getAllAsync<{ party_id: string; paid_paise: number; share_paise: number }>(`SELECT party_id, paid_paise, share_paise FROM split_shares WHERE expense_id = ? ORDER BY rowid`, id);
  return rows.map((r) => ({ party: r.party_id, paidPaise: r.paid_paise, sharePaise: r.share_paise }));
}

export async function listSplitExpenses(db: IDatabase, scope: Scope, opts: { groupId?: string | null; limit?: number } = {}): Promise<SplitExpense[]> {
  const where = opts.groupId === undefined ? '' : opts.groupId === null ? 'AND group_id IS NULL' : 'AND group_id = ?';
  const params: unknown[] = [scope, scope]; if (typeof opts.groupId === 'string') params.push(opts.groupId);
  const list = await db.getAllAsync<Omit<SplitExpense, 'rows'>>(
    `SELECT id, user_id, group_id, transaction_id, title, category, total_paise, expense_date, mode, note, created_at, updated_at FROM split_expenses WHERE deleted_at IS NULL AND ${scopeWhere()} ${where} ORDER BY expense_date DESC, created_at DESC, id LIMIT ${Math.max(1, Math.min(opts.limit ?? 500, 5000))}`, ...params);
  const out: SplitExpense[] = [];
  for (const e of list) out.push({ ...e, rows: await rowsOf(db, e.id) });
  return out;
}

export async function deleteSplitExpense(db: IDatabase, scope: Scope, id: string): Promise<boolean> {
  return inTransaction(db, async () => {
    const t = now();
    const r = await db.runAsync(`UPDATE split_expenses SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere()}`, t, t, id, scope, scope);
    return r.changes > 0;
  });
}

/** Called when the linked bank transaction is deleted, so its split cannot linger as a ghost. */
export async function deleteSplitForTransaction(db: IDatabase, scope: Scope, transactionId: string): Promise<void> {
  await inTransaction(db, async () => {
    const t = now();
    await db.runAsync(`UPDATE split_expenses SET deleted_at = ?, updated_at = ? WHERE transaction_id = ? AND deleted_at IS NULL AND ${scopeWhere()}`, t, t, transactionId, scope, scope);
  });
}

// ------------------------------------------------------------------------------------------------------- settlements
/**
 * Records a payment from one party to another. It reduces balances and is NEVER income or expense: it lives in its own table
 * and is not part of v_spend. A partial amount is fine. The amount is not capped at what is owed (a simplified plan can pay
 * someone the person never owed directly); the UI offers the owed amount as the default.
 */
export async function recordSettlement(db: IDatabase, scope: Scope, input: { from: string; to: string; amountPaise: number; groupId?: string | null; date?: string; note?: string | null }): Promise<Settlement> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new SplitError('Enter an amount greater than zero.');
  if (input.from === input.to) throw new SplitError('A payment needs two different people.');
  const others = [input.from, input.to].filter((p) => p !== SELF);
  await requireContacts(db, scope, others);
  if (input.groupId) await requireGroup(db, scope, input.groupId);
  const s: Settlement = { id: generateUUID(), user_id: scope, group_id: input.groupId ?? null, from_party: input.from, to_party: input.to, amount_paise: input.amountPaise, settled_on: cleanDate(input.date ?? now()), note: input.note?.trim() || null, created_at: now() };
  await inTransaction(db, async () => {
    await db.runAsync(`INSERT INTO settlements (id, user_id, group_id, from_party, to_party, amount_paise, settled_on, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, scope, s.group_id, s.from_party, s.to_party, s.amount_paise, s.settled_on, s.note, s.created_at, s.created_at);
  });
  return s;
}

export async function deleteSettlement(db: IDatabase, scope: Scope, id: string): Promise<boolean> {
  return inTransaction(db, async () => {
    const t = now();
    const r = await db.runAsync(`UPDATE settlements SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere()}`, t, t, id, scope, scope);
    return r.changes > 0;
  });
}

export async function listSettlements(db: IDatabase, scope: Scope, opts: { groupId?: string | null } = {}): Promise<Settlement[]> {
  const where = opts.groupId === undefined ? '' : opts.groupId === null ? 'AND group_id IS NULL' : 'AND group_id = ?';
  const params: unknown[] = [scope, scope]; if (typeof opts.groupId === 'string') params.push(opts.groupId);
  return db.getAllAsync<Settlement>(`SELECT id, user_id, group_id, from_party, to_party, amount_paise, settled_on, note, created_at FROM settlements WHERE deleted_at IS NULL AND ${scopeWhere()} ${where} ORDER BY settled_on DESC, created_at DESC, id`, ...params);
}

// -------------------------------------------------------------------------------------------- guest -> account claim
/**
 * Moves the guest's split data into an account's scope, locally, in the same database transaction as importGuestData (the caller owns
 * BEGIN/COMMIT). Nothing here touches sync_queue: splits are local-only, so the claim is a plain ownership change.
 *
 * `skippedTransactions` maps a guest transaction that was NOT imported (the account already had the same payment) to the account's
 * existing transaction. A split on such a transaction follows it when the account's copy is unsplit and has the same amount (the same
 * rule that moves photos); otherwise it stays with the guest transaction, so a split and its transaction are never in different scopes.
 */
export async function claimGuestSplitData(db: IDatabase, userId: string, skippedTransactions: Map<string, string>, now = new Date().toISOString()): Promise<{ claimedExpenses: number; keptAsGuest: number }> {
  const stay = new Set<string>();
  for (const [guestTx, accountTx] of skippedTransactions) {
    const split = await db.getFirstAsync<{ id: string; total_paise: number }>(`SELECT id, total_paise FROM split_expenses WHERE transaction_id = ? AND user_id IS NULL AND deleted_at IS NULL`, guestTx);
    if (!split) continue;
    const acct = await db.getFirstAsync<{ amount_paise: number | null; amount: number }>(`SELECT amount_paise, amount FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, accountTx, userId);
    const taken = await db.getFirstAsync<{ id: string }>(`SELECT id FROM split_expenses WHERE transaction_id = ? AND deleted_at IS NULL`, accountTx);
    if (acct && !taken && (acct.amount_paise ?? Math.round(acct.amount * 100)) === split.total_paise) {
      await db.runAsync(`UPDATE split_expenses SET transaction_id = ?, updated_at = ? WHERE id = ?`, accountTx, now, split.id);
    } else stay.add(split.id);
  }
  const keep = [...stay];
  const notKept = keep.length ? `AND id NOT IN (${keep.map(() => '?').join(',')})` : '';
  const claimed = await db.runAsync(`UPDATE split_expenses SET user_id = ?, updated_at = ? WHERE user_id IS NULL ${notKept}`, userId, now, ...keep);
  await db.runAsync(`UPDATE contacts SET user_id = ?, updated_at = ? WHERE user_id IS NULL`, userId, now);
  await db.runAsync(`UPDATE split_groups SET user_id = ?, updated_at = ? WHERE user_id IS NULL`, userId, now);
  await db.runAsync(`UPDATE settlements SET user_id = ?, updated_at = ? WHERE user_id IS NULL`, userId, now);
  return { claimedExpenses: claimed.changes, keptAsGuest: keep.length };
}

export async function countGuestSplitData(db: IDatabase): Promise<number> {
  const r = await db.getFirstAsync<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM contacts WHERE user_id IS NULL AND deleted_at IS NULL) + (SELECT COUNT(*) FROM split_expenses WHERE user_id IS NULL AND deleted_at IS NULL) AS n`);
  return Number(r?.n ?? 0);
}

// ------------------------------------------------------------------------------------ linked-transaction lifecycle
/** The transaction's amount is changing and the split cannot follow by itself: the person must re-enter the exact amounts. */
export class SplitReentryRequired extends SplitError {
  readonly split: SplitExpense; readonly newTotalPaise: number;
  constructor(split: SplitExpense, newTotalPaise: number) { super('The amount changed. Enter the exact amounts again.'); this.name = 'SplitReentryRequired'; this.split = split; this.newTotalPaise = newTotalPaise; }
}

export type SplitEditPlan =
  | { kind: 'none' }
  | { kind: 'remove'; split: SplitExpense }
  | { kind: 'follow'; split: SplitExpense }
  | { kind: 'resplit'; split: SplitExpense; input: SplitExpenseInput; zeroShare: string[] };

/**
 * Decides, BEFORE a transaction edit is applied, what happens to its split. Throws SplitReentryRequired for an Exact split whose
 * amount changes (unless `override` carries the re-entered split), so the edit can be refused or redirected without changing anything.
 * The split total must always equal the transaction amount.
 */
export async function planSplitForTransactionEdit(
  db: IDatabase, scope: Scope, transactionId: string, after: { amountPaise: number; direction: string }, override?: SplitExpenseInput,
): Promise<SplitEditPlan> {
  const split = await getSplitForTransaction(db, scope, transactionId);
  if (!split) return { kind: 'none' };
  if (after.direction !== 'expense') return { kind: 'remove', split };
  if (after.amountPaise === split.total_paise) return { kind: 'follow', split };
  let input: SplitExpenseInput;
  if (override) {
    if (override.totalPaise !== after.amountPaise) throw new SplitError('The split total must match the transaction amount.');
    input = override;
  } else {
    if (split.mode === 'exact') throw new SplitReentryRequired(split, after.amountPaise);
    const re = resplitInputs(split, after.amountPaise);
    const paid = split.rows.filter((r) => r.paidPaise > 0);
    const payTotals = allocateByWeight(after.amountPaise, paid.map((r) => r.paidPaise));
    input = {
      title: split.title, category: split.category, totalPaise: after.amountPaise, expenseDate: split.expense_date, note: split.note, mode: re.mode,
      participants: re.participants, payers: paid.map((r, i) => ({ party: r.party, paidPaise: payTotals[i] })),
    };
  }
  // validate now, before anything is written
  const rows = buildPartyAmounts(input.totalPaise, computeShares(input.mode, input.totalPaise, input.participants), input.payers);
  return { kind: 'resplit', split, input, zeroShare: input.mode === 'equal' ? zeroSharePeople(rows, 'equal') : [] };
}

/** Applies the plan after the transaction was saved. Category and date always follow the transaction. */
export async function applySplitPlan(db: IDatabase, scope: Scope, plan: SplitEditPlan, tx: { id: string; category: string; transaction_date: string }): Promise<void> {
  if (plan.kind === 'none') return;
  if (plan.kind === 'remove') { await deleteSplitForTransaction(db, scope, tx.id); return; }
  if (plan.kind === 'follow') {
    if (plan.split.category !== tx.category || plan.split.expense_date !== tx.transaction_date) {
      await inTransaction(db, async () => { await db.runAsync(`UPDATE split_expenses SET category = ?, expense_date = ?, updated_at = ? WHERE id = ?`, tx.category, tx.transaction_date, now(), plan.split.id); });
    }
    return;
  }
  await updateSplitExpense(db, scope, plan.split.id, { ...plan.input, category: tx.category, expenseDate: tx.transaction_date });
}
