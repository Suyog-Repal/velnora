import type { IDatabase } from '../db/types.ts';
import { MetadataRepository } from '../db/repositories/metadataRepository.ts';
import type { LoadStatus } from './sessionPersistence.ts';

/**
 * The three different reasons the app can open signed out, each with its own wording. Pure apart from the small marker
 * stored in app metadata, so the decision is unit-tested.
 *
 *   session ended              a 401 from the server: the sign-in is no longer valid (wording unchanged)
 *   saved sign-in unreadable   something is stored but secure storage could not read it, or it is not a complete session
 *   no session found           nothing is stored although this device was signed in before (a reinstall or restore that
 *                              brought the data back but not the secure-store entry)
 */
export const NOTICE_SESSION_ENDED = 'Your session has ended. Sign in again; your data on this device is preserved.';
export const NOTICE_SAVED_SIGN_IN_UNREADABLE = "Your saved sign-in couldn't be read on this device. Sign in again; your data on this device is preserved.";
export const NOTICE_NO_SESSION = 'No saved sign-in was found on this device. This can happen after a reinstall or a restore. Sign in to continue; your data on this device is preserved.';

export type LaunchNotice = 'saved_sign_in_unreadable' | 'no_session';

/** What to tell the person when the app starts without a session. `wasSignedIn` separates "first run" (no notice) from "lost it". */
export function launchNotice(status: LoadStatus, wasSignedIn: boolean): LaunchNotice | null {
  if (status === 'ok') return null;
  if (status === 'missing') return wasSignedIn ? 'no_session' : null;
  return 'saved_sign_in_unreadable'; // read_error, parse_error, invalid_shape
}

export const launchNoticeText = (notice: LaunchNotice): string => (notice === 'no_session' ? NOTICE_NO_SESSION : NOTICE_SAVED_SIGN_IN_UNREADABLE);

/**
 * "This device was signed in" marker, kept in the local database (not secure storage), so it survives exactly the cases
 * secure storage does not (a restore that brings the database back). It is set while a session exists, cleared when the app
 * itself ends the session (sign-out, 401), and consumed once when "no session found" has been shown.
 */
export const SIGNED_IN_MARKER_KEY = 'session_was_present';

export async function wasSignedIn(db: IDatabase): Promise<boolean> {
  return (await new MetadataRepository(db).get(SIGNED_IN_MARKER_KEY)) === '1';
}

export async function setSignedInMarker(db: IDatabase, signedIn: boolean): Promise<void> {
  await new MetadataRepository(db).set(SIGNED_IN_MARKER_KEY, signedIn ? '1' : '0');
}
