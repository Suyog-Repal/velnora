import { useEffect, useRef, useState } from 'react';
import { AppState, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isDarkScheme, palette } from '../../theme';
import { Bell, MessageSquare, WalletCards } from '../../icons';
import {
  APP_NOTIFICATIONS_PROMPT_KEY, LAST_GRANTS_KEY, NOTIFICATION_ACCESS_PROMPT_KEY, SMS_PROMPT_STORAGE_KEY,
  pendingPermissionSteps, revocationMessage, revokedSince, type GrantState, type PermissionStep,
} from '../services/smsPermissionPolicy';
import { areAppNotificationsEnabled, isNotificationAccessGranted, isSmsPermissionGranted, openNotificationAccessSettings, requestAppNotifications } from '../../sms';
import { readableOn } from '../ui/common';
import { showToast } from '../ui/Toast';
import { useCapturePermissions } from '../ui/useCapturePermissions';
import { useSmsPermission } from '../ui/useSmsPermission';

const KEYS: Record<PermissionStep, string> = {
  sms: SMS_PROMPT_STORAGE_KEY,
  app_notifications: APP_NOTIFICATIONS_PROMPT_KEY,
  notification_access: NOTIFICATION_ACCESS_PROMPT_KEY,
};

const COPY: Record<PermissionStep, { icon: typeof Bell; title: string; body: string; fine: string; allow: string }> = {
  sms: {
    icon: MessageSquare,
    title: 'Track your payments automatically',
    body: 'Allow Velnora to receive SMS so it can spot bank and UPI payment alerts and suggest transactions for you.',
    fine: 'Only bank-style alerts are processed, and one-time passwords are discarded. Message text is never uploaded or logged, and your SMS inbox is not read. You can change this any time in Profile or Android settings.',
    allow: 'Allow SMS access',
  },
  app_notifications: {
    icon: Bell,
    title: 'Allow notifications from Velnora?',
    body: 'Velnora can tell you when a payment needs a category or a quick check, and take you straight to it.',
    fine: 'Message text, OTPs and account numbers are never shown, and the lock screen hides the amount and name. You can turn these off any time in Profile.',
    allow: 'Continue',
  },
  notification_access: {
    icon: WalletCards,
    title: 'Read alerts from payment apps?',
    body: 'Notification access lets Velnora record payments announced by Google Pay, PhonePe, Paytm, BHIM, CRED and Truecaller.',
    fine: 'Android will show one list: turn on Velnora there. Notifications from every other app are ignored without being read or stored. If an app posts no notification for a payment, Velnora cannot see it. Installed from an APK and it says "Restricted setting"? Open App info, tap ⋮, then "Allow restricted settings".',
    allow: 'Open Android settings',
  },
};

function currentGrants(): GrantState {
  return { sms: isSmsPermissionGranted(), app_notifications: areAppNotificationsEnabled(), notification_access: isNotificationAccessGranted() };
}

/**
 * Explains each kind of access before asking for it, one step at a time, after the splash. "Not now" is respected: a
 * step is never asked automatically again, and Profile can turn it on later. Also warns when access is later revoked.
 */
