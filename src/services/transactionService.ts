import { getDatabase } from '../db/database.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { CategoryRepository } from '../db/repositories/categoryRepository.ts';
import { SyncQueueRepository } from '../db/repositories/syncQueueRepository.ts';
import { migrateFromAsyncStorage } from '../db/asyncStorageMigration.ts';
import type { CategoryEntity, CreateTransactionInput, DetectionSource, Direction, IDatabase, Session, TransactionEntity, UpdateTransactionInput } from '../db/types.ts';
import { recordAccountEvidence } from './accountService.ts';
import { isGenericMerchant } from './duplicateMatcher.ts';
import { evaluateCompleteness, isAutoDetected, type ReviewField } from './transactionCompleteness.ts';
import { cancelReviewNotification, reviewContext, runReviewPass } from './reviewNotifications.ts';
import type { IngestOutcome } from '../db/repositories/transactionRepository.ts';
import type { ParsedSmsTransaction } from '../../transactionParser.ts';
import { canEditTransaction, toUpdateInput, type DetailsPatch } from './transactionDetails.ts';
import { applyAlias, rememberAlias } from './merchantAliasService.ts';
import { autoSettleFromTransaction } from './expectedPaymentService.ts';
import { listCategories } from './categoryService.ts';
import { applySplitPlan, deleteSplitForTransaction, planSplitForTransactionEdit, type SplitEditPlan, type SplitExpenseInput } from './splitService.ts';
import { syncEngine, triggerSync, type SyncSummary } from './syncEngine.ts';
import { installSyncHttpTally, recordSyncCycle } from './syncDiagnostics.ts';

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
  return withDetectionSources(transactionRepository, await transactionRepository.getAll({ userId: userId.trim() }));
}

async function withDetectionSources(repo: TransactionRepository, rows: TransactionEntity[]): Promise<TransactionEntity[]> {
  try {
    const sources = await repo.getSourcesFor(rows.map((r) => r.id));
    return rows.map((r) => (sources[r.id] ? { ...r, detected_via: sources[r.id] } : r));
  } catch {
    return rows; // source metadata is debug-only; never block the list
  }
}

/** Local-only guest records (no owner). Never uploaded; see guestModeService. */
export async function getGuestTransactions(): Promise<TransactionEntity[]> {
  const { transactionRepository } = await initTransactionService();
  return withDetectionSources(transactionRepository, await transactionRepository.getAll({ userId: null }));
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

  // If this payment matches something the person was expected to pay/receive (exact name + exact outstanding amount), settle it.
  try { await autoSettleFromTransaction(getServiceDb(), session?.user.id ?? null, created); } catch { /* never block recording a transaction */ }

  if (session) {
    void syncPendingTransactions(session);
  }

  return created;
}

export async function addSmsTransaction(
  parsed: ParsedSmsTransaction,
  session: Session | null,
): Promise<TransactionEntity> {
  return (await ingestDetectedTransaction(parsed, { source: 'sms', detectedAt: parsed.receivedAt }, session)).transaction;
}

/**
 * Single entry point for every auto-detected bank event (SMS, Truecaller notification, ...). Idempotent: an event that
 * is already known only records its source on the existing transaction (no new row, no settle, no sync enqueue).
 * Raw message bodies are never stored here.
 */
