/**
 * When to show the first-launch "allow SMS" explanation. Pure (no React Native) so it is unit-tested in Node.
 *
 * The prompt is shown once per install: only if bank-SMS detection exists on this device, the permission is not
 * already granted, and the person has not already answered it. After that the choice lives in Android's own
 * permission settings and in Profile → "Bank SMS detection" (no nagging).
 */
export const SMS_PROMPT_STORAGE_KEY = 'velnora.smsPrompt.v1';

export function shouldShowSmsPrompt(state: { available: boolean; granted: boolean; answered: boolean }): boolean {
  return state.available && !state.granted && !state.answered;
}

export function smsPermissionLabel(state: { available: boolean; granted: boolean }): string {
  if (!state.available) return 'Not available on this device';
  return state.granted ? 'On · bank alerts are detected' : 'Off · tap to turn on';
}
