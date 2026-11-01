import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

export type AuthUser = { id: string; full_name: string; email: string };
export type Session = { user: AuthUser; access_token: string; refresh_token: string; token_type: string };
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
  constructor(
    message: string,
    public readonly kind: RequestErrorKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthRequestError';
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

export async function logout(session: Session): Promise<void> {
  try {
    await request('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
  } finally {
    await clearSession();
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