export async function ingestDetectedTransaction(
  parsed: ParsedSmsTransaction,
  detection: { source: DetectionSource; detectedAt: number; senderLabel?: string },
  session: Session | null,
): Promise<IngestOutcome> {
  const { transactionRepository } = await initTransactionService();
  // Saved alias (this account only): corrected merchant name and, if the user saved one, its category.
  // The original merchant text is preserved in the description.
  const aliased = await applyAlias(getServiceDb(), session?.user.id ?? null, parsed.merchant);
  const account = await recordAccountEvidence(getServiceDb(), session?.user.id ?? null, parsed.bankName ?? null, parsed.accountLast4 ?? null);
  const scope = session?.user.id ?? null;
  const counterparty = aliased.matched ? aliased.merchant : parsed.merchant;
  const category = aliased.category ?? parsed.category ?? (parsed.direction === 'income' ? 'Other Income' : 'Other Expenses');
  const completeness = evaluateCompleteness(
    { amount_paise: Math.round(parsed.amount * 100), direction: parsed.direction, counterparty, category, transaction_date: parsed.transactionDate, txn_kind: parsed.kind ?? 'payment', account_last4: account.last4 },
    { ...(await reviewContext(getServiceDb(), scope, parsed.merchant)), categoryConfirmed: !!aliased.category },
  );
  const outcome = await transactionRepository.ingestDetected(
    {
      amount: parsed.amount,
      direction: parsed.direction,
      counterparty,
      category,
      txn_kind: parsed.kind ?? 'payment',
      verification_status: completeness.complete ? 'detected' : 'needs_review',
      capture_source: detection.source === 'sms' ? 'sms' : 'notification',
      account_last4: account.last4,
      bank_name: account.bankName,
      payment_app: parsed.paymentApp ?? null,
      confidence: parsed.confidence ?? null,
      description: [
        aliased.matched ? `Detected from ${parsed.bankSender} (${parsed.merchant})` : `Detected from ${parsed.bankSender}`,
        parsed.accountLast4 ? `A/c XX${parsed.accountLast4}` : null,
        parsed.balance !== undefined ? `Avl bal INR ${parsed.balance.toFixed(2)}` : null,
      ].filter(Boolean).join(' · '),
      transaction_date: parsed.transactionDate,
      // 'sms' = auto-detected (the CHECK constraint and server schema know only manual|sms); the channel(s) that
      // actually saw it are in transaction_sources.
      source: 'sms',
      // Many bank alerts carry no reference; store NULL rather than '' (dedupe then relies on the fingerprint).
      reference_id: parsed.referenceId?.trim() || null,
      fingerprint: parsed.fingerprint,
      payment_method: parsed.paymentMethod ?? null,
      user_id: session?.user.id ?? null,
      sync_status: 'pending_create',
    },
    {
      source: detection.source,
      detectedAt: detection.detectedAt,
      eventKey: parsed.eventKey,
      metadata: {
        sender: detection.senderLabel ?? parsed.bankSender,
        referenceId: parsed.referenceId || undefined,
        accountLast4: parsed.accountLast4,
        balance: parsed.balance,
        fingerprint: parsed.fingerprint,
        sourceApp: parsed.paymentApp,
      },
    },
  );

  if (outcome.created) {
    // If this payment matches something the person was expected to pay/receive (exact name + exact outstanding amount), settle it.
    try { await autoSettleFromTransaction(getServiceDb(), session?.user.id ?? null, outcome.transaction); } catch { /* never block recording a transaction */ }
    if (session) {
      void syncPendingTransactions(session);
    }
  } else if (outcome.newSource) {
    await refreshReviewState(outcome.transaction.id, scope, false);
    if (session) void syncPendingTransactions(session);
  }
  kickReviewPass(scope);
  return outcome;
}

/** Fire-and-forget: notification bookkeeping must never fail or slow a ledger write. */
function kickReviewPass(scope: string | null): void {
  try { void runReviewPass(getServiceDb(), scope).catch(() => undefined); } catch { /* database not ready */ }
}

/**
 * Re-judges a transaction after new information. byPerson: the person just edited it, so complete means verified.
 * Rows the person has already confirmed are left alone.
 */
async function refreshReviewState(id: string, scope: string | null, byPerson: boolean): Promise<void> {
  const { transactionRepository } = await initTransactionService();
  const tx = await transactionRepository.getById(id);
  if (!tx || tx.deleted_at || !isAutoDetected(tx.capture_source)) return;
  if (tx.verification_status !== 'detected' && tx.verification_status !== 'needs_review') return;
  const { complete } = evaluateCompleteness(tx, await reviewContext(getServiceDb(), scope, tx.counterparty));
  if (!complete) {
    if (tx.verification_status === 'detected') await transactionRepository.update(id, { verification_status: 'needs_review' });
    return;
  }
  if (tx.verification_status !== 'needs_review') return;
  const sources = (await transactionRepository.getSources(id)).map((s) => s.source);
  const independent = sources.includes('payment_notification') && (sources.includes('sms') || sources.includes('truecaller_notification'));
  await transactionRepository.update(id, { verification_status: byPerson || independent ? 'verified' : 'detected' });
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
  const before = await transactionRepository.getById(id);
  const plan = before && !before.deleted_at ? await planSplitForTransactionEdit(getServiceDb(), before.user_id, id, afterEdit(before, updates)) : null;
  const updated = await transactionRepository.update(id, updates);
  if (before && plan) await applySplitPlan(getServiceDb(), before.user_id, plan, updated);

  if (session) {
    void syncPendingTransactions(session);
  }

  return updated;
}

