/**
 * Velnora Two-Way Synchronization Engine
 * Handles bidirectional offline-first sync between Expo SQLite and FastAPI / Neon PostgreSQL.
 * Features:
 * - NetInfo network status monitoring with reconnect debouncing (no rapid-fire loops)
 * - Error classification: HTTP 401 (auth abort), HTTP 422/400 (permanent validation rejection, no infinite retries), HTTP 5xx / offline (exponential backoff)
 * - Idempotent batch push with max retry cap (10 attempts -> failed state) and manual recovery methods
 * - Incremental cursor-based pull with atomic SQLite transactions, tombstone processing, and category synchronization
 * - Conflict resolution: Server version authority & server tombstone protection (winning server record merged before queue removal)
 * - Concurrency lock preventing overlapping sync jobs
 * - Zero raw SMS body transmission
 */

import { pushSync, pullSync, SyncApiError } from './syncApi.ts';
import { withWriteLock } from '../db/writeLock.ts';
import { CategoryRepository } from '../db/repositories/categoryRepository.ts';
import { MetadataRepository } from '../db/repositories/metadataRepository.ts';
import { SyncQueueRepository } from '../db/repositories/syncQueueRepository.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import type { IDatabase, RemoteTransaction, TransactionEntity } from '../db/types.ts';

export interface SyncEngineState {
  isSyncing: boolean;
  isOnline: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingCount: number;
}

export interface SyncPushResultItem {
  operation_id: string;
  entity_id: string;
  operation: 'create' | 'update' | 'delete';
  status: 'synced' | 'conflict_resolved' | 'conflict_rejected' | 'error';
  server_version: number;
  updated_at?: string;
  error?: string | null;
  winning_record?: RemoteTransaction | null;
}

export interface SyncPushServerResponse {
  results: SyncPushResultItem[];
  server_time: string;
}

export interface RemoteCategory {
  id: string;
  user_id?: string | null;
  name: string;
  direction: string;
  icon: string;
  color: string;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface RemoteBudget { id: string; category: string | null; amount_paise: number; deleted_at?: string | null; created_at: string; updated_at: string }
export interface RemoteAlias { id: string; match_key: string; original_text: string; display_name: string; category: string | null; deleted_at?: string | null; created_at: string; updated_at: string }

export interface RemoteExpected { id: string; person: string; direction: 'receive' | 'pay'; amount_paise: number; paid_paise: number; note: string | null; due_date: string | null; status: 'pending' | 'settled'; settled_at: string | null; payments: unknown; deleted_at?: string | null; created_at: string; updated_at: string }

export interface SyncPullServerResponse {
  expected_payments?: RemoteExpected[];
  budgets?: RemoteBudget[];
  merchant_aliases?: RemoteAlias[];
  transactions: RemoteTransaction[];
  categories?: RemoteCategory[];
  categories_complete?: boolean;
  server_time: string;
  next_cursor?: string | null;
  has_more: boolean;
  total_active_count: number;
}

export interface SyncSummary {
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
}

export interface SyncSession {
  access_token: string;
  user?: { id: string; email?: string };
}

type StateListener = (state: SyncEngineState) => void;

const MIN_RECONNECT_INTERVAL_MS = 5000;
const MAX_RETRY_ATTEMPTS = 10;
const PERMANENT_FAILURE_DATE = '9999-12-31T23:59:59Z';

function buildSimplePayload(entityType: string, p: Record<string, unknown>, isDelete: boolean): Record<string, unknown> {
  if (isDelete) return {};
  if (entityType === 'category') return { category: p.category, direction: p.direction, icon: p.icon, color: p.color };
  if (entityType === 'budget') return { category: p.category ?? null, amount_paise: p.amount_paise };
  if (entityType === 'expected_payment') return { person: p.person, direction: p.direction, amount_paise: p.amount_paise, paid_paise: p.paid_paise, note: p.note ?? null, due_date: p.due_date ?? null, status: p.status, settled_at: p.settled_at ?? null, payments: p.payments ?? [] };
  return { match_key: p.match_key, original_text: p.original_text, display_name: p.display_name, category: p.category ?? null };
}

export class SyncEngine {
  private isSyncing = false;
  private isOnline = true;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private lastReconnectTrigger = 0;
  private listeners: Set<StateListener> = new Set();
  private unsubscribeNetInfo: (() => void) | null = null;
  private sessionProvider: (() => Promise<SyncSession | null>) | null = null;
  private sessionRefresher: ((stale: SyncSession) => Promise<SyncSession | null>) | null = null;

