import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { setCheckInPrefs, syncCheckInSchedule, type CheckInPrefs } from './dailyCheckIn.ts';
import { runReviewPass, setReviewPref, type ReviewNotificationPref } from './reviewNotifications.ts';

/**
 * How the Settings screen presents the notification preferences. The stored values are unchanged: the review
 * preference is still one of 'all' | 'duplicates' | 'off' (metadata key `review_notifications_pref`), and the check-in
 * keeps its enabled flag and 'HH:mm' time. This file only maps them to a switch plus a choice, and wraps the exact
 * calls the Profile screen made before, so a toggle does what the old row did.
 */
export type ReviewRemindScope = 'all' | 'duplicates';
export interface ReviewReminderState { enabled: boolean; scope: ReviewRemindScope }

/** Off = switch off; All = on + All payments; Duplicates only = on + Duplicates only. */
export function reviewStateFromPref(pref: ReviewNotificationPref): ReviewReminderState {
  return pref === 'off' ? { enabled: false, scope: 'all' } : { enabled: true, scope: pref };
}

export function reviewPrefFromState(state: ReviewReminderState): ReviewNotificationPref {
  return state.enabled ? state.scope : 'off';
}

/** Android is not letting Velnora post notifications (only meaningful where the app can tell). */
export function notificationsBlocked(state: { available: boolean; granted: boolean }): boolean {
  return state.available && !state.granted;
}

/** A switch is drawn on only if it is on AND Velnora can actually notify; while blocked every notification switch reads off. */
export function switchShownOn(stored: boolean, blocked: boolean): boolean {
  return stored && !blocked;
}

/** Turning a notification feature on while Android blocks notifications is the moment to ask (or send to Settings). */
export function shouldRequestNotificationPermission(turningOn: boolean, state: { available: boolean; granted: boolean }): boolean {
  return turningOn && notificationsBlocked(state);
}

/** Same two calls as before: save the preference, then let the review pass act on it (post, or clear, notifications). */
export async function applyReviewPref(db: IDatabase, scope: Scope, pref: ReviewNotificationPref): Promise<void> {
  await setReviewPref(db, pref);
  await runReviewPass(db, scope);
}

/** Same two calls as before: save the change, then hand the saved schedule to the native alarm (idempotent). */
export async function applyCheckInChange(db: IDatabase, change: Partial<CheckInPrefs>): Promise<CheckInPrefs> {
  await setCheckInPrefs(db, change);
  return syncCheckInSchedule(db);
}
