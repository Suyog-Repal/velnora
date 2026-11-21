/**
 * Settings > Notifications: the review-reminder switch + "Remind me about" choice maps onto the three stored states,
 * the check-in switch and time go through the same save + reschedule as before, and a blocked notification permission
 * shows the switches off. Real services and SQLite; the Android alarm is a mock, so this says nothing about a real device.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { MetadataRepository } from '../../db/repositories/metadataRepository.ts';
import { setTransactionServiceAdapter } from '../transactionService.ts';
import { DEFAULT_CHECKIN_TIME, getCheckInPrefs, setCheckInPort, type CheckInPort } from '../dailyCheckIn.ts';
import { REVIEW_PREF_KEY, getReviewPref, setReviewNotifierPort, type ReviewNotificationPref } from '../reviewNotifications.ts';
import {
  applyCheckInChange, applyReviewPref, notificationsBlocked, reviewPrefFromState, reviewStateFromPref, shouldRequestNotificationPermission, switchShownOn,
} from '../notificationSettings.ts';
import type { IDatabase } from '../../db/types.ts';

class MockAlarm implements CheckInPort {
  configured: { enabled: boolean; time: string }[] = [];
  canNotify() { return true; }
  post() { return true; }
  confirmedDay() { return null; }
  markConfirmed() { /* unused */ }
  configure(enabled: boolean, time: string) { this.configured.push({ enabled, time }); }
}
async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  const alarm = new MockAlarm(); setCheckInPort(alarm); setReviewNotifierPort(null);
  return { db: db as unknown as IDatabase, alarm };
}
let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); passed += 1; console.log(`✓ ${name}`); }

async function main() {
  await test('review state: the three stored values map to switch + choice, and back', () => {
    assert.deepEqual(reviewStateFromPref('off'), { enabled: false, scope: 'all' });
    assert.deepEqual(reviewStateFromPref('all'), { enabled: true, scope: 'all' });
    assert.deepEqual(reviewStateFromPref('duplicates'), { enabled: true, scope: 'duplicates' });
    for (const pref of ['off', 'all', 'duplicates'] as ReviewNotificationPref[]) {
      assert.equal(reviewPrefFromState(reviewStateFromPref(pref)), pref);
    }
    assert.equal(reviewPrefFromState({ enabled: false, scope: 'duplicates' }), 'off'); // switch off wins over the remembered choice
    assert.equal(reviewPrefFromState({ enabled: true, scope: 'duplicates' }), 'duplicates');
  });

  await test('review pref: existing stored values (and a missing one) read back as before', async () => {
    const { db } = await fresh();
    assert.equal(await getReviewPref(db), 'all'); // never set: default All
    const meta = new MetadataRepository(db);
    for (const v of ['all', 'duplicates', 'off'] as const) {
      await meta.set(REVIEW_PREF_KEY, v);
      assert.equal(await getReviewPref(db), v);
      assert.equal(reviewPrefFromState(reviewStateFromPref(await getReviewPref(db))), v);
    }
    await meta.set(REVIEW_PREF_KEY, 'garbage');
    assert.equal(await getReviewPref(db), 'all');
  });

  await test('review switch + choice save the same stored value the old row did', async () => {
    const { db } = await fresh();
    await applyReviewPref(db, null, reviewPrefFromState({ enabled: true, scope: 'duplicates' }));
    assert.equal(await new MetadataRepository(db).get(REVIEW_PREF_KEY), 'duplicates');
    await applyReviewPref(db, null, reviewPrefFromState({ enabled: false, scope: 'duplicates' }));
    assert.equal(await new MetadataRepository(db).get(REVIEW_PREF_KEY), 'off');
    await applyReviewPref(db, null, reviewPrefFromState({ enabled: true, scope: 'all' }));
    assert.equal(await getReviewPref(db), 'all');
  });

  await test('check-in: default is on at 9 PM; switch off/on saves and reschedules the native alarm each time', async () => {
    const { db, alarm } = await fresh();
    assert.deepEqual(await getCheckInPrefs(db), { enabled: true, time: DEFAULT_CHECKIN_TIME });
    const off = await applyCheckInChange(db, { enabled: false });
    assert.deepEqual(off, { enabled: false, time: DEFAULT_CHECKIN_TIME });
    assert.deepEqual(alarm.configured.at(-1), { enabled: false, time: DEFAULT_CHECKIN_TIME });
    await applyCheckInChange(db, { enabled: true });
    assert.deepEqual(alarm.configured.at(-1), { enabled: true, time: DEFAULT_CHECKIN_TIME });
    assert.equal(alarm.configured.length, 2);
  });

  await test('check-in: time change is saved, kept across off/on, and rescheduled; an invalid time is ignored', async () => {
    const { db, alarm } = await fresh();
    await applyCheckInChange(db, { time: '22:30' });
    assert.deepEqual(alarm.configured.at(-1), { enabled: true, time: '22:30' });
    await applyCheckInChange(db, { enabled: false }); // hiding the time row must not lose the time
    assert.equal((await getCheckInPrefs(db)).time, '22:30');
    await applyCheckInChange(db, { enabled: true });
    assert.deepEqual(alarm.configured.at(-1), { enabled: true, time: '22:30' });
    await applyCheckInChange(db, { time: '25:99' });
    assert.equal((await getCheckInPrefs(db)).time, '22:30');
    await applyCheckInChange(db, { time: '07:05' });
    assert.deepEqual(await getCheckInPrefs(db), { enabled: true, time: '07:05' });
  });

  await test('check-in: an off choice with its time survives a restart (read back from storage)', async () => {
    const { db } = await fresh();
    await applyCheckInChange(db, { enabled: false, time: '20:15' });
    assert.deepEqual(await getCheckInPrefs(db), { enabled: false, time: '20:15' });
  });

  await test('blocked notification permission: switches read off and turning one on asks for permission', () => {
    const blocked = { available: true, granted: false };
    assert.equal(notificationsBlocked(blocked), true);
    assert.equal(notificationsBlocked({ available: true, granted: true }), false);
    assert.equal(notificationsBlocked({ available: false, granted: false }), false); // not detectable on this build: not "blocked"
    assert.equal(switchShownOn(true, true), false);
    assert.equal(switchShownOn(true, false), true);
    assert.equal(switchShownOn(false, false), false);
    assert.equal(shouldRequestNotificationPermission(true, blocked), true);
    assert.equal(shouldRequestNotificationPermission(false, blocked), false);
    assert.equal(shouldRequestNotificationPermission(true, { available: true, granted: true }), false);
  });

  console.log(`${passed} tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
