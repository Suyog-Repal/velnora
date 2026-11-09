import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  areAppNotificationsEnabled, canManageAppNotifications, canUseNotificationAccess, isNotificationAccessGranted,
  openAppNotificationSettings, openNotificationAccessSettings, requestAppNotifications,
} from '../../sms';

/** Live notification state, re-read whenever the app returns to the foreground (both are changed in system Settings). */
export function useCapturePermissions() {
  const appNotificationsAvailable = canManageAppNotifications();
  const accessAvailable = canUseNotificationAccess();
  const [appNotifications, setAppNotifications] = useState(() => areAppNotificationsEnabled());
  const [access, setAccess] = useState(() => isNotificationAccessGranted());

  const refresh = useCallback(() => { setAppNotifications(areAppNotificationsEnabled()); setAccess(isNotificationAccessGranted()); }, []);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);

  const toggleAppNotifications = useCallback(async () => {
    if (areAppNotificationsEnabled()) { openAppNotificationSettings(); return; }
    const result = await requestAppNotifications();
    if (result === 'blocked') openAppNotificationSettings();
    refresh();
  }, [refresh]);

  return { appNotificationsAvailable, accessAvailable, appNotifications, access, toggleAppNotifications, openAccessSettings: openNotificationAccessSettings };
}
