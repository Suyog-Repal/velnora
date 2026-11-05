import type {
  CreateTransactionInput,
  IDatabase,
  RemoteTransaction,
  SyncStatus,
  TransactionEntity,
  UpdateTransactionInput,
} from '../types.ts';
import { generateUUID, SyncQueueRepository } from './syncQueueRepository.ts';
import { withWriteLock } from '../writeLock.ts';

const EXTRA_UPDATE_COLUMNS = [
  'merchant_phone', 'payment_method', 'receipt_local_path', 'receipt_remote_id', 'receipt_upload_pending',
  'location_lat', 'location_lng', 'location_name', 'location_address', 'location_confirmed',
] as const;

export class TransactionRepository {
  private db: IDatabase;
  private syncQueueRepo: SyncQueueRepository;

  constructor(db: IDatabase) {
    this.db = db;
    this.syncQueueRepo = new SyncQueueRepository(db);
  }

  create(input: CreateTransactionInput): Promise<TransactionEntity> {
    return withWriteLock(() => this.createUnlocked(input));
  }

  private async createUnlocked(input: CreateTransactionInput): Promise<TransactionEntity> {
    if (!input.amount || input.amount <= 0) {
      throw new Error('Transaction amount must be greater than zero');
    }
    if (!input.counterparty?.trim()) {
      throw new Error('Counterparty cannot be empty');
    }

    // 1. Authoritative duplicate check by reference_id (bank UTR / txn reference)
    if (input.reference_id?.trim()) {
      const existingRef = await this.findByReferenceId(input.reference_id.trim(), input.user_id);
      if (existingRef) {
        return existingRef;
      }
    }

    // 2. Duplicate check by fingerprint
    // Only treat as duplicate if incoming has no reference_id, or existing has matching/empty reference_id
    if (input.fingerprint?.trim()) {
      const existingFp = await this.findByFingerprint(input.fingerprint.trim(), input.user_id);
      if (existingFp) {
        if (!input.reference_id?.trim() || !existingFp.reference_id || input.reference_id.trim() === existingFp.reference_id) {
          return existingFp;
        }
      }
    }

    const id = input.id || generateUUID();
    const now = new Date().toISOString();
    const transactionDate = input.transaction_date || now;
    const syncStatus: SyncStatus = input.sync_status || 'pending_create';
    const source = input.source || 'manual';
    const description = input.description?.trim() || '';

    const amount = input.amount;
    const amountPaise = input.amount_paise ?? Math.round(amount * 100);

    const record: TransactionEntity = {
      id,
      user_id: input.user_id ?? null,
      amount,
      amount_paise: amountPaise,
      direction: input.direction,
      counterparty: input.counterparty.trim(),
      category_id: input.category_id ?? null,
      category: input.category.trim(),
      description,
      transaction_date: transactionDate,
      source,
      reference_id: input.reference_id?.trim() ?? null,
      fingerprint: input.fingerprint?.trim() ?? null,
      sync_status: syncStatus,
      server_version: 1,
      deleted_at: null,
      created_at: now,
      updated_at: now,
      merchant_phone: input.merchant_phone ?? null,
      payment_method: input.payment_method ?? null,
      receipt_local_path: null,
      receipt_remote_id: null,
      receipt_upload_pending: 0,
      location_lat: input.location_lat ?? null,
      location_lng: input.location_lng ?? null,
      location_name: input.location_name ?? null,
      location_address: input.location_address ?? null,
      location_confirmed: input.location_confirmed ?? 0,
    };

    await this.db.execAsync('BEGIN TRANSACTION');
    try {
      await this.db.runAsync(
        `INSERT INTO transactions (
          id, user_id, amount, amount_paise, direction, counterparty, category_id, category,
          description, transaction_date, source, reference_id, fingerprint,
          sync_status, server_version, deleted_at, created_at, updated_at,
          merchant_phone, payment_method, location_lat, location_lng, location_name, location_address, location_confirmed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.id,
        record.user_id,
        record.amount,
        record.amount_paise,
        record.direction,
        record.counterparty,
        record.category_id,
        record.category,
        record.description,
        record.transaction_date,
        record.source,
        record.reference_id,
        record.fingerprint,
        record.sync_status,
        record.server_version,
        record.deleted_at,
        record.created_at,
        record.updated_at,
        record.merchant_phone,
        record.payment_method,
        record.location_lat,
        record.location_lng,
        record.location_name,
        record.location_address,
        record.location_confirmed,
      );

      // If pending, enqueue into sync_queue atomically
      if (syncStatus === 'pending_create') {
        await this.syncQueueRepo.enqueue({
          entity_type: 'transaction',
          entity_id: record.id,
          operation: 'create',
          payload: JSON.stringify(record),
        });
      }

      await this.db.execAsync('COMMIT');
      return record;
    } catch (err) {
      await this.db.execAsync('ROLLBACK');
      throw err;
    }
  }

  private mapRow(row: TransactionEntity): TransactionEntity {
    return {
      ...row,
      amount_paise: row.amount_paise ?? Math.round(row.amount * 100),
    };
  }

  async getAll(options?: { userId?: string | null; includeDeleted?: boolean; limit?: number; offset?: number }): Promise<TransactionEntity[]> {
    const includeDeleted = options?.includeDeleted ?? false;
    const limit = options?.limit ?? 500;
    const offset = options?.offset ?? 0;
    const userId = options?.userId;

    let sql: string;
    const params: unknown[] = [];

    if (userId !== undefined) {
      if (includeDeleted) {
        sql = 'SELECT * FROM transactions WHERE (user_id = ? OR (user_id IS NULL AND ? IS NULL)) ORDER BY transaction_date DESC LIMIT ? OFFSET ?';
        params.push(userId, userId, limit, offset);
      } else {
        sql = 'SELECT * FROM transactions WHERE deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL)) ORDER BY transaction_date DESC LIMIT ? OFFSET ?';
        params.push(userId, userId, limit, offset);
      }
    } else {
      sql = includeDeleted
        ? 'SELECT * FROM transactions ORDER BY transaction_date DESC LIMIT ? OFFSET ?'
        : 'SELECT * FROM transactions WHERE deleted_at IS NULL ORDER BY transaction_date DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
    }

    const rows = await this.db.getAllAsync<TransactionEntity>(sql, ...params);
    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: string): Promise<TransactionEntity | null> {
    const row = await this.db.getFirstAsync<TransactionEntity>(
      'SELECT * FROM transactions WHERE id = ?',
      id,
    );
    return row ? this.mapRow(row) : null;
  }

  update(id: string, updates: UpdateTransactionInput): Promise<TransactionEntity> {
    return withWriteLock(() => this.updateUnlocked(id, updates));
  }

  private async updateUnlocked(id: string, updates: UpdateTransactionInput): Promise<TransactionEntity> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Transaction with ID ${id} not found`);
    }

    const now = new Date().toISOString();
    const amount = updates.amount !== undefined ? updates.amount : existing.amount;
    const amountPaise = Math.round(amount * 100);
    const direction = updates.direction !== undefined ? updates.direction : existing.direction;
    const counterparty = updates.counterparty !== undefined ? updates.counterparty.trim() : existing.counterparty;
    const category = updates.category !== undefined ? updates.category.trim() : existing.category;
    const categoryId = updates.category_id !== undefined ? updates.category_id : existing.category_id;
    const description = updates.description !== undefined ? updates.description.trim() : existing.description;
    const transactionDate = updates.transaction_date !== undefined ? updates.transaction_date : existing.transaction_date;

    const syncStatus: SyncStatus = existing.sync_status === 'pending_create' ? 'pending_create' : 'pending_update';

    // Optional detail fields: only columns explicitly present in `updates` are written (null clears).
    const extraCols: string[] = [];
    const extraValues: unknown[] = [];
    for (const col of EXTRA_UPDATE_COLUMNS) {
      const v = (updates as Record<string, unknown>)[col];
      if (v !== undefined) { extraCols.push(`${col} = ?`); extraValues.push(v); }
    }
    const extraSet = extraCols.length ? `, ${extraCols.join(', ')}` : '';

    await this.db.execAsync('BEGIN TRANSACTION');
    try {
      await this.db.runAsync(
        `UPDATE transactions
         SET amount = ?, amount_paise = ?, direction = ?, counterparty = ?, category = ?, category_id = ?,
             description = ?, transaction_date = ?, sync_status = ?, updated_at = ?${extraSet}
         WHERE id = ?`,
        amount,
        amountPaise,
        direction,
        counterparty,
        category,
        categoryId,
        description,
        transactionDate,
        syncStatus,
        now,
        ...extraValues,
        id,
      );

      const updated = (await this.getById(id))!;

      await this.syncQueueRepo.enqueue({
        entity_type: 'transaction',
        entity_id: updated.id,
        operation: updated.sync_status === 'pending_create' ? 'create' : 'update',
        payload: JSON.stringify(updated),
      });

      await this.db.execAsync('COMMIT');
      return updated;
    } catch (err) {
      await this.db.execAsync('ROLLBACK');
      throw err;
    }
  }

