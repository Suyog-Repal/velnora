import type { IDatabase, SyncEntityType, SyncOperation, SyncQueueEntity } from '../types.ts';

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class SyncQueueRepository {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async enqueue(entry: {
    entity_type: SyncEntityType;
    entity_id: string;
    operation: SyncOperation;
    payload: string;
  }): Promise<SyncQueueEntity | null> {
    const now = new Date().toISOString();

    // Check if there is an existing pending queue item for this entity
    const existing = await this.db.getFirstAsync<SyncQueueEntity>(
      'SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ?',
      entry.entity_type,
      entry.entity_id,
    );

    let finalOperation: SyncOperation = entry.operation;

    if (existing) {
      if (existing.operation === 'create') {
        if (entry.operation === 'delete') {
          // Entity was created locally and deleted before ever being synced.
          // Safely eliminate from queue so nothing is sent to the server.
          await this.removeForEntity(entry.entity_type, entry.entity_id);
          return null;
        }
        if (entry.operation === 'update') {
          // Keep operation as 'create' with updated payload
          finalOperation = 'create';
        }
      } else if (existing.operation === 'update' && entry.operation === 'delete') {
        // Switch to 'delete' operation
        finalOperation = 'delete';
      }
    }

    const id = existing?.id || generateUUID();

    // Upsert using the unique constraint (entity_type, entity_id)
    await this.db.runAsync(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         operation = excluded.operation,
         payload = excluded.payload,
         retry_count = 0,
         last_attempt_at = NULL,
         next_retry_at = NULL,
         error_code = NULL`,
      id,
      entry.entity_type,
      entry.entity_id,
      finalOperation,
      entry.payload,
      now,
    );

    return {
      id,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      operation: finalOperation,
      payload: entry.payload,
      retry_count: 0,
      last_attempt_at: null,
      next_retry_at: null,
      error_code: null,
      created_at: now,
    };
  }

  async peek(limit = 50, userId?: string | null): Promise<SyncQueueEntity[]> {
    let sql = 'SELECT * FROM sync_queue';
    const params: unknown[] = [];

    if (userId !== undefined) {
      if (userId === null) {
        sql += ` WHERE (
          (sync_queue.entity_type = 'transaction' AND
           (SELECT user_id FROM transactions WHERE transactions.id = sync_queue.entity_id) IS NULL)
          OR
          (sync_queue.entity_type != 'transaction' AND
           json_extract(payload, '$.user_id') IS NULL)
        )`;
      } else {
        sql += ` WHERE (
          (sync_queue.entity_type = 'transaction' AND
           (SELECT user_id FROM transactions WHERE transactions.id = sync_queue.entity_id) = ? AND
           (
             json_extract(payload, '$.user_id') IS NULL OR
             json_extract(payload, '$.user_id') = (SELECT user_id FROM transactions WHERE transactions.id = sync_queue.entity_id)
           )
          )
          OR
          (sync_queue.entity_type != 'transaction' AND
           json_extract(payload, '$.user_id') = ?
          )
        )`;
        params.push(userId, userId);
      }
    }

    sql += ' ORDER BY created_at ASC LIMIT ?';
    params.push(limit);
    return this.db.getAllAsync<SyncQueueEntity>(sql, ...params);
  }

  async peekEligible(limit = 50, userId?: string | null): Promise<SyncQueueEntity[]> {
    const now = new Date().toISOString();
    let sql = 'SELECT * FROM sync_queue WHERE (next_retry_at IS NULL OR next_retry_at <= ?)';
    const params: unknown[] = [now];

    if (userId !== undefined) {
      if (userId === null) {
        sql += ` AND (
          (sync_queue.entity_type = 'transaction' AND
           (SELECT user_id FROM transactions WHERE transactions.id = sync_queue.entity_id) IS NULL)
          OR
          (sync_queue.entity_type != 'transaction' AND
           json_extract(payload, '$.user_id') IS NULL)
        )`;
      } else {
        sql += ` AND (
          (sync_queue.entity_type = 'transaction' AND
           (SELECT user_id FROM transactions WHERE transactions.id = sync_queue.entity_id) = ? AND
           (
             json_extract(payload, '$.user_id') IS NULL OR
             json_extract(payload, '$.user_id') = (SELECT user_id FROM transactions WHERE transactions.id = sync_queue.entity_id)
           )
          )
          OR
          (sync_queue.entity_type != 'transaction' AND
           json_extract(payload, '$.user_id') = ?
          )
        )`;
        params.push(userId, userId);
      }
    }

    sql += ' ORDER BY created_at ASC LIMIT ?';
    params.push(limit);
    return this.db.getAllAsync<SyncQueueEntity>(sql, ...params);
  }

  async dequeue(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM sync_queue WHERE id = ?', id);
  }

  /**
   * Server acknowledged the change it was SENT. Removes the queue item only if it still holds that same change. A local edit
   * made while the request was in flight reuses the same queue row (one row per entity), so removing it unconditionally
   * would drop that edit: it is kept instead, as an 'update' (the server now has the entity), ready for the next push.
   * Returns true when the item was removed, false when a newer local change is still queued.
   */
  async acknowledge(id: string, sentPayload: string): Promise<boolean> {
    const removed = await this.db.runAsync('DELETE FROM sync_queue WHERE id = ? AND payload = ?', id, sentPayload);
    if (removed.changes > 0) return true;
    await this.db.runAsync(
      `UPDATE sync_queue SET operation = CASE WHEN operation = 'create' THEN 'update' ELSE operation END,
         retry_count = 0, next_retry_at = NULL, error_code = NULL
       WHERE id = ?`,
      id,
    );
    return false;
  }

  async removeForEntity(entityType: SyncEntityType, entityId: string): Promise<void> {
    await this.db.runAsync(
      'DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?',
      entityType,
      entityId,
    );
  }

  async markFailed(id: string, errorCode: string, nextRetryAt: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.db.runAsync(
      `UPDATE sync_queue
       SET retry_count = retry_count + 1,
           last_attempt_at = ?,
           next_retry_at = ?,
           error_code = ?
       WHERE id = ?`,
      now,
      nextRetryAt,
      errorCode,
      id,
    );
  }

  async resetRetry(id: string): Promise<void> {
    await this.db.runAsync(
      `UPDATE sync_queue
       SET retry_count = 0,
           next_retry_at = NULL,
           error_code = NULL
       WHERE id = ?`,
      id,
    );
  }

  async getPendingCount(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM sync_queue',
    );
    return row?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.db.runAsync('DELETE FROM sync_queue');
  }
}
