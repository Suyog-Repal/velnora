import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { deleteUserLocalData, getLocalDataSummary } from './src/services/localDataService.ts';
import { purgeStagedSmsForUser } from './src/services/smsStagingService.ts';
import type { AuthUser, Session } from './src/db/types.ts';

export type { AuthUser, Session };
export type SyncTransaction = {
  amount: number;
  direction: 'income' | 'expense';
  counterparty: string;
  category: string;
  description: string;
  reference_id?: string;
};
export type RequestErrorKind = 'connection' | 'client' | 'server';

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

const SESSION_KEY = 'velnora.session.v1';
const DEFAULT_API_PORT = 8000;

function getDefaultApiUrl(): string {
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(':')[0];
  return host ? `http://${host}:${DEFAULT_API_PORT}` : `http://localhost:${DEFAULT_API_PORT}`;
}

export const API_URL = (process.env.EXPO_PUBLIC_API_URL?.trim() || getDefaultApiUrl()).replace(/\/+$/, '');

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export async function loadSession(): Promise<Session | null> {
  const value = await SecureStore.getItemAsync(SESSION_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as Session;
  } catch {
    await clearSession();
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new AuthRequestError('Unable to reach Velnora. Check that the API is running and reachable from this device.', 'connection');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string'
      ? body.detail
      : response.status >= 500
        ? 'Velnora is temporarily unavailable. Try again.'
        : 'Please check the submitted information and try again.';
    throw new AuthRequestError(detail, response.status >= 500 ? 'server' : 'client', response.status);
  }
  return body as T;
}

export function register(fullName: string, email: string, password: string): Promise<Session> {
  return request<Session>('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ full_name: fullName, email, password, terms_accepted: true }) });
}

export function login(email: string, password: string): Promise<Session> {
  return request<Session>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function refreshSession(session: Session): Promise<Session> {
  const next = await request<Session>('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) });
  await saveSession(next);
  return next;
}

/**
 * Returns count of unsynchronized transactions for a given user.
 * Throws on failure (a failed count must never be shown as "0 unsynchronized").
 */
export async function getUnsyncedTransactionCount(userId: string): Promise<number> {
  return (await getLocalDataSummary(userId)).unsyncedCount;
}

/**
 * Explicit user-initiated local data purge for a specific user account.
 * Callers must obtain explicit confirmation after warning about unsynchronized records.
 */
export async function clearUserLocalDataWithWarning(userId: string): Promise<{ cleared: boolean; unsyncedCount: number }> {
  const { cleared, unsyncedCount } = await deleteUserLocalData(userId, undefined, purgeStagedSmsForUser);
  return { cleared, unsyncedCount };
}

export async function clearLocalUserData(): Promise<void> {
  // Deprecated for automatic calls: preserves local records across logouts
}

export async function logout(session: Session): Promise<void> {
  try {
    await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
  } finally {
    await clearSession();
    // Do NOT delete local SQLite records or sync_queue on logout!
    // Unsynchronized SMS and offline transactions are preserved for session.user.id.
  }
}

export function requestPasswordReset(email: string): Promise<{ detail: string }> {
  return request<{ detail: string }>('/api/v1/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
}

export function createTransaction(session: Session, transaction: SyncTransaction): Promise<unknown> {
  return request('/api/v1/transactions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(transaction),
  });
}

import { pushSync, pullSync, getSyncStatus } from './src/services/syncApi.ts';

export function apiPushSync<T = unknown>(session: Session, body: unknown): Promise<T> {
  return pushSync<T>(session.access_token, body, API_URL);
}

export function apiPullSync<T = unknown>(session: Session, sinceCursor?: string | null, limit = 100): Promise<T> {
  return pullSync<T>(session.access_token, sinceCursor, limit, API_URL);
}

export function apiGetSyncStatus<T = unknown>(session: Session): Promise<T> {
  return getSyncStatus<T>(session.access_token, API_URL);
}