  delete(id: string): Promise<boolean> {
    return withWriteLock(() => this.deleteUnlocked(id));
  }

  private async deleteUnlocked(id: string): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    const now = new Date().toISOString();

    await this.db.execAsync('BEGIN TRANSACTION');
    try {
      // Soft-delete with tombstone
      await this.db.runAsync(
        `UPDATE transactions
         SET deleted_at = ?, sync_status = ?, updated_at = ?
         WHERE id = ?`,
        now,
        existing.sync_status === 'pending_create' ? 'pending_create' : 'pending_delete',
        now,
        id,
      );

      if (existing.sync_status === 'pending_create') {
        // If it was never sent to server, remove creation from sync queue
        await this.syncQueueRepo.removeForEntity('transaction', id);
      } else {
        // If it exists on server, enqueue delete operation for sync
        await this.syncQueueRepo.enqueue({
          entity_type: 'transaction',
          entity_id: id,
          operation: 'delete',
          payload: JSON.stringify({ id, deleted_at: now, user_id: existing.user_id }),
        });
      }

      await this.db.execAsync('COMMIT');
      return true;
    } catch (err) {
      await this.db.execAsync('ROLLBACK');
      throw err;
    }
  }

  async filterByDate(startDate: string, endDate: string): Promise<TransactionEntity[]> {
    const rows = await this.db.getAllAsync<TransactionEntity>(
      `SELECT * FROM transactions
       WHERE deleted_at IS NULL AND transaction_date >= ? AND transaction_date <= ?
       ORDER BY transaction_date DESC`,
      startDate,
      endDate,
    );
    return rows.map((r) => this.mapRow(r));
  }

  async filterByCategory(category: string): Promise<TransactionEntity[]> {
    const rows = await this.db.getAllAsync<TransactionEntity>(
      `SELECT * FROM transactions
       WHERE deleted_at IS NULL AND category = ?
       ORDER BY transaction_date DESC`,
      category,
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getPending(): Promise<TransactionEntity[]> {
    const rows = await this.db.getAllAsync<TransactionEntity>(
      `SELECT * FROM transactions
       WHERE sync_status != 'synced'
       ORDER BY updated_at ASC`,
    );
    return rows.map((r) => this.mapRow(r));
  }

  async updateSyncStatus(id: string, status: SyncStatus, serverVersion?: number): Promise<void> {
    const now = new Date().toISOString();
    if (serverVersion !== undefined) {
      await this.db.runAsync(
        `UPDATE transactions
         SET sync_status = ?, server_version = ?, updated_at = ?
         WHERE id = ?`,
        status,
        serverVersion,
        now,
        id,
      );
    } else {
      await this.db.runAsync(
        `UPDATE transactions
         SET sync_status = ?, updated_at = ?
         WHERE id = ?`,
        status,
        now,
        id,
      );
    }
  }

  async findByReferenceId(referenceId: string, userId?: string | null): Promise<TransactionEntity | null> {
    const sql = userId !== undefined
      ? 'SELECT * FROM transactions WHERE reference_id = ? AND deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))'
      : 'SELECT * FROM transactions WHERE reference_id = ? AND deleted_at IS NULL';
    const params = userId !== undefined ? [referenceId, userId, userId] : [referenceId];
    const row = await this.db.getFirstAsync<TransactionEntity>(sql, ...params);
    return row ? this.mapRow(row) : null;
  }

  async findByFingerprint(fingerprint: string, userId?: string | null): Promise<TransactionEntity | null> {
    const sql = userId !== undefined
      ? 'SELECT * FROM transactions WHERE fingerprint = ? AND deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))'
      : 'SELECT * FROM transactions WHERE fingerprint = ? AND deleted_at IS NULL';
    const params = userId !== undefined ? [fingerprint, userId, userId] : [fingerprint];
    const row = await this.db.getFirstAsync<TransactionEntity>(sql, ...params);
    return row ? this.mapRow(row) : null;
  }

  async mergeRemoteTransaction(
    remote: RemoteTransaction,
    options?: { forceServerWin?: boolean },
  ): Promise<'inserted' | 'updated' | 'conflict_preserved' | 'ignored'> {
    const outcome = await this.mergeRemoteCore(remote, options);
    if ((outcome === 'inserted' || outcome === 'updated') && remote.merchant_phone !== undefined) {
      // Server-confirmed detail fields. Never touches receipt_local_path (device-private).
      await this.db.runAsync(
        `UPDATE transactions SET merchant_phone = ?, payment_method = ?, receipt_remote_id = ?,
           location_lat = ?, location_lng = ?, location_name = ?, location_address = ?, location_confirmed = ?
         WHERE id = ?`,
        remote.merchant_phone ?? null, remote.payment_method ?? null, remote.receipt_remote_id ?? null,
        remote.location_lat ?? null, remote.location_lng ?? null, remote.location_name ?? null,
        remote.location_address ?? null, remote.location_confirmed ? 1 : 0, remote.id,
      );
    }
    return outcome;
  }

  private async mergeRemoteCore(
    remote: RemoteTransaction,
    options?: { forceServerWin?: boolean },
  ): Promise<'inserted' | 'updated' | 'conflict_preserved' | 'ignored'> {
    const existing = await this.getById(remote.id);
    const amountNum = typeof remote.amount === 'string' ? parseFloat(remote.amount) : remote.amount;
    const amountPaise = remote.amount_paise ?? Math.round(amountNum * 100);

    if (!existing) {
      if (remote.deleted_at) {
        // Record was soft-deleted on server and never existed locally; record tombstone
        await this.db.runAsync(
          `INSERT INTO transactions (
            id, user_id, amount, amount_paise, direction, counterparty, category_id, category,
            description, transaction_date, source, reference_id, fingerprint,
            sync_status, server_version, deleted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?)`,
          remote.id,
          remote.user_id,
          amountNum,
          amountPaise,
          remote.direction,
          remote.counterparty,
          remote.category_id ?? null,
          remote.category,
          remote.description || '',
          remote.transaction_date,
          remote.source,
          remote.reference_id ?? null,
          remote.fingerprint ?? null,
          remote.server_version,
          remote.deleted_at,
          remote.created_at,
          remote.updated_at,
        );
        return 'inserted';
      }

      await this.db.runAsync(
        `INSERT INTO transactions (
          id, user_id, amount, amount_paise, direction, counterparty, category_id, category,
          description, transaction_date, source, reference_id, fingerprint,
          sync_status, server_version, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, NULL, ?, ?)`,
        remote.id,
        remote.user_id,
        amountNum,
        amountPaise,
        remote.direction,
        remote.counterparty,
        remote.category_id ?? null,
        remote.category,
        remote.description || '',
        remote.transaction_date,
        remote.source,
        remote.reference_id ?? null,
        remote.fingerprint ?? null,
        remote.server_version,
        remote.created_at,
        remote.updated_at,
      );
      return 'inserted';
    }

    // Existing record exists locally: check sync_status or explicit server conflict resolution
    if (existing.sync_status === 'synced' || options?.forceServerWin) {
      // Clean remote update or confirmed server conflict resolution
      await this.db.runAsync(
        `UPDATE transactions
         SET user_id = ?, amount = ?, amount_paise = ?, direction = ?, counterparty = ?,
             category_id = ?, category = ?, description = ?, transaction_date = ?,
             source = ?, reference_id = ?, fingerprint = ?, sync_status = 'synced',
             server_version = ?, deleted_at = ?, updated_at = ?
         WHERE id = ?`,
        remote.user_id,
        amountNum,
        amountPaise,
        remote.direction,
        remote.counterparty,
        remote.category_id ?? null,
        remote.category,
        remote.description || '',
        remote.transaction_date,
        remote.source,
        remote.reference_id ?? null,
        remote.fingerprint ?? null,
        remote.server_version,
        remote.deleted_at ?? null,
        remote.updated_at,
        remote.id,
      );
      return 'updated';
    }

    // Local record is dirty (pending_create, pending_update, pending_delete)
    // NEVER silently overwrite pending local changes!
    if (existing.sync_status === 'pending_delete') {
      return 'conflict_preserved';
    }

    if (remote.deleted_at) {
      // Remote deleted, but local was edited: retain local changes so user doesn't lose work
      return 'conflict_preserved';
    }

    // Compare updated_at timestamps
    const localTime = new Date(existing.updated_at).getTime();
    const remoteTime = new Date(remote.updated_at).getTime();

    if (remoteTime > localTime) {
      // Remote is strictly newer: update server_version anchor but preserve local pending edits
      await this.db.runAsync(
        'UPDATE transactions SET server_version = ? WHERE id = ?',
        remote.server_version,
        remote.id,
      );
      return 'conflict_preserved';
    } else {
      // Local is newer: preserve local fields and pending status
      return 'conflict_preserved';
    }
  }
}