  private customDb: IDatabase | null = null;
  private txRepo: TransactionRepository | null = null;
  private catRepo: CategoryRepository | null = null;
  private syncQueueRepo: SyncQueueRepository | null = null;
  private metadataRepo: MetadataRepository | null = null;

  constructor(customDb?: IDatabase) {
    if (customDb) {
      this.customDb = customDb;
      this.txRepo = new TransactionRepository(customDb);
      this.catRepo = new CategoryRepository(customDb);
      this.syncQueueRepo = new SyncQueueRepository(customDb);
      this.metadataRepo = new MetadataRepository(customDb);
    }
  }

  private async getRepos() {
    if (this.customDb) {
      return {
        db: this.customDb,
        txRepo: this.txRepo!,
        catRepo: this.catRepo!,
        syncQueueRepo: this.syncQueueRepo!,
        metadataRepo: this.metadataRepo!,
      };
    }
    const { getDatabase } = await import('../db/database.ts');
    const db = await getDatabase();
    if (!this.txRepo) this.txRepo = new TransactionRepository(db);
    if (!this.catRepo) this.catRepo = new CategoryRepository(db);
    if (!this.syncQueueRepo) this.syncQueueRepo = new SyncQueueRepository(db);
    if (!this.metadataRepo) this.metadataRepo = new MetadataRepository(db);
    return {
      db,
      txRepo: this.txRepo,
      catRepo: this.catRepo,
      syncQueueRepo: this.syncQueueRepo,
      metadataRepo: this.metadataRepo,
    };
  }

  /**
   * Set online status manually (useful for tests or custom network providers).
   * Debounces auto-sync triggers on rapid reconnects.
   */
  public setOnline(online: boolean): void {
    const wasOffline = !this.isOnline;
    this.isOnline = online;
    this.notifyListeners();

    if (wasOffline && online) {
      const now = Date.now();
      if (now - this.lastReconnectTrigger >= MIN_RECONNECT_INTERVAL_MS) {
        this.lastReconnectTrigger = now;
        void this.triggerSync();
      }
    }
  }

