import type { Session } from '../db/types.ts';
import { drainReviewActions, type ReviewActionDrainSummary } from './reviewActionDrain.ts';

/** Lazy native binding so Node tests importing reviewActionDrain never load react-native. */
export async function drainNativeReviewActions(session: Session | null): Promise<ReviewActionDrainSummary | null> {
  const store = (await import('../../sms.ts')).getNativeReviewActionStore();
  return store ? drainReviewActions(store, session) : null;
}
