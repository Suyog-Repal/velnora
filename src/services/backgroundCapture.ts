import { loadSession } from '../../auth';
import { diag } from './diagnostics';
import { getNativeCheckIn, getNativeReviewNotifier } from '../../sms';
import { drainNativeReviewActions } from './reviewActionDrain.native';
import { DEFAULT_SMS_RULE } from '../../transactionParser';
import { isGuestModeChosen } from './guestModeService';
import { runDailyCheckIn, setCheckInPort } from './dailyCheckIn';
import { REVIEW_SETTLE_MS, runReviewPass, setReviewNotifierPort } from './reviewNotifications';
import { drainNativeStagedSms, logCaptureEvent } from './smsStagingService';
import { getServiceDb, initTransactionService } from './transactionService';

export const CAPTURE_TASK_NAME = 'VelnoraCaptureDrain';

/**
 * Runs in a headless JS task when a payment arrives while Velnora is not on screen: the same parser, ledger write and
 * completeness rules as the open app. Touches local data only and shows no UI. Anything it cannot finish stays staged
 * and is processed the next time the app opens.
 */
export async function runBackgroundCapture(): Promise<void> {
  try {
    await initTransactionService();
    setReviewNotifierPort(getNativeReviewNotifier());
    const session = await loadSession();
    diag('headless_task', { task: 'capture_drain', session_present: !!session });
    if (!session && !(await isGuestModeChosen())) { // nobody to own these yet: they wait, staged
      await logCaptureEvent('headless', 'held', 'signed_out');
      return;
    }
    const rules = [DEFAULT_SMS_RULE];
    await drainNativeStagedSms(session, rules);
    // The same payment's other source usually arrives within seconds; let it complete or merge this one first.
    await new Promise((resolve) => setTimeout(resolve, REVIEW_SETTLE_MS + 500));
    await drainNativeStagedSms(session, rules);
    await runReviewPass(getServiceDb(), session?.user.id ?? null);
  } catch (error) {
    await logCaptureEvent('headless', 'held', 'drain_failed');
    throw error;
  }
}

export const REVIEW_ACTION_TASK_NAME = 'VelnoraReviewActionDrain';

/**
 * Runs headless when a category button on a review notification was tapped with the app closed. Applies every queued
 * choice (the native receiver already stored them), then lets the review pass tidy the notifications. No UI.
 */
export async function runReviewActionDrain(): Promise<void> {
  await initTransactionService();
  setReviewNotifierPort(getNativeReviewNotifier());
  const session = await loadSession();
  diag('headless_task', { task: 'review_action', session_present: !!session });
  if (!session && !(await isGuestModeChosen())) return; // nobody to own them yet: they stay queued
  await drainNativeReviewActions(session);
  await runReviewPass(getServiceDb(), session?.user.id ?? null);
}

export const DAILY_CHECKIN_TASK_NAME = 'VelnoraDailyCheckIn';

/**
 * Runs headless when the daily alarm fires. Counts today's captured transactions in the local ledger and posts the
 * check-in (unless it is off or already confirmed today). Local data only; no UI, no network.
 */
export async function runDailyCheckInTask(): Promise<void> {
  await initTransactionService();
  setCheckInPort(getNativeCheckIn());
  const session = await loadSession();
  diag('headless_task', { task: 'daily_checkin', session_present: !!session });
  if (!session && !(await isGuestModeChosen())) return; // no ledger owner yet: nothing meaningful to count
  await runDailyCheckIn(getServiceDb(), session?.user.id ?? null);
}
