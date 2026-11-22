/**
 * Local display name ("What should we call you?"). Stored in the existing app_metadata key-value table, so there is no new
 * schema: the table is created idempotently by the migrations and a missing key simply means "no name yet".
 * Never sent to the server.
 */
import type { IDatabase } from '../db/types.ts';

export const DISPLAY_NAME_KEY = 'profile_display_name';
export const NAME_PROMPTED_KEY = 'guest_name_prompted';
export const NAME_MAX_LENGTH = 40;

/** Trimmed, inner whitespace collapsed; null when it is empty or longer than 40 characters. */
export function normalizeDisplayName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= NAME_MAX_LENGTH ? name : null;
}

export async function getDisplayName(db: IDatabase): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key = ?', DISPLAY_NAME_KEY);
  return row ? normalizeDisplayName(row.value) : null;
}

/** Returns false (and stores nothing) when the name is not valid. */
export async function setDisplayName(db: IDatabase, raw: string): Promise<boolean> {
  const name = normalizeDisplayName(raw);
  if (!name) return false;
  await db.runAsync(
    `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    DISPLAY_NAME_KEY, name, new Date().toISOString(),
  );
  return true;
}

/** The one-time "add your name" sheet for existing guests: shown only while there is no name and it was never offered. */
export async function shouldPromptForName(db: IDatabase): Promise<boolean> {
  if (await getDisplayName(db)) return false;
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key = ?', NAME_PROMPTED_KEY);
  return !row;
}

export async function markNamePrompted(db: IDatabase): Promise<void> {
  await db.runAsync(
    `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    NAME_PROMPTED_KEY, new Date().toISOString(),
  );
}

/** The name to show: a name set on this device wins, then the account's name, then null (callers show no name, never "Guest"). */
export function resolveDisplayName(localName: string | null, accountName: string | null | undefined): string | null {
  return localName || normalizeDisplayName(accountName ?? '') || null;
}

export const firstName = (name: string | null): string | null => (name ? name.split(' ')[0] : null);
export const initialOf = (name: string | null): string => (name ? Array.from(name)[0].toUpperCase() : '•');
