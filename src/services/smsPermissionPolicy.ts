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

export const APP_NOTIFICATIONS_PROMPT_KEY = 'velnora.appNotificationsPrompt.v1';
export const NOTIFICATION_ACCESS_PROMPT_KEY = 'velnora.notificationAccessPrompt.v1';
export const LAST_GRANTS_KEY = 'velnora.captureGrants.v1';

export type PermissionStep = 'sms' | 'app_notifications' | 'notification_access';
export interface GrantState { sms: boolean; app_notifications: boolean; notification_access: boolean }

/**
 * The setup steps still to show, in order. Velnora explains and asks before relying on any access; each step is asked
 * once per install, and a capability this device or build lacks is never asked for.
 */
export function pendingPermissionSteps(state: { available: Record<PermissionStep, boolean>; granted: GrantState; answered: Record<PermissionStep, boolean> }): PermissionStep[] {
  return (['sms', 'app_notifications', 'notification_access'] as const).filter((step) => state.available[step] && !state.granted[step] && !state.answered[step]);
}

/** Access that was on the last time the app looked and is off now. */
export function revokedSince(previous: GrantState | null, current: GrantState): PermissionStep[] {
  if (!previous) return [];
  return (['sms', 'app_notifications', 'notification_access'] as const).filter((step) => previous[step] && !current[step]);
}

export function revocationMessage(steps: PermissionStep[]): string {
  if (steps.includes('notification_access')) return 'Notification access was turned off. Payment-app detection may be incomplete.';
  if (steps.includes('sms')) return 'SMS access was turned off. Bank SMS detection may be incomplete.';
  return 'Velnora notifications were turned off.';
}

export function notificationAccessLabel(state: { available: boolean; granted: boolean }): string {
  if (!state.available) return 'Not available on this device';
  return state.granted ? 'On · payment-app alerts are detected' : 'Off · capture may be incomplete';
}

export function appNotificationsLabel(state: { available: boolean; granted: boolean }): string {
  if (!state.available) return 'Not available on this device';
  return state.granted ? 'On · tells you when a payment needs you' : 'Off · tap to turn on';
}

export function smsPermissionLabel(state: { available: boolean; granted: boolean }): string {
  if (!state.available) return 'Not available on this device';
  return state.granted ? 'On · bank alerts are detected' : 'Off · tap to turn on';
}
