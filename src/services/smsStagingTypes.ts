/** Durable native staging of SMS events (lifecycle: STAGED → PROCESSING → COMPLETED | RETRY | DEAD). */
export type StagedSmsState = 'STAGED' | 'PROCESSING' | 'RETRY' | 'COMPLETED' | 'DEAD';

export interface StagedSms {
  id: number;
  sender: string;
  body: string;
  receivedAt: number;
  partCount: number;
  attempts: number;
  /** Channel that produced the event; absent on older native builds = 'sms'. For notifications `sender` is the title. */
  source?: 'sms' | 'truecaller_notification' | 'payment_notification';
  /** Display name of the app that posted a notification ("Google Pay"); absent for SMS. */
  sourceApp?: string | null;
}

export interface StagingCounts {
  /** Events owned by the requested user that still need processing (STAGED/PROCESSING/RETRY). */
  pending: number;
  /** Events given up on after repeated failure (retained for recovery). */
  dead: number;
  /** Pending events stamped with a different user; never processed under this account. */
  heldForOthers: number;
  /** Pending events with no owner (received in guest mode / before any sign-in); processed in guest mode, never adopted by an account. */
  ownerless: number;
}

export interface SmsStagingStore {
  /** Remember which user the device's SMS belong to; new events are stamped with it at receive time. */
  setOwnerHint(userId: string): Promise<void>;
  /**
   * Forget the owner hint (guest mode / signed out): new events are then stamped with NO owner, which is the guest
   * scope. Events already stamped with an account stay held for that account.
   */
  clearOwnerHint?(): Promise<void>;
  /**
   * Atomically lease up to `limit` events owned by `ownerUserId` that are due.
   * `null` is the guest scope (events with no owner). Guest events become local-only guest transactions.
   * Increments `attempts` (so a crash mid-processing still counts), reclaims expired leases,
   * and moves events whose attempts already reached `maxAttempts` to DEAD instead of returning them.
   */
  claim(ownerUserId: string | null, limit: number, nowMs: number, leaseMs: number, maxAttempts: number): Promise<StagedSms[]>;
  /** Terminal success/rejection: wipes the body, keeps a body-less dedupe tombstone. */
  complete(id: number): Promise<void>;
  scheduleRetry(id: number, errorCode: string, nextRetryAtMs: number): Promise<void>;
  markDead(id: number, errorCode: string): Promise<void>;
  counts(ownerUserId: string | null): Promise<StagingCounts>;
  /** Delete every staged event stamped with this owner (explicit local data deletion only). */
  purgeOwner(ownerUserId: string): Promise<void>;
}
