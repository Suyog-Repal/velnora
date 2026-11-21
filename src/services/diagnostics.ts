/**
 * In-app diagnostics: a small ring buffer of sign-in and sync events the person can copy when reporting a problem.
 * Pure (no React Native imports): persistence is a port the app attaches at start-up, so this is unit-tested in Node.
 *
 * Privacy is enforced HERE, not left to callers. An event is accepted only if its name and every key are on the allow-lists
 * below; every string must be one of a fixed vocabulary for its key (anything else, including a short password-like word, is
 * replaced with "[redacted]"); numbers are accepted only under count-like keys, as whole numbers; histogram keys are HTTP
 * statuses or known error codes (anything else is folded into "other"). A token, a password, an e-mail address, a user id or an amount therefore
 * cannot get through even if a caller passes one by mistake.
 */
export const DIAG_EVENTS = [
  'load_session', 'refresh_start', 'refresh_http', 'save_session_ok', 'save_session_fail', 'session_cleared', 'notice_shown',
  'headless_task', 'sync_cycle', 'app_state', 'network',
] as const;
export type DiagEventName = typeof DIAG_EVENTS[number];

/** key -> the only kind of value it may hold. */
const KEY_KINDS = {
  result: 'str', source: 'str', kind: 'str', site: 'str', notice: 'str', task: 'str', state: 'str', type: 'str', last_error: 'str',
  session_present: 'bool', connected: 'bool',
  status: 'num', retry: 'num', pending: 'num', eligible: 'num', waiting: 'num', failed: 'num', pushed: 'num', pulled: 'num', errors: 'num',
  error_codes: 'hist', http: 'hist',
} as const;
type DiagKey = keyof typeof KEY_KINDS;

export type DiagValue = string | number | boolean | null | Record<string, number>;
export type DiagData = Partial<Record<DiagKey, DiagValue>>;

export interface DiagEntry { t: string; ev: DiagEventName; app?: string; net?: string; d?: Record<string, DiagValue> }

export const DIAG_CAPACITY = 200;
/** The only strings a report can contain, per key. */
const VOCAB: Record<string, ReadonlySet<string>> = {
  result: new Set(['ok', 'missing', 'read_error', 'parse_error', 'invalid_shape']),
  source: new Set(['launch', 'sync401', 'offlineRetry']),
  kind: new Set(['config', 'connection', 'timeout', 'client', 'server', 'unknown']),
  site: new Set(['logout', 'launch_expired', 'sync401_rejected', 'check_sign_in_rejected', 'sign_in_again_notice']),
  notice: new Set(['session_ended', 'saved_sign_in_unreadable', 'no_session', 'cant_verify', 'sign_in_again']),
  task: new Set(['capture_drain', 'review_action', 'daily_checkin']),
  state: new Set(['active', 'background', 'inactive', 'unknown', 'extension']),
  type: new Set(['wifi', 'cellular', 'none', 'unknown', 'ethernet', 'bluetooth', 'vpn', 'wimax', 'other']),
  last_error: new Set(['none', 'unauthorized', 'no_session', 'in_progress', 'rejected', 'network', 'other']),
};
const APP_VERSION = /^[0-9]{1,3}(.[0-9]{1,3}){0,3}$/;
/** Histogram keys: HTTP statuses, the two "no answer" words, and the error codes the server and the sync engine produce. */
const HIST_WORDS = new Set([
  'network', 'timeout',
  'validation_error', 'forbidden', 'missing_fields', 'not_found', 'rejected', 'internal_error',
  'NO_ACK', 'INVALID_RESPONSE', 'MALFORMED_PAYLOAD', 'TEMPORARY_SERVER_ERROR', 'UNAUTHORIZED', 'other',
]);
const isHistKey = (key: string): boolean => /^[1-5][0-9]{2}$/.test(key) || /^(PERMANENT_ERROR|VALIDATION_FAILED)_[1-5][0-9]{2}$/.test(key) || HIST_WORDS.has(key);
const REDACTED = '[redacted]';

const inVocab = (key: string, value: unknown): string => (typeof value === 'string' && VOCAB[key]?.has(value) ? value : REDACTED);

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 ? Math.trunc(value) : null;
}

