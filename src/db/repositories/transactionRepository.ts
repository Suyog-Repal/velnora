import type {
  CreateTransactionInput,
  DetectionSource,
  IDatabase,
  RemoteTransaction,
  SyncStatus,
  TransactionEntity,
  UpdateTransactionInput,
} from '../types.ts';
import { generateUUID, SyncQueueRepository } from './syncQueueRepository.ts';
import { withWriteLock } from '../writeLock.ts';
import { isGenericMerchant, relateMerchants, scoreMatch, WEAK_WINDOW_MS, type MatchResult, type MatchSide } from '../../services/duplicateMatcher.ts';

const EXTRA_UPDATE_COLUMNS = [
  'merchant_phone', 'payment_method', 'receipt_local_path', 'receipt_remote_id', 'receipt_upload_pending',
  'location_lat', 'location_lng', 'location_name', 'location_address', 'location_confirmed',
  'txn_kind', 'verification_status', 'capture_source', 'account_last4', 'bank_name', 'payment_app', 'possible_duplicate_of', 'confidence',
] as const;

const LEDGER_REMOTE_COLUMNS = ['txn_kind', 'verification_status', 'capture_source', 'account_last4', 'bank_name', 'payment_app', 'possible_duplicate_of', 'confidence'] as const;

/** SMS delivery and notification posting are seconds apart; a few minutes also absorbs delayed delivery. */
export const CROSS_SOURCE_WINDOW_MS = 5 * 60 * 1000;

export interface DetectionInput {
  source: DetectionSource;
  /** Epoch ms the source observed the event. */
  detectedAt: number;
  /** Cross-source event key from the parser ('' when the message does not pin the event down). */
  eventKey?: string;
  /** Debug metadata. Never the raw message body. */
  metadata?: { accountLast4?: string; balance?: number; [k: string]: unknown };
  /** Only the calendar day is known (bank statements). */
  dayPrecision?: boolean;
}

/** A statement row the person already confirmed is this existing transaction. */
export interface IngestOptions { attachTo?: string }

export interface PossibleMatch { row: TransactionEntity; result: MatchResult }

export interface IngestOutcome {
  transaction: TransactionEntity;
  /** True only when a new transaction row was inserted. */
  created: boolean;
  matchedBy: 'reference' | 'fingerprint' | 'cross_source' | null;
  /** True when this source had not been recorded for the transaction before. */
  newSource: boolean;
}

export interface TransactionSourceRecord {
  source: DetectionSource;
  detectedAt: string;
  processedAt: string;
  seenCount: number;
  metadata: Record<string, unknown>;
}

function safeJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

/** Truncated notification text can yield a shorter or generic merchant; the same payee never differs entirely. */
export function merchantsCompatible(a: string, b: string): boolean {
  return relateMerchants(a, b) !== 'different';
}

