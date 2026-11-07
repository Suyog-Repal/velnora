import { processIncomingSms, type SmsProcessResult } from './smsIntegrationService.ts';
import type { SmsStagingStore, StagingCounts } from './smsStagingTypes.ts';
import { DEFAULT_SMS_RULE, type SmsParsingRule } from '../../transactionParser.ts';
import type { Session } from '../db/types.ts';

export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 2 * 60 * 1000;
export const BATCH_SIZE = 25;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface DrainSummary {
  processed: number;
  saved: number;
  duplicates: number;
  rejected: number;
  retried: number;
  dead: number;
}

type Processor = (event: Parameters<typeof processIncomingSms>[0], session: Session | null, rules: SmsParsingRule[]) => Promise<SmsProcessResult>;

export function retryDelayMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

let drainTail: Promise<unknown> = Promise.resolve();

/**
 * Drains staged SMS events for the current scope: the signed-in user's own events, or — in guest mode (no session) —
 * events with no owner, which become local-only guest transactions. Calls are serialized so overlapping triggers
 * (foreground event, AppState change, session change) never process the same event concurrently.
 *
 * An event is completed ONLY after processIncomingSms reports that the transaction and its sync-queue item
 * were committed (saved), or that it is a duplicate / non-financial message. Errors keep the event for retry.
 */
export function drainStagedSms(
  store: SmsStagingStore,
  session: Session | null,
  rules: SmsParsingRule[] = [DEFAULT_SMS_RULE],
  options: { processor?: Processor; now?: () => number } = {},
): Promise<DrainSummary> {
  const run = drainTail.then(() => drainOnce(store, session, rules, options));
  drainTail = run.catch(() => undefined);
  return run;
}

async function drainOnce(
  store: SmsStagingStore,
  session: Session | null,
  rules: SmsParsingRule[],
  options: { processor?: Processor; now?: () => number },
): Promise<DrainSummary> {
  const processor = options.processor ?? processIncomingSms;
  const now = options.now ?? Date.now;
  const summary: DrainSummary = { processed: 0, saved: 0, duplicates: 0, rejected: 0, retried: 0, dead: 0 };
  // null = guest scope. A signed-in user only ever claims their own events (the store matches the owner exactly).
  const ownerId: string | null = session?.user?.id?.trim() || null;

  for (;;) {
    const batch = await store.claim(ownerId, BATCH_SIZE, now(), LEASE_MS, MAX_ATTEMPTS);
    if (batch.length === 0) break;
    for (const item of batch) {
      summary.processed += 1;
      let result: SmsProcessResult;
      try {
        result = await processor(
          { sender: item.sender, receivedAt: item.receivedAt, partCount: item.partCount, body: item.body },
          session,
          rules,
        );
      } catch {
        result = { success: false, action: 'error', reason: 'processor_exception' };
      }
      if (result.action === 'saved') { summary.saved += 1; await store.complete(item.id); }
      else if (result.action === 'duplicate_ignored') { summary.duplicates += 1; await store.complete(item.id); }
      else if (result.action === 'unsupported_or_invalid') { summary.rejected += 1; await store.complete(item.id); }
      else if (item.attempts >= MAX_ATTEMPTS) { summary.dead += 1; await store.markDead(item.id, 'max_attempts'); }
      else { summary.retried += 1; await store.scheduleRetry(item.id, result.action === 'held' ? 'no_owner' : 'persist_failed', now() + retryDelayMs(item.attempts)); }
    }
    // Failed items are scheduled in the future, so the next claim cannot return them: no tight retry loop.
  }
  return summary;
}

// ---- Native store binding (lazy so Node tests never import react-native) ----

let nativeStore: SmsStagingStore | null | undefined;

async function getNativeStore(): Promise<SmsStagingStore | null> {
  if (nativeStore === undefined) {
    const mod = await import('../../sms.ts');
    nativeStore = mod.getNativeStagingStore();
  }
  return nativeStore;
}

export async function getStagingStore(): Promise<SmsStagingStore | null> {
  return getNativeStore();
}

export async function drainNativeStagedSms(session: Session | null, rules?: SmsParsingRule[]): Promise<DrainSummary | null> {
  const store = await getNativeStore();
  return store ? drainStagedSms(store, session, rules) : null;
}

export async function recordSmsOwner(userId: string): Promise<void> {
  const store = await getNativeStore();
  await store?.setOwnerHint(userId);
}

/** Guest mode / signed out: new SMS are stamped with no owner so they are processed as local guest transactions. */
export async function clearSmsOwner(): Promise<void> {
  const store = await getNativeStore();
  await store?.clearOwnerHint?.();
}

export async function getStagingCounts(userId: string | null): Promise<StagingCounts | null> {
  const store = await getNativeStore();
  return store ? store.counts(userId) : null;
}

export async function purgeStagedSmsForUser(userId: string): Promise<void> {
  const store = await getNativeStore();
  await store?.purgeOwner(userId);
}
