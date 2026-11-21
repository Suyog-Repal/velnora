/**
 * Where the signed-in session lives, and what happens when writing it fails. Pure (no React Native / Expo imports): the
 * secure-store calls are passed in as a port, so the behaviour is unit-tested in Node.
 *
 * Refresh tokens ROTATE on the server: once it answers a refresh, the old token is (almost) useless and the NEW pair is the
 * only way to stay signed in. If writing that pair to secure storage fails (a Keystore hiccup), dropping it would lose the
 * session on the next launch. So a session the server already issued is kept in memory for this run, the write is retried
 * with backoff, and \`load\` returns the in-memory copy until it has been written. It is never discarded.
 *
 * Limit: if the app process dies before a retry succeeds, the unsaved pair is lost with it; the server's 60-second reuse
 * grace on the OLD token is the second line of defence for that case.
 */
export interface SessionStorePort {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

/** What reading the stored session found. Only 'ok' carries a session; the rest tell the app which notice to show. */
export type LoadResult<S> =
  | { status: 'ok'; session: S }
  | { status: 'missing' }      // nothing stored (first run, signed out, or a reinstall / restore that did not bring it back)
  | { status: 'read_error' }   // secure storage could not be read (Keystore not ready / failing); the stored value is untouched
  | { status: 'parse_error' }  // something is stored but is not JSON
  | { status: 'invalid_shape' }; // valid JSON that is not a complete session

export type LoadStatus = LoadResult<unknown>['status'];

/** A complete signed-in session: the app reads user.full_name and sends both tokens, so every one of these must be present. */
export function isValidSession(value: unknown): value is { user: { id: string; full_name: string; email: string }; access_token: string; refresh_token: string; token_type?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const user = v.user as Record<string, unknown> | null | undefined;
  const text = (x: unknown): x is string => typeof x === 'string';
  return typeof user === 'object' && user !== null
    && text(user.id) && user.id.length > 0 && text(user.full_name) && text(user.email)
    && text(v.access_token) && v.access_token.length > 0
    && text(v.refresh_token) && v.refresh_token.length > 0
    && (v.token_type === undefined || text(v.token_type));
}

export interface SessionStoreOptions<S = unknown> {
  /** Checks the parsed value is a complete session. Without it any parsed JSON is accepted. */
  validate?: (value: unknown) => value is S;
  /** Runs `fn` after `ms` and returns a cancel function. Default: setTimeout (unref'd so it never keeps Node alive in tests). */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Delay before retry number `attempt` (1-based). Default: 1 s, 2 s, 4 s ... capped at 60 s. */
  backoffMs?: (attempt: number) => number;
  /** Diagnostics hook: event names only, never the session. */
  onEvent?: (event: 'save_session_ok' | 'save_session_fail' | 'load_session', detail?: { retry?: number; result?: LoadStatus }) => void;
}

export const defaultBackoffMs = (attempt: number): number => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

export function createSessionStore<S>(port: SessionStorePort, options: SessionStoreOptions<S> = {}) {
  const schedule = options.schedule ?? defaultSchedule;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const emit = options.onEvent ?? (() => undefined);

  /** A session the server issued that could not be written yet. It outranks whatever is in storage. */
  let pending: S | null = null;
  let cancelRetry: (() => void) | null = null;
  let attempt = 0;
  let writing = false;

  const stopRetrying = () => { cancelRetry?.(); cancelRetry = null; attempt = 0; };

  async function tryWritePending(): Promise<boolean> {
    if (!pending || writing) return !pending;
    writing = true;
    const snapshot = pending;
    try {
      await port.write(JSON.stringify(snapshot));
      emit('save_session_ok', attempt > 0 ? { retry: attempt } : undefined);
      if (pending === snapshot) { pending = null; stopRetrying(); } // a newer pending session keeps retrying
      return true;
    } catch {
      emit('save_session_fail', { retry: attempt });
      return false;
    } finally {
      writing = false;
    }
  }

  function scheduleRetry(): void {
    cancelRetry?.();
    attempt += 1;
    cancelRetry = schedule(() => {
      cancelRetry = null;
      void tryWritePending().then(() => { if (pending) scheduleRetry(); }); // still unwritten (or a newer one arrived): back off further
    }, backoffMs(attempt));
  }

  /**
   * Reads the session and says what it found. NEVER deletes or rewrites what is stored, whatever it finds: a failed read or
   * an odd-looking value is not proof the session is gone (and a background task must never be the one to end it). Only
   * `clear` (sign-out, a 401) removes it, and signing in again overwrites it.
   * The in-memory session wins while a write is pending.
   */

  async function loadDetailed(): Promise<LoadResult<S>> {
    const done = (result: LoadResult<S>): LoadResult<S> => { emit('load_session', { result: result.status }); return result; };
    if (pending) return done({ status: 'ok', session: pending });
    let value: string | null;
    try { value = await port.read(); } catch { return done({ status: 'read_error' }); }
    if (!value) return done({ status: 'missing' });
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return done({ status: 'parse_error' }); }
    if (options.validate && !options.validate(parsed)) return done({ status: 'invalid_shape' });
    return done({ status: 'ok', session: parsed as S });
  }

  return {
    /** Login / sign-up: a failed write is reported to the caller (nothing has been lost; the person can sign in again). */
    async save(session: S): Promise<void> {
      stopRetrying();
      pending = null;
      await port.write(JSON.stringify(session));
      emit('save_session_ok');
    },

    /** After a SUCCESSFUL refresh: the tokens are already issued, so a failed write keeps them in memory and retries. */
    async persistIssued(session: S): Promise<'saved' | 'deferred'> {
      pending = session;
      if (await tryWritePending()) return 'saved';
      if (pending === session) scheduleRetry();
      return 'deferred';
    },

    /** Tries the deferred write again now (e.g. when the app returns to the foreground). */
    async flushPending(): Promise<boolean> {
      if (!pending) return true;
      const done = await tryWritePending();
      if (!done && pending && !cancelRetry) scheduleRetry();
      return done;
    },

    hasPending: (): boolean => pending !== null,

    loadDetailed,

    async load(): Promise<S | null> {
      const result = await loadDetailed();
      return result.status === 'ok' ? result.session : null;
    },

    async clear(): Promise<void> {
      stopRetrying();
      pending = null;
      await port.remove();
    },
  };
}
