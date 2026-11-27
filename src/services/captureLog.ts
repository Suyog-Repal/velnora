/**
 * The local capture log: what happened to a message Velnora saw, never what it said. Pure (no React Native).
 *
 * The log itself lives in the native staging database (most drops happen before JavaScript runs) and is never synced. The
 * vocabulary mirrors VelnoraCaptureRules.kt; a test keeps the two identical. Rows are checked again here before they are
 * shown or shared, so a field or value outside these lists cannot reach the screen.
 */
import {
  DEFAULT_SMS_RULE, REVERSAL_DONE, REVERSAL_FUTURE, classifySmsStatus, isOtpMessage, isPromotionalMessage, parseSmsTransaction,
  type SmsParsingRule, type SmsReceivedPayload,
} from '../../transactionParser.ts';
import { CAPTURE_SOURCES } from './captureSources.ts';
import type { SmsProcessResult } from './smsIntegrationService.ts';

export const LOG_SOURCES = ['sms', 'payment_notification', 'truecaller_notification', 'app'] as const;
export const LOG_STAGES = ['receiver', 'listener', 'staging', 'headless', 'queue', 'parse', 'match', 'insert'] as const;
export const LOG_RESULTS = ['dropped', 'held', 'retry', 'dead', 'saved'] as const;

/** Every reason code, with the words shown to the person. */
export const REASON_LABELS = {
  no_sender: 'No sender on the message',
  empty_message: 'Empty message',
  sender_filtered: 'Sender is not a business-style sender',
  otp: 'One-time password',
  group_summary: 'Summary of other notifications',
  ongoing: 'Ongoing notification',
  no_content: 'Notification had no content',
  no_title: 'Notification had no title',
  too_short: 'Text too short',
  no_amount: 'No amount found',
  no_payment_word: 'No payment word found',
  already_staged: 'Already received',
  repeat: 'Repeat of a recent notification',
  staging_error: 'Could not store it',
  wake_failed: 'Android did not start background processing',
  max_attempts: 'Gave up after repeated attempts',
  no_account: 'Arrived with no account',
  other_account: 'Belongs to another account',
  signed_out: 'Signed out: waiting',
  drain_failed: 'Processing failed: waiting',
  sender_not_supported: 'Sender not supported',
  promotion: 'Looks like a promotion',
  failed_wording: 'Wording suggests a failed payment',
  pending_wording: 'Wording suggests a pending payment',
  no_status_word: 'No completed-payment word',
  excluded_wording: 'Wording of a due, request or future payment',
  no_direction_or_amount: 'Could not tell the amount or direction',
  invalid_fields: 'Details were not usable',
  same_reference: 'Same reference as a saved transaction',
  same_fingerprint: 'Same as a saved transaction',
  same_payment_other_source: 'Matched a payment seen by another source',
  possible_duplicate: 'Saved as a possible duplicate (not counted)',
  saved: 'Saved',
  no_owner: 'No owner yet',
  persist_failed: 'Could not save',
  processor_exception: 'Processing error',
} as const;

export type LogStage = typeof LOG_STAGES[number];
export type LogResult = typeof LOG_RESULTS[number];
export type LogReason = keyof typeof REASON_LABELS;

export interface CaptureLogRow { at: number; source: typeof LOG_SOURCES[number]; origin: string; stage: LogStage; result: LogResult; reason: LogReason; count: number }

const BANK_HEADER = /^(?:[A-Z]{2}-[A-Z0-9]{3,9}(?:-[A-Z])?|[A-Z]{6})$/;
const NOTIFICATION_IDS: ReadonlySet<string> = new Set(CAPTURE_SOURCES.filter((s) => s.kind === 'notification').map((s) => s.id));

/** A bank-style header, an allowed app package, or one of the fixed words. Anything else becomes "other". */
function safeOrigin(source: string, origin: unknown): string {
  if (source === 'app') return 'app';
  if (typeof origin !== 'string') return 'other';
  if (source === 'sms') return origin === 'numeric' || BANK_HEADER.test(origin) ? origin : 'other';
  return NOTIFICATION_IDS.has(origin) ? origin : 'other';
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** Rebuilds each row from the allowed fields only; rows with anything outside the vocabulary are left out. */
export function sanitizeLogRows(raw: unknown): CaptureLogRow[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptureLogRow[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item.at !== 'number' || !Number.isFinite(item.at)) continue;
    const { source, stage, result, reason } = item;
    if (!oneOf(LOG_SOURCES, source) || !oneOf(LOG_STAGES, stage) || !oneOf(LOG_RESULTS, result)) continue;
    if (typeof reason !== 'string' || !Object.prototype.hasOwnProperty.call(REASON_LABELS, reason)) continue;
    const count = typeof item.count === 'number' && item.count >= 1 ? Math.trunc(item.count) : 1;
    out.push({ at: item.at, source, origin: safeOrigin(source, item.origin), stage, result, reason: reason as LogReason, count });
  }
  return out;
}

