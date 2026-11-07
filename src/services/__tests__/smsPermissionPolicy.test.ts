import assert from 'node:assert/strict';
import { SMS_PROMPT_STORAGE_KEY, shouldShowSmsPrompt, smsPermissionLabel } from '../smsPermissionPolicy.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

test('first launch on a device with SMS detection and no permission shows the prompt', () => {
  assert.equal(shouldShowSmsPrompt({ available: true, granted: false, answered: false }), true);
});
test('never prompts when permission is already granted, already answered, or SMS detection is unavailable', () => {
  assert.equal(shouldShowSmsPrompt({ available: true, granted: true, answered: false }), false);
  assert.equal(shouldShowSmsPrompt({ available: true, granted: false, answered: true }), false);   // no nagging after Allow or Not now
  assert.equal(shouldShowSmsPrompt({ available: false, granted: false, answered: false }), false); // iOS / Expo Go / no native module
});
test('profile label reflects the real state', () => {
  assert.match(smsPermissionLabel({ available: true, granted: true }), /^On/);
  assert.match(smsPermissionLabel({ available: true, granted: false }), /^Off/);
  assert.match(smsPermissionLabel({ available: false, granted: false }), /Not available/);
});
test('the storage key is versioned', () => { assert.equal(SMS_PROMPT_STORAGE_KEY, 'velnora.smsPrompt.v1'); });

console.log(`\n${passed} SMS permission policy tests passed`);