export type QuickCategoryResult = 'applied' | 'gone' | 'other_scope' | 'already_handled' | 'invalid_category';

/**
 * A category chosen on a notification button, applied without the app on screen. Idempotent and conservative:
 * - a transaction that is gone is dropped; one that belongs to another scope is left for that scope;
 * - one that no longer needs review was already handled in the app, and the person's choice there wins;
 * - the category must exist for this scope and direction, exactly as the pickers would offer it.
 * Saved locally first, then queued for sync like any edit (the sync engine never uploads guest rows).
 */
export async function applyNotificationCategory(id: string, category: string, session: Session | null): Promise<QuickCategoryResult> {
  const { transactionRepository } = await initTransactionService();
  const scope = session?.user.id ?? null;
  const tx = await transactionRepository.getById(id);
  if (!tx || tx.deleted_at) return 'gone';
  if ((tx.user_id ?? null) !== scope) return 'other_scope';
  if (tx.verification_status !== 'needs_review') return 'already_handled';
  const chosen = (await listCategories(getServiceDb(), scope)).find((c) => c.type === tx.direction && c.name.toLowerCase() === category.trim().toLowerCase());
  if (!chosen) return 'invalid_category';
  await transactionRepository.update(id, { category: chosen.name, category_id: chosen.id });
  await refreshReviewState(id, scope, true);
  cancelReviewNotification(id);
  kickReviewPass(scope);
  if (session) void syncPendingTransactions(session);
  return 'applied';
}

/** The amount (paise) and direction a transaction will have once `updates` is applied. */
function afterEdit(t: TransactionEntity, updates: { amount?: number; direction?: Direction }): { amountPaise: number; direction: string } {
  return { amountPaise: updates.amount !== undefined ? Math.round(updates.amount * 100) : t.amount_paise, direction: updates.direction ?? t.direction };
}

/** True when the transaction has a split, so the UI can ask before deleting both. */
export async function hasSplit(id: string): Promise<boolean> {
  await initTransactionService();
  return !!(await getServiceDb().getFirstAsync<{ id: string }>(`SELECT id FROM split_expenses WHERE transaction_id = ? AND deleted_at IS NULL`, id));
}

/** Deleting a transaction also removes its split (settlements are separate records and stay), so nothing orphaned keeps counting. */
export async function deleteTransaction(
  id: string,
  session: Session | null,
): Promise<boolean> {
  const { transactionRepository } = await initTransactionService();
  const existing = await transactionRepository.getById(id);
  const success = await transactionRepository.delete(id);
  if (success && existing) await deleteSplitForTransaction(getServiceDb(), existing.user_id, id);
  cancelReviewNotification(id);
  kickReviewPass(session?.user.id ?? null);

  if (session) {
    void syncPendingTransactions(session);
  }

  return success;
}

/** Saved locally first, like every edit; synced in the background when signed in. */
export async function updateLedgerFields(
  id: string,
  patch: Pick<UpdateTransactionInput, 'txn_kind' | 'verification_status' | 'account_last4' | 'bank_name'>,
  session: Session | null,
): Promise<TransactionEntity> {
  const { transactionRepository } = await initTransactionService();
  const existing = await transactionRepository.getById(id);
  if (!existing || existing.deleted_at) throw new Error('Transaction not found.');
  if (!canEditTransaction(existing, session)) throw new Error('This transaction belongs to a different account.');
  const updated = await transactionRepository.update(id, patch);
  kickReviewPass(session?.user.id ?? null);
  if (session) void syncPendingTransactions(session);
  return updated;
}

