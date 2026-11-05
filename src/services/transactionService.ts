import { getDatabase } from '../db/database.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { CategoryRepository } from '../db/repositories/categoryRepository.ts';
import { SyncQueueRepository } from '../db/repositories/syncQueueRepository.ts';
import { migrateFromAsyncStorage } from '../db/asyncStorageMigration.ts';
import type { CategoryEntity, CreateTransactionInput, Direction, IDatabase, Session, TransactionEntity } from '../db/types.ts';
import type { ParsedSmsTransaction } from '../../transactionParser.ts';
import { canEditTransaction, toUpdateInput, type DetailsPatch } from './transactionDetails.ts';
import { applyAlias } from './merchantAliasService.ts';
import { triggerSync, type SyncSummary } from './syncEngine.ts';

let repositoriesInitialized = false;
let txRepo: TransactionRepository | null = null;
let catRepo: CategoryRepository | null = null;
let syncRepo: SyncQueueRepository | null = null;
let activeDb: IDatabase | null = null;

/** The SQLite connection the services currently use (also the injected one in tests). */
export function getServiceDb(): IDatabase {
  if (!activeDb) throw new Error('Local database is not initialised');
  return activeDb;
}

export function setTransactionServiceAdapter(customDb: IDatabase | null): void {
  activeDb = customDb;
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
    activeDb = db;
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

/** Local-only guest records (no owner). Never uploaded; see guestModeService. */
export async function getGuestTransactions(): Promise<TransactionEntity[]> {
  const { transactionRepository } = await initTransactionService();
  return transactionRepository.getAll({ userId: null });
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
  // A saved merchant correction (account only) is applied to the typed merchant name; the user's category choice stands.
  const aliased = await applyAlias(getServiceDb(), session?.user.id ?? null, input.counterparty);
  const created = await transactionRepository.create({
    ...input,
    counterparty: aliased.matched ? aliased.merchant : input.counterparty,
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
  // Saved alias (this account only): corrected merchant name and, if the user saved one, its category.
  // The original SMS merchant text is preserved in the description. Raw SMS bodies are never stored here.
  const aliased = await applyAlias(getServiceDb(), session?.user.id ?? null, parsed.merchant);
  const created = await transactionRepository.create({
    amount: parsed.amount,
    direction: parsed.direction,
    counterparty: aliased.matched ? aliased.merchant : parsed.merchant,
    category: aliased.category ?? (parsed.direction === 'income' ? 'Other Income' : 'Other Expenses'),
    description: aliased.matched ? `Detected from ${parsed.bankSender} (${parsed.merchant})` : `Detected from ${parsed.bankSender}`,
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

let postSyncHook: ((session: Session) => Promise<void>) | null = null;
/** Lets the app run extra work (receipt uploads) after each sync without the service depending on native modules. */
export function setPostSyncHook(hook: ((session: Session) => Promise<void>) | null): void {
  postSyncHook = hook;
}

export async function syncPendingTransactions(session: Session): Promise<SyncSummary> {
  const summary = await triggerSync(session);
  if (postSyncHook) await postSyncHook(session).catch(() => undefined);
  return summary;
}

/**
 * Validated, ownership-checked edit used by the transaction bottom sheet.
 * Saves locally first (SQLite is the source of truth), queues sync, then syncs in the background if signed in.
 */
export async function updateTransactionDetails(
  id: string,
  patch: DetailsPatch,
  session: Session | null,
): Promise<TransactionEntity> {
  const { transactionRepository } = await initTransactionService();
  const existing = await transactionRepository.getById(id);
  if (!existing || existing.deleted_at) throw new Error('Transaction not found.');
  if (!canEditTransaction(existing, session)) throw new Error('This transaction belongs to a different account.');
  const updated = await transactionRepository.update(id, toUpdateInput(patch));
  if (session) void syncPendingTransactions(session);
  return updated;
}
