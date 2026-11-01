import { PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import type { SmsReceivedPayload } from './transactionParser';

export type SmsReceivedEvent = SmsReceivedPayload;

type VelnoraSmsNativeModule = {
  addListener: (eventName: 'onSmsReceived', listener: (event: SmsReceivedEvent) => void) => EventSubscription;
  isReceiveSmsPermissionGranted: () => boolean;
  setSupportedSenderPatterns: (patterns: string[]) => void;
};

const nativeModule = requireOptionalNativeModule<VelnoraSmsNativeModule>('VelnoraSms');

export function isSmsDetectionAvailable(): boolean {
  return Platform.OS === 'android' && nativeModule !== null;
}

export async function requestSmsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || nativeModule === null) return false;
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
    {
      title: 'Allow Velnora to receive bank alerts',
      message: 'Velnora uses incoming bank alert metadata to prepare transaction suggestions. Message contents are not saved, uploaded, or logged.',
      buttonPositive: 'Allow',
      buttonNegative: 'Deny',
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export function configureSupportedSenderPatterns(patterns: string[]): void {
  nativeModule?.setSupportedSenderPatterns(patterns);
}

export function isSmsPermissionGranted(): boolean {
  return nativeModule?.isReceiveSmsPermissionGranted() ?? false;
}

export function addSmsReceivedListener(listener: (event: SmsReceivedEvent) => void): EventSubscription | null {
  return nativeModule?.addListener('onSmsReceived', listener) ?? null;
}
