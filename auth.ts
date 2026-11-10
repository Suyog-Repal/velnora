import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { deleteUserLocalData, getLocalDataSummary } from './src/services/localDataService.ts';
import { purgeStagedSmsForUser } from './src/services/smsStagingService.ts';
import type { AuthUser, Session } from './src/db/types.ts';
import { resolveApiUrl } from './src/services/apiConfig.ts';
import { createSharedRefresh } from './src/services/sessionRefresh.ts';
import { AUTH_PATHS, AuthRequestError, apiRequest, expectSession, registerBody, type RequestErrorKind } from './src/services/apiClient.ts';

export type { AuthUser, Session };
export type SyncTransaction = {
  amount: number;
  direction: 'income' | 'expense';
  counterparty: string;
  category: string;
  description: string;
  reference_id?: string;
};
export { AuthRequestError, type RequestErrorKind };

const SESSION_KEY = 'velnora.session.v1';

/**
 * The single place the backend URL is decided (rules in src/services/apiConfig.ts):
 * `EXPO_PUBLIC_API_URL` (inlined at build time) → Expo dev-server host in development → cloud sync disabled in a
 * release build that has no URL. Auth, sync, receipts and every other caller share this value.
 */
const apiResolution = resolveApiUrl({
  envUrl: process.env.EXPO_PUBLIC_API_URL,
  hostUri: Constants.expoConfig?.hostUri,
  isDev: typeof __DEV__ !== 'undefined' && __DEV__,
});
export const API_URL = apiResolution.url;
/** Non-null when the API URL is missing/invalid for this build (also logged once at start-up). */
export const API_CONFIG_PROBLEM = apiResolution.problem;
if (apiResolution.problem) console.warn(`[Velnora] ${apiResolution.problem}`);
configureApiBaseUrl(API_URL); // sync requests that pass no explicit URL now use this same value

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

// One log line at start-up says where this build will send requests (the host is not a secret; no credentials are involved).
console.log(`[Velnora API] base URL: ${API_URL || '(not configured)'} (source: ${apiResolution.source})`);

/** All auth calls go through the shared client: failures are classified (config / connection / timeout / 4xx / 5xx) and logged safely. */
function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiRequest<T>({ baseUrl: API_URL }, path, init);
}

export async function register(fullName: string, email: string, password: string): Promise<Session> {
  return expectSession<Session>(await request<unknown>(AUTH_PATHS.register, { method: 'POST', body: JSON.stringify(registerBody(fullName, email, password)) }));
}

export async function login(email: string, password: string): Promise<Session> {
  return expectSession<Session>(await request<unknown>(AUTH_PATHS.login, { method: 'POST', body: JSON.stringify({ email, password }) }));
}

export async function refreshSession(session: Session): Promise<Session> {
  const next = expectSession<Session>(await request<unknown>(AUTH_PATHS.refresh, { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) }));
  await saveSession(next);
  return next;
}

/**
 * Refresh tokens ROTATE on the server: the old one is revoked the moment it is used. Three callers need a fresh session (launch
 * restore, the offline retry, a sync that got 401) and they used to call refreshSession separately, so two of them could spend the
 * same token, the loser got "revoked" (401), and that was read as "the session ended". Every caller must come through here:
 * one request at a time, and a token that was already rotated by someone else is never sent again (the stored session wins).
 * Errors keep their HTTP status so callers can tell a rejected token from a network failure.
 */
export const refreshSessionShared = createSharedRefresh<Session>({ loadStored: loadSession, refresh: refreshSession });

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
    await request(AUTH_PATHS.logout, {
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
  return request<{ detail: string }>(AUTH_PATHS.forgotPassword, { method: 'POST', body: JSON.stringify({ email }) });
}

export function createTransaction(session: Session, transaction: SyncTransaction): Promise<unknown> {
  return request('/api/v1/transactions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(transaction),
  });
}

import { pushSync, pullSync, getSyncStatus, configureApiBaseUrl } from './src/services/syncApi.ts';

export function apiPushSync<T = unknown>(session: Session, body: unknown): Promise<T> {
  return pushSync<T>(session.access_token, body, API_URL);
}

export function apiPullSync<T = unknown>(session: Session, sinceCursor?: string | null, limit = 100): Promise<T> {
  return pullSync<T>(session.access_token, sinceCursor, limit, API_URL);
}

export function apiGetSyncStatus<T = unknown>(session: Session): Promise<T> {
  return getSyncStatus<T>(session.access_token, API_URL);
}
