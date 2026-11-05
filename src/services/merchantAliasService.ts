import { withWriteLock } from '../db/writeLock.ts';
import { SyncQueueRepository, generateUUID } from '../db/repositories/syncQueueRepository.ts';
import type { IDatabase } from '../db/types.ts';

export interface MerchantAlias {
  id: string;
  user_id: string;
  match_key: string;
  original_text: string;
  display_name: string;
  category: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Conservative merchant identity: case, repeated whitespace and surrounding punctuation are ignored; nothing else.
 * No fuzzy/substring matching, so "SPJIMR MESS" never merges with "SPJIMR MESS 2" or "SPJ MESS".
 */
export function normalizeMerchantKey(text: string): string {
  return (text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s&'./-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[\s.\-/']+|[\s.\-/']+$/g, '').trim();
}

const payload = (a: Pick<MerchantAlias, 'user_id' | 'match_key' | 'original_text' | 'display_name' | 'category'>) =>
  JSON.stringify({ user_id: a.user_id, match_key: a.match_key, original_text: a.original_text, display_name: a.display_name, category: a.category });

/** Aliases exist per signed-in account only. */
export async function findAlias(db: IDatabase, userId: string | null, merchantText: string): Promise<MerchantAlias | null> {
  if (!userId) return null;
  const key = normalizeMerchantKey(merchantText);
  if (!key) return null;
  return db.getFirstAsync<MerchantAlias>('SELECT * FROM merchant_aliases WHERE user_id = ? AND match_key = ? AND deleted_at IS NULL', userId, key);
}

export async function listAliases(db: IDatabase, userId: string): Promise<MerchantAlias[]> {
  return db.getAllAsync<MerchantAlias>('SELECT * FROM merchant_aliases WHERE user_id = ? AND deleted_at IS NULL ORDER BY display_name ASC', userId);
}

/** Saves (or updates) "originalText -> displayName [+ category]". Call only after the user agreed to remember it. */
export async function rememberAlias(
  db: IDatabase, userId: string, originalText: string, displayName: string, category?: string | null,
): Promise<MerchantAlias> {
  const key = normalizeMerchantKey(originalText);
  const name = displayName.trim();
  if (!userId) throw new Error('Sign in to remember merchant names.');
  if (!key) throw new Error('Nothing to remember.');
  if (!name) throw new Error('Enter a merchant name.');
  return withWriteLock(async () => {
    const now = new Date().toISOString();
    const queue = new SyncQueueRepository(db);
    const existing = await db.getFirstAsync<MerchantAlias>('SELECT * FROM merchant_aliases WHERE user_id = ? AND match_key = ? AND deleted_at IS NULL', userId, key);
    await db.execAsync('BEGIN TRANSACTION');
    try {
      let row: MerchantAlias;
      if (existing) {
        row = { ...existing, display_name: name, category: category === undefined ? existing.category : category, updated_at: now };
        await db.runAsync(`UPDATE merchant_aliases SET display_name = ?, category = ?, updated_at = ?, sync_status = 'pending_update' WHERE id = ?`, row.display_name, row.category, now, row.id);
        await queue.enqueue({ entity_type: 'merchant_alias', entity_id: row.id, operation: 'update', payload: payload(row) });
      } else {
        row = { id: generateUUID(), user_id: userId, match_key: key, original_text: originalText.trim(), display_name: name, category: category ?? null, created_at: now, updated_at: now };
        await db.runAsync(
          `INSERT INTO merchant_aliases (id, user_id, match_key, original_text, display_name, category, sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_create', ?, ?)`,
          row.id, userId, key, row.original_text, row.display_name, row.category, now, now);
        await queue.enqueue({ entity_type: 'merchant_alias', entity_id: row.id, operation: 'create', payload: payload(row) });
      }
      await db.execAsync('COMMIT');
      return row;
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
}

export async function removeAlias(db: IDatabase, userId: string, id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const row = await db.getFirstAsync<MerchantAlias>('SELECT * FROM merchant_aliases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);
    if (!row) return false;
    const now = new Date().toISOString();
    await db.execAsync('BEGIN TRANSACTION');
    try {
      await db.runAsync(`UPDATE merchant_aliases SET deleted_at = ?, updated_at = ?, sync_status = 'pending_delete' WHERE id = ?`, now, now, id);
      await new SyncQueueRepository(db).enqueue({ entity_type: 'merchant_alias', entity_id: id, operation: 'delete', payload: JSON.stringify({ id, user_id: userId, deleted_at: now }) });
      await db.execAsync('COMMIT');
      return true;
    } catch (err) { await db.execAsync('ROLLBACK'); throw err; }
  });
}

/**
 * Applies a saved alias to an incoming merchant. Returns what to store; the original text is always kept
 * in the description by the caller. Category is only taken from the alias when the user saved one.
 */
export async function applyAlias(
  db: IDatabase, userId: string | null, merchantText: string,
): Promise<{ merchant: string; category: string | null; matched: boolean }> {
  const alias = await findAlias(db, userId, merchantText);
  return alias ? { merchant: alias.display_name, category: alias.category, matched: true } : { merchant: merchantText, category: null, matched: false };
}
