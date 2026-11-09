import {
  parseSmsTransaction,
  type ParsedSmsTransaction,
  type SmsParsingRule,
  type SmsReceivedPayload,
  DEFAULT_SMS_RULE,
} from '../../transactionParser.ts';
import { ingestDetectedTransaction } from './transactionService.ts';
import type { DetectionSource, Session, TransactionEntity } from '../db/types.ts';

export interface SmsProcessResult {
  success: boolean;
  action: 'saved' | 'duplicate_ignored' | 'unsupported_or_invalid' | 'held' | 'error';
  transaction?: TransactionEntity;
  reason?: string;
}

function notificationSenderLabel(title: string): string {
  const cleaned = title.replace(/[^A-Za-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30).trim();
  return cleaned.length >= 4 ? cleaned : 'TRUECALLER';
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
 * 6. Guest mode (no session) saves into the local guest scope and is never uploaded.
 */
export async function processIncomingSms(
  event: SmsReceivedPayload,
  session: Session | null,
  rules: SmsParsingRule[] = [DEFAULT_SMS_RULE],
): Promise<SmsProcessResult> {
  // 0. Scope: a signed-in user's SMS become that account's transactions (synced). With no session the SMS belongs to
  // the device's guest scope (user_id NULL): saved locally only, never uploaded, and only imported into an account
  // through the explicit guest-import consent flow. Account isolation is unchanged: an account's own events are
  // only ever claimed for that account (see the staging store), so guest and account data never mix.
  const ownerId: string | null = session?.user?.id?.trim() || null;

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
  // A Truecaller notification title is free text ("Axis Bank Ltd."), not a short sender id: normalise it so sender-id
  // rules apply. Whether the body is actually a transaction is decided by the parser, not the title.
  const parseInput = event.source === 'truecaller_notification'
    ? { ...event, sender: notificationSenderLabel(event.sender) }
    : event;
  const parsed: ParsedSmsTransaction | null = parseSmsTransaction(parseInput, rules);
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
    // 4+5. One atomic, idempotent ingest: duplicate detection (reference -> fingerprint -> cross-source event key ->
    // conservative cross-source proximity match) and the insert happen inside a single SQLite transaction, so SMS and
    // Truecaller events racing each other, retries and restarts can never produce two rows.
    const source: DetectionSource = event.source ?? 'sms';
    const outcome = await ingestDetectedTransaction(
      parsed,
      { source, detectedAt: event.receivedAt || Date.now(), senderLabel: event.sender },
      session,
    );
    if (!outcome.created) {
      return {
        success: true,
        action: 'duplicate_ignored',
        transaction: outcome.transaction,
        reason: `Already recorded (matched by ${outcome.matchedBy}); source '${source}' ${outcome.newSource ? 'added' : 'already known'}`,
      };
    }
    return { success: true, action: 'saved', transaction: outcome.transaction };
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