export function PermissionSetup({ enabled }: { enabled: boolean }) {
  const sms = useSmsPermission();
  const capture = useCapturePermissions();
  const [queue, setQueue] = useState<PermissionStep[]>([]);
  const [waitingForSettings, setWaitingForSettings] = useState(false);
  const [systemDialogOpen, setSystemDialogOpen] = useState(false);
  const step = queue[0];
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    Promise.all((['sms', 'app_notifications', 'notification_access'] as const).map((s) => AsyncStorage.getItem(KEYS[s])))
      .then(([smsAnswer, notifyAnswer, accessAnswer]) => {
        if (!active) return;
        setQueue(pendingPermissionSteps({
          available: { sms: sms.available, app_notifications: capture.appNotificationsAvailable, notification_access: capture.accessAvailable },
          granted: currentGrants(),
          answered: { sms: smsAnswer !== null, app_notifications: notifyAnswer !== null, notification_access: accessAnswer !== null },
        }));
      })
      .catch(() => undefined); // if storage fails, stay quiet rather than risk nagging
    return () => { active = false; };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (s: PermissionStep, answer: 'allowed' | 'declined') => {
    AsyncStorage.setItem(KEYS[s], answer).catch(() => undefined);
    setWaitingForSettings(false);
    setQueue((q) => q.filter((x) => x !== s));
  };

  // Notification access can only be granted on Android's own screen: continue when the person comes back with it on.
  // Also the place revocation is noticed, whenever the app returns to the foreground.
  useEffect(() => {
    if (!enabled) return;
    const check = async () => {
      const now = currentGrants();
      if (stepRef.current === 'notification_access' && now.notification_access) {
        finish('notification_access', 'allowed');
        showToast('Payment-app detection is on', 'success', 'notification-access');
      }
      try {
        const stored = await AsyncStorage.getItem(LAST_GRANTS_KEY);
        const revoked = revokedSince(stored ? JSON.parse(stored) as GrantState : null, now);
        if (revoked.length) showToast(revocationMessage(revoked), 'info', 'capture-revoked');
        await AsyncStorage.setItem(LAST_GRANTS_KEY, JSON.stringify(now));
      } catch { /* a warning is a convenience */ }
    };
    void check();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void check(); });
    return () => sub.remove();
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const allow = async () => {
    // Android's own dialog replaces the card; the next step appears only after the person has answered it.
    if (step === 'sms') {
      setSystemDialogOpen(true);
      try {
        const result = await sms.requestWithGuidance(false);
        if (result === 'granted') showToast('SMS detection is on', 'success', 'sms-permission');
      } finally { finish('sms', 'allowed'); setSystemDialogOpen(false); }
    } else if (step === 'app_notifications') {
      setSystemDialogOpen(true);
      try { await requestAppNotifications(); } finally { finish('app_notifications', 'allowed'); setSystemDialogOpen(false); }
    } else if (step === 'notification_access') {
      setWaitingForSettings(true);
      openNotificationAccessSettings();
    }
  };

  const copy = step ? COPY[step] : null;
  const accent = palette.emerald;
  const dark = isDarkScheme();
  const surface = dark ? palette.darkElevated : palette.card;
  const ink = dark ? palette.darkText : palette.ink;
  const sub = dark ? palette.darkMuted : palette.muted;
  const Icon = copy?.icon ?? Bell;
  return <Modal visible={!!copy && !systemDialogOpen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => { if (step) finish(step, 'declined'); }}>
    <View style={s.backdrop}>
      <View style={[s.card, { backgroundColor: surface, borderColor: dark ? palette.darkBorder : 'transparent', borderWidth: dark ? 1 : 0 }]} accessibilityViewIsModal>
        <View style={[s.iconWrap, { backgroundColor: `${accent}22` }]}><Icon size={30} color={accent} /></View>
        <Text style={[s.title, { color: ink }]} accessibilityRole="header">{copy?.title}</Text>
        <Text style={[s.body, { color: sub }]}>{waitingForSettings ? 'Notification access is still off. Turn on Velnora in the list, then come back.' : copy?.body}</Text>
        <Text style={[s.fine, { color: sub }]}>{copy?.fine}</Text>
        <Pressable onPress={() => void allow()} accessibilityRole="button" style={({ pressed }) => [s.primary, { backgroundColor: accent, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={{ color: readableOn(accent), fontWeight: '600', fontSize: 15 }}>{copy?.allow}</Text>
        </Pressable>
        <Pressable onPress={() => { if (step) finish(step, 'declined'); }} accessibilityRole="button" style={s.secondary}>
          <Text style={{ color: sub, fontWeight: '700' }}>Not now</Text>
        </Pressable>
      </View>
    </View>
  </Modal>;
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(5,8,7,0.62)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  card: { width: '100%', maxWidth: 380, borderRadius: 26, backgroundColor: '#FFFFFF', padding: 24, alignItems: 'center' },
  iconWrap: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: palette.ink, textAlign: 'center' },
  body: { fontSize: 14.5, lineHeight: 21, color: palette.ink, textAlign: 'center', marginTop: 10 },
  fine: { fontSize: 12, lineHeight: 18, color: palette.muted, textAlign: 'center', marginTop: 10 },
  primary: { alignSelf: 'stretch', minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  secondary: { alignSelf: 'stretch', minHeight: 46, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
});