  /**
   * Initialize network listener and start background engine.
   */
  public async start(sessionProvider: () => Promise<SyncSession | null>): Promise<void> {
    this.sessionProvider = sessionProvider;

    try {
      const NetInfoModule = await import('@react-native-community/netinfo');
      const NetInfo = NetInfoModule.default || NetInfoModule;

      if (NetInfo && typeof NetInfo.addEventListener === 'function') {
        this.unsubscribeNetInfo = NetInfo.addEventListener((state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => {
          const online = Boolean(state.isConnected && state.isInternetReachable !== false);
          this.setOnline(online);
        });

        const initial = await NetInfo.fetch();
        this.setOnline(Boolean(initial.isConnected && initial.isInternetReachable !== false));
      }
    } catch {
      this.isOnline = true;
      this.notifyListeners();
    }
  }

  /** Registers the callback used to obtain a fresh session after an HTTP 401 (see sessionRefresh.ts). */
  public setSessionRefresher(fn: ((stale: SyncSession) => Promise<SyncSession | null>) | null): void {
    this.sessionRefresher = fn;
  }

  public stop(): void {
    if (this.unsubscribeNetInfo) {
      this.unsubscribeNetInfo();
      this.unsubscribeNetInfo = null;
    }
    this.sessionProvider = null;
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  public getState(): SyncEngineState {
    return {
      isSyncing: this.isSyncing,
      isOnline: this.isOnline,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      pendingCount: 0,
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (e) {
        console.warn('SyncEngine listener error:', e);
      }
    });
  }

  /**
   * Main synchronization trigger: executes Push followed by Pull.
   * Guarded by concurrency lock.
   */
  public async triggerSync(explicitSession?: SyncSession | null, apiBaseUrl?: string): Promise<SyncSummary> {
    if (this.isSyncing) {
      return { pushed: 0, pulled: 0, conflicts: 0, errors: ['Sync already in progress'] };
    }

    let session = explicitSession || (this.sessionProvider ? await this.sessionProvider() : null);
    if (!session) {
      return { pushed: 0, pulled: 0, conflicts: 0, errors: ['No active session'] };
    }

    this.isSyncing = true;
    this.lastError = null;
    this.notifyListeners();

    const summary: SyncSummary = {
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      errors: [],
    };

    try {
      const runCycle = async (s: SyncSession) => {
        // 1. Push local changes
        const pushResult = await this.pushPendingChanges(s, apiBaseUrl);
        summary.pushed += pushResult.pushed;
        summary.conflicts += pushResult.conflicts;
        summary.errors.push(...pushResult.errors);

        // 2. Pull remote changes (transactions + categories)
        const pullResult = await this.pullRemoteChanges(s, apiBaseUrl);
        summary.pulled += pullResult.pulled;
        summary.conflicts += pullResult.conflicts;
        summary.errors.push(...pullResult.errors);
      };

      try {
        await runCycle(session);
      } catch (err) {
        // Expired access token: refresh once and retry the whole cycle once. The queue was not modified by the 401,
        // so nothing is lost; a failed refresh or a second 401 ends the cycle (no retry loop).
        if (!(err instanceof SyncApiError && err.status === 401 && this.sessionRefresher)) throw err;
        const refreshed = await this.sessionRefresher(session);
        if (!refreshed || refreshed.user?.id !== session.user?.id) throw err;
        session = refreshed;
        this.lastError = null;
        await runCycle(session);
      }

      this.lastSyncAt = new Date().toISOString();
      const { metadataRepo } = await this.getRepos();
      if (session.user?.id) {
        await metadataRepo.set(`last_sync_at_${session.user.id}`, this.lastSyncAt);
      }
      await metadataRepo.set('last_sync_at', this.lastSyncAt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      summary.errors.push(msg);
    } finally {
      this.isSyncing = false;
      this.notifyListeners();
    }

    return summary;
  }

  /**
   * Push pending transactions from sync_queue to cloud.
   * Differentiates HTTP 401, 422/400 (permanent rejection), and 5xx/network (exponential backoff).
   */
  public async pushPendingChanges(
    session: SyncSession,
    apiBaseUrl?: string,
  ): Promise<{ pushed: number; conflicts: number; errors: string[] }> {
    const { db, syncQueueRepo, txRepo } = await this.getRepos();
    const pendingItems = await syncQueueRepo.peekEligible(50, session.user?.id);

    if (pendingItems.length === 0) {
      return { pushed: 0, conflicts: 0, errors: [] };
    }

    const pushItems = [];
    for (const item of pendingItems) {
      try {
        const payloadObj = JSON.parse(item.payload) as TransactionEntity | { id: string; deleted_at: string; user_id?: string | null };
        const isDelete = item.operation === 'delete';

        // Strict ownership verification immediately before assembling push payload:
        // 1. For transaction queue entries, establish ownership using the associated SQLite transaction's user_id.
        // 2. If payload.user_id exists, require it to match the associated transaction's user_id.
        // 3. Require the verified transaction owner to match the authenticated session user ID.
        // 4. If the transaction is missing, its owner is missing, or the payload and transaction owners disagree, skip synchronization.
        // 5. Preserve these entries without deleting, dequeuing, or marking them failed.
        if (item.entity_type === 'transaction') {
          const localTx = await txRepo.getById(item.entity_id);
          if (!localTx || !localTx.user_id) {
            // Missing transaction or missing transaction owner: skip synchronization
            continue;
          }

          const verifiedTxOwnerId = localTx.user_id;

          // If payload.user_id exists, require it to match the associated transaction's user_id
          if ('user_id' in payloadObj && payloadObj.user_id && payloadObj.user_id !== verifiedTxOwnerId) {
            // Mismatched payload and transaction ownership: skip synchronization
            continue;
          }

          // Require verified transaction owner to match authenticated session user ID
          if (!session.user?.id || verifiedTxOwnerId !== session.user.id) {
            // Mismatched session user: skip synchronization
            continue;
          }
        } else {
          const payloadOwner = 'user_id' in payloadObj ? payloadObj.user_id : null;
          if (!session.user?.id || payloadOwner !== session.user.id) {
            continue;
          }
        }

        if (item.entity_type !== 'transaction') {
          // Categories, budgets and merchant aliases: ownership already verified above (payload.user_id === session user).
          pushItems.push({
            operation_id: item.id,
            entity_type: item.entity_type,
            entity_id: item.entity_id,
            operation: item.operation,
            client_version: 1,
            payload: buildSimplePayload(item.entity_type, payloadObj as unknown as Record<string, unknown>, isDelete),
          });
          continue;
        }

        pushItems.push({
          operation_id: item.id,
          entity_type: item.entity_type,
          entity_id: item.entity_id,
          operation: item.operation,
          client_version: 'server_version' in payloadObj ? payloadObj.server_version || 1 : 1,
          payload: isDelete
            ? {
                deleted_at: (payloadObj as { deleted_at: string }).deleted_at || new Date().toISOString(),
              }
            : {
                amount: (payloadObj as TransactionEntity).amount,
                direction: (payloadObj as TransactionEntity).direction,
                counterparty: (payloadObj as TransactionEntity).counterparty,
                category: (payloadObj as TransactionEntity).category,
                category_id: (payloadObj as TransactionEntity).category_id,
                merchant_phone: (payloadObj as TransactionEntity).merchant_phone ?? null,
                payment_method: (payloadObj as TransactionEntity).payment_method ?? null,
                receipt_remote_id: (payloadObj as TransactionEntity).receipt_remote_id ?? null,
                location_lat: (payloadObj as TransactionEntity).location_lat ?? null,
                location_lng: (payloadObj as TransactionEntity).location_lng ?? null,
                location_name: (payloadObj as TransactionEntity).location_name ?? null,
                location_address: (payloadObj as TransactionEntity).location_address ?? null,
                location_confirmed: Boolean((payloadObj as TransactionEntity).location_confirmed),
                description: (payloadObj as TransactionEntity).description,
                transaction_date: (payloadObj as TransactionEntity).transaction_date,
                source: (payloadObj as TransactionEntity).source,
                reference_id: (payloadObj as TransactionEntity).reference_id,
                fingerprint: (payloadObj as TransactionEntity).fingerprint,
                txn_kind: (payloadObj as TransactionEntity).txn_kind ?? 'payment',
                verification_status: (payloadObj as TransactionEntity).verification_status ?? 'verified',
                capture_source: (payloadObj as TransactionEntity).capture_source ?? null,
                account_last4: (payloadObj as TransactionEntity).account_last4 ?? null,
                bank_name: (payloadObj as TransactionEntity).bank_name ?? null,
                payment_app: (payloadObj as TransactionEntity).payment_app ?? null,
                possible_duplicate_of: (payloadObj as TransactionEntity).possible_duplicate_of ?? null,
                confidence: (payloadObj as TransactionEntity).confidence ?? null,
                updated_at: (payloadObj as TransactionEntity).updated_at,
              },
        });
      } catch {
        await syncQueueRepo.markFailed(item.id, 'MALFORMED_PAYLOAD', PERMANENT_FAILURE_DATE);
        await txRepo.updateSyncStatus(item.entity_id, 'failed');
      }
    }

    if (pushItems.length === 0) {
      return { pushed: 0, conflicts: 0, errors: [] };
    }

    let serverResp: SyncPushServerResponse;
    try {
      serverResp = await pushSync<SyncPushServerResponse>(
        session.access_token,
        { items: pushItems },
        apiBaseUrl,
      );
    } catch (err) {
      if (err instanceof SyncApiError) {
        // 401 Unauthorized: Do not retry immediately; abort sync cycle
        if (err.status === 401) {
          this.lastError = 'UNAUTHORIZED';
          throw err;
        }

        // 422 / 400 Permanent Validation Rejection: Do NOT retry indefinitely
        if (err.status === 422 || err.status === 400) {
          for (const item of pendingItems) {
            await syncQueueRepo.markFailed(item.id, `PERMANENT_ERROR_${err.status}`, PERMANENT_FAILURE_DATE);
            await txRepo.updateSyncStatus(item.entity_id, 'failed');
          }
          this.lastError = `VALIDATION_FAILED_${err.status}`;
          throw err;
        }
      }

      // Temporary server failure (5xx) or network interruption: apply exponential backoff
      for (const item of pendingItems) {
        const nextRetryCount = item.retry_count + 1;
        if (nextRetryCount >= MAX_RETRY_ATTEMPTS) {
          // Reached retry limit -> dead-letter / mark failed
          await syncQueueRepo.markFailed(item.id, 'MAX_RETRIES_EXCEEDED', PERMANENT_FAILURE_DATE);
          await txRepo.updateSyncStatus(item.entity_id, 'failed');
        } else {
          const backoffMs = Math.min(300000, Math.pow(2, item.retry_count) * 1000 + Math.random() * 500);
          const nextRetry = new Date(Date.now() + backoffMs).toISOString();
          await syncQueueRepo.markFailed(
            item.id,
            err instanceof Error ? err.message : 'TEMPORARY_SERVER_ERROR',
            nextRetry,
          );
        }
      }
      throw err;
    }

    let pushed = 0;
    let conflicts = 0;
    const errors: string[] = [];

    // Process server acknowledgements
    for (const ack of serverResp.results) {
      if (ack.status === 'synced' || ack.status === 'conflict_resolved') {
        if (ack.status === 'conflict_resolved') {
          conflicts++;
          // When server version wins or record was deleted on server,
          // update local transaction with winning server record BEFORE removing from queue!
          if (ack.winning_record) {
            await txRepo.mergeRemoteTransaction(ack.winning_record, { forceServerWin: true });
          }
        }
        pushed++;
        // Queue items are removed ONLY upon confirmed server acknowledgement
        await txRepo.updateSyncStatus(ack.entity_id, 'synced', ack.server_version);
        const ackedItem = pendingItems.find((p) => p.id === ack.operation_id);
        if (ackedItem?.entity_type === 'budget') {
          await db.runAsync("UPDATE budgets SET sync_status = 'synced' WHERE id = ?", ack.entity_id);
        } else if (ackedItem?.entity_type === 'merchant_alias') {
          await db.runAsync("UPDATE merchant_aliases SET sync_status = 'synced' WHERE id = ?", ack.entity_id);
        } else if (ackedItem?.entity_type === 'expected_payment') {
          await db.runAsync("UPDATE expected_payments SET sync_status = 'synced' WHERE id = ?", ack.entity_id);
        }
        await syncQueueRepo.dequeue(ack.operation_id);
      } else {
        const errorMsg = ack.error || 'Server rejected item';
        errors.push(`${ack.entity_id}: ${errorMsg}`);
        const item = pendingItems.find((p) => p.id === ack.operation_id);
        const retryCount = item ? item.retry_count + 1 : 1;

        if (errorMsg.includes('Missing required') || errorMsg.includes('Forbidden') || retryCount >= MAX_RETRY_ATTEMPTS) {
          // Permanent failure
          await syncQueueRepo.markFailed(ack.operation_id, errorMsg, PERMANENT_FAILURE_DATE);
          await txRepo.updateSyncStatus(ack.entity_id, 'failed');
        } else {
          const backoffMs = Math.min(300000, Math.pow(2, retryCount) * 1000 + Math.random() * 500);
          const nextRetry = new Date(Date.now() + backoffMs).toISOString();
          await syncQueueRepo.markFailed(ack.operation_id, errorMsg, nextRetry);
        }
      }
    }

    return { pushed, conflicts, errors };
  }

  /**
   * Pull remote changes from cloud and merge into SQLite.
   * Hydrates both transactions and custom categories for complete multi-device recovery.
   * All updates in a batch page execute inside an atomic SQLite transaction.
   * Updates cursor ONLY after local records are successfully committed.
   */
  public async pullRemoteChanges(
    session: SyncSession,
    apiBaseUrl?: string,
  ): Promise<{ pulled: number; conflicts: number; errors: string[] }> {
    const { db, metadataRepo, txRepo, catRepo, syncQueueRepo } = await this.getRepos();
    const userCursorKey = session.user?.id ? `last_sync_cursor_${session.user.id}` : 'last_sync_cursor';
    let cursor = await metadataRepo.get(userCursorKey);
    if (!cursor && !session.user?.id) {
      cursor = await metadataRepo.get('last_sync_cursor');
    }

    // 10-second safety lookback window on starting cursor to capture any out-of-order concurrent commits
    let queryCursor = cursor;
    if (cursor && cursor !== '0' && cursor.includes('|')) {
      const [tsPart] = cursor.split('|');
      const lookbackTime = new Date(new Date(tsPart).getTime() - 10000).toISOString();
      queryCursor = lookbackTime;
    }

    let pulled = 0;
    let conflicts = 0;
    const errors: string[] = [];
    let hasMore = true;
    let isFirstPage = true;

    // Loop through paginated pull pages
    while (hasMore) {
      const activeCursor = isFirstPage ? queryCursor : cursor;
      isFirstPage = false;

      const pullResp: SyncPullServerResponse = await pullSync<SyncPullServerResponse>(
        session.access_token,
        activeCursor,
        100,
        apiBaseUrl,
      );

      // Wrap page processing in an atomic SQLite transaction, serialized with other multi-statement writers
      // (manual add / SMS drain / deletion) so none can start or be swept into this transaction.
      await withWriteLock(async () => {
      await db.execAsync('BEGIN TRANSACTION');
      try {
        // 1. Reconcile categories: ONLY prune if server explicitly indicates categories_complete === true
        // and response contains valid categories including system categories
        if (
          pullResp.categories_complete === true &&
          Array.isArray(pullResp.categories) &&
          pullResp.categories.length > 0 &&
          pullResp.categories.some((c) => c.is_system)
        ) {
          const serverCatIds = new Set(pullResp.categories.map((c) => c.id));

          for (const cat of pullResp.categories) {
            await catRepo.upsert({
              id: cat.id,
              user_id: cat.user_id,
              name: cat.name,
              transaction_type: cat.direction === 'income' ? 'income' : 'expense',
              icon: cat.icon,
              color: cat.color,
            });
          }

          // Prune deleted user custom categories (excluding system categories & local pending creates)
          const localCats = await catRepo.getAll();
          const pendingQueue = await syncQueueRepo.peek(100);
          const pendingCatIds = new Set(
            pendingQueue.filter((q) => q.entity_type === 'category').map((q) => q.entity_id)
          );

          for (const localCat of localCats) {
            if (localCat.user_id && localCat.user_id === session.user?.id && !serverCatIds.has(localCat.id) && !pendingCatIds.has(localCat.id)) {
              await catRepo.delete(localCat.id);
            }
          }
        } else if (Array.isArray(pullResp.categories) && pullResp.categories.length > 0) {
          // Partial or uncertified category response: upsert received categories but STRICTLY SKIP pruning
          for (const cat of pullResp.categories) {
            await catRepo.upsert({
              id: cat.id,
              user_id: cat.user_id,
              name: cat.name,
              transaction_type: cat.direction === 'income' ? 'income' : 'expense',
              icon: cat.icon,
              color: cat.color,
            });
          }
        }

        // 1b. Merge budgets and merchant aliases (this user's rows only; local unsynced edits win until pushed)
        const ownerId = session.user?.id;
        if (ownerId) {
          for (const rb of pullResp.budgets ?? []) {
            const local = await db.getFirstAsync<{ sync_status: string }>('SELECT sync_status FROM budgets WHERE id = ?', rb.id);
            if (!local) {
              if (!rb.deleted_at) {
                await db.runAsync(
                  `INSERT INTO budgets (id, user_id, category, amount_paise, sync_status, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'synced', NULL, ?, ?)`,
                  rb.id, ownerId, rb.category, rb.amount_paise, rb.created_at, rb.updated_at);
              }
            } else if (local.sync_status === 'synced') {
              await db.runAsync(
                `UPDATE budgets SET category = ?, amount_paise = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
                rb.category, rb.amount_paise, rb.deleted_at ?? null, rb.updated_at, rb.id, ownerId);
            }
          }
          for (const re of pullResp.expected_payments ?? []) {
            const local = await db.getFirstAsync<{ sync_status: string }>('SELECT sync_status FROM expected_payments WHERE id = ? AND user_id = ?', re.id, ownerId);
            const payments = JSON.stringify(Array.isArray(re.payments) ? re.payments : []);
            const key = re.person.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s&'./-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[\s.\-/']+|[\s.\-/']+$/g, '').trim();
            if (!local) {
              if (!re.deleted_at) {
                await db.runAsync(
                  `INSERT INTO expected_payments (id, user_id, person, person_key, direction, amount_paise, paid_paise, note, due_date, status, settled_at, payments_json, sync_status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
                  re.id, ownerId, re.person, key, re.direction, re.amount_paise, re.paid_paise, re.note, re.due_date, re.status, re.settled_at, payments, re.created_at, re.updated_at);
              }
            } else if (local.sync_status === 'synced') {
              await db.runAsync(
                `UPDATE expected_payments SET person = ?, person_key = ?, direction = ?, amount_paise = ?, paid_paise = ?, note = ?, due_date = ?, status = ?, settled_at = ?, payments_json = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
                re.person, key, re.direction, re.amount_paise, re.paid_paise, re.note, re.due_date, re.status, re.settled_at, payments, re.deleted_at ?? null, re.updated_at, re.id, ownerId);
            }
          }
          for (const ra of pullResp.merchant_aliases ?? []) {
            const local = await db.getFirstAsync<{ sync_status: string }>('SELECT sync_status FROM merchant_aliases WHERE id = ? AND user_id = ?', ra.id, ownerId);
            if (!local) {
              const keyClash = await db.getFirstAsync<{ id: string }>(
                'SELECT id FROM merchant_aliases WHERE user_id = ? AND match_key = ? AND deleted_at IS NULL', ownerId, ra.match_key);
              if (!ra.deleted_at && !keyClash) {
                await db.runAsync(
                  `INSERT INTO merchant_aliases (id, user_id, match_key, original_text, display_name, category, sync_status, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'synced', NULL, ?, ?)`,
                  ra.id, ownerId, ra.match_key, ra.original_text, ra.display_name, ra.category, ra.created_at, ra.updated_at);
              }
            } else if (local.sync_status === 'synced') {
              await db.runAsync(
                `UPDATE merchant_aliases SET display_name = ?, category = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
                ra.display_name, ra.category, ra.deleted_at ?? null, ra.updated_at, ra.id, ownerId);
            }
          }
        }

        // 2. Merge transactions
        for (const remoteTx of pullResp.transactions) {
          const mergeResult = await txRepo.mergeRemoteTransaction(remoteTx);
          if (mergeResult === 'inserted' || mergeResult === 'updated') {
            pulled++;
          } else if (mergeResult === 'conflict_preserved') {
            conflicts++;
          }
        }

        // 3. Cursor advancement occurs ONLY after all records in the batch are committed locally
        if (pullResp.next_cursor) {
          cursor = pullResp.next_cursor;
          await metadataRepo.set(userCursorKey, cursor);
          await metadataRepo.set('last_sync_cursor', cursor);
        }

        await db.execAsync('COMMIT');
      } catch (pageErr) {
        await db.execAsync('ROLLBACK');
        throw pageErr;
      }
      });

      hasMore = pullResp.has_more;
      if (!hasMore || pullResp.transactions.length === 0) {
        break;
      }
    }

    return { pulled, conflicts, errors };
  }

  /**
   * Manually retry a failed transaction or queue operation.
   * Resets retry count, clears dead-letter next_retry_at, and sets transaction to pending.
   */
  public async retryFailedOperation(entityId: string): Promise<boolean> {
    const { syncQueueRepo, txRepo } = await this.getRepos();
    const queue = await syncQueueRepo.peek(100);
    const item = queue.find((q) => q.entity_id === entityId);
    if (!item) return false;

    // Reset backoff delay and error in queue
    await syncQueueRepo.resetRetry(item.id);
    await txRepo.updateSyncStatus(entityId, item.operation === 'create' ? 'pending_create' : 'pending_update');
    return true;
  }

  /**
   * Manually retry all failed operations.
   */
  public async retryAllFailed(): Promise<number> {
    const { syncQueueRepo, txRepo } = await this.getRepos();
    const queue = await syncQueueRepo.peek(100);
    const failedItems = queue.filter(
      (q) => q.next_retry_at === PERMANENT_FAILURE_DATE || q.retry_count >= MAX_RETRY_ATTEMPTS,
    );

    for (const item of failedItems) {
      await syncQueueRepo.resetRetry(item.id);
      await txRepo.updateSyncStatus(item.entity_id, item.operation === 'create' ? 'pending_create' : 'pending_update');
    }

    return failedItems.length;
  }
}

export const syncEngine = new SyncEngine();

export function startSyncEngine(sessionProvider: () => Promise<SyncSession | null>): Promise<void> {
  return syncEngine.start(sessionProvider);
}

export function setSyncSessionRefresher(fn: ((stale: SyncSession) => Promise<SyncSession | null>) | null): void {
  syncEngine.setSessionRefresher(fn);
}

export function stopSyncEngine(): void {
  syncEngine.stop();
}

export function triggerSync(session?: SyncSession | null, apiBaseUrl?: string): Promise<SyncSummary> {
  return syncEngine.triggerSync(session, apiBaseUrl);
}

export function retryFailedOperation(entityId: string): Promise<boolean> {
  return syncEngine.retryFailedOperation(entityId);
}

export function retryAllFailed(): Promise<number> {
  return syncEngine.retryAllFailed();
}

export function getSyncState(): SyncEngineState {
  return syncEngine.getState();
}

export function subscribeSyncState(listener: (state: SyncEngineState) => void): () => void {
  return syncEngine.subscribe(listener);
}
