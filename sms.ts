import { PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import type { SmsStagingStore } from './src/services/smsStagingTypes';

type VelnoraSmsNativeModule = {
  addListener: (eventName: 'onSmsStaged', listener: () => void) => EventSubscription;
  isReceiveSmsPermissionGranted: () => boolean;
  setSupportedSenderPatterns: (patterns: string[]) => void;
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
