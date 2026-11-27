import { withWriteLock } from '../db/writeLock.ts';
import { SyncQueueRepository, generateUUID } from '../db/repositories/syncQueueRepository.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { normalizeMerchantKey } from './merchantAliasService.ts';
import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';

/** 'receive' = someone will pay me; 'pay' = I will pay someone. */
export type ExpectedDirection = 'receive' | 'pay';
export interface PaymentEvent { transaction_id: string | null; amount_paise: number; at: string }
export interface ExpectedPayment {
  id: string; user_id: string | null; person: string; person_key: string; direction: ExpectedDirection;
  amount_paise: number; paid_paise: number; note: string | null; due_date: string | null;
  status: 'pending' | 'settled'; settled_at: string | null; payments: PaymentEvent[]; created_at: string; updated_at: string;
}

interface Row extends Omit<ExpectedPayment, 'payments'> { payments_json: string }
const scopeWhere = '(user_id = ? OR (user_id IS NULL AND ? IS NULL))';
const toModel = (r: Row): ExpectedPayment => { const { payments_json, ...rest } = r; let payments: PaymentEvent[] = []; try { payments = JSON.parse(payments_json) as PaymentEvent[]; } catch { /* corrupt history is shown as empty */ } return { ...rest, payments }; };
const outstanding = (e: Pick<ExpectedPayment, 'amount_paise' | 'paid_paise'>) => Math.max(0, e.amount_paise - e.paid_paise);
export const outstandingPaise = outstanding;

export const isOverdue = (e: ExpectedPayment, now = new Date()): boolean => {
  if (e.status !== 'pending' || !e.due_date) return false;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return e.due_date < today;
};

const payload = (e: ExpectedPayment, scope: Scope) => JSON.stringify({
  user_id: scope, person: e.person, direction: e.direction, amount_paise: e.amount_paise, paid_paise: e.paid_paise, note: e.note,
  due_date: e.due_date, status: e.status, settled_at: e.settled_at, payments: e.payments,
});

function validDueDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) throw new Error('Enter the due date as YYYY-MM-DD.');
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (dt.getFullYear() !== Number(m[1]) || dt.getMonth() !== Number(m[2]) - 1 || dt.getDate() !== Number(m[3])) throw new Error('That due date does not exist.');
  return d.trim();
}

function validate(input: { person?: string; amountPaise?: number; note?: string | null }) {
  if (input.person !== undefined) {
    const p = input.person.trim();
    if (!p) throw new Error('Enter the person\'s name.');
    if (p.length > 80) throw new Error('The name is too long.');
  }
  if (input.amountPaise !== undefined && (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0)) throw new Error('Enter an amount greater than zero.');
  if (input.note && input.note.length > 200) throw new Error('The note can be at most 200 characters.');
}

async function save(db: IDatabase, scope: Scope, e: ExpectedPayment, op: 'create' | 'update'): Promise<void> {
  if (op === 'create') {
    await db.runAsync(
      `INSERT INTO expected_payments (id, user_id, person, person_key, direction, amount_paise, paid_paise, note, due_date, status, settled_at, payments_json, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_create', ?, ?)`,
      e.id, scope, e.person, e.person_key, e.direction, e.amount_paise, e.paid_paise, e.note, e.due_date, e.status, e.settled_at, JSON.stringify(e.payments), e.created_at, e.updated_at);
  } else {
    await db.runAsync(
      `UPDATE expected_payments SET person = ?, person_key = ?, amount_paise = ?, paid_paise = ?, note = ?, due_date = ?, status = ?, settled_at = ?, payments_json = ?, sync_status = 'pending_update', updated_at = ? WHERE id = ?`,
      e.person, e.person_key, e.amount_paise, e.paid_paise, e.note, e.due_date, e.status, e.settled_at, JSON.stringify(e.payments), e.updated_at, e.id);
  }
  await new SyncQueueRepository(db).enqueue({ entity_type: 'expected_payment', entity_id: e.id, operation: op, payload: payload(e, scope) });
}

export async function getExpected(db: IDatabase, scope: Scope, id: string): Promise<ExpectedPayment | null> {
  const r = await db.getFirstAsync<Row>(`SELECT * FROM expected_payments WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere}`, id, scope, scope);
  return r ? toModel(r) : null;
}

