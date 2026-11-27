/** Capture health: statuses, counts, and when each piece of guidance is shown. */
import assert from 'node:assert/strict';
import { buildHealthRows, buildQueueRows, isSideloaded, manufacturerGuide, showRestrictedGuide, type CaptureHealthRaw } from '../captureHealth.ts';
import { resolveCaptureSources } from '../captureSources.ts';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`✓ ${name}`); }

const good: CaptureHealthRaw = {
  smsPermission: true, notificationAccess: true, listenerConnected: true, listenerLastEventAt: 1000,
  ignoringBatteryOptimizations: true, backgroundRestricted: false, pauseIfUnusedExempt: true,
  installerPackage: null, sdkInt: 34, manufacturer: 'Google', brand: 'google',
};
const allOn = resolveCaptureSources([]);
const apps = allOn.filter((s) => s.kind === 'notification').map((s) => s.id);
const rows = (h: Partial<CaptureHealthRaw>, off: string[] = []) => Object.fromEntries(
  buildHealthRows({ ...good, ...h }, resolveCaptureSources(off), (at) => `T${at}`).map((r) => [r.id, r]),
);

test('everything allowed: every row is OK, in a fixed order', () => {
  const list = buildHealthRows(good, allOn, String);
  assert.deepEqual(list.map((r) => r.id), ['sms_permission', 'notification_access', 'listener', 'battery', 'background', 'unused']);
  assert.ok(list.every((r) => r.status === 'ok' && !r.reconnect));
  assert.deepEqual(list.map((r) => r.page), ['app_info', 'notification_access', 'notification_access', 'battery', 'app_info', 'app_info']);
  assert.match(rows({}).listener.detail, /T1000/);
  assert.match(rows({ listenerLastEventAt: null }).listener.detail, /No notification from a listed app/);
});

test('each blocked setting is flagged', () => {
  const bad = rows({ smsPermission: false, notificationAccess: false, listenerConnected: false, ignoringBatteryOptimizations: false, backgroundRestricted: true, pauseIfUnusedExempt: false });
  for (const row of Object.values(bad)) assert.equal(row.status, 'attention', row.id);
  assert.equal(bad.listener.reconnect, false, 'no reconnect without notification access');
});

test('reconnect is offered only when access is on but the listener is not connected', () => {
  const row = rows({ listenerConnected: false }).listener;
  assert.equal(row.status, 'attention'); assert.equal(row.reconnect, true); assert.match(row.detail, /Not connected/);
});

test('switched-off sources are not reported as problems', () => {
  const noSms = rows({ smsPermission: false }, ['sms']);
  assert.equal(noSms.sms_permission.status, 'off');
  const noApps = rows({ notificationAccess: false, listenerConnected: false }, apps);
  assert.equal(noApps.notification_access.status, 'off'); assert.equal(noApps.listener.status, 'off'); assert.equal(noApps.listener.reconnect, false);
  assert.equal(rows({ notificationAccess: false }, apps.slice(1)).notification_access.status, 'attention', 'one app still on');
});

test('a setting this Android version does not report is unknown, not OK', () => {
  const r = rows({ ignoringBatteryOptimizations: null, backgroundRestricted: null, pauseIfUnusedExempt: null });
  assert.deepEqual([r.battery.status, r.background.status, r.unused.status], ['unknown', 'unknown', 'unknown']);
});

test('counts: a guest\'s ownerless messages are waiting; signed in they are stranded', () => {
  const raw = { pendingMine: 2, pendingOwnerless: 3, pendingOther: 4, dead: 5 };
  const view = (signedIn: boolean) => Object.fromEntries(buildQueueRows(raw, signedIn).map((r) => [r.id, r.count]));
  assert.deepEqual(view(true), { waiting: 2, held: 4, ownerless: 3, dead: 5 });
  assert.deepEqual(view(false), { waiting: 3, held: 4, ownerless: 0, dead: 5 });
});

test('restricted-settings steps: sideloaded, Android 13 or newer, and some access off', () => {
  assert.equal(isSideloaded(null), true);
  assert.equal(isSideloaded('com.google.android.packageinstaller'), true);
  assert.equal(isSideloaded('com.android.chrome'), true);
  assert.equal(isSideloaded('com.android.vending'), false);
  const show = (h: Partial<CaptureHealthRaw>) => showRestrictedGuide({ ...good, ...h });
  assert.equal(show({}), false, 'all access on');
  assert.equal(show({ smsPermission: false }), true);
  assert.equal(show({ notificationAccess: false }), true);
  assert.equal(show({ smsPermission: false, installerPackage: 'com.android.vending' }), false);
  assert.equal(show({ smsPermission: false, sdkInt: 32 }), false);
});

test('manufacturer steps for Xiaomi, Oppo/Realme, Vivo and Samsung only', () => {
  const title = (m: string | null, b: string | null = null) => manufacturerGuide(m, b)?.title ?? null;
  assert.equal(title('Xiaomi', 'Redmi'), 'Xiaomi, Redmi and POCO');
  assert.equal(title('Xiaomi', 'POCO'), 'Xiaomi, Redmi and POCO');
  assert.equal(title('OPPO'), 'Oppo and Realme');
  assert.equal(title('realme'), 'Oppo and Realme');
  assert.equal(title('vivo', 'iQOO'), 'Vivo and iQOO');
  assert.equal(title('samsung'), 'Samsung');
  for (const other of ['Google', 'OnePlus', 'motorola', '', null]) assert.equal(title(other), null);
});

console.log(`${passed} passed`);
