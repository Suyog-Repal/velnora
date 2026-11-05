import type { SmsStagingStore } from './smsStagingTypes.ts';

/** Counts only: never SMS bodies, senders, amounts or other users' identities. */
export interface SmsStagingStatus {
  /** false when SMS staging is not available on this platform/build. */
  available: boolean;
  dead: number;
  heldForOtherAccounts: number;
  ownerless: number;
  /** true when every count is zero (drives the empty state). */
  isEmpty: boolean;
}

const UNAVAILABLE: SmsStagingStatus = { available: false, dead: 0, heldForOtherAccounts: 0, ownerless: 0, isEmpty: true };

export async function loadSmsStagingStatus(store: SmsStagingStore | null, userId: string): Promise<SmsStagingStatus> {
  if (!store) return UNAVAILABLE;
  const c = await store.counts(userId);
  return {
    available: true,
    dead: c.dead,
    heldForOtherAccounts: c.heldForOthers,
    ownerless: c.ownerless,
    isEmpty: c.dead + c.heldForOthers + c.ownerless === 0,
  };
}