export async function listExpected(db: IDatabase, scope: Scope): Promise<ExpectedPayment[]> {
  const rows = await db.getAllAsync<Row>(`SELECT * FROM expected_payments WHERE deleted_at IS NULL AND ${scopeWhere}`, scope, scope);
  return rows.map(toModel).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    if (a.status === 'settled') return (b.settled_at ?? '').localeCompare(a.settled_at ?? '');
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    // newest first; identical timestamps fall back to id so the order never depends on clock resolution
    return b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
  });
}

export async function createExpected(
  db: IDatabase, scope: Scope, input: { person: string; amountPaise: number; note?: string | null; dueDate?: string | null; direction?: ExpectedDirection },
): Promise<ExpectedPayment> {
  validate(input);
  const dueDate = validDueDate(input.dueDate);
  const now = new Date().toISOString();
  const e: ExpectedPayment = {
    id: generateUUID(), user_id: scope, person: input.person.trim(), person_key: normalizeMerchantKey(input.person), direction: input.direction ?? 'receive',
    amount_paise: input.amountPaise, paid_paise: 0, note: input.note?.trim() || null, due_date: dueDate, status: 'pending', settled_at: null, payments: [], created_at: now, updated_at: now,
  };
  if (!e.person_key) throw new Error('Enter the person\'s name.');
  await withWriteLock(async () => {
    await db.execAsync('BEGIN TRANSACTION');
    try { await save(db, scope, e, 'create'); await db.execAsync('COMMIT'); } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
  return e;
}

export async function updateExpected(
  db: IDatabase, scope: Scope, id: string, patch: { person?: string; amountPaise?: number; note?: string | null; dueDate?: string | null },
): Promise<ExpectedPayment> {
  validate(patch);
  return withWriteLock(async () => {
    const cur = await getExpected(db, scope, id);
    if (!cur) throw new Error('Not found.');
    const next: ExpectedPayment = { ...cur, updated_at: new Date().toISOString() };
    if (patch.person !== undefined) { next.person = patch.person.trim(); next.person_key = normalizeMerchantKey(patch.person); }
    if (patch.amountPaise !== undefined) {
      if (patch.amountPaise < cur.paid_paise) throw new Error('The amount cannot be less than what has already been paid.');
      next.amount_paise = patch.amountPaise;
    }
    if (patch.note !== undefined) next.note = patch.note?.trim() || null;
    if (patch.dueDate !== undefined) next.due_date = validDueDate(patch.dueDate);
    if (next.paid_paise >= next.amount_paise && next.status === 'pending') { next.status = 'settled'; next.settled_at = next.updated_at; }
    else if (next.paid_paise < next.amount_paise && next.status === 'settled') { next.status = 'pending'; next.settled_at = null; }
    await db.execAsync('BEGIN TRANSACTION');
    try { await save(db, scope, next, 'update'); await db.execAsync('COMMIT'); } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
    return next;
  });
}

export async function deleteExpected(db: IDatabase, scope: Scope, id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const cur = await getExpected(db, scope, id);
    if (!cur) return false;
    const now = new Date().toISOString();
    await db.execAsync('BEGIN TRANSACTION');
    try {
      await db.runAsync(`UPDATE expected_payments SET deleted_at = ?, updated_at = ?, sync_status = 'pending_delete' WHERE id = ?`, now, now, id);
      await new SyncQueueRepository(db).enqueue({ entity_type: 'expected_payment', entity_id: id, operation: 'delete', payload: JSON.stringify({ id, user_id: scope, deleted_at: now }) });
      await db.execAsync('COMMIT');
      return true;
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
}

/** Adds a (possibly partial) payment. Becomes 'settled' once the full amount is covered. */
export async function recordPayment(db: IDatabase, scope: Scope, id: string, input: { amountPaise: number; transactionId?: string | null }): Promise<ExpectedPayment> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new Error('Enter an amount greater than zero.');
  return withWriteLock(async () => {
    const cur = await getExpected(db, scope, id);
    if (!cur) throw new Error('Not found.');
    if (cur.status === 'settled') throw new Error('This is already settled.');
    if (input.transactionId && cur.payments.some((p) => p.transaction_id === input.transactionId)) return cur; // idempotent
    if (input.amountPaise > outstanding(cur)) throw new Error('That is more than what is still outstanding.');
    const now = new Date().toISOString();
    const next: ExpectedPayment = { ...cur, paid_paise: cur.paid_paise + input.amountPaise, payments: [...cur.payments, { transaction_id: input.transactionId ?? null, amount_paise: input.amountPaise, at: now }], updated_at: now };
    if (next.paid_paise >= next.amount_paise) { next.status = 'settled'; next.settled_at = now; }
    await db.execAsync('BEGIN TRANSACTION');
    try { await save(db, scope, next, 'update'); await db.execAsync('COMMIT'); } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
    return next;
  });
}

export async function markSettled(db: IDatabase, scope: Scope, id: string): Promise<ExpectedPayment> {
  const cur = await getExpected(db, scope, id);
  if (!cur) throw new Error('Not found.');
  return recordPayment(db, scope, id, { amountPaise: outstanding(cur) });
}

/** Records the payment AND creates the matching income/expense transaction so the books agree. */
export async function recordPaymentWithTransaction(
  db: IDatabase, scope: Scope, id: string, input: { amountPaise: number; date?: string },
): Promise<{ expected: ExpectedPayment; transactionId: string }> {
  const cur = await getExpected(db, scope, id);
  if (!cur) throw new Error('Not found.');
  if (input.amountPaise > outstanding(cur)) throw new Error('That is more than what is still outstanding.');
  const receive = cur.direction === 'receive';
  const tx = await new TransactionRepository(db).create({
    amount: input.amountPaise / 100, amount_paise: input.amountPaise, direction: receive ? 'income' : 'expense', counterparty: cur.person,
    category: receive ? 'Other Income' : 'Other Expenses', description: cur.note ? `${receive ? 'Payment from' : 'Payment to'} ${cur.person}: ${cur.note}` : `${receive ? 'Payment from' : 'Payment to'} ${cur.person}`,
    transaction_date: input.date, source: 'manual', user_id: scope,
  });
  const expected = await recordPayment(db, scope, id, { amountPaise: input.amountPaise, transactionId: tx.id });
  return { expected, transactionId: tx.id };
}

/** Open (pending) items for this person and direction, matched by exact normalized name. */
export async function findOpenForPerson(db: IDatabase, scope: Scope, name: string, direction: ExpectedDirection): Promise<ExpectedPayment[]> {
  const key = normalizeMerchantKey(name);
  if (!key) return [];
  return (await listExpected(db, scope)).filter((e) => e.status === 'pending' && e.direction === direction && e.person_key === key);
}

/**
 * When a transaction arrives (SMS or manual), settle an expected payment ONLY if the person's name matches exactly
 * and the amount equals what is outstanding. Anything fuzzier is left for the user to confirm.
 */
export async function autoSettleFromTransaction(
  db: IDatabase, scope: Scope, tx: { id: string; counterparty: string; direction: 'income' | 'expense'; amount_paise: number },
): Promise<ExpectedPayment | null> {
  const open = await findOpenForPerson(db, scope, tx.counterparty, tx.direction === 'income' ? 'receive' : 'pay');
  const match = open.find((e) => outstanding(e) === tx.amount_paise && !e.payments.some((p) => p.transaction_id === tx.id));
  return match ? recordPayment(db, scope, match.id, { amountPaise: tx.amount_paise, transactionId: tx.id }) : null;
}

export interface ExpectedSummary { receive: { outstandingPaise: number; count: number; people: number }; pay: { outstandingPaise: number; count: number; people: number }; overdueCount: number }
/** What the Expected tab's dot announces ("3 pending"), or undefined when there is nothing pending and no dot. */
export function expectedBadge(summary: ExpectedSummary): string | undefined {
  const pending = summary.receive.count + summary.pay.count;
  return pending ? `${pending} pending` : undefined;
}
export function summarizeExpected(items: ExpectedPayment[], now = new Date()): ExpectedSummary {
  const out: ExpectedSummary = { receive: { outstandingPaise: 0, count: 0, people: 0 }, pay: { outstandingPaise: 0, count: 0, people: 0 }, overdueCount: 0 };
  const people = { receive: new Set<string>(), pay: new Set<string>() };
  for (const e of items) {
    if (e.status !== 'pending') continue;
    const bucket = out[e.direction];
    bucket.outstandingPaise += outstanding(e); bucket.count += 1; people[e.direction].add(e.person_key);
    if (isOverdue(e, now)) out.overdueCount += 1;
  }
  out.receive.people = people.receive.size; out.pay.people = people.pay.size;
  return out;
}