export interface ReviewItem { transaction: TransactionEntity; missing: ReviewField[] }

export async function getReviewQueue(session: Session | null): Promise<ReviewItem[]> {
  const { transactionRepository } = await initTransactionService();
  const scope = session?.user.id ?? null;
  const rows = await transactionRepository.getNeedingReview(scope);
  const out: ReviewItem[] = [];
  for (const transaction of rows) out.push({ transaction, missing: evaluateCompleteness(transaction, await reviewContext(getServiceDb(), scope, transaction.counterparty)).missing });
  return out;
}

export interface ReviewDetails extends ReviewItem { duplicateOf: TransactionEntity | null }

/** Everything the review screen shows for one transaction; null when it is gone or not this account's. */
export async function getReviewDetails(id: string, session: Session | null): Promise<ReviewDetails | null> {
  const { transactionRepository } = await initTransactionService();
  const row = await transactionRepository.getById(id);
  if (!row || row.deleted_at || !canEditTransaction(row, session)) return null;
  const [transaction] = await withDetectionSources(transactionRepository, [row]);
  const { missing } = evaluateCompleteness(row, await reviewContext(getServiceDb(), session?.user.id ?? null, row.counterparty));
  const other = row.possible_duplicate_of ? await transactionRepository.getById(row.possible_duplicate_of) : null;
  return { transaction, missing, duplicateOf: other && !other.deleted_at ? other : null };
}

export interface ReviewCompletion {
  counterparty?: string;
  category?: string;
  category_id?: string | null;
  direction?: Direction;
  bank_name?: string | null;
  account_last4?: string | null;
  duplicate?: 'keep' | 'merge';
}

/**
 * Saves the answers from the review screen onto the existing transaction and marks it verified. Reliable corrections
 * are remembered for future payments from the same merchant; a placeholder name like "UPI payment" says nothing about
 * who was paid, so it is never learned. Existing transactions other than this one are not changed.
 */
export async function completeTransactionReview(id: string, answers: ReviewCompletion, session: Session | null): Promise<void> {
  const { transactionRepository } = await initTransactionService();
  const row = await transactionRepository.getById(id);
  if (!row || row.deleted_at) throw new Error('Transaction not found.');
  if (!canEditTransaction(row, session)) throw new Error('This transaction belongs to a different account.');
  const scope = session?.user.id ?? null;
  if (answers.counterparty !== undefined && !answers.counterparty.trim()) throw new Error('Enter who it was for.');
  if (answers.account_last4 && !/^\d{3,4}$/.test(answers.account_last4)) throw new Error('Account: enter only the last 3 or 4 digits.');

  if (answers.duplicate === 'merge' && row.possible_duplicate_of) {
    await transactionRepository.mergeDuplicate(id, row.possible_duplicate_of);
  } else {
    if (answers.duplicate === 'keep') await transactionRepository.keepAsSeparate(id);
    await transactionRepository.update(id, {
      ...(answers.counterparty !== undefined ? { counterparty: answers.counterparty } : {}),
      ...(answers.category !== undefined ? { category: answers.category, category_id: answers.category_id ?? null } : {}),
      ...(answers.direction !== undefined ? { direction: answers.direction } : {}),
      ...(answers.bank_name !== undefined ? { bank_name: answers.bank_name } : {}),
      ...(answers.account_last4 !== undefined ? { account_last4: answers.account_last4 } : {}),
      verification_status: 'verified',
    });
    const renamed = answers.counterparty !== undefined && answers.counterparty.trim() !== row.counterparty;
    if (session && !isGenericMerchant(row.counterparty) && (renamed || answers.category !== undefined)) {
      await rememberAlias(getServiceDb(), session.user.id, row.counterparty, answers.counterparty?.trim() ?? row.counterparty, answers.category).catch(() => undefined);
    }
  }
  cancelReviewNotification(id);
  kickReviewPass(scope);
  if (session) void syncPendingTransactions(session);
}

