import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking } from 'react-native';
import { isSmsDetectionAvailable, isSmsPermissionGranted, requestSmsPermissionDetailed, type SmsPermissionResult } from '../../sms';

/** Live RECEIVE_SMS status (re-checked whenever the app returns to the foreground, e.g. after Android Settings). */
export function useSmsPermission() {
  const available = isSmsDetectionAvailable();
  const [granted, setGranted] = useState(() => isSmsPermissionGranted());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') setGranted(isSmsPermissionGranted()); });
    return () => sub.remove();
  }, []);

  /** Shows Android's permission dialog. Returns the outcome; 'blocked' means the dialog can no longer be shown. */
  const request = useCallback(async (): Promise<SmsPermissionResult> => {
    const result = await requestSmsPermissionDetailed();
    setGranted(isSmsPermissionGranted());
    return result;
  }, []);

  const openSettings = useCallback(() => { void Linking.openSettings(); }, []);

  /**
   * request() plus plain-language help when Android will not (or did not) grant it. `explainDenial` is for an explicit
   * "turn it on" action (Profile row); the first-launch prompt only explains the "blocked" case so a simple "Deny" is not nagged.
   * Apps installed from a downloaded APK on Android 13+ also need "Allow restricted settings" before SMS can be enabled.
   */
  const requestWithGuidance = useCallback(async (explainDenial: boolean): Promise<SmsPermissionResult> => {
    const result = await request();
    if (result === 'blocked' || (explainDenial && result === 'denied')) {
      Alert.alert(
        'Turn on SMS access in Settings',
        'Open Velnora\'s settings, then choose Permissions → SMS → Allow.\n\nIf Android says "Restricted setting" (common for apps installed from a downloaded APK), tap the ⋮ menu at the top right of the App info page and choose "Allow restricted settings" first.',
        [{ text: 'Not now', style: 'cancel' }, { text: 'Open settings', onPress: openSettings }],
      );
    }
    return result;
  }, [request, openSettings]);

  return { available, granted, request, requestWithGuidance, openSettings };
}
