/**
 * Single-flight session refresher used when a sync request is rejected with HTTP 401 (expired 15-minute access token).
 *
 * Refresh tokens ROTATE server-side: the old one is revoked on use. So (a) concurrent refreshes must share one request,
 * and (b) the caller's captured session may already be stale — the latest stored session is always preferred.
 * Never throws: returns the new session, or null when it could not be refreshed (queue is left untouched by callers).
 */
export interface RefreshableSession {
  access_token: string;
  refresh_token: string;
  user: { id: string };
}

const REJECTION_STATUSES = new Set([400, 401, 403, 422]);

export interface SessionRefresherDeps<S extends RefreshableSession> {
  loadStored: () => Promise<S | null>;
  refresh: (session: S) => Promise<S>; // must persist the new session
  onRefreshed?: (session: S) => void;
  /** The server definitively rejected the refresh token: the user must sign in again. */
  onRejected?: (session: S) => void;
}

export function createSessionRefresher<S extends RefreshableSession>(deps: SessionRefresherDeps<S>) {
  let inflight: Promise<S | null> | null = null;

  return function refresher(stale: S): Promise<S | null> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const stored = await deps.loadStored().catch(() => null);
        if (stored && stored.user.id !== stale.user.id) return null; // never cross accounts
        // Someone else already refreshed: reuse it instead of spending the (rotated) refresh token twice.
        if (stored && stored.access_token !== stale.access_token) return stored;
        const base = stored ?? stale;
        try {
          const next = await deps.refresh(base);
          deps.onRefreshed?.(next);
          return next;
        } catch (err) {
          const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status : undefined;
          if (typeof status === 'number' && REJECTION_STATUSES.has(status)) deps.onRejected?.(base);
          return null;
        }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}
