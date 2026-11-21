import type { IDatabase } from '../db/types.ts';
import { SyncQueueRepository } from '../db/repositories/syncQueueRepository.ts';
import { diag } from './diagnostics.ts';
import { setSyncHttpObserver } from './syncApi.ts';

/**
 * One diagnostics line per sync cycle: how many queue items are pending / eligible now / waiting for a retry time / parked as
 * failed, a histogram of their error codes and one of the HTTP statuses the cycle's requests got. Read-only: it never changes the
 * queue or the retry rules. Only counts and short codes leave this file (diagnostics.ts refuses anything else).
 */
const PERMANENT_FAILURE_DATE = '9999-12-31T23:59:59Z';

export interface QueueRow { next_retry_at: string | null; error_code: string | null }
export interface QueueCounts { pending: number; eligible: number; waiting: number; failed: number; error_codes: Record<string, number> }

/** Pure. `failed` = parked for good, `waiting` = has a future retry time, `eligible` = would be sent now. Their sum is `pending`. */
export function summarizeQueue(items: QueueRow[], nowIso: string): QueueCounts {
  const out: QueueCounts = { pending: items.length, eligible: 0, waiting: 0, failed: 0, error_codes: {} };
  for (const item of items) {
    if (item.next_retry_at === PERMANENT_FAILURE_DATE) out.failed += 1;
    else if (item.next_retry_at && item.next_retry_at > nowIso) out.waiting += 1;
    else out.eligible += 1;
    if (item.error_code) out.error_codes[item.error_code] = (out.error_codes[item.error_code] ?? 0) + 1; // long messages become "other" in diagnostics.ts
  }
  return out;
}

/** A short class for the cycle's first error, never its text (messages can echo server details). */
export function classifyCycleError(errors: string[]): string {
  const first = errors[0];
  if (!first) return 'none';
  if (/^UNAUTHORIZED|status 401|Invalid or expired session/i.test(first)) return 'unauthorized';
  if (/No active session/i.test(first)) return 'no_session';
  if (/already in progress/i.test(first)) return 'in_progress';
  if (/VALIDATION_FAILED|rejected by server/i.test(first)) return 'rejected';
  if (/respond in time|connect/i.test(first)) return 'network';
  return 'other';
}

/** Statuses seen since the last cycle report: "200", "401", "500", or "network" / "timeout" when there was no answer. */
let tally: Record<string, number> = {};
let installed = false;
export function installSyncHttpTally(): void {
  if (installed) return;
  installed = true;
  setSyncHttpObserver((outcome) => { const key = String(outcome); tally[key] = (tally[key] ?? 0) + 1; });
}
export function takeHttpTally(): Record<string, number> { const t = tally; tally = {}; return t; }

export async function recordSyncCycle(db: IDatabase, summary: { pushed: number; pulled: number; errors: string[] }, userId: string | null | undefined): Promise<void> {
  const http = takeHttpTally();
  let counts: QueueCounts | null = null;
  try { counts = summarizeQueue(await new SyncQueueRepository(db).peek(5000, userId ?? undefined), new Date().toISOString()); } catch { /* counts are best effort */ }
  diag('sync_cycle', {
    ...(counts ? { pending: counts.pending, eligible: counts.eligible, waiting: counts.waiting, failed: counts.failed, error_codes: counts.error_codes } : {}),
    http, pushed: summary.pushed, pulled: summary.pulled, errors: summary.errors.length, last_error: classifyCycleError(summary.errors),
  });
}
