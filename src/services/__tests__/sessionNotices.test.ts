/**
 * Why the app opens signed out, and what it says: session ended (401), saved sign-in unreadable, no session found (a reinstall
 * or restore). Also the "was signed in" marker in the local database, and a guard that background tasks cannot clear the session.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import {
  NOTICE_NO_SESSION, NOTICE_SAVED_SIGN_IN_UNREADABLE, NOTICE_SESSION_ENDED, SIGNED_IN_MARKER_KEY, launchNotice, launchNoticeText, setSignedInMarker, wasSignedIn,
} from '../sessionNotices.ts';
import type { IDatabase } from '../../db/types.ts';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed += 1; console.log(`✓ ${name}`); }

async function main() {
  await test('the existing 401 wording is unchanged', () => {
    assert.equal(NOTICE_SESSION_ENDED, 'Your session has ended. Sign in again; your data on this device is preserved.');
  });

  await test('three different notices, none of them the same text', () => {
    const texts = [NOTICE_SESSION_ENDED, NOTICE_SAVED_SIGN_IN_UNREADABLE, NOTICE_NO_SESSION];
    assert.equal(new Set(texts).size, 3);
    assert.match(NOTICE_SAVED_SIGN_IN_UNREADABLE, /couldn't be read/);
    assert.match(NOTICE_NO_SESSION, /No saved sign-in was found/);
    assert.match(NOTICE_NO_SESSION, /reinstall or a restore/);
    assert.equal(launchNoticeText('saved_sign_in_unreadable'), NOTICE_SAVED_SIGN_IN_UNREADABLE);
    assert.equal(launchNoticeText('no_session'), NOTICE_NO_SESSION);
  });

  await test('which notice at launch: ok and a first run show nothing; unreadable shows the unreadable one; lost-after-restore shows no-session', () => {
    assert.equal(launchNotice('ok', true), null);
    assert.equal(launchNotice('ok', false), null);
    assert.equal(launchNotice('missing', false), null, 'a brand-new install must not claim a sign-in went missing');
    assert.equal(launchNotice('missing', true), 'no_session');
    for (const status of ['read_error', 'parse_error', 'invalid_shape'] as const) {
      assert.equal(launchNotice(status, false), 'saved_sign_in_unreadable', status);
      assert.equal(launchNotice(status, true), 'saved_sign_in_unreadable', status);
    }
  });

  await test('the was-signed-in marker lives in the local database: unset, set, cleared', async () => {
    const db = new NodeSqliteAdapter() as unknown as IDatabase; await runMigrations(db);
    assert.equal(await wasSignedIn(db), false);
    await setSignedInMarker(db, true);
    assert.equal(await wasSignedIn(db), true);
    await setSignedInMarker(db, false);
    assert.equal(await wasSignedIn(db), false);
    assert.equal(SIGNED_IN_MARKER_KEY, 'session_was_present');
  });

  await test('background tasks never clear the stored session (they only read it)', () => {
    const source = readFileSync(new URL('../backgroundCapture.ts', import.meta.url), 'utf8');
    assert.match(source, /loadSession/);
    assert.doesNotMatch(source, /clearSession|deleteItemAsync|SecureStore|saveSession/);
    for (const file of ['../reviewActionDrain.native.ts', '../reviewActionDrain.ts', '../smsStagingService.ts', '../dailyCheckIn.ts']) {
      assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /clearSession/, file);
    }
  });

  console.log(`${passed} tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
