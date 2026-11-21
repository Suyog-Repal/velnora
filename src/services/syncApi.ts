/**
 * HTTP Client for Velnora Cloud Synchronization endpoints.
 * Operates with plain fetch without native storage dependencies.
 */

export interface SyncApiOptions {
  apiUrl?: string;
  accessToken: string;
}

export class SyncApiError extends Error {
  readonly status?: number;
  readonly kind: 'connection' | 'client' | 'server';

  constructor(message: string, kind: 'connection' | 'client' | 'server', status?: number) {
    super(message);
    this.name = 'SyncApiError';
    this.kind = kind;
    this.status = status;
  }
}

const DEFAULT_API_PORT = 8000;
/** Long enough for a free-tier server to wake up (about a minute), short enough that a dead request cannot block syncing. */
export const SYNC_REQUEST_TIMEOUT_MS = 75_000;
let requestTimeoutMs: number | null = null;
/** Test hook: override the request timeout (null restores the default). */
export function setSyncRequestTimeoutMs(ms: number | null): void {
  requestTimeoutMs = ms;
}

/** Read-only hook for diagnostics: told the HTTP status of every sync request, or "network" / "timeout" when there was none. */
let httpObserver: ((outcome: number | 'network' | 'timeout') => void) | null = null;
export function setSyncHttpObserver(fn: ((outcome: number | 'network' | 'timeout') => void) | null): void { httpObserver = fn; }
const observe = (outcome: number | 'network' | 'timeout'): void => { try { httpObserver?.(outcome); } catch { /* diagnostics never affect syncing */ } };

let configuredBaseUrl: string | null = null;

/** Called once by auth.ts with the app-wide resolved API URL ('' = not configured) so sync never uses a divergent default. */
export function configureApiBaseUrl(url: string): void {
  configuredBaseUrl = url.trim().replace(/\/+$/, '');
}

export function getBaseApiUrl(): string {
  if (configuredBaseUrl !== null) return configuredBaseUrl;
  // Fallback only when auth.ts has not configured the URL (e.g. Node unit tests).
  const env = typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_API_URL : undefined;
  return env?.trim() ? env.trim().replace(/\/+$/, '') : `http://localhost:${DEFAULT_API_PORT}`;
}

async function syncRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST',
  token: string,
  body?: unknown,
  baseUrl?: string,
): Promise<T> {
  const url = `${baseUrl || getBaseApiUrl()}${endpoint}`;
  let response: Response;
  let responseBody: unknown;
  // React Native's Android HTTP client has no read timeout: without this a stalled request (a sleeping server, a network
  // switch mid-request) would keep the sync engine "in progress" forever and every later sync would be skipped.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs ?? SYNC_REQUEST_TIMEOUT_MS) : null;

  try {
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
      });
    } catch (netErr) {
      const timedOut = controller?.signal.aborted === true;
      observe(timedOut ? 'timeout' : 'network');
      throw new SyncApiError(
        timedOut ? 'Synchronization server did not respond in time.' : 'Unable to connect to synchronization server.',
        'connection',
      );
    }
    try {
      responseBody = await response.json();
    } catch {
      if (controller?.signal.aborted) throw new SyncApiError('Synchronization server did not respond in time.', 'connection');
      responseBody = null;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  observe(response.status);
  if (!response.ok) {
    const detail =
      typeof responseBody === 'object' && responseBody !== null && 'detail' in responseBody
        ? String(responseBody.detail)
        : `Sync HTTP ${response.status}`;

    throw new SyncApiError(
      detail,
      response.status >= 500 ? 'server' : 'client',
      response.status,
    );
  }

  return responseBody as T;
}

export function pushSync<T = unknown>(
  token: string,
  batch: unknown,
  baseUrl?: string,
): Promise<T> {
  return syncRequest<T>('/api/v1/sync/push', 'POST', token, batch, baseUrl);
}

export function pullSync<T = unknown>(
  token: string,
  sinceCursor?: string | null,
  limit = 100,
  baseUrl?: string,
): Promise<T> {
  const params: string[] = [];
  if (sinceCursor) params.push(`since_cursor=${encodeURIComponent(sinceCursor)}`);
  if (limit) params.push(`limit=${encodeURIComponent(limit.toString())}`);
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return syncRequest<T>(`/api/v1/sync/pull${qs}`, 'GET', token, undefined, baseUrl);
}

export function getSyncStatus<T = unknown>(
  token: string,
  baseUrl?: string,
): Promise<T> {
  return syncRequest<T>('/api/v1/sync/status', 'GET', token, undefined, baseUrl);
}