const BANK_CHANNELS: DetectionSource[] = ['sms', 'truecaller_notification'];

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

  /**
   * Idempotent ingest of an auto-detected bank event (SMS or Truecaller notification).
   * Runs under the shared write lock and inside ONE SQLite transaction. If the event is already known
   * (reference, fingerprint, cross-source event key, or a conservative cross-source time/amount match) the existing
   * transaction is left untouched and only its source metadata is recorded; otherwise it is created together with its
   * identity keys and source row. A duplicate changes nothing that feeds balances, analytics or the sync queue.
   */
  ingestDetected(input: CreateTransactionInput, detection: DetectionInput, options?: IngestOptions): Promise<IngestOutcome> {
    return withWriteLock(() => this.ingestDetectedUnlocked(input, detection, options));
  }

  private async ingestDetectedUnlocked(input: CreateTransactionInput, detection: DetectionInput, options?: IngestOptions): Promise<IngestOutcome> {
    const scope = input.user_id ?? '';
    const nowIso = new Date().toISOString();
    const ref = input.reference_id?.trim() || '';
    const fp = input.fingerprint?.trim() || '';
    const ev = detection.eventKey?.trim() || '';
    // A reference number is authoritative; fingerprints only identify events that carry none.
    const keys = ref ? [`ref:${ref}`] : [fp ? `fp:${fp}` : '', ev ? `ev:${ev}` : ''].filter(Boolean);

    await this.db.execAsync('BEGIN TRANSACTION');
    try {
      // Keys whose transaction was deleted no longer identify anything.
      await this.db.runAsync(
        'DELETE FROM transaction_keys WHERE scope = ? AND transaction_id NOT IN (SELECT id FROM transactions WHERE deleted_at IS NULL)',
        scope,
      );

      let existing: TransactionEntity | null = null;
      let matchedBy: IngestOutcome['matchedBy'] = null;
      if (options?.attachTo) {
        const target = await this.getById(options.attachTo);
        if (target && !target.deleted_at && (target.user_id ?? '') === scope) { existing = target; matchedBy = 'cross_source'; }
      }
      for (const key of existing ? [] : keys) {
        const row = await this.db.getFirstAsync<{ transaction_id: string }>(
          'SELECT transaction_id FROM transaction_keys WHERE scope = ? AND key = ?', scope, key,
        );
        if (row) {
          existing = await this.getById(row.transaction_id);
          matchedBy = key.startsWith('ref:') ? 'reference' : 'fingerprint';
          break;
        }
      }
      // Rows created before keys existed (or pulled from the server) are found through the legacy columns.
      if (!existing && ref) {
        existing = await this.findByReferenceId(ref, input.user_id ?? null);
        if (existing) matchedBy = 'reference';
      }
      if (!existing && fp && !ref) {
        const legacy = await this.findByFingerprint(fp, input.user_id ?? null);
        if (legacy && !legacy.reference_id) { existing = legacy; matchedBy = 'fingerprint'; }
      }
      // Same payment reported by the other channel when the message pins neither a reference nor a time.
      if (!existing) {
        existing = await this.findCrossSourceCandidate(input, detection, scope);
        if (existing) matchedBy = 'cross_source';
      }

      const created = existing === null;
      // Uncertain match: keep it as its own row, flagged for the person to resolve. Never merged or dropped silently.
      let toCreate = input;
      if (created) {
        const possible = await this.findPossibleDuplicate(input, detection, scope);
        if (possible) toCreate = { ...input, verification_status: 'needs_review', possible_duplicate_of: possible.row.id };
      }
      const transaction = existing ?? (await this.createUnlocked(toCreate, true));

      for (const key of keys) {
        await this.db.runAsync(
          'INSERT OR IGNORE INTO transaction_keys (scope, key, transaction_id, created_at) VALUES (?, ?, ?, ?)',
          scope, key, transaction.id, nowIso,
        );
      }
      const seen = await this.db.getFirstAsync<{ id: number }>(
        'SELECT id FROM transaction_sources WHERE transaction_id = ? AND source = ?', transaction.id, detection.source,
      );
      if (seen) {
        await this.db.runAsync('UPDATE transaction_sources SET seen_count = seen_count + 1, processed_at = ? WHERE id = ?', nowIso, seen.id);
      } else {
        await this.db.runAsync(
          'INSERT INTO transaction_sources (transaction_id, source, detected_at, processed_at, metadata) VALUES (?, ?, ?, ?, ?)',
          transaction.id, detection.source, new Date(Number.isFinite(detection.detectedAt) ? detection.detectedAt : Date.now()).toISOString(), nowIso, JSON.stringify(detection.metadata ?? {}),
        );
      }
      if (!created && !seen) await this.enrichFromNewSource(transaction, input, detection.source);
      await this.db.execAsync('COMMIT');
      return { transaction, created, matchedBy: created ? null : matchedBy, newSource: !seen };
    } catch (err) {
      await this.db.execAsync('ROLLBACK');
      throw err;
    }
  }

  /** A newly seen channel fills in what the row was missing, and independent confirmation raises its status. */
  private async enrichFromNewSource(existing: TransactionEntity, input: CreateTransactionInput, source: DetectionSource): Promise<void> {
    const sources = (await this.db.getAllAsync<{ source: DetectionSource }>('SELECT source FROM transaction_sources WHERE transaction_id = ?', existing.id)).map((r) => r.source);
    const independent = sources.includes('payment_notification') && BANK_CHANNELS.some((c) => sources.includes(c));
    let status = existing.verification_status ?? 'detected';
    if (source === 'csv_import') status = 'reconciled';
    else if (independent && status === 'detected') status = 'verified';

    // A channel that names the payee replaces a placeholder like "UPI payment", unless the person has already confirmed the row.
    const unconfirmed = existing.verification_status === 'detected' || existing.verification_status === 'needs_review';
    const betterName = source !== 'csv_import' && unconfirmed && isGenericMerchant(existing.counterparty) && !isGenericMerchant(input.counterparty);
    const betterCategory = betterName && /^other (?:expenses?|income)$/i.test(existing.category);
    const next = {
      counterparty: betterName ? input.counterparty.trim() : existing.counterparty,
      category: betterCategory ? input.category.trim() : existing.category,
      account_last4: existing.account_last4 ?? input.account_last4 ?? null,
      bank_name: existing.bank_name ?? input.bank_name ?? null,
      payment_app: existing.payment_app ?? input.payment_app ?? null,
      reference_id: existing.reference_id ?? (input.reference_id?.trim() || null),
    };
    const unchanged = !betterName && status === existing.verification_status && next.account_last4 === (existing.account_last4 ?? null) && next.bank_name === (existing.bank_name ?? null)
      && next.payment_app === (existing.payment_app ?? null) && next.reference_id === (existing.reference_id ?? null);
    if (unchanged) return;

    const syncStatus: SyncStatus = existing.sync_status === 'pending_create' ? 'pending_create' : 'pending_update';
    await this.db.runAsync(
      'UPDATE transactions SET counterparty = ?, category = ?, account_last4 = ?, bank_name = ?, payment_app = ?, reference_id = ?, verification_status = ?, sync_status = ?, updated_at = ? WHERE id = ?',
      next.counterparty, next.category, next.account_last4, next.bank_name, next.payment_app, next.reference_id, status, syncStatus, new Date().toISOString(), existing.id,
    );
    const updated = (await this.getById(existing.id))!;
    await this.syncQueueRepo.enqueue({ entity_type: 'transaction', entity_id: updated.id, operation: updated.sync_status === 'pending_create' ? 'create' : 'update', payload: JSON.stringify(updated) });
  }

  private async sideOf(row: TransactionEntity): Promise<MatchSide> {
    const sources = await this.getSources(row.id);
    const balance = sources.map((s) => (s.metadata as { balance?: number }).balance).find((b) => b !== undefined);
    const accountLast4 = row.account_last4 ?? sources.map((s) => (s.metadata as { accountLast4?: string }).accountLast4).find(Boolean) ?? null;
    return {
      amountPaise: row.amount_paise ?? Math.round(row.amount * 100), direction: row.direction, kind: row.txn_kind ?? 'payment',
      at: new Date(row.transaction_date).getTime(), counterparty: row.counterparty, referenceId: row.reference_id, accountLast4,
      balance, channels: sources.map((s) => s.source),
      dayPrecision: sources.length > 0 && sources.every((s) => s.source === 'csv_import'),
    };
  }

  /** Best existing row that may be this event, across every source including manual entries. Read-only. */
  async findPossibleDuplicate(input: CreateTransactionInput, detection: DetectionInput, scope: string): Promise<PossibleMatch | null> {
    const at = new Date(input.transaction_date || detection.detectedAt).getTime();
    const paise = input.amount_paise ?? Math.round(input.amount * 100);
    const rows = await this.db.getAllAsync<TransactionEntity>(
      `SELECT * FROM transactions WHERE deleted_at IS NULL AND COALESCE(user_id, '') = ? AND direction = ? AND amount_paise = ?
         AND possible_duplicate_of IS NULL AND transaction_date >= ? AND transaction_date <= ?`,
      scope, input.direction, paise, new Date(at - WEAK_WINDOW_MS).toISOString(), new Date(at + WEAK_WINDOW_MS).toISOString(),
    );
    const side: MatchSide = {
      amountPaise: paise, direction: input.direction, kind: input.txn_kind ?? 'payment', at, counterparty: input.counterparty,
      referenceId: input.reference_id, accountLast4: input.account_last4 ?? detection.metadata?.accountLast4 ?? null,
      balance: detection.metadata?.balance, channels: [detection.source], dayPrecision: detection.dayPrecision,
    };
    let best: PossibleMatch | null = null;
    for (const row of rows) {
      const result = scoreMatch(side, await this.sideOf(row));
      if (result.outcome !== 'none' && (!best || result.score > best.result.score)) best = { row: this.mapRow(row), result };
    }
    return best;
  }

  /** True when a reference or fingerprint key already identifies this event in the scope. */
  async hasIdentityKey(scope: string, key: string): Promise<boolean> {
    return (await this.db.getFirstAsync<{ n: number }>('SELECT 1 AS n FROM transaction_keys WHERE scope = ? AND key = ?', scope, key)) !== null;
  }

  /** Rows the person needs to look at, newest first. */
  async getNeedingReview(userId: string | null): Promise<TransactionEntity[]> {
    const rows = await this.db.getAllAsync<TransactionEntity>(
      `SELECT * FROM transactions WHERE deleted_at IS NULL AND verification_status = 'needs_review' AND (user_id = ? OR (user_id IS NULL AND ? IS NULL)) ORDER BY transaction_date DESC LIMIT 200`,
      userId, userId,
    );
    return rows.map((r) => this.mapRow(r));
  }

  /** The person says these are two real payments: the row starts counting in totals. */
  keepAsSeparate(id: string): Promise<TransactionEntity> {
    return withWriteLock(() => this.updateUnlocked(id, { possible_duplicate_of: null, verification_status: 'verified' }));
  }

  /** The person says it is the same payment: one financial row remains, keeping every source record and identity key. */
  mergeDuplicate(id: string, intoId: string): Promise<TransactionEntity> {
    return withWriteLock(async () => {
      const [row, target] = [await this.getById(id), await this.getById(intoId)];
      if (!row || row.deleted_at || !target || target.deleted_at || (row.user_id ?? '') !== (target.user_id ?? '')) throw new Error('Transaction not found.');
      await this.db.execAsync('BEGIN TRANSACTION');
      try {
        await this.db.runAsync('UPDATE OR IGNORE transaction_keys SET transaction_id = ? WHERE transaction_id = ?', intoId, id);
        await this.db.runAsync('UPDATE OR IGNORE transaction_sources SET transaction_id = ? WHERE transaction_id = ?', intoId, id);
        await this.db.runAsync('DELETE FROM transaction_sources WHERE transaction_id = ?', id);
        await this.deleteUnlocked(id, true);
        const status = target.verification_status === 'reconciled' ? 'reconciled' : 'verified';
        const syncStatus: SyncStatus = target.sync_status === 'pending_create' ? 'pending_create' : 'pending_update';
        await this.db.runAsync(
          `UPDATE transactions SET verification_status = ?, account_last4 = COALESCE(account_last4, ?), bank_name = COALESCE(bank_name, ?), payment_app = COALESCE(payment_app, ?), reference_id = COALESCE(reference_id, ?), sync_status = ?, updated_at = ? WHERE id = ?`,
          status, row.account_last4 ?? null, row.bank_name ?? null, row.payment_app ?? null, row.reference_id ?? null, syncStatus, new Date().toISOString(), intoId,
        );
        const updated = (await this.getById(intoId))!;
        await this.syncQueueRepo.enqueue({ entity_type: 'transaction', entity_id: intoId, operation: updated.sync_status === 'pending_create' ? 'create' : 'update', payload: JSON.stringify(updated) });
        await this.db.execAsync('COMMIT');
        return updated;
      } catch (err) {
        await this.db.execAsync('ROLLBACK');
        throw err;
      }
    });
  }

  /**
   * Same payment seen through the other channel, for events with no reference and no pinned time. ALL must hold:
   * same account scope, amount and direction; an existing auto-detected row NOT yet seen by this source (a source
   * reports each payment once, so a second same-source message is a different payment); transaction time within the
   * window; compatible merchants; no contradicting reference, account or balance.
   */
  private async findCrossSourceCandidate(input: CreateTransactionInput, detection: DetectionInput, scope: string): Promise<TransactionEntity | null> {
    const at = new Date(input.transaction_date || detection.detectedAt).getTime();
    const rows = await this.db.getAllAsync<TransactionEntity>(
      `SELECT t.* FROM transactions t
       WHERE t.deleted_at IS NULL AND COALESCE(t.user_id, '') = ? AND t.direction = ? AND t.amount_paise = ?
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND EXISTS (SELECT 1 FROM transaction_sources s WHERE s.transaction_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM transaction_sources s WHERE s.transaction_id = t.id AND s.source = ?)`,
      scope, input.direction, input.amount_paise ?? Math.round(input.amount * 100),
      new Date(at - CROSS_SOURCE_WINDOW_MS).toISOString(), new Date(at + CROSS_SOURCE_WINDOW_MS).toISOString(), detection.source,
    );
    const incomingRef = input.reference_id?.trim() || '';
    const candidates: { row: TransactionEntity; dist: number }[] = [];
    for (const row of rows) {
      if (incomingRef && row.reference_id && row.reference_id !== incomingRef) continue;
      if (!merchantsCompatible(row.counterparty, input.counterparty)) continue;
      const metas = await this.db.getAllAsync<{ metadata: string }>('SELECT metadata FROM transaction_sources WHERE transaction_id = ?', row.id);
      const contradicts = metas.some(({ metadata }) => {
        const m = safeJson(metadata) as { accountLast4?: string; balance?: number };
        if (m.accountLast4 && detection.metadata?.accountLast4 && m.accountLast4 !== detection.metadata.accountLast4) return true;
        return m.balance !== undefined && detection.metadata?.balance !== undefined && Math.abs(m.balance - detection.metadata.balance) > 0.005;
      });
      if (!contradicts) candidates.push({ row, dist: Math.abs(new Date(row.transaction_date).getTime() - at) });
    }
    candidates.sort((a, b) => a.dist - b.dist || a.row.created_at.localeCompare(b.row.created_at));
    return candidates[0] ? this.mapRow(candidates[0].row) : null;
  }

  async getSources(transactionId: string): Promise<TransactionSourceRecord[]> {
    const rows = await this.db.getAllAsync<{ source: DetectionSource; detected_at: string; processed_at: string; seen_count: number; metadata: string }>(
      'SELECT source, detected_at, processed_at, seen_count, metadata FROM transaction_sources WHERE transaction_id = ? ORDER BY detected_at ASC', transactionId,
    );
    return rows.map((r) => ({ source: r.source, detectedAt: r.detected_at, processedAt: r.processed_at, seenCount: r.seen_count, metadata: safeJson(r.metadata) }));
  }

  /** Detection sources for many transactions at once (list screens). */
  async getSourcesFor(ids: string[]): Promise<Record<string, DetectionSource[]>> {
    const out: Record<string, DetectionSource[]> = {};
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = await this.db.getAllAsync<{ transaction_id: string; source: DetectionSource }>(
        `SELECT transaction_id, source FROM transaction_sources WHERE transaction_id IN (${chunk.map(() => '?').join(',')})`, ...chunk,
      );
      for (const r of rows) (out[r.transaction_id] ??= []).push(r.source);
    }
    return out;
  }

  private async createUnlocked(input: CreateTransactionInput, externalTxn = false): Promise<TransactionEntity> {
    if (!input.amount || input.amount <= 0) {
      throw new Error('Transaction amount must be greater than zero');
    }
    if (!input.counterparty?.trim()) {
      throw new Error('Counterparty cannot be empty');
    }

    // 1. Authoritative duplicate check by reference_id (bank UTR / txn reference)
    if (!externalTxn && input.reference_id?.trim()) {
      const existingRef = await this.findByReferenceId(input.reference_id.trim(), input.user_id);
      if (existingRef) {
        return existingRef;
      }
    }

    // 2. Duplicate check by fingerprint
    // Only treat as duplicate if incoming has no reference_id, or existing has matching/empty reference_id
    if (!externalTxn && input.fingerprint?.trim()) {
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
      txn_kind: input.txn_kind ?? 'payment',
      verification_status: input.verification_status ?? (source === 'manual' ? 'verified' : 'detected'),
      capture_source: input.capture_source ?? (source === 'manual' ? 'manual' : 'sms'),
      account_last4: input.account_last4 ?? null,
      bank_name: input.bank_name ?? null,
      payment_app: input.payment_app ?? null,
      possible_duplicate_of: input.possible_duplicate_of ?? null,
      confidence: input.confidence ?? null,
    };

    if (!externalTxn) await this.db.execAsync('BEGIN TRANSACTION');
    try {
      await this.db.runAsync(
        `INSERT INTO transactions (
          id, user_id, amount, amount_paise, direction, counterparty, category_id, category,
          description, transaction_date, source, reference_id, fingerprint,
          sync_status, server_version, deleted_at, created_at, updated_at,
          merchant_phone, payment_method, location_lat, location_lng, location_name, location_address, location_confirmed,
          txn_kind, verification_status, capture_source, account_last4, bank_name, payment_app, possible_duplicate_of, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.txn_kind,
        record.verification_status,
        record.capture_source,
        record.account_last4,
        record.bank_name,
        record.payment_app,
        record.possible_duplicate_of,
        record.confidence,
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

      if (!externalTxn) await this.db.execAsync('COMMIT');
      return record;
    } catch (err) {
      if (!externalTxn) await this.db.execAsync('ROLLBACK');
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

  private async deleteUnlocked(id: string, externalTxn = false): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    const now = new Date().toISOString();

    if (!externalTxn) await this.db.execAsync('BEGIN TRANSACTION');
    try {
      // Rows waiting on this one can no longer be duplicates of it; they count again and stay flagged for review.
      const dependents = await this.db.getAllAsync<{ id: string }>('SELECT id FROM transactions WHERE possible_duplicate_of = ? AND deleted_at IS NULL', id);
      for (const dep of dependents) {
        await this.db.runAsync(
          `UPDATE transactions SET possible_duplicate_of = NULL, updated_at = ?, sync_status = CASE WHEN sync_status = 'pending_create' THEN 'pending_create' ELSE 'pending_update' END WHERE id = ?`, now, dep.id,
        );
        const updated = (await this.getById(dep.id))!;
        await this.syncQueueRepo.enqueue({ entity_type: 'transaction', entity_id: dep.id, operation: updated.sync_status === 'pending_create' ? 'create' : 'update', payload: JSON.stringify(updated) });
      }

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

      if (!externalTxn) await this.db.execAsync('COMMIT');
      return true;
    } catch (err) {
      if (!externalTxn) await this.db.execAsync('ROLLBACK');
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
    // An older server omits these fields; the local values then stay as they are.
    if ((outcome === 'inserted' || outcome === 'updated') && remote.verification_status !== undefined) {
      await this.db.runAsync(
        `UPDATE transactions SET ${LEDGER_REMOTE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...LEDGER_REMOTE_COLUMNS.map((c) => (c === 'txn_kind' ? remote.txn_kind ?? 'payment' : remote[c] ?? null)), remote.id,
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
