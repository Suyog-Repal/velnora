import { loadSession } from '../../auth';
import { getNativeReviewNotifier } from '../../sms';
import { DEFAULT_SMS_RULE } from '../../transactionParser';
import { isGuestModeChosen } from './guestModeService';
import { REVIEW_SETTLE_MS, runReviewPass, setReviewNotifierPort } from './reviewNotifications';
import { drainNativeStagedSms } from './smsStagingService';
import { getServiceDb, initTransactionService } from './transactionService';

export const CAPTURE_TASK_NAME = 'VelnoraCaptureDrain';

/**
 * Runs in a headless JS task when a payment arrives while Velnora is not on screen: the same parser, ledger write and
 * completeness rules as the open app. Touches local data only and shows no UI. Anything it cannot finish stays staged
 * and is processed the next time the app opens.
 */
export async function runBackgroundCapture(): Promise<void> {
  await initTransactionService();
  setReviewNotifierPort(getNativeReviewNotifier());
  const session = await loadSession();
  if (!session && !(await isGuestModeChosen())) return; // nobody to own these yet: they wait, staged
  const rules = [DEFAULT_SMS_RULE];
  await drainNativeStagedSms(session, rules);
  // The same payment's other source usually arrives within seconds; let it complete or merge this one first.
  await new Promise((resolve) => setTimeout(resolve, REVIEW_SETTLE_MS + 500));
  await drainNativeStagedSms(session, rules);
  await runReviewPass(getServiceDb(), session?.user.id ?? null);
}
