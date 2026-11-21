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
import type { IDatabase, RemoteTransaction, SyncQueueEntity, TransactionEntity } from '../db/types.ts';

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
  /** Stable reason for status 'error' (newer servers). See isPermanentItemError. */
  error_code?: string | null;
  winning_record?: RemoteTransaction | null;
}

/** Server rejected the change itself: resending it unchanged cannot succeed. */
const PERMANENT_ITEM_ERROR_CODES = new Set(['validation_error', 'forbidden', 'missing_fields', 'not_found', 'rejected']);
/** The same rejections as worded by servers that send no error_code. */
const LEGACY_PERMANENT_ITEM_ERROR = /^(Missing required|Forbidden|Unsupported entity type|System categories|Transaction not found|Category not found|Invalid value)/;

/**
 * Permanent = the server rejected this exact change. Anything else (internal_error, or an unclassified message from an older
 * server such as a database error) means the server failed to apply it, so it is retried with capped backoff, never parked.
 */
export function isPermanentItemError(ack: Pick<SyncPushResultItem, 'error' | 'error_code'>): boolean {
  if (ack.error_code) return PERMANENT_ITEM_ERROR_CODES.has(ack.error_code);
  return LEGACY_PERMANENT_ITEM_ERROR.test(ack.error ?? '');
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

const MAX_AUTO_RETRIES = 6;
/** One cycle pushes the queue in batches until it is empty (bounded so a pathological queue cannot spin forever). */
const PUSH_BATCH_SIZE = 50;
const MAX_PUSH_BATCHES_PER_CYCLE = 40;
/** Network / 5xx backoff cap. Such failures are never permanent: the item keeps its place and retries. */
const MAX_TRANSIENT_BACKOFF_MS = 15 * 60_000;
type CycleListener = (summary: SyncSummary, session: SyncSession) => void | Promise<void>;

export class SyncEngine {
  private isSyncing = false;
  private isOnline = true;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private lastReconnectTrigger = 0;
  /** A sync was requested while one was running: one follow-up cycle runs afterwards, so a just-saved change is never left waiting. */
  private rerunRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private listeners: Set<StateListener> = new Set();
  private cycleListeners: Set<CycleListener> = new Set();
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
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  /**
   * Called after every real sync cycle (app-triggered, reconnect, follow-up or retry timer) with the session it used
   * (possibly refreshed). Lets the UI refresh and lets dependent uploads (receipts, attachments) run after any sync.
   */
  public onCycleComplete(listener: CycleListener): () => void {
    this.cycleListeners.add(listener);
    return () => { this.cycleListeners.delete(listener); };
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
      this.rerunRequested = true;
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
        // 1. Push local changes: batch after batch until nothing eligible is left (a 183-item backlog needs 4 batches).
        for (let batch = 0; batch < MAX_PUSH_BATCHES_PER_CYCLE; batch++) {
          const pushResult = await this.pushPendingChanges(s, apiBaseUrl);
          summary.pushed += pushResult.pushed;
          summary.conflicts += pushResult.conflicts;
          summary.errors.push(...pushResult.errors);
          if (!pushResult.more) break;
        }

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
    this.scheduleFollowUp(summary);
    for (const listener of [...this.cycleListeners]) {
      try { await listener(summary, session); } catch { /* a listener must never break syncing */ }
    }
    return summary;
  }

  /**
   * After a cycle: run one more if a request arrived meanwhile; after a TRANSIENT failure (network, server down, timeout) retry later
   * with exponential backoff, capped and bounded. A rejected session (401) or a permanently rejected item never retries by itself:
   * the person signing in again, the app returning to the foreground or the network coming back starts the next cycle.
   */
  private scheduleFollowUp(summary: SyncSummary): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const transient = !!this.lastError && !/^(UNAUTHORIZED|VALIDATION_FAILED_|No active session)/.test(this.lastError) && !/status 401/i.test(this.lastError);
    if (!this.lastError && summary.errors.length === 0) this.consecutiveFailures = 0;
    let delay: number | null = null;
    if (this.rerunRequested) { this.rerunRequested = false; delay = 250; }
    else if (transient && this.consecutiveFailures < MAX_AUTO_RETRIES) { delay = Math.min(300_000, 30_000 * 2 ** this.consecutiveFailures); this.consecutiveFailures += 1; }
    if (delay === null || !this.sessionProvider) return; // without a session provider (tests, signed out) nothing can run by itself
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.triggerSync(); }, delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Gives one more chance to items parked as permanently failed only because of a whole-batch rejection or an exhausted
   * retry budget (older builds failed every item in a batch when one was bad). It runs ONCE per account on this device
   * (tracked in app metadata): an item that is genuinely invalid is then isolated and failed individually, and is never
   * requeued again, so this cannot loop.
   */
  private async requeueStrandedFailures(userId?: string | null): Promise<void> {
    const { syncQueueRepo, txRepo, metadataRepo } = await this.getRepos();
    // v2: builds before this one also parked items PERMANENTLY after 10 network/5xx failures (an offline stretch or a
    // sleeping server was enough), and the v1 pass had already been used. Those were never rejected by the server, so they
    // are given back to the queue once more. Server creates are idempotent (same id / fingerprint / reference -> same row),
    // so items that did reach the server before the ack was lost are acknowledged, not duplicated.
    const markerKey = `sync_requeue_stranded_v2_${userId ?? 'none'}`;
    if (await metadataRepo.get(markerKey)) return;
    const parked = await syncQueueRepo.peek(5000, userId);
    for (const item of parked) {
      if (item.next_retry_at !== PERMANENT_FAILURE_DATE) continue;
      const code = item.error_code ?? '';
      // Never retried: payloads that cannot be parsed, and explicit ownership / completeness rejections.
      if (code === 'MALFORMED_PAYLOAD' || code.includes('Forbidden') || code.includes('Missing required')) continue;
      await syncQueueRepo.resetRetry(item.id);
      if (item.entity_type === 'transaction') {
        await txRepo.updateSyncStatus(item.entity_id, item.operation === 'create' ? 'pending_create' : item.operation === 'delete' ? 'pending_delete' : 'pending_update');
      }
    }
    await metadataRepo.set(markerKey, new Date().toISOString());
  }

  /**
   * A transaction of this account that is not synced but has NO queue entry can never be pushed (the engine only sends
   * queue items), so it would stay "waiting to sync" forever. Re-queue it. The server treats a repeated create as
   * already-synced and an update of an unknown id as an upsert, so this is safe whether or not the server has it.
   * A row created and deleted before it ever synced is left alone (it must never reach the server).
   */
  private async requeueOrphans(userId: string): Promise<void> {
    const { db, syncQueueRepo } = await this.getRepos();
    const orphans = await db.getAllAsync<TransactionEntity>(
      `SELECT * FROM transactions t
       WHERE t.user_id = ? AND t.sync_status IN ('pending_create', 'pending_update', 'pending_delete', 'failed')
         AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.entity_type = 'transaction' AND q.entity_id = t.id)
       LIMIT 5000`,
      userId,
    );
    for (const tx of orphans) {
      if (tx.deleted_at) {
        if (tx.sync_status === 'pending_create') continue;
        await syncQueueRepo.enqueue({
          entity_type: 'transaction', entity_id: tx.id, operation: 'delete',
          payload: JSON.stringify({ id: tx.id, deleted_at: tx.deleted_at, user_id: tx.user_id, reference_id: tx.reference_id ?? null, fingerprint: tx.fingerprint ?? null }),
        });
        continue;
      }
      await syncQueueRepo.enqueue({
        entity_type: 'transaction', entity_id: tx.id, operation: tx.sync_status === 'pending_create' ? 'create' : 'update',
        payload: JSON.stringify(tx),
      });
    }
  }

  /**
   * Push pending transactions from sync_queue to cloud.
   * Differentiates HTTP 401, 422/400 (permanent rejection), and 5xx/network (exponential backoff).
   */
  public async pushPendingChanges(
    session: SyncSession,
    apiBaseUrl?: string,
  ): Promise<{ pushed: number; conflicts: number; errors: string[]; more: boolean }> {
    const { syncQueueRepo, txRepo } = await this.getRepos();
    await this.requeueStrandedFailures(session.user?.id);
    if (session.user?.id) await this.requeueOrphans(session.user.id);
    const pendingItems = await syncQueueRepo.peekEligible(PUSH_BATCH_SIZE, session.user?.id);

    if (pendingItems.length === 0) {
      return { pushed: 0, conflicts: 0, errors: [], more: false };
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
                // identity keys let the server find the payment even when it was acknowledged under another row's id
                reference_id: (payloadObj as { reference_id?: string | null }).reference_id ?? null,
                fingerprint: (payloadObj as { fingerprint?: string | null }).fingerprint ?? null,
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
      return { pushed: 0, conflicts: 0, errors: [], more: false };
    }

    const result = await this.sendAndAcknowledge(session, pendingItems, pushItems, apiBaseUrl);
    // A full batch that made progress means more may be waiting. Rejected items got a future retry time, so the next batch
    // of the same cycle never re-sends them.
    return { ...result, more: pendingItems.length === PUSH_BATCH_SIZE && (result.pushed > 0 || result.errors.length > 0) };
  }

  /**
   * Sends one batch and applies the server's per-item acknowledgements. Local state is keyed by the QUEUE item the ack's
   * operation_id refers to, never by ack.entity_id: for a fingerprint/reference duplicate the server answers with the id
   * of the row it already holds, which is not the local row's id.
   */
  private async sendAndAcknowledge(
    session: SyncSession,
    pendingItems: SyncQueueEntity[],
    pushItems: Array<{ operation_id: string }>,
    apiBaseUrl?: string,
  ): Promise<{ pushed: number; conflicts: number; errors: string[] }> {
    const { db, syncQueueRepo, txRepo } = await this.getRepos();
    const sentIds = new Set(pushItems.map((p) => p.operation_id));
    const sent = pendingItems.filter((p) => sentIds.has(p.id));
    let serverResp: SyncPushServerResponse;
    try {
      serverResp = await pushSync<SyncPushServerResponse>(
        session.access_token,
        { items: pushItems },
        apiBaseUrl,
      );
    } catch (err) {
      // TEMP-SYNC-DEBUG (remove after diagnosis): one line per failed attempt. No payload values.
      console.log(`[sync-debug] push FAILED batch=${pushItems.length} http=${err instanceof SyncApiError ? (err.status ?? err.kind) : 'unknown'} body=${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}`);
      if (err instanceof SyncApiError) {
        // 401 Unauthorized: Do not retry immediately; abort sync cycle
        if (err.status === 401) {
          this.lastError = 'UNAUTHORIZED';
          throw err;
        }

        // 422 / 400 Permanent Validation Rejection: Do NOT retry indefinitely
        if (err.status === 422 || err.status === 400) {
          if (pushItems.length > 1) {
            // One malformed item must not condemn the others: resend each alone so only the rejected one fails.
            const total = { pushed: 0, conflicts: 0, errors: [] as string[] };
            for (const single of pushItems) {
              const one = sent.filter((p) => p.id === single.operation_id);
              try {
                const r = await this.sendAndAcknowledge(session, one, [single], apiBaseUrl);
                total.pushed += r.pushed;
                total.conflicts += r.conflicts;
                total.errors.push(...r.errors);
              } catch (inner) {
                if (inner instanceof SyncApiError && (inner.status === 422 || inner.status === 400)) {
                  total.errors.push(`${one[0]?.entity_id}: rejected by server (${inner.status})`);
                  continue;
                }
                throw inner; // 401 / transient: already handled and recorded for the remaining items
              }
            }
            return total;
          }
          for (const item of sent) {
            await syncQueueRepo.markFailed(item.id, `PERMANENT_ERROR_${err.status}`, PERMANENT_FAILURE_DATE);
            await txRepo.updateSyncStatus(item.entity_id, 'failed');
          }
          this.lastError = `VALIDATION_FAILED_${err.status}`;
          throw err;
        }
      }

      // Temporary server failure (5xx), 429, timeout or network interruption: exponential backoff, capped. Never
      // permanent: the server did not reject these items, it simply was not reachable (offline, asleep, overloaded).
      // Earlier builds dead-lettered them after 10 attempts, which stranded whole backlogs as "waiting to sync".
      for (const item of sent) {
        const backoffMs = Math.min(MAX_TRANSIENT_BACKOFF_MS, Math.pow(2, Math.min(item.retry_count, 20)) * 1000 + Math.random() * 500);
        const nextRetry = new Date(Date.now() + backoffMs).toISOString();
        await syncQueueRepo.markFailed(
          item.id,
          err instanceof Error ? err.message : 'TEMPORARY_SERVER_ERROR',
          nextRetry,
        );
      }
      throw err;
    }

    let pushed = 0;
    let conflicts = 0;
    const errors: string[] = [];

    // TEMP-SYNC-DEBUG (remove after diagnosis): one line per successful HTTP exchange. No payload values.
    if (serverResp && Array.isArray(serverResp.results)) {
      const byStatus: Record<string, number> = {};
      const byCode: Record<string, number> = {};
      for (const r of serverResp.results) { byStatus[r.status] = (byStatus[r.status] ?? 0) + 1; if (r.status === 'error') { const k = r.error_code ?? (r.error ?? 'none').slice(0, 80); byCode[k] = (byCode[k] ?? 0) + 1; } }
      console.log(`[sync-debug] push OK http=200 batch=${pushItems.length} results=${serverResp.results.length} status=${JSON.stringify(byStatus)} errors=${JSON.stringify(byCode)}`);
    }

    // A response that is not the documented shape acknowledges nothing: keep everything pending and back off.
    if (!serverResp || !Array.isArray(serverResp.results)) {
      for (const item of sent) {
        await syncQueueRepo.markFailed(item.id, 'INVALID_RESPONSE', new Date(Date.now() + 30000).toISOString());
      }
      throw new SyncApiError('Synchronization server returned an invalid response.', 'server');
    }

    // Process server acknowledgements
    const acknowledged = new Set<string>();
    for (const ack of serverResp.results) {
      const ackedFor = sent.find((p) => p.id === ack.operation_id);
      if (!ackedFor) continue; // not an operation we sent: never trust it to change local state
      acknowledged.add(ack.operation_id);
      let localId = ackedFor.entity_id;
      if (ack.status === 'synced' || ack.status === 'conflict_resolved') {
        pushed++;
        // The server matched this create/update to an existing row of the same payment and answered with THAT row's id.
        // Adopt it, so later edits, deletes, attachments and other devices all address one record.
        if (ackedFor.entity_type === 'transaction' && ackedFor.operation !== 'delete' && ack.entity_id && ack.entity_id !== localId) {
          const before = await txRepo.getById(localId);
          const canonicalHeld = await txRepo.getById(ack.entity_id);
          if (before?.deleted_at && canonicalHeld && !canonicalHeld.deleted_at) {
            // Deleted on the device while in flight, and the device still holds the payment's canonical row: the user removed
            // a second copy. The kept row must not be deleted on the server; the copy is merged away locally.
            await txRepo.adoptCanonicalId(localId, ack.entity_id, { discardCopyAttachments: true });
            await syncQueueRepo.dequeue(ack.operation_id);
            continue;
          }
          const outcome = await txRepo.adoptCanonicalId(localId, ack.entity_id);
          if (outcome === 'merged') {
            await syncQueueRepo.dequeue(ack.operation_id);
            continue;
          }
          if (outcome === 'rekeyed') localId = ack.entity_id;
        }
        if (ack.status === 'conflict_resolved') {
          conflicts++;
          // When server version wins or record was deleted on server,
          // update local transaction with winning server record BEFORE removing from queue!
          if (ack.winning_record) {
            await txRepo.mergeRemoteTransaction(ack.winning_record, { forceServerWin: true });
          }
        }
        // Queue items are removed ONLY upon confirmed server acknowledgement
        const local = ackedFor.entity_type === 'transaction' && ackedFor.operation !== 'delete' ? await txRepo.getById(localId) : null;
        if (local?.deleted_at) {
          // Deleted on the device while this create/update was in flight: the server now holds an ACTIVE copy. It must not be
          // marked synced (a later pull would bring it back); record the deletion for the server instead.
          await txRepo.updateSyncStatus(localId, 'pending_delete', ack.server_version);
          await syncQueueRepo.dequeue(ack.operation_id); // first: enqueueing a delete next to a queued create would cancel both
          await syncQueueRepo.enqueue({
            entity_type: 'transaction', entity_id: localId, operation: 'delete',
            payload: JSON.stringify({ id: localId, deleted_at: local.deleted_at, user_id: local.user_id, reference_id: local.reference_id ?? null, fingerprint: local.fingerprint ?? null }),
          });
          continue;
        }
        // Remove the queue item only if it still holds the change that was sent. An edit made while the request was in
        // flight stays queued (as an update) and the row stays pending until THAT change is acknowledged too.
        const settled = await syncQueueRepo.acknowledge(ack.operation_id, ackedFor.payload);
        if (ackedFor.entity_type === 'transaction') {
          if (settled) {
            await txRepo.updateSyncStatus(localId, 'synced', ack.server_version);
          } else if (ackedFor.operation !== 'delete') {
            await txRepo.updateSyncStatus(localId, 'pending_update', ack.server_version);
          }
        } else if (settled) {
          const table = { budget: 'budgets', merchant_alias: 'merchant_aliases', expected_payment: 'expected_payments' }[ackedFor.entity_type as string];
          if (table) await db.runAsync(`UPDATE ${table} SET sync_status = 'synced' WHERE id = ?`, localId);
        }
      } else {
        const errorMsg = ack.error || 'Server rejected item';
        errors.push(`${localId}: ${errorMsg}`);
        if (isPermanentItemError(ack)) {
          // The server REJECTED this exact change (invalid, forbidden, incomplete): resending it unchanged cannot succeed.
          // It stays visible as failed, with the reason, until the user edits it or retries it explicitly.
          await syncQueueRepo.markFailed(ack.operation_id, errorMsg, PERMANENT_FAILURE_DATE);
          if (ackedFor.entity_type === 'transaction') await txRepo.updateSyncStatus(localId, 'failed');
        } else {
          // The server FAILED to apply it (internal error, e.g. a schema problem it must fix): not a rejection. Keep the
          // item queued and pending, with capped exponential backoff, so it syncs on its own once the server is fixed.
          // Earlier builds parked these permanently after 10 attempts (how the 183-item backlog got stranded).
          const backoffMs = Math.min(MAX_TRANSIENT_BACKOFF_MS, Math.pow(2, Math.min(ackedFor.retry_count + 1, 20)) * 1000 + Math.random() * 500);
          await syncQueueRepo.markFailed(ack.operation_id, errorMsg, new Date(Date.now() + backoffMs).toISOString());
        }
      }
    }

    // Sent but not acknowledged (partial response): stays queued and pending, retried with backoff.
    for (const item of sent) {
      if (acknowledged.has(item.id)) continue;
      await syncQueueRepo.markFailed(item.id, 'NO_ACK', new Date(Date.now() + Math.min(300000, Math.pow(2, item.retry_count) * 1000)).toISOString());
      errors.push(`${item.entity_id}: not acknowledged by server`);
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
    const queue = await syncQueueRepo.peek(5000);
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
    const queue = await syncQueueRepo.peek(5000);
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
