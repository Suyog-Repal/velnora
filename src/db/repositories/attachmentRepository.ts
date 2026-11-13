import type { AttachmentEntity, AttachmentUploadStatus, IDatabase } from '../types.ts';

export type NewAttachment = Omit<AttachmentEntity, 'created_at' | 'updated_at' | 'retry_count' | 'next_retry_at' | 'last_error'> &
  Partial<Pick<AttachmentEntity, 'created_at'>>;

const COLUMNS = [
  'id', 'transaction_id', 'user_id', 'local_path', 'remote_id', 'upload_status', 'attachment_type', 'page_index',
  'created_at', 'updated_at', 'deleted_at', 'file_name', 'mime_type', 'size_bytes', 'width', 'height',
  'retry_count', 'next_retry_at', 'last_error',
] as const;
type Column = (typeof COLUMNS)[number];
type Patch = Partial<Pick<AttachmentEntity, Exclude<Column, 'id' | 'transaction_id' | 'created_at'>>>;

/** Metadata of transaction attachments. The image bytes live in files (see attachmentFiles.ts), never in SQLite. */
export class AttachmentRepository {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async create(data: NewAttachment): Promise<AttachmentEntity> {
    const now = new Date().toISOString();
    const record: AttachmentEntity = {
      ...data,
      created_at: data.created_at ?? now,
      updated_at: now,
      retry_count: 0,
      next_retry_at: null,
      last_error: null,
    };
    await this.db.runAsync(
      `INSERT INTO transaction_attachments (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
      ...COLUMNS.map((c) => record[c] ?? null),
    );
    return record;
  }

  /** Active attachments of one transaction, in page order. */
  async getByTransaction(transactionId: string): Promise<AttachmentEntity[]> {
    return this.db.getAllAsync<AttachmentEntity>(
      `SELECT * FROM transaction_attachments
       WHERE transaction_id = ? AND deleted_at IS NULL
       ORDER BY page_index ASC, created_at ASC`,
      transactionId,
    );
  }

  async countActive(transactionId: string): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transaction_attachments WHERE transaction_id = ? AND deleted_at IS NULL', transactionId);
    return row?.n ?? 0;
  }

  /** Active attachment counts per transaction (for list indicators). */
  async countsByTransaction(transactionIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!transactionIds.length) return out;
    for (let i = 0; i < transactionIds.length; i += 500) {
      const ids = transactionIds.slice(i, i + 500);
      const rows = await this.db.getAllAsync<{ transaction_id: string; n: number }>(
        `SELECT transaction_id, COUNT(*) AS n FROM transaction_attachments
         WHERE deleted_at IS NULL AND transaction_id IN (${ids.map(() => '?').join(',')}) GROUP BY transaction_id`, ...ids);
      for (const r of rows) out.set(r.transaction_id, r.n);
    }
    return out;
  }

  async getById(id: string): Promise<AttachmentEntity | null> {
    return this.db.getFirstAsync<AttachmentEntity>('SELECT * FROM transaction_attachments WHERE id = ?', id);
  }

  async update(id: string, data: Patch): Promise<void> {
    const cols = (Object.keys(data) as (keyof Patch)[]).filter((c) => (COLUMNS as readonly string[]).includes(c));
    if (cols.length === 0) return;
    const patch: Patch = { updated_at: new Date().toISOString(), ...data };
    const all = [...new Set([...cols, 'updated_at' as const])];
    await this.db.runAsync(
      `UPDATE transaction_attachments SET ${all.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...all.map((c) => patch[c] ?? null),
      id,
    );
  }

  async setStatus(id: string, status: AttachmentUploadStatus, extra: Patch = {}): Promise<void> {
    await this.update(id, { ...extra, upload_status: status });
  }

  /** Tombstone. The row stays until the server confirmed the deletion (or it never reached the server). */
  async softDelete(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.runAsync(
      'UPDATE transaction_attachments SET deleted_at = ?, updated_at = ?, local_path = NULL WHERE id = ? AND deleted_at IS NULL',
      now, now, id,
    );
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM transaction_attachments WHERE id = ?', id);
  }

  /** An upload that was in flight when the app stopped can never finish: make it eligible again. */
  async resetStaleUploads(userId: string): Promise<void> {
    await this.db.runAsync(
      "UPDATE transaction_attachments SET upload_status = 'pending' WHERE upload_status = 'uploading' AND user_id = ?", userId);
  }

  /**
   * Uploads that may run now: this account's, not deleted, file present, retry time reached, and only for transactions the
   * server already knows (synced, or synced before and edited since) — the server refuses attachments of unknown transactions.
   */
  async getUploadable(userId: string, nowIso: string, limit = 25): Promise<AttachmentEntity[]> {
    return this.db.getAllAsync<AttachmentEntity>(
      `SELECT a.* FROM transaction_attachments a
       JOIN transactions t ON t.id = a.transaction_id
       WHERE a.user_id = ? AND a.deleted_at IS NULL AND a.local_path IS NOT NULL
         AND a.upload_status IN ('pending', 'failed')
         AND (a.next_retry_at IS NULL OR a.next_retry_at <= ?)
         AND t.deleted_at IS NULL AND t.sync_status IN ('synced', 'pending_update')
       ORDER BY a.created_at ASC
       LIMIT ?`,
      userId, nowIso, limit,
    );
  }

  /** Tombstones the server still has to hear about. */
  async getPendingDeletions(userId: string): Promise<AttachmentEntity[]> {
    return this.db.getAllAsync<AttachmentEntity>(
      `SELECT * FROM transaction_attachments
       WHERE deleted_at IS NOT NULL AND remote_id IS NOT NULL AND user_id = ?`,
      userId,
    );
  }

  /** Guest attachments of a transaction that now belongs to an account (guest data import): queue them for upload. */
  async adoptForUser(userId: string): Promise<number> {
    const r = await this.db.runAsync(
      `UPDATE transaction_attachments SET user_id = ?, upload_status = 'pending', updated_at = ?
       WHERE user_id IS NULL AND deleted_at IS NULL
         AND transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)`,
      userId, new Date().toISOString(), userId,
    );
    return r.changes;
  }
}
