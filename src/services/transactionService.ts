import { getDatabase } from '../db/database.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { CategoryRepository } from '../db/repositories/categoryRepository.ts';
import { SyncQueueRepository } from '../db/repositories/syncQueueRepository.ts';
import { migrateFromAsyncStorage } from '../db/asyncStorageMigration.ts';
import type { CategoryEntity, CreateTransactionInput, Direction, IDatabase, Session, TransactionEntity } from '../db/types.ts';
import type { ParsedSmsTransaction } from '../../transactionParser.ts';
import { triggerSync, type SyncSummary } from './syncEngine.ts';

let repositoriesInitialized = false;
let txRepo: TransactionRepository | null = null;
let catRepo: CategoryRepository | null = null;
let syncRepo: SyncQueueRepository | null = null;

export function setTransactionServiceAdapter(customDb: IDatabase | null): void {
  if (customDb) {
    txRepo = new TransactionRepository(customDb);
    catRepo = new CategoryRepository(customDb);
    syncRepo = new SyncQueueRepository(customDb);
    repositoriesInitialized = true;
  } else {
    txRepo = null;
    catRepo = null;
    syncRepo = null;
    repositoriesInitialized = false;
  }
}

export async function initTransactionService(): Promise<{
  transactionRepository: TransactionRepository;
  categoryRepository: CategoryRepository;
  syncQueueRepository: SyncQueueRepository;
}> {
  const db = await getDatabase();

  if (!repositoriesInitialized || !txRepo || !catRepo || !syncRepo) {
    txRepo = new TransactionRepository(db);
    catRepo = new CategoryRepository(db);
    syncRepo = new SyncQueueRepository(db);
    repositoriesInitialized = true;

    // Run safe, idempotent migration from legacy AsyncStorage
    try {
      await migrateFromAsyncStorage(db);
    } catch (e) {
      console.warn('AsyncStorage migration notice:', e);
    }
  }

  return {
    transactionRepository: txRepo,
    categoryRepository: catRepo,
    syncQueueRepository: syncRepo,
  };
}

export async function getTransactions(userId?: string | null): Promise<TransactionEntity[]> {
  if (!userId?.trim()) {
    return [];
  }
  const { transactionRepository } = await initTransactionService();
  return transactionRepository.getAll({ userId: userId.trim() });
}

export async function getCategories(): Promise<CategoryEntity[]> {
  const { categoryRepository } = await initTransactionService();
  return categoryRepository.getAll();
}

export async function addTransaction(
  input: CreateTransactionInput,
  session: Session | null,
): Promise<TransactionEntity> {
  const { transactionRepository } = await initTransactionService();
  const created = await transactionRepository.create({
    ...input,
    user_id: session?.user.id ?? null,
  });

  if (session) {
    void syncPendingTransactions(session);
  }

  return created;
}

export async function addSmsTransaction(
  parsed: ParsedSmsTransaction,
  session: Session | null,
): Promise<TransactionEntity> {
  const { transactionRepository } = await initTransactionService();
  const created = await transactionRepository.create({
    amount: parsed.amount,
    direction: parsed.direction,
    counterparty: parsed.merchant,
    category: parsed.direction === 'income' ? 'Other Income' : 'Other Expenses',
    description: `Detected from ${parsed.bankSender}`,
    transaction_date: parsed.transactionDate,
    source: 'sms',
    reference_id: parsed.referenceId,
    fingerprint: parsed.fingerprint,
    user_id: session?.user.id ?? null,
    sync_status: 'pending_create',
  });

  if (session) {
    void syncPendingTransactions(session);
  }

  return created;
}

export async function updateTransaction(
  id: string,
  updates: {
    amount?: number;
    direction?: Direction;
    counterparty?: string;
    category?: string;
    description?: string;
  },
  session: Session | null,
): Promise<TransactionEntity> {
  const { transactionRepository } = await initTransactionService();
  const updated = await transactionRepository.update(id, updates);

  if (session) {
    void syncPendingTransactions(session);
  }

  return updated;
}

export async function deleteTransaction(
  id: string,
  session: Session | null,
): Promise<boolean> {
  const { transactionRepository } = await initTransactionService();
  const success = await transactionRepository.delete(id);

  if (session) {
    void syncPendingTransactions(session);
  }

  return success;
}

export async function syncPendingTransactions(session: Session): Promise<SyncSummary> {
  return triggerSync(session);
}
