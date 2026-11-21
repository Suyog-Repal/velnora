import type { Session } from '../db/types.ts';
import { refreshFailureKind } from './sessionRefresh.ts';

export type RestoreStatus = 'refreshed' | 'offline' | 'unverified' | 'expired';
export interface RestoreResult { session: Session | null; status: RestoreStatus }

/**
 * Restores a stored session at launch without destroying it on a transient failure.
 * - refresh succeeds            -> new session
 * - network / 5xx / unknown     -> keep the stored session (local data stays usable; refresh is retried later)
 * - 401 from the refresh        -> session ended (caller clears tokens only; local data is never touched)
 * - 400 / 403 / 422             -> 'unverified': keep the stored session (the server did not judge the token); the app tells the person
 */
export async function restoreSession(stored: Session, refresh: (s: Session) => Promise<Session>): Promise<RestoreResult> {
  try {
    return { session: await refresh(stored), status: 'refreshed' };
  } catch (err) {
    const kind = refreshFailureKind(err);
    if (kind === 'rejected') return { session: null, status: 'expired' };
    return { session: stored, status: kind === 'unverifiable' ? 'unverified' : 'offline' };
  }
}