/** 'keep' = two real payments; 'merge' = one payment seen twice. Either way the choice is the person's. */
export async function resolvePossibleDuplicate(id: string, choice: 'keep' | 'merge', session: Session | null): Promise<void> {
  const { transactionRepository } = await initTransactionService();
  const row = await transactionRepository.getById(id);
  if (!row || row.deleted_at) throw new Error('Transaction not found.');
  if (!canEditTransaction(row, session)) throw new Error('This transaction belongs to a different account.');
  if (choice === 'merge' && row.possible_duplicate_of) await transactionRepository.mergeDuplicate(id, row.possible_duplicate_of);
  else await transactionRepository.keepAsSeparate(id);
  cancelReviewNotification(id);
  kickReviewPass(session?.user.id ?? null);
  if (session) void syncPendingTransactions(session);
}

let postSyncHook: ((session: Session) => Promise<void>) | null = null;
/** Lets the app run extra work (receipt uploads) after each sync without the service depending on native modules. */
export function setPostSyncHook(hook: ((session: Session) => Promise<void>) | null): void {
  postSyncHook = hook;
}

const syncListeners = new Set<(summary: SyncSummary) => void>();
/** Observe the outcome of every sync attempt (used for the "synced" / "saved offline" notices). Returns an unsubscribe. */
export function onSyncResult(listener: (summary: SyncSummary) => void): () => void {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
}

// Every real cycle of the engine (app-triggered, network reconnect, follow-up, retry timer) reports here, so the UI and the
// dependent uploads (receipts, attachments) react to automatic syncs too, not only to the ones the app starts itself.
// Earlier only syncPendingTransactions() notified, so a backlog synced in the background left the screen showing it pending.
installSyncHttpTally();
syncEngine.onCycleComplete(async (summary, s) => {
  try { void recordSyncCycle(getServiceDb(), summary, (s as Session).user?.id).catch(() => undefined); } catch { /* diagnostics only: counts, never data; must never affect the listeners below */ }
  for (const l of syncListeners) { try { l(summary); } catch { /* a UI listener must never break syncing */ } }
  if (postSyncHook) await postSyncHook(s as Session).catch(() => undefined);
});

export async function syncPendingTransactions(session: Session): Promise<SyncSummary> {
  return triggerSync(session);
}

/**
 * Validated, ownership-checked edit used by the transaction bottom sheet.
 * Saves locally first (SQLite is the source of truth), queues sync, then syncs in the background if signed in.
 */
export async function updateTransactionDetails(
  id: string,
  patch: DetailsPatch,
  session: Session | null,
  splitOverride?: SplitExpenseInput,
): Promise<TransactionEntity> {
  return (await updateTransactionDetailsDetailed(id, patch, session, splitOverride)).transaction;
}

/**
 * Same edit, also reporting what happened to the transaction's split. If the transaction has an EXACT split and its amount changes,
 * this throws SplitReentryRequired BEFORE changing anything; call again with `splitOverride` (the re-entered split) to apply both.
 * Equal / percent / shares splits re-split by themselves, and a split's category and date always follow the transaction.
 */
export async function updateTransactionDetailsDetailed(
  id: string,
  patch: DetailsPatch,
  session: Session | null,
  splitOverride?: SplitExpenseInput,
): Promise<{ transaction: TransactionEntity; splitPlan: SplitEditPlan }> {
  const { transactionRepository } = await initTransactionService();
  const existing = await transactionRepository.getById(id);
  if (!existing || existing.deleted_at) throw new Error('Transaction not found.');
  if (!canEditTransaction(existing, session)) throw new Error('This transaction belongs to a different account.');
  const updates = toUpdateInput(patch);
  const splitPlan = await planSplitForTransactionEdit(getServiceDb(), existing.user_id, id, afterEdit(existing, updates), splitOverride);
  await transactionRepository.update(id, updates);
  const transaction = (await transactionRepository.getById(id))!;
  await applySplitPlan(getServiceDb(), existing.user_id, splitPlan, transaction);
  await refreshReviewState(id, session?.user.id ?? null, true);
  kickReviewPass(session?.user.id ?? null);
  if (session) void syncPendingTransactions(session);
  return { transaction, splitPlan };
}