export function originLabel(row: Pick<CaptureLogRow, 'source' | 'origin'>): string {
  if (row.source === 'app') return 'Velnora';
  const app = CAPTURE_SOURCES.find((s) => s.id === row.origin)?.label;
  if (app) return app;
  if (row.source === 'sms') return row.origin === 'numeric' ? 'SMS from a number' : row.origin === 'other' ? 'SMS, other sender' : `SMS ${row.origin}`;
  return 'Notification';
}

/** The plain-text export. Times are ISO so a report can be compared with other logs. */
export function formatCaptureLog(raw: unknown, now: Date = new Date()): string {
  const rows = sanitizeLogRows(raw);
  return [
    'Velnora capture log',
    `generated: ${now.toISOString()}`,
    `entries: ${rows.length} (keeps up to 500, for 14 days)`,
    'Holds times, sources, stages and reason codes only: no message text, amounts, names or account ids.',
    '---',
    ...rows.map((r) => `${new Date(r.at).toISOString()} ${r.source} ${r.origin} ${r.stage} ${r.result} ${r.reason}${r.count > 1 ? ` x${r.count}` : ''}`),
  ].join('\n');
}

/**
 * Why the parser returned nothing, as a reason code. It only explains: it walks the parser's own checks in the parser's order
 * and never changes what is accepted.
 */
export function explainRejection(event: SmsReceivedPayload, rules: SmsParsingRule[] = [DEFAULT_SMS_RULE]): LogReason {
  const body = (event.body ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return 'empty_message';
  if (!event.sender) return 'no_sender';
  // A Truecaller title is rewritten into a supported sender before parsing, so only other sources can fail the sender rule.
  const rule = event.source === 'truecaller_notification' ? rules[0] : rules.find((r) => new RegExp(r.senderPattern, 'i').test(event.sender));
  if (!rule) return 'sender_not_supported';
  if (isOtpMessage(body)) return 'otp';
  if (isPromotionalMessage(body)) return 'promotion';
  const reversal = REVERSAL_DONE.test(body) && !REVERSAL_FUTURE.test(body);
  const status = reversal ? 'success' : classifySmsStatus(body, rule);
  if (status === 'failed') return 'failed_wording';
  if (status === 'pending') return 'pending_wording';
  if (status === 'ambiguous') return 'no_status_word';
  if (rule.ignorePatterns?.some((p) => new RegExp(p, 'i').test(body))) return 'excluded_wording';
  const sender = event.source === 'truecaller_notification' ? 'TRUECALLER' : event.sender;
  return parseSmsTransaction({ ...event, sender }, rules) ? 'invalid_fields' : 'no_direction_or_amount';
}

export interface CaptureNote { stage: LogStage; result: LogResult; reason: LogReason }

const MATCH_REASONS = { reference: 'same_reference', fingerprint: 'same_fingerprint', cross_source: 'same_payment_other_source' } as const;

/** What to log for one processed event. `gaveUp` is true when a failure has used its last attempt. */
export function captureNote(event: SmsReceivedPayload, result: SmsProcessResult, gaveUp: boolean, rules?: SmsParsingRule[]): CaptureNote {
  if (result.action === 'saved') {
    return result.transaction?.possible_duplicate_of
      ? { stage: 'match', result: 'held', reason: 'possible_duplicate' }
      : { stage: 'insert', result: 'saved', reason: 'saved' };
  }
  if (result.action === 'duplicate_ignored') return { stage: 'match', result: 'dropped', reason: MATCH_REASONS[result.matchedBy ?? 'fingerprint'] };
  if (result.action === 'unsupported_or_invalid') return { stage: 'parse', result: 'dropped', reason: explainRejection(event, rules) };
  if (gaveUp) return { stage: 'insert', result: 'dead', reason: 'max_attempts' };
  const reason = result.action === 'held' ? 'no_owner' : result.reason === 'processor_exception' ? 'processor_exception' : 'persist_failed';
  return { stage: 'insert', result: 'retry', reason };
}
