import { PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import type { SmsStagingStore } from './src/services/smsStagingTypes';
import type { ReviewActionStore } from './src/services/reviewActionDrain';
import type { ReviewNotifierPort } from './src/services/reviewNotifications';
import type { CheckInPort } from './src/services/dailyCheckIn';

type VelnoraSmsNativeModule = {
  addListener: (eventName: 'onSmsStaged', listener: () => void) => EventSubscription;
  isReceiveSmsPermissionGranted: () => boolean;
  setSupportedSenderPatterns: (patterns: string[]) => void;
  isNotificationAccessGranted?: () => boolean;
  openNotificationAccessSettings?: () => boolean;
  areNotificationsEnabled?: () => boolean;
  openAppNotificationSettings?: () => boolean;
  postReviewNotification?: (transactionId: string, title: string, body: string, categories: string[]) => boolean;
  claimReviewActions?: ReviewActionStore['claim'];
  completeReviewAction?: ReviewActionStore['complete'];
  releaseReviewAction?: ReviewActionStore['release'];
  postReviewSummary?: (count: number) => boolean;
  cancelReviewNotification?: (transactionId: string) => void;
  cancelReviewSummary?: () => void;
  configureDailyCheckIn?: (enabled: boolean, time: string) => void;
  getCheckInConfirmedDay?: () => string | null;
  markCheckInConfirmed?: (day: string) => void;
  postDailyCheckIn?: (title: string, body: string) => boolean;
} & SmsStagingStore;

const nativeModule = requireOptionalNativeModule<VelnoraSmsNativeModule>('VelnoraSms');

export function isSmsDetectionAvailable(): boolean {
  return Platform.OS === 'android' && nativeModule !== null;
}

/** 'blocked' = Android will no longer show the dialog ("don't ask again"); the person must use system Settings. */
export type SmsPermissionResult = 'granted' | 'denied' | 'blocked' | 'unavailable';

export async function requestSmsPermissionDetailed(): Promise<SmsPermissionResult> {
  if (Platform.OS !== 'android' || nativeModule === null) return 'unavailable';
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
    {
      title: 'Allow Velnora to receive bank alerts',
      message: 'Velnora uses incoming bank alert metadata to prepare transaction suggestions. Message contents are not saved, uploaded, or logged.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );
  // Trust the real permission state over the dialog's return value (it can report "never ask again" even though the grant landed).
  if (result === PermissionsAndroid.RESULTS.GRANTED || nativeModule.isReceiveSmsPermissionGranted()) return 'granted';
  return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
}

export async function requestSmsPermission(): Promise<boolean> {
  return (await requestSmsPermissionDetailed()) === 'granted';
}

export function configureSupportedSenderPatterns(patterns: string[]): void {
  nativeModule?.setSupportedSenderPatterns(patterns);
}

/** Truecaller notification detection needs the special 'Notification access' grant (older native builds: false). */
export function isNotificationAccessGranted(): boolean {
  return Platform.OS === 'android' ? nativeModule?.isNotificationAccessGranted?.() ?? false : false;
}

export function openNotificationAccessSettings(): boolean {
  return Platform.OS === 'android' ? nativeModule?.openNotificationAccessSettings?.() ?? false : false;
}

/** False on an installed build older than this code: it cannot read the notification state or show the dialog. */
export function canManageAppNotifications(): boolean {
  return Platform.OS === 'android' && typeof nativeModule?.areNotificationsEnabled === 'function';
}

export function canUseNotificationAccess(): boolean {
  return Platform.OS === 'android' && typeof nativeModule?.isNotificationAccessGranted === 'function';
}

/** Can Velnora post its own notifications? */
export function areAppNotificationsEnabled(): boolean {
  return Platform.OS === 'android' ? nativeModule?.areNotificationsEnabled?.() ?? false : false;
}

export function openAppNotificationSettings(): boolean {
  return Platform.OS === 'android' ? nativeModule?.openAppNotificationSettings?.() ?? false : false;
}

/** Shows Android's "Allow Velnora to send you notifications?" dialog (Android 13+; earlier versions have no dialog). */
export async function requestAppNotifications(): Promise<SmsPermissionResult> {
  if (!canManageAppNotifications()) return 'unavailable';
  if (areAppNotificationsEnabled()) return 'granted';
  if (typeof Platform.Version === 'number' && Platform.Version < 33) return 'blocked'; // switched off in Settings; there is no dialog
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  if (result === PermissionsAndroid.RESULTS.GRANTED || areAppNotificationsEnabled()) return 'granted';
  return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
}

/** Null on an installed build older than this code or off Android: review then stays in the in-app queue. */
export function getNativeReviewNotifier(): ReviewNotifierPort | null {
  const native = nativeModule;
  if (Platform.OS !== 'android' || !native?.postReviewNotification) return null;
  return {
    canNotify: () => native.areNotificationsEnabled?.() ?? false,
    post: (n) => native.postReviewNotification?.(n.transactionId, n.title, n.body, n.categories ?? []) ?? false,
    postSummary: (count) => native.postReviewSummary?.(count) ?? false,
    cancel: (id) => native.cancelReviewNotification?.(id),
    cancelSummary: () => native.cancelReviewSummary?.(),
  };
}

/** Daily check-in alarm and notification. Null on an older native build or off Android: the check-in then does not run. */
export function getNativeCheckIn(): CheckInPort | null {
  const native = nativeModule;
  if (Platform.OS !== 'android' || !native?.postDailyCheckIn || !native.configureDailyCheckIn) return null;
  return {
    canNotify: () => native.areNotificationsEnabled?.() ?? false,
    post: (title, body) => native.postDailyCheckIn?.(title, body) ?? false,
    confirmedDay: () => native.getCheckInConfirmedDay?.() ?? null,
    markConfirmed: (day) => native.markCheckInConfirmed?.(day),
    configure: (enabled, time) => native.configureDailyCheckIn?.(enabled, time),
  };
}

/** Durable queue of categories chosen on notification buttons. Null on an older native build or off Android. */
export function getNativeReviewActionStore(): ReviewActionStore | null {
  const native = nativeModule;
  if (Platform.OS !== 'android' || !native?.claimReviewActions || !native.completeReviewAction || !native.releaseReviewAction) return null;
  return {
    claim: (limit, nowMs, leaseMs) => native.claimReviewActions!(limit, nowMs, leaseMs),
    complete: (id) => native.completeReviewAction!(id),
    release: (id) => native.releaseReviewAction!(id),
  };
}

export function isSmsPermissionGranted(): boolean {
  return nativeModule?.isReceiveSmsPermissionGranted() ?? false;
}

/** Lightweight "something was staged" signal (carries no SMS content). Drain via the staging service. */
export function addSmsStagedListener(listener: () => void): EventSubscription | null {
  return nativeModule?.addListener('onSmsStaged', listener) ?? null;
}

export function getNativeStagingStore(): SmsStagingStore | null {
  return Platform.OS === 'android' ? nativeModule : null;
}
