import { withWriteLock } from '../db/writeLock.ts';
import { SyncQueueRepository, generateUUID } from '../db/repositories/syncQueueRepository.ts';
import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';

export interface Budget { id: string; user_id: string | null; category: string | null; amount_paise: number; created_at: string; updated_at: string }
export type BudgetState = 'within' | 'near' | 'exceeded';
export interface BudgetProgress {
  budget: Budget;
  spentPaise: number;
  remainingPaise: number; // negative when exceeded
  percentUsed: number; // integer, may exceed 100
  state: BudgetState;
}

export const NEAR_LIMIT_PERCENT = 80;

/** "YYYY-MM" -> [start, end) as ISO instants using the device's local calendar month. */
export function monthRange(month: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error('Invalid month');
  const y = Number(m[1]); const mo = Number(m[2]) - 1;
  return { start: new Date(y, mo, 1).toISOString(), end: new Date(y, mo + 1, 1).toISOString() };
}

export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees <= 0) throw new Error('Enter an amount greater than zero.');
  return Math.round(rupees * 100);
}

const scopeWhere = '(user_id = ? OR (user_id IS NULL AND ? IS NULL))';
const payload = (b: { user_id: Scope; category: string | null; amount_paise: number }) =>
  JSON.stringify({ user_id: b.user_id, category: b.category, amount_paise: b.amount_paise });

export async function listBudgets(db: IDatabase, scope: Scope): Promise<Budget[]> {
  return db.getAllAsync<Budget>(`SELECT id, user_id, category, amount_paise, created_at, updated_at FROM budgets WHERE deleted_at IS NULL AND ${scopeWhere} ORDER BY category IS NOT NULL, category`, scope, scope);
}

export async function saveBudget(db: IDatabase, scope: Scope, input: { id?: string; category: string | null; amountPaise: number }): Promise<Budget> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new Error('Enter an amount greater than zero.');
  const category = input.category?.trim() || null;
  return withWriteLock(async () => {
    const now = new Date().toISOString();
    const queue = new SyncQueueRepository(db);
    const clash = await db.getFirstAsync<Budget>(
      `SELECT * FROM budgets WHERE deleted_at IS NULL AND ${scopeWhere} AND ((category IS NULL AND ? IS NULL) OR category = ? COLLATE NOCASE)`, scope, scope, category, category);
    const target = input.id ? await db.getFirstAsync<Budget>(`SELECT * FROM budgets WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere}`, input.id, scope, scope) : null;
    if (input.id && !target) throw new Error('Budget not found.');
    if (clash && clash.id !== target?.id) throw new Error(category ? 'A budget for this category already exists.' : 'An overall budget already exists.');
    await db.execAsync('BEGIN TRANSACTION');
    try {
      let row: Budget;
      if (target) {
        row = { ...target, category, amount_paise: input.amountPaise, updated_at: now };
        await db.runAsync(`UPDATE budgets SET category = ?, amount_paise = ?, updated_at = ?, sync_status = 'pending_update' WHERE id = ?`, category, input.amountPaise, now, target.id);
        await queue.enqueue({ entity_type: 'budget', entity_id: row.id, operation: 'update', payload: payload(row) });
      } else {
        row = { id: generateUUID(), user_id: scope, category, amount_paise: input.amountPaise, created_at: now, updated_at: now };
        await db.runAsync(`INSERT INTO budgets (id, user_id, category, amount_paise, sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending_create', ?, ?)`, row.id, scope, category, row.amount_paise, now, now);
        await queue.enqueue({ entity_type: 'budget', entity_id: row.id, operation: 'create', payload: payload(row) });
      }
      await db.execAsync('COMMIT');
      return row;
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
}

export async function deleteBudget(db: IDatabase, scope: Scope, id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const row = await db.getFirstAsync<Budget>(`SELECT * FROM budgets WHERE id = ? AND deleted_at IS NULL AND ${scopeWhere}`, id, scope, scope);
    if (!row) return false;
    const now = new Date().toISOString();
    await db.execAsync('BEGIN TRANSACTION');
    try {
      await db.runAsync(`UPDATE budgets SET deleted_at = ?, updated_at = ?, sync_status = 'pending_delete' WHERE id = ?`, now, now, id);
      await new SyncQueueRepository(db).enqueue({ entity_type: 'budget', entity_id: id, operation: 'delete', payload: JSON.stringify({ id, user_id: scope, deleted_at: now }) });
      await db.execAsync('COMMIT');
      return true;
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
}

/** Integer paise spent (expenses only, not deleted, inside the month) overall or for one category. */
export async function spentPaise(db: IDatabase, scope: Scope, month: string, category: string | null): Promise<number> {
  const { start, end } = monthRange(month);
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(COALESCE(amount_paise, CAST(ROUND(amount * 100) AS INTEGER))) AS total FROM transactions
     WHERE direction = 'expense' AND deleted_at IS NULL AND amount > 0 AND ${scopeWhere}
       AND transaction_date >= ? AND transaction_date < ?
       AND (? IS NULL OR category = ? COLLATE NOCASE)`,
    scope, scope, start, end, category, category);
  return row?.total ?? 0;
}

export function progressFor(budget: Budget, spent: number): BudgetProgress {
  const percentUsed = Math.floor((spent * 100) / budget.amount_paise);
  const state: BudgetState = spent > budget.amount_paise ? 'exceeded' : percentUsed >= NEAR_LIMIT_PERCENT ? 'near' : 'within';
  return { budget, spentPaise: spent, remainingPaise: budget.amount_paise - spent, percentUsed, state };
}

export async function getBudgetProgress(db: IDatabase, scope: Scope, month: string): Promise<BudgetProgress[]> {
  const budgets = await listBudgets(db, scope);
  const out: BudgetProgress[] = [];
  for (const b of budgets) out.push(progressFor(b, await spentPaise(db, scope, month, b.category)));
  return out;
}
