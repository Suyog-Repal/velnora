import type { Session } from '../db/types.ts';
import { applyNotificationCategory, type QuickCategoryResult } from './transactionService.ts';

/**
 * Applies the category choices made on notification buttons. The native receiver wrote each choice to a durable
 * queue first; here it is leased, applied to the ledger and only then completed, so a crash at any point leaves it
 * queued. Running twice (headless task, then app open) is harmless.
 */
export interface PendingReviewAction { id: number; transactionId: string; category: string }

export interface ReviewActionStore {
  claim(limit: number, nowMs: number, leaseMs: number): Promise<PendingReviewAction[]>;
  complete(id: number): Promise<void>;
  /** Keep it queued for a later drain. */
  release(id: number): Promise<void>;
}

export interface ReviewActionDrainSummary { applied: number; dropped: number; deferred: number; failed: number }

export const REVIEW_ACTION_BATCH = 25;
export const REVIEW_ACTION_LEASE_MS = 60_000;

type Apply = (id: string, category: string, session: Session | null) => Promise<QuickCategoryResult>;

let tail: Promise<unknown> = Promise.resolve();

/** Serialized: overlapping triggers (headless task and app open) never apply the same row concurrently. */
export function drainReviewActions(
  store: ReviewActionStore, session: Session | null, options: { apply?: Apply; now?: () => number } = {},
): Promise<ReviewActionDrainSummary> {
  const run = tail.then(() => drainOnce(store, session, options));
  tail = run.catch(() => undefined);
  return run;
}

async function drainOnce(store: ReviewActionStore, session: Session | null, options: { apply?: Apply; now?: () => number }): Promise<ReviewActionDrainSummary> {
  const apply = options.apply ?? applyNotificationCategory;
  const now = options.now ?? Date.now;
  const summary: ReviewActionDrainSummary = { applied: 0, dropped: 0, deferred: 0, failed: 0 };
  for (;;) {
    const batch = await store.claim(REVIEW_ACTION_BATCH, now(), REVIEW_ACTION_LEASE_MS);
    if (batch.length === 0) break;
    let progressed = false;
    for (const action of batch) {
      try {
        const result = await apply(action.transactionId, action.category, session);
        if (result === 'other_scope') { summary.deferred += 1; await store.release(action.id); continue; }
        await store.complete(action.id);
        progressed = true;
        if (result === 'applied') summary.applied += 1; else summary.dropped += 1;
      } catch {
        // A leased row comes back after its lease; attempts are capped natively, so this cannot loop forever.
        summary.failed += 1;
      }
    }
    // Released or failed rows are returned by the next claim; stop rather than spin on them.
    if (!progressed) break;
  }
  return summary;
}
