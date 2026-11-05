import { withWriteLock } from '../db/writeLock.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { SyncQueueRepository, generateUUID } from '../db/repositories/syncQueueRepository.ts';
import type { IDatabase } from '../db/types.ts';

/** null = guest scope; otherwise the signed-in user id. */
export type Scope = string | null;

export interface CategoryView {
  id: string;
  name: string;
  type: 'income' | 'expense';
  icon: string;
  color: string;
  isCustom: boolean;
}

export const CATEGORY_COLORS = ['#F97316', '#84CC16', '#0EA5E9', '#64748B', '#8B5CF6', '#EF4444', '#3B82F6', '#EC4899', '#14B8A6', '#F59E0B', '#6366F1', '#10B981'];
export const CATEGORY_ICONS = ['Utensils', 'ShoppingBag', 'Car', 'Receipt', 'ShoppingCart', 'HeartPulse', 'GraduationCap', 'Film', 'Plane', 'Sparkles', 'Home', 'Briefcase', 'Laptop', 'Store', 'TrendingUp', 'Tag'];

export function fallbackColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_COLORS[h % CATEGORY_COLORS.length];
}

interface CategoryRow { id: string; user_id: string | null; name: string; transaction_type: string; icon: string | null; color: string | null; is_custom: number }

/** Categories visible to a scope: shared defaults/system + that scope's own custom categories. Duplicate names collapse. */
export async function listCategories(db: IDatabase, scope: Scope): Promise<CategoryView[]> {
  const rows = await db.getAllAsync<CategoryRow>(
    `SELECT id, user_id, name, transaction_type, icon, color, is_custom FROM categories
     WHERE archived_at IS NULL AND (is_custom = 0 OR (is_custom = 1 AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))))
     ORDER BY is_custom ASC, name ASC`,
    scope, scope,
  );
  const seen = new Set<string>();
  const out: CategoryView[] = [];
  for (const r of rows) {
    const type: 'income' | 'expense' = r.transaction_type === 'income' ? 'income' : 'expense';
    const key = `${r.name.trim().toLowerCase()}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, name: r.name, type, icon: r.icon ?? 'Tag', color: r.color ?? fallbackColor(r.name), isCustom: r.is_custom === 1 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function validateCategoryInput(input: { name: string; type: string; color?: string; icon?: string }): string | null {
  const name = input.name?.trim() ?? '';
  if (!name) return 'Enter a category name.';
  if (name.length > 40) return 'Category names can be at most 40 characters.';
  if (input.type !== 'income' && input.type !== 'expense') return 'Choose income or expense.';
  if (input.color && !/^#[0-9a-fA-F]{6}$/.test(input.color)) return 'Choose a valid color.';
  return null;
}

function queuePayload(scope: Scope, c: { name: string; type: string; icon: string; color: string }): string {
  return JSON.stringify({ user_id: scope, category: c.name, direction: c.type, icon: c.icon, color: c.color });
}

export async function createCategory(
  db: IDatabase, scope: Scope, input: { name: string; type: 'income' | 'expense'; icon?: string; color?: string },
): Promise<CategoryView> {
  const error = validateCategoryInput(input);
  if (error) throw new Error(error);
  const name = input.name.trim();
  const existing = await listCategories(db, scope);
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.type === input.type)) {
    throw new Error('A category with that name already exists.');
  }
  const view: CategoryView = { id: generateUUID(), name, type: input.type, icon: input.icon ?? 'Tag', color: input.color ?? fallbackColor(name), isCustom: true };
  const now = new Date().toISOString();
  await withWriteLock(async () => {
    await db.execAsync('BEGIN TRANSACTION');
    try {
      await db.runAsync(
        `INSERT INTO categories (id, user_id, name, transaction_type, icon, color, is_custom, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        view.id, scope, view.name, view.type, view.icon, view.color, now, now,
      );
      await new SyncQueueRepository(db).enqueue({ entity_type: 'category', entity_id: view.id, operation: 'create', payload: queuePayload(scope, view) });
      await db.execAsync('COMMIT');
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
  return view;
}

async function requireOwnCustom(db: IDatabase, scope: Scope, id: string): Promise<CategoryRow> {
  const row = await db.getFirstAsync<CategoryRow>(
    `SELECT id, user_id, name, transaction_type, icon, color, is_custom FROM categories
     WHERE id = ? AND is_custom = 1 AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`, id, scope, scope);
  if (!row) throw new Error('Only your own custom categories can be changed.');
  return row;
}

export async function updateCategory(
  db: IDatabase, scope: Scope, id: string, input: { name: string; icon?: string; color?: string },
): Promise<CategoryView> {
  const row = await requireOwnCustom(db, scope, id);
  const error = validateCategoryInput({ ...input, type: row.transaction_type });
  if (error) throw new Error(error);
  const name = input.name.trim();
  const others = (await listCategories(db, scope)).filter((c) => c.id !== id);
  if (others.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.type === row.transaction_type)) {
    throw new Error('A category with that name already exists.');
  }
  const icon = input.icon ?? row.icon ?? 'Tag';
  const color = input.color ?? row.color ?? fallbackColor(name);
  const now = new Date().toISOString();
  await withWriteLock(async () => {
    await db.execAsync('BEGIN TRANSACTION');
    try {
      await db.runAsync('UPDATE categories SET name = ?, icon = ?, color = ?, updated_at = ? WHERE id = ?', name, icon, color, now, id);
      await new SyncQueueRepository(db).enqueue({ entity_type: 'category', entity_id: id, operation: 'update', payload: queuePayload(scope, { name, type: row.transaction_type, icon, color }) });
      await db.execAsync('COMMIT');
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
  if (name !== row.name) await renameInRecords(db, scope, row.name, name, id);
  return { id, name, type: row.transaction_type === 'income' ? 'income' : 'expense', icon, color, isCustom: true };
}

async function scopedTransactionIds(db: IDatabase, scope: Scope, categoryName: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM transactions WHERE deleted_at IS NULL AND category = ? COLLATE NOCASE AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    categoryName, scope, scope);
  return rows.map((r) => r.id);
}

/** Moves this scope's transactions (through the normal repository path so each edit is queued for sync) and budgets/aliases. */
async function renameInRecords(db: IDatabase, scope: Scope, from: string, to: string, toId: string | null): Promise<void> {
  const txRepo = new TransactionRepository(db);
  for (const id of await scopedTransactionIds(db, scope, from)) {
    await txRepo.update(id, { category: to, category_id: toId });
  }
  await db.runAsync(
    `UPDATE budgets SET category = ?, updated_at = ?, sync_status = 'pending_update' WHERE category = ? AND deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    to, new Date().toISOString(), from, scope, scope);
  await db.runAsync(
    `UPDATE merchant_aliases SET category = ?, updated_at = ?, sync_status = 'pending_update' WHERE category = ? AND deleted_at IS NULL AND user_id = ?`,
    to, new Date().toISOString(), from, scope ?? '');
}

export async function countCategoryUsage(db: IDatabase, scope: Scope, name: string): Promise<number> {
  return (await scopedTransactionIds(db, scope, name)).length;
}

/**
 * Deletes one of the scope's custom categories. Transactions that use it must be moved to `reassignToId` first
 * (never silently deleted, never left pointing at a missing category). Budgets for it are removed (soft); merchant
 * aliases keep their merchant mapping but lose the category.
 */
export async function deleteCategory(db: IDatabase, scope: Scope, id: string, reassignToId?: string): Promise<{ reassigned: number }> {
  const row = await requireOwnCustom(db, scope, id);
  const used = await scopedTransactionIds(db, scope, row.name);
  let target: CategoryView | undefined;
  if (used.length > 0) {
    if (!reassignToId) throw new Error(`CATEGORY_IN_USE:${used.length}`);
    target = (await listCategories(db, scope)).find((c) => c.id === reassignToId);
    if (!target || target.id === id || target.type !== (row.transaction_type === 'income' ? 'income' : 'expense')) {
      throw new Error('Choose another category of the same type to move the transactions to.');
    }
    const txRepo = new TransactionRepository(db);
    for (const txId of used) await txRepo.update(txId, { category: target.name, category_id: target.id });
  }
  const now = new Date().toISOString();
  const queue = new SyncQueueRepository(db);
  await withWriteLock(async () => {
    await db.execAsync('BEGIN TRANSACTION');
    try {
      const budgets = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM budgets WHERE category = ? AND deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`, row.name, scope, scope);
      for (const b of budgets) {
        await db.runAsync(`UPDATE budgets SET deleted_at = ?, updated_at = ?, sync_status = 'pending_delete' WHERE id = ?`, now, now, b.id);
        await queue.enqueue({ entity_type: 'budget', entity_id: b.id, operation: 'delete', payload: JSON.stringify({ id: b.id, user_id: scope, deleted_at: now }) });
      }
      await db.runAsync(`UPDATE merchant_aliases SET category = NULL, updated_at = ?, sync_status = 'pending_update' WHERE category = ? AND deleted_at IS NULL AND user_id = ?`, now, row.name, scope ?? '');
      await db.runAsync('DELETE FROM categories WHERE id = ?', id);
      await queue.enqueue({ entity_type: 'category', entity_id: id, operation: 'delete', payload: JSON.stringify({ id, user_id: scope, deleted_at: now }) });
      await db.execAsync('COMMIT');
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
  return { reassigned: used.length };
}
