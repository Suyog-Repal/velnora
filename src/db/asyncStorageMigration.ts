import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IDatabase, SyncStatus, TransactionEntity } from './types.ts';
import { SyncQueueRepository } from './repositories/syncQueueRepository.ts';

export const ASYNC_STORAGE_TRANSACTIONS_KEY = 'velnora.transactions.v1';
export const ASYNC_STORAGE_SYNC_QUEUE_KEY = 'velnora.transaction-sync.v1';
export const MIGRATION_METADATA_KEY = 'async_storage_migrated';

export interface MigrationResult {
  status: 'completed' | 'already_migrated' | 'empty' | 'failed';
  migratedCount: number;
  totalInAsyncStorage: number;
  error?: string;
}

interface LegacyTransaction {
  id: string;
  amount: number;
  direction: 'income' | 'expense';
  counterparty: string;
  category: string;
  description: string;
  date: string;
  source?: 'manual' | 'sms';
  referenceId?: string;
  fingerprint?: string;
}

export async function migrateFromAsyncStorage(db: IDatabase): Promise<MigrationResult> {
  // 1. Check if migration was already verified and completed
  const existingMigration = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_metadata WHERE key = ?',
    MIGRATION_METADATA_KEY,
  );

  if (existingMigration) {
    try {
      const parsed = JSON.parse(existingMigration.value);
      if (parsed.status === 'completed') {
        return {
          status: 'already_migrated',
          migratedCount: parsed.migratedCount ?? 0,
          totalInAsyncStorage: parsed.totalInAsyncStorage ?? 0,
        };
      }
    } catch {
      // If metadata is corrupt, re-run safe idempotent migration
    }
  }

  // 2. Read legacy records from AsyncStorage (DO NOT delete them)
  const rawTransactions = await AsyncStorage.getItem(ASYNC_STORAGE_TRANSACTIONS_KEY);
  const rawSyncQueue = await AsyncStorage.getItem(ASYNC_STORAGE_SYNC_QUEUE_KEY);

  let legacyTransactions: LegacyTransaction[] = [];
  if (rawTransactions) {
    try {
      const parsed = JSON.parse(rawTransactions);
      if (Array.isArray(parsed)) {
        legacyTransactions = parsed;
      }
    } catch (e) {
      return {
        status: 'failed',
        migratedCount: 0,
        totalInAsyncStorage: 0,
        error: `Failed to parse AsyncStorage transactions: ${String(e)}`,
      };
    }
  }

  if (legacyTransactions.length === 0) {
    // Record completion for empty state
    await db.runAsync(
      `INSERT OR REPLACE INTO app_metadata (key, value, updated_at)
       VALUES (?, ?, ?)`,
      MIGRATION_METADATA_KEY,
      JSON.stringify({ status: 'completed', migratedCount: 0, totalInAsyncStorage: 0, timestamp: new Date().toISOString() }),
      new Date().toISOString(),
    );
    return { status: 'empty', migratedCount: 0, totalInAsyncStorage: 0 };
  }

  // Identify transactions that were queued for sync
  const queuedIds = new Set<string>();
  if (rawSyncQueue) {
    try {
      const parsedQueue = JSON.parse(rawSyncQueue);
      if (Array.isArray(parsedQueue)) {
        for (const item of parsedQueue) {
          if (item?.id) queuedIds.add(item.id);
        }
      }
    } catch {
      // Non-fatal, assume not queued if parse fails
    }
  }

  const syncQueueRepo = new SyncQueueRepository(db);
  const now = new Date().toISOString();
  let migratedCount = 0;

  // 3. Migrate each transaction into SQLite (safe & idempotent)
  for (const legacy of legacyTransactions) {
    const existing = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM transactions WHERE id = ?',
      legacy.id,
    );

    const isQueued = queuedIds.has(legacy.id);
    const syncStatus: SyncStatus = isQueued ? 'pending_create' : 'synced';
    const source = legacy.source ?? (legacy.referenceId ? 'sms' : 'manual');
    const transactionDate = legacy.date || now;

    if (!existing) {
      const amountPaise = Math.round(legacy.amount * 100);
      await db.runAsync(
        `INSERT INTO transactions (
          id, user_id, amount, amount_paise, direction, counterparty, category_id, category,
          description, transaction_date, source, reference_id, fingerprint,
          sync_status, server_version, deleted_at, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
        legacy.id,
        legacy.amount,
        amountPaise,
        legacy.direction,
        legacy.counterparty,
        legacy.category,
        legacy.description || '',
        transactionDate,
        source,
        legacy.referenceId ?? null,
        legacy.fingerprint ?? null,
        syncStatus,
        transactionDate,
        now,
      );
      migratedCount += 1;
    }

    if (isQueued) {
      const record: TransactionEntity = {
        id: legacy.id,
        user_id: null,
        amount: legacy.amount,
        amount_paise: Math.round(legacy.amount * 100),
        direction: legacy.direction,
        counterparty: legacy.counterparty,
        category_id: null,
        category: legacy.category,
        description: legacy.description || '',
        transaction_date: transactionDate,
        source,
        reference_id: legacy.referenceId ?? null,
        fingerprint: legacy.fingerprint ?? null,
        sync_status: 'pending_create',
        server_version: 1,
        deleted_at: null,
        created_at: transactionDate,
        updated_at: now,
      };

      await syncQueueRepo.enqueue({
        entity_type: 'transaction',
        entity_id: legacy.id,
        operation: 'create',
        payload: JSON.stringify(record),
      });
    }
  }

  // 4. Verification step: verify records exist in SQLite
  let verifiedCount = 0;
  for (const legacy of legacyTransactions) {
    const row = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM transactions WHERE id = ?',
      legacy.id,
    );
    if (row) {
      verifiedCount += 1;
    }
  }

  if (verifiedCount !== legacyTransactions.length) {
    return {
      status: 'failed',
      migratedCount,
      totalInAsyncStorage: legacyTransactions.length,
      error: `Verification mismatch: ${verifiedCount} of ${legacyTransactions.length} records verified in SQLite`,
    };
  }

  // 5. Mark migration as completed in metadata
  await db.runAsync(
    `INSERT OR REPLACE INTO app_metadata (key, value, updated_at)
     VALUES (?, ?, ?)`,
    MIGRATION_METADATA_KEY,
    JSON.stringify({
      status: 'completed',
      migratedCount,
      totalInAsyncStorage: legacyTransactions.length,
      timestamp: new Date().toISOString(),
    }),
    new Date().toISOString(),
  );

  return {
    status: 'completed',
    migratedCount,
    totalInAsyncStorage: legacyTransactions.length,
  };
}
