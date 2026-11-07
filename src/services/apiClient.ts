/**
 * HTTP core for the Velnora auth API. Pure (no React Native imports) so it is unit-tested in Node with a fake fetch.
 *
 * Failure kinds are reported separately so the UI never says "unable to reach" when the real problem is different:
 *   config      this build has no server address (EXPO_PUBLIC_API_URL was not set when it was built)
 *   connection  the request never got a response (offline, DNS, TLS, server down)
 *   timeout     no response within the timeout (e.g. a sleeping free-tier server still waking up)
 *   client      the server answered 4xx (validation, wrong password, duplicate e-mail, ...)
 *   server      the server answered 5xx, or answered with something that is not a Velnora response
 *
 * Diagnostics: one log line per request with the method, URL, status, duration and failure class. They NEVER contain
 * request bodies, passwords, tokens, the Authorization header, or the `input` echo FastAPI puts in validation errors.
 */
export type RequestErrorKind = 'config' | 'connection' | 'timeout' | 'client' | 'server';

export class AuthRequestError extends Error {
  readonly kind: RequestErrorKind;
  readonly status?: number;

  constructor(message: string, kind: RequestErrorKind, status?: number) {
    super(message);
    this.name = 'AuthRequestError';
    this.kind = kind;
    this.status = status;
  }
}

/** The existing backend routes (backend/app/main.py). */
export const AUTH_PATHS = {
  register: '/api/v1/auth/register',
  login: '/api/v1/auth/login',
  refresh: '/api/v1/auth/refresh',
  logout: '/api/v1/auth/logout',
  forgotPassword: '/api/v1/auth/forgot-password',
} as const;

/** A sleeping free-tier Render instance took ~35 s to answer its first request, so wait longer than that before giving up. */
export const REQUEST_TIMEOUT_MS = 70_000;

export const MESSAGES = {
  config: 'This build of Velnora has no server address configured, so it cannot sign in or create accounts. Install the latest build.',
  connection: 'Unable to reach Velnora. Check your internet connection and try again.',
  timeout: "Velnora's server did not respond in time. It may be starting up: wait a few seconds and try again.",
  starting: "Velnora's server is starting up. Please try again in a moment.",
  unavailable: 'Velnora is temporarily unavailable. Try again.',
  generic4xx: 'Please check the submitted information and try again.',
  unexpected: 'Velnora returned an unexpected response. Make sure this app is pointed at the right server.',
} as const;

export interface ApiClientOptions {
  /** Base URL without a trailing slash; '' means "not configured". */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (level: 'info' | 'warn', line: string) => void;
  now?: () => number;
}

const defaultLog = (level: 'info' | 'warn', line: string): void => { (level === 'warn' ? console.warn : console.log)(line); };
const clip = (text: string, max = 140): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Human-readable server error. FastAPI sends `{"detail": "text"}` for our own errors and `{"detail": [{loc, msg, input, ...}]}`
 * for request validation: for the latter only "field: message" is used (never `input`, which echoes what the user typed).
 */
export function readErrorDetail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('detail' in body)) return null;
  const detail = (body as { detail: unknown }).detail;
  if (typeof detail === 'string') return detail.trim() || null;
  if (Array.isArray(detail)) {
    for (const item of detail) {
      if (typeof item !== 'object' || item === null) continue;
      const { loc, msg } = item as { loc?: unknown; msg?: unknown };
      if (typeof msg !== 'string') continue;
      const field = Array.isArray(loc) ? [...loc].reverse().find((part) => typeof part === 'string' && part !== 'body') : undefined;
      const text = msg.replace(/^Value error,\s*/i, '');
      return field ? `${String(field)}: ${text}` : text;
    }
  }
  return null;
}

export async function apiRequest<T>(options: ApiClientOptions, path: string, init: RequestInit = {}): Promise<T> {
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const method = (init.method ?? 'GET').toUpperCase();

  if (!options.baseUrl) {
    log('warn', `[Velnora API] ${method} ${path} not sent: no server address (EXPO_PUBLIC_API_URL) was configured when this build was made`);
    throw new AuthRequestError(MESSAGES.config, 'config');
  }

  const url = `${options.baseUrl}${path}`;
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const reason = error instanceof Error ? `${error.name}: ${clip(error.message, 100)}` : 'unknown error';
    log('warn', `[Velnora API] ${method} ${url} -> no response (${timedOut ? 'timeout' : 'network failure'}: ${reason}) after ${now() - started} ms`);
    throw new AuthRequestError(timedOut ? MESSAGES.timeout : MESSAGES.connection, timedOut ? 'timeout' : 'connection');
  } finally {
    clearTimeout(timer);
  }

  const body: unknown = await response.json().catch(() => null);
  const took = now() - started;
  if (!response.ok) {
    const detail = readErrorDetail(body);
    const kind: RequestErrorKind = response.status >= 500 ? 'server' : 'client';
    const message = detail
      ?? ([502, 503, 504].includes(response.status) ? MESSAGES.starting : response.status >= 500 ? MESSAGES.unavailable : MESSAGES.generic4xx);
    log('warn', `[Velnora API] ${method} ${url} -> HTTP ${response.status} (${kind} error) in ${took} ms${detail ? `: "${clip(detail)}"` : ' (no error message in the response)'}`);
    throw new AuthRequestError(message, kind, response.status);
  }
  log('info', `[Velnora API] ${method} ${url} -> HTTP ${response.status} in ${took} ms`);
  return body as T;
}

/** Register / login / refresh must answer with a session; anything else means the app is talking to the wrong thing. */
export function expectSession<T extends { access_token: string; refresh_token: string; user: { id: string } }>(body: unknown): T {
  const ok = typeof body === 'object' && body !== null
    && typeof (body as { access_token?: unknown }).access_token === 'string'
    && typeof (body as { refresh_token?: unknown }).refresh_token === 'string'
    && typeof (body as { user?: { id?: unknown } }).user?.id === 'string';
  if (!ok) throw new AuthRequestError(MESSAGES.unexpected, 'server');
  return body as T;
}

/** Exactly the fields backend/app/auth.py RegisterRequest declares. */
export function registerBody(fullName: string, email: string, password: string) {
  return { full_name: fullName, email, password, terms_accepted: true as const };
}