/** Histogram of counts keyed by short identifiers; any other key (free text, a message) is folded into "other". */
function safeHistogram(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    const n = safeNumber(count);
    if (n === null) continue;
    const name = isHistKey(key) ? key : 'other';
    out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

export function sanitizeData(data: Record<string, unknown> | undefined): Record<string, DiagValue> | undefined {
  if (!data) return undefined;
  const out: Record<string, DiagValue> = {};
  for (const [key, value] of Object.entries(data)) {
    const kind = (KEY_KINDS as Record<string, string>)[key];
    if (!kind || value === undefined) continue; // unknown keys are dropped, never stored
    if (value === null) { out[key] = null; continue; }
    if (kind === 'str') out[key] = inVocab(key, value);
    else if (kind === 'bool') { if (typeof value === 'boolean') out[key] = value; }
    else if (kind === 'num') { const n = safeNumber(value); if (n !== null) out[key] = n; }
    else { const h = safeHistogram(value); if (h) out[key] = h; }
  }
  return Object.keys(out).length ? out : undefined;
}

export interface DiagnosticsPort {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface DiagnosticsOptions {
  capacity?: number;
  now?: () => Date;
  /** Runs `fn` after `ms`, returns a cancel function. Default: setTimeout (unref'd). */
  schedule?: (fn: () => void, ms: number) => () => void;
  writeDelayMs?: number;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

const formatValue = (value: DiagValue): string => (typeof value === 'object' && value !== null
  ? `{${Object.entries(value).map(([k, v]) => `${k}:${v}`).join(',')}}`
  : String(value));

export function createDiagnostics(options: DiagnosticsOptions = {}) {
  const capacity = options.capacity ?? DIAG_CAPACITY;
  const now = options.now ?? (() => new Date());
  const schedule = options.schedule ?? defaultSchedule;
  const writeDelayMs = options.writeDelayMs ?? 400;

  let entries: DiagEntry[] = [];
  let port: DiagnosticsPort | null = null;
  let cancelWrite: (() => void) | null = null;
  let context: { app?: string; net?: string } = {};

  const trim = () => { if (entries.length > capacity) entries = entries.slice(entries.length - capacity); };

  function queueWrite(): void {
    if (!port || cancelWrite) return;
    cancelWrite = schedule(() => { cancelWrite = null; void flush(); }, writeDelayMs);
  }

  async function flush(): Promise<void> {
    cancelWrite?.(); cancelWrite = null;
    if (!port) return;
    try { await port.write(JSON.stringify(entries)); } catch { /* diagnostics must never break the app */ }
  }

  function validEntry(value: unknown): DiagEntry | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.t !== 'string' || Number.isNaN(Date.parse(v.t)) || !DIAG_EVENTS.includes(v.ev as DiagEventName)) return null;
    // Re-sanitised on the way in, so a tampered or old stored file cannot smuggle anything into a report.
    return { t: v.t, ev: v.ev as DiagEventName, app: v.app === undefined ? undefined : inVocab('state', v.app), net: v.net === undefined ? undefined : inVocab('type', v.net), d: sanitizeData(v.d as Record<string, unknown> | undefined) };
  }

  return {
    /** Records one event. Never throws; anything not on the allow-lists is dropped or redacted. */
    record(ev: DiagEventName, data?: DiagData): void {
      try {
        if (!DIAG_EVENTS.includes(ev)) return;
        entries.push({ t: now().toISOString(), ev, app: context.app, net: context.net, d: sanitizeData(data as Record<string, unknown> | undefined) });
        trim();
        queueWrite();
      } catch { /* never break the caller */ }
    },

    /** App state and network type stamped on the events that follow. Only the known words are kept. */
    setContext(next: { app?: string; net?: string }): void {
      context = { app: next.app === undefined ? context.app : inVocab('state', next.app), net: next.net === undefined ? context.net : inVocab('type', next.net) };
    },

    /** Attaches storage: earlier runs' events come first, then this run's, newest last, capped. */
    async attach(storage: DiagnosticsPort): Promise<void> {
      port = storage;
      try {
        const raw = await storage.read();
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        const previous = Array.isArray(parsed) ? parsed.map(validEntry).filter((e): e is DiagEntry => e !== null) : [];
        entries = [...previous, ...entries];
        trim();
      } catch { /* unreadable history: start from this run */ }
      queueWrite();
    },

    flush,
    entries: (): DiagEntry[] => entries.map((e) => ({ ...e })),
    async clear(): Promise<void> { entries = []; await flush(); },

    /** The text the person copies. Plain lines, one per event. */
    format(header: { app?: string } = {}): string {
      const lines = [
        'Velnora diagnostics',
        `generated: ${now().toISOString()}`,
        ...(header.app ? [`app: ${APP_VERSION.test(header.app) ? header.app : REDACTED}`] : []),
        `events: ${entries.length} (keeps the last ${capacity})`,
        'Contains event names, times, status codes and counts only: no tokens, passwords, e-mail addresses, account ids or amounts.',
        '---',
        ...entries.map((e) => {
          const ctx = [e.app ? `app=${e.app}` : '', e.net ? `net=${e.net}` : ''].filter(Boolean).join(' ');
          const data = e.d ? Object.entries(e.d).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ') : '';
          return [e.t, ctx, e.ev, data].filter(Boolean).join(' ');
        }),
      ];
      return lines.join('\n');
    },
  };
}

/** The app-wide log. Events recorded before storage is attached are kept and merged when it is. */
export const diagnostics = createDiagnostics();
export const diag = (ev: DiagEventName, data?: DiagData): void => diagnostics.record(ev, data);
