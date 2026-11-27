/** The per-source switches: an install from before they existed keeps everything on, and JS and Kotlin agree on the list. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAPTURE_SOURCES, resolveCaptureSources } from '../captureSources.ts';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`✓ ${name}`); }

const kotlin = (file: string) => readFileSync(new URL(`../../../modules/velnora-sms/android/src/main/java/com/velnora/sms/${file}`, import.meta.url), 'utf8');
const on = (stored: unknown) => resolveCaptureSources(stored).filter((s) => s.enabled).map((s) => s.id);
const ALL = CAPTURE_SOURCES.map((s) => s.id);

test('existing users keep everything on: nothing stored, an older build or an unreadable value switches nothing off', () => {
  for (const stored of [undefined, null, [], '', 'com.phonepe.app', 42, {}, [null, 7]]) assert.deepEqual(on(stored), ALL, String(JSON.stringify(stored)));
});

test('only a known id switches a source off, and only that one', () => {
  assert.deepEqual(on(['com.phonepe.app']), ALL.filter((id) => id !== 'com.phonepe.app'));
  assert.deepEqual(on(['sms', 'com.truecaller', 'com.example.unknown']), ALL.filter((id) => id !== 'sms' && id !== 'com.truecaller'));
  assert.deepEqual(on(ALL), []);
});

test('the list is exactly SMS plus the existing six apps, the same as the native allow-list', () => {
  assert.deepEqual(CAPTURE_SOURCES.map((s) => s.label), ['SMS from banks', 'Google Pay', 'PhonePe', 'Paytm', 'BHIM', 'CRED', 'Truecaller']);
  const rules = kotlin('VelnoraCaptureRules.kt');
  const block = /val NOTIFICATION_SOURCES[^=]*= mapOf\(([\s\S]*?)\n  \)/.exec(rules)![1];
  const nativeIds = [...block.matchAll(/^\s*(TRUECALLER_PACKAGE|"[^"]+") to Origin/gm)].map((m) => (m[1] === 'TRUECALLER_PACKAGE' ? 'com.truecaller' : m[1].slice(1, -1)));
  assert.deepEqual([...nativeIds].sort(), CAPTURE_SOURCES.filter((s) => s.kind === 'notification').map((s) => s.id).sort());
});

test('the native store keeps only switched-off ids and defaults to none, so an update changes nothing', () => {
  const prefs = kotlin('VelnoraCapturePrefs.kt');
  assert.match(prefs, /getStringSet\(DISABLED, null\)\?\.toSet\(\) \?: emptySet\(\)/);
});

test('both native entry points check the switch before reading anything', () => {
  const receiver = kotlin('VelnoraSmsReceiver.kt');
  const onReceive = receiver.slice(receiver.indexOf('override fun onReceive'));
  assert.ok(onReceive.indexOf('isEnabled(appContext') > 0 && onReceive.indexOf('isEnabled(appContext') < onReceive.indexOf('goAsync()'), 'SMS: before any work');
  const listener = kotlin('VelnoraNotificationListener.kt');
  const handle = listener.slice(listener.indexOf('private fun handle('));
  const gate = handle.indexOf('VelnoraCapturePrefs.isEnabled');
  assert.ok(gate > 0);
  for (const later of ['sbn.notification', 'extras.getCharSequence', 'markListenerEvent', 'note(', 'stageNotification', 'emitSmsStaged']) assert.ok(gate < handle.indexOf(later), `switch checked before ${later}`);
});

console.log(`${passed} passed`);
