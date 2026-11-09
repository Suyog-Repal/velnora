import { getDatabase } from '../db/database.ts';
import { withWriteLock } from '../db/writeLock.ts';
import type { IDatabase } from '../db/types.ts';

export interface LocalDataSummary {
  unsyncedCount: number;
  totalCount: number;
}

export interface LocalDataDeletionResult {
  cleared: boolean;
  unsyncedCount: number;
  deletedTransactions: number;
}

function requireUserId(userId: string | null | undefined): string {
  const id = userId?.trim();
  if (!id) throw new Error('A signed-in user is required for local data operations');
  return id;
}

/** Counts this user's records that the backend has not confirmed (anything not 'synced'). Throws on failure. */
export async function getLocalDataSummary(userId: string, database?: IDatabase): Promise<LocalDataSummary> {
  const id = requireUserId(userId);
  const db = database ?? (await getDatabase());
  const unsynced = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ? AND sync_status != 'synced'",
    id,
  );
  const total = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?',
    id,
  );
  return { unsyncedCount: unsynced?.count ?? 0, totalCount: total?.count ?? 0 };
}

/**
 * Explicit, user-confirmed purge of ONE user's local financial data.
 * Deletes (atomically): that user's transactions, their sync-queue items, and their sync cursors.
 * Never touches other users' rows, categories, devices, or app configuration.
 * Any failure rolls back everything and rethrows.
 */
export async function deleteUserLocalData(
  userId: string,
  database?: IDatabase,
  afterCommit?: (userId: string) => Promise<void>,
): Promise<LocalDataDeletionResult> {
  const id = requireUserId(userId);
  const db = database ?? (await getDatabase());
  const result = await withWriteLock(async () => {
    const summary = await getLocalDataSummary(id, db);
    await db.execAsync('BEGIN TRANSACTION');
    try {
      await db.runAsync(
        `DELETE FROM sync_queue
         WHERE (entity_type = 'transaction' AND entity_id IN (SELECT id FROM transactions WHERE user_id = ?))
            OR json_extract(payload, '$.user_id') = ?`,
        id,
        id,
      );
      await db.runAsync('DELETE FROM account_profiles WHERE user_id = ?', id);
      const deleted = await db.runAsync('DELETE FROM transactions WHERE user_id = ?', id);
      await db.runAsync(
        'DELETE FROM app_metadata WHERE key IN (?, ?)',
        `last_sync_cursor_${id}`,
        `last_sync_at_${id}`,
      );
      await db.execAsync('COMMIT');
      return { cleared: true, unsyncedCount: summary.unsyncedCount, deletedTransactions: deleted.changes };
    } catch (err) {
      await db.execAsync('ROLLBACK');
      throw err;
    }
  });
  // Staged (not yet processed) SMS events for this user are part of their local financial data.
  if (afterCommit) await afterCommit(id);
  return result;
}
