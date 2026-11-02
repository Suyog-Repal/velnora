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

export function getBaseApiUrl(): string {
  if (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/+$/, '');
  }
  return `http://localhost:${DEFAULT_API_PORT}`;
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

  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (netErr) {
    throw new SyncApiError(
      'Unable to connect to synchronization server.',
      'connection',
    );
  }

  const responseBody = await response.json().catch(() => null);

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
