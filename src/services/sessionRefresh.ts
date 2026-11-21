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

/**
 * What a failed refresh means. ONLY a 401 from the refresh endpoint ends the session: it is the server's own answer for "this
 * refresh token is revoked, expired or unknown". Anything else says nothing certain about the token:
 *   rejected      401: sign in again
 *   unverifiable  400 / 403 / 422: the server (or something in front of it, e.g. a proxy or firewall) refused the request
 *                 without judging the token. Keep the session, stay offline-first, and let the person retry or sign in again.
 *   transient     network failure, timeout, 5xx, 429, anything else: keep the session and try again later
 */
export type RefreshFailureKind = 'rejected' | 'unverifiable' | 'transient';

export function refreshFailureKind(err: unknown): RefreshFailureKind {
  const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status : undefined;
  if (status === 401) return 'rejected';
  if (status === 400 || status === 403 || status === 422) return 'unverifiable';
  return 'transient';
}

export interface SessionRefresherDeps<S extends RefreshableSession> {
  loadStored: () => Promise<S | null>;
  refresh: (session: S) => Promise<S>; // must persist the new session
  onRefreshed?: (session: S) => void;
  /** The server answered 401 to the refresh: the user must sign in again. */
  onRejected?: (session: S) => void;
  /** The refresh got 400 / 403 / 422: the session is kept; the app shows "Can't verify your sign-in". */
  onUnverifiable?: (session: S) => void;
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
          const kind = refreshFailureKind(err);
          if (kind === 'rejected') deps.onRejected?.(base);
          else if (kind === 'unverifiable') deps.onUnverifiable?.(base);
          return null;
        }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/**
 * Refresh tokens ROTATE on the server: using one revokes it. Every caller that needs a fresh session (launch restore, the offline
 * retry, a sync that got 401) must come through ONE of these: a single request at a time, and a token that someone else already
 * rotated is never sent again (the stored, newer session is returned without touching the network). Errors keep their HTTP status
 * so the caller can tell a rejected token (sign in again) from a network failure (keep the session, retry later).
 */
export function createSharedRefresh<S extends RefreshableSession>(deps: { loadStored: () => Promise<S | null>; refresh: (session: S) => Promise<S> }) {
  let inflight: { userId: string; promise: Promise<S> } | null = null;
  return function refreshShared(session: S): Promise<S> {
    if (inflight && inflight.userId === session.user.id) return inflight.promise;
    const promise = (async () => {
      const stored = await deps.loadStored().catch(() => null);
      const base = stored && stored.user.id === session.user.id ? stored : session;
      if (base !== session && base.refresh_token !== session.refresh_token) return base; // rotated meanwhile: already fresh
      return deps.refresh(base);
    })().finally(() => { inflight = null; });
    inflight = { userId: session.user.id, promise };
    return promise;
  };
}
