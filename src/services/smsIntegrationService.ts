import {
  parseSmsTransaction,
  type ParsedSmsTransaction,
  type SmsParsingRule,
  type SmsReceivedPayload,
  DEFAULT_SMS_RULE,
} from '../../transactionParser.ts';
import { addSmsTransaction, initTransactionService } from './transactionService.ts';
import type { Session, TransactionEntity } from '../db/types.ts';

export interface SmsProcessResult {
  success: boolean;
  action: 'saved' | 'duplicate_ignored' | 'unsupported_or_invalid' | 'held' | 'error';
  transaction?: TransactionEntity;
  reason?: string;
}

/**
 * Validates, normalizes, and integrates an incoming bank SMS alert into local SQLite
 * and the offline-first synchronization engine.
 *
 * Guarantees:
 * 1. Raw SMS body is NEVER stored in database and NEVER uploaded to server.
 * 2. Deduplicates by reference_id (bank UTR/Txn ID) and fingerprint.
 * 3. Does NOT discard legitimate separate transactions with same amount & merchant on different dates/reference IDs.
 * 4. Atomically inserts the transaction and its sync_queue operation in SQLite.
 * 5. Works completely offline; triggers cloud sync only if an authenticated session exists.
 */
export async function processIncomingSms(
  event: SmsReceivedPayload,
  session: Session | null,
  rules: SmsParsingRule[] = [DEFAULT_SMS_RULE],
): Promise<SmsProcessResult> {
  // 0. Ownership: a financial record is never saved without an authenticated owner.
  // The event is reported as 'held' so callers keep it staged instead of discarding it.
  const ownerId = session?.user?.id?.trim();
  if (!ownerId) {
    return { success: false, action: 'held', reason: 'No authenticated owner for SMS event' };
  }

  // 1. Basic event structure validation
  if (!event || typeof event.body !== 'string' || !event.body.trim()) {
    return {
      success: false,
      action: 'unsupported_or_invalid',
      reason: 'Empty or missing SMS message body',
    };
  }

  if (!event.sender || typeof event.sender !== 'string') {
    return {
      success: false,
      action: 'unsupported_or_invalid',
      reason: 'Missing SMS sender address',
    };
  }

  // 2. Parse using the existing domain parser (preserving recognition rules)
  const parsed: ParsedSmsTransaction | null = parseSmsTransaction(event, rules);
  if (!parsed) {
    return {
      success: false,
      action: 'unsupported_or_invalid',
      reason: 'SMS does not match supported bank debit/credit transaction rules or was declined/pending',
    };
  }

  // 3. Normalize & validate extracted transaction fields
  if (!Number.isFinite(parsed.amount) || parsed.amount <= 0) {
    return {
      success: false,
      action: 'unsupported_or_invalid',
      reason: 'Invalid transaction amount',
    };
  }

  if (!parsed.merchant || !parsed.merchant.trim()) {
    return {
      success: false,
      action: 'unsupported_or_invalid',
      reason: 'Missing merchant or counterparty',
    };
  }

  if (parsed.direction !== 'income' && parsed.direction !== 'expense') {
    return {
      success: false,
      action: 'unsupported_or_invalid',
      reason: 'Invalid or unsupported transaction direction',
    };
  }

  // Validate date string
  const parsedDate = new Date(parsed.transactionDate);
  if (Number.isNaN(parsedDate.getTime())) {
    return {
      success: false,
      action: 'unsupported_or_invalid',
      reason: 'Invalid transaction date',
    };
  }

  try {
    const { transactionRepository } = await initTransactionService();

    // 4. Duplicate prevention check
    if (parsed.referenceId?.trim()) {
      const existingRef = await transactionRepository.findByReferenceId(parsed.referenceId.trim(), ownerId);
      if (existingRef) {
        return {
          success: true,
          action: 'duplicate_ignored',
          transaction: existingRef,
          reason: `Duplicate transaction with reference ID ${parsed.referenceId} already exists`,
        };
      }
    }

    if (parsed.fingerprint?.trim()) {
      const existingFp = await transactionRepository.findByFingerprint(parsed.fingerprint.trim(), ownerId);
      if (existingFp) {
        // Only treat as duplicate if incoming has no reference_id, or existing has matching/empty reference_id
        if (!parsed.referenceId?.trim() || !existingFp.reference_id || parsed.referenceId.trim() === existingFp.reference_id) {
          return {
            success: true,
            action: 'duplicate_ignored',
            transaction: existingFp,
            reason: `Duplicate transaction matching fingerprint already exists`,
          };
        }
      }
    }

    // 5. Save through transaction service (atomic SQLite transaction insertion & sync_queue enqueue)
    const saved = await addSmsTransaction(parsed, session);

    return {
      success: true,
      action: 'saved',
      transaction: saved,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to process incoming SMS (event retained for retry)');
    return {
      success: false,
      action: 'error',
      reason: errorMsg,
    };
  }
}
