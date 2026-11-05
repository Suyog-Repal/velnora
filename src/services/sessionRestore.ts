import type { Session } from '../db/types.ts';

export type RestoreStatus = 'refreshed' | 'offline' | 'expired';
export interface RestoreResult { session: Session | null; status: RestoreStatus }

/** Server answers that definitively mean "this refresh token is no longer valid". */
const REJECTION_STATUSES = new Set([400, 401, 403, 422]);

/**
 * Restores a stored session at launch without destroying it on a transient failure.
 * - refresh succeeds            -> new session
 * - network / 5xx / unknown     -> keep the stored session (local data stays usable; refresh is retried later)
 * - server rejects the token    -> session ended (caller clears tokens only; local data is never touched)
 */
export async function restoreSession(stored: Session, refresh: (s: Session) => Promise<Session>): Promise<RestoreResult> {
  try {
    return { session: await refresh(stored), status: 'refreshed' };
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status : undefined;
    if (typeof status === 'number' && REJECTION_STATUSES.has(status)) return { session: null, status: 'expired' };
    return { session: stored, status: 'offline' };
  }
}
