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

export interface SessionStoreOptions {
  /** Runs `fn` after `ms` and returns a cancel function. Default: setTimeout (unref'd so it never keeps Node alive in tests). */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Delay before retry number `attempt` (1-based). Default: 1 s, 2 s, 4 s ... capped at 60 s. */
  backoffMs?: (attempt: number) => number;
  /** Diagnostics hook: event names only, never the session. */
  onEvent?: (event: 'save_session_ok' | 'save_session_fail', detail?: { retry?: number }) => void;
}

export const defaultBackoffMs = (attempt: number): number => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

export function createSessionStore<S>(port: SessionStorePort, options: SessionStoreOptions = {}) {
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

    /** The in-memory session while a write is pending, otherwise what storage holds. */
    async load(): Promise<S | null> {
      if (pending) return pending;
      const value = await port.read();
      if (!value) return null;
      try {
        return JSON.parse(value) as S;
      } catch {
        await port.remove();
        return null;
      }
    },

    async clear(): Promise<void> {
      stopRetrying();
      pending = null;
      await port.remove();
    },
  };
}
