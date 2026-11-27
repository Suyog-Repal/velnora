import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Share, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette } from '../../theme';
import { Bell, Check, Clock, FileText, X } from '../../icons';
import { CaptureSourcesSection } from '../components/CaptureSourcesSection';
import { openAppNotificationSettings } from '../../sms';
import { currencySymbol, Sheet, type Colors } from '../ui/common';
import { CURRENCIES } from '../ui/currency';
import { useCapturePermissions } from '../ui/useCapturePermissions';
import { ActionRow, Group, Segmented, SwitchRow, Tap, ValueRow, useAnimateNext } from '../ui/rows';
import { TimePickerModal } from '../ui/TimePicker';
import { getServiceDb } from '../services/transactionService';
import { getReviewPref } from '../services/reviewNotifications';
import { getCheckInPrefs, type CheckInPrefs } from '../services/dailyCheckIn';
import { formatDisplayTime } from '../services/dateUtils';
import { diagnostics } from '../services/diagnostics';
import {
  applyCheckInChange, applyReviewPref, notificationsBlocked, reviewPrefFromState, reviewStateFromPref, shouldRequestNotificationPermission, switchShownOn,
  type ReviewReminderState,
} from '../services/notificationSettings';
import { AppearanceCard, Reveal } from './ProfileView';
import type { AccentId, ThemeMode } from '../../theme';

/** Full-screen page chrome (slides up) shared by Settings and Privacy & data. */
function FullPage({ visible, onClose, colors, title, closeLabel, children }: { visible: boolean; onClose: () => void; colors: Colors; title: string; closeLabel: string; children: ReactNode }) {
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 }}>
        <View><Text style={{ color: palette.accentText, fontSize: 12, fontWeight: '600', letterSpacing: 2 }}>VELNORA</Text><Text style={{ color: colors.text, fontSize: 26, fontWeight: '700', marginTop: 4 }}>{title}</Text></View>
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={closeLabel} style={{ width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }}><X color={colors.muted} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 4, paddingBottom: 60 }}>{visible ? children : null}</ScrollView>
    </SafeAreaView>
  </Modal>;
}

const REMIND_OPTIONS = [['all', 'All payments'], ['duplicates', 'Duplicates only']] as const;

/** Mounted only while Settings is open, so every value is re-read from storage and Android each time. */
function SettingsContent({ colors, mode, setMode, accent, setAccent, scope, currency, openCurrency }: {
  colors: Colors; mode: ThemeMode; setMode: (m: ThemeMode) => void; accent: AccentId; setAccent: (a: AccentId) => void; scope: string | null; currency: string; openCurrency: () => void;
}) {
  const capture = useCapturePermissions();
  const animate = useAnimateNext();
  const notify = { available: capture.appNotificationsAvailable, granted: capture.appNotifications };
  const blocked = notificationsBlocked(notify);

  const [review, setReview] = useState<ReviewReminderState>({ enabled: true, scope: 'all' });
  useEffect(() => { void getReviewPref(getServiceDb()).then((pref) => setReview(reviewStateFromPref(pref))).catch(() => undefined); }, []);
  const changeReview = (next: ReviewReminderState) => {
    animate();
    setReview(next);
    // Turning reminders on while Android blocks notifications: ask now (Android 13+ dialog) or send to Settings if it was refused for good.
    if (shouldRequestNotificationPermission(next.enabled, notify)) void capture.toggleAppNotifications();
    void applyReviewPref(getServiceDb(), scope, reviewPrefFromState(next)).catch(() => undefined);
  };

  const [checkIn, setCheckIn] = useState<CheckInPrefs>({ enabled: true, time: '21:00' });
  const [pickTime, setPickTime] = useState(false);
  useEffect(() => { void getCheckInPrefs(getServiceDb()).then(setCheckIn).catch(() => undefined); }, []);
  const changeCheckIn = (change: Partial<CheckInPrefs>) => {
    if (change.enabled !== undefined) animate();
    setCheckIn((current) => ({ ...current, ...change }));
    // Ask for notification permission the moment the check-in is switched on (Android 13+ dialog, or Settings if refused for good).
    if (shouldRequestNotificationPermission(change.enabled === true, notify)) void capture.toggleAppNotifications();
    void applyCheckInChange(getServiceDb(), change).catch(() => undefined);
  };

  const reviewOn = switchShownOn(review.enabled, blocked);
  const checkInOn = switchShownOn(checkIn.enabled, blocked);
  const icon = (node: (p: { size: number; color: string }) => ReactNode) => node({ size: 18, color: palette.emerald });
  const currencyInfo = CURRENCIES.find((c) => c.code === currency);

  return <>
    <Reveal index={0}><AppearanceCard mode={mode} setMode={setMode} accent={accent} setAccent={setAccent} colors={colors} /></Reveal>
    <Reveal index={1}><Text style={{ color: colors.muted, marginTop: 10, marginLeft: 4, fontSize: 12 }}>Your choice is saved on this device. “System” follows your phone’s light/dark setting.</Text></Reveal>

    <Reveal index={2}><CaptureSourcesSection colors={colors} /></Reveal>

    <Reveal index={3}>
      <Group title="Notifications" colors={colors}>
        {blocked ? <ActionRow icon={icon((p) => <Bell {...p} />)} tone="warning" title="Notifications are blocked" subtitle="Velnora can’t remind you until notifications are allowed."
          action="Open settings" onPress={() => { openAppNotificationSettings(); }} colors={colors} /> : null}
        <SwitchRow icon={icon((p) => <Check {...p} />)} title="Review reminders" subtitle="Tell me when a payment needs a category" value={reviewOn} last={reviewOn}
          onValueChange={(enabled) => changeReview({ ...review, enabled })} colors={colors} />
        {reviewOn ? <Segmented label="Remind me about" options={REMIND_OPTIONS} value={review.scope} onChange={(next) => changeReview({ enabled: true, scope: next })} colors={colors} /> : null}
        <SwitchRow icon={icon((p) => <Bell {...p} />)} title="Daily check-in" subtitle="Ask me each evening if anything was missed" value={checkInOn} last={!checkInOn}
          onValueChange={(enabled) => changeCheckIn({ enabled })} colors={colors} />
        {checkInOn ? <ValueRow icon={icon((p) => <Clock {...p} />)} title="Check-in time" value={formatDisplayTime(checkIn.time)} onPress={() => setPickTime(true)} last colors={colors} /> : null}
      </Group>
    </Reveal>

    <Reveal index={4}>
      <Group title="General" colors={colors}>
        <ValueRow icon={<Text style={{ color: palette.accentText, fontWeight: '600', fontSize: 16 }}>{currencySymbol()}</Text>} title="Currency" value={currencyInfo ? `${currencyInfo.symbol.trim()} ${currencyInfo.code}` : currency} onPress={openCurrency} last colors={colors} />
      </Group>
    </Reveal>

    <TimePickerModal visible={pickTime} value={checkIn.time} colors={colors} title="Daily check-in time" onCancel={() => setPickTime(false)} onConfirm={(hm) => { setPickTime(false); changeCheckIn({ time: hm }); }} />
  </>;
}

/** Full-screen Settings page: Appearance, Automatic capture, Notifications, General. */
export function SettingsPage({ visible, onClose, colors, mode, setMode, accent, setAccent, scope, currency, setCurrency }: {
  visible: boolean; onClose: () => void; colors: Colors; mode: ThemeMode; setMode: (m: ThemeMode) => void; accent: AccentId; setAccent: (a: AccentId) => void;
  /** Signed-in user id, or null for guest data (scopes the review-reminder pass). */
  scope: string | null; currency: string; setCurrency: (c: string) => void;
}) {
  const [showCurrency, setShowCurrency] = useState(false);
  return <FullPage visible={visible} onClose={onClose} colors={colors} title="Settings" closeLabel="Close settings">
    <SettingsContent colors={colors} mode={mode} setMode={setMode} accent={accent} setAccent={setAccent} scope={scope} currency={currency} openCurrency={() => setShowCurrency(true)} />
    <CurrencySheet visible={showCurrency} onClose={() => setShowCurrency(false)} colors={colors} code={currency} setCode={setCurrency} />
  </FullPage>;
}

/** Full-screen Privacy & data page. `children` are the existing local-data deletion and SMS-processing sections. */
export function PrivacyPage({ visible, onClose, colors, deleteSection, smsSection }: { visible: boolean; onClose: () => void; colors: Colors; deleteSection: ReactNode; smsSection: ReactNode }) {
  return <FullPage visible={visible} onClose={onClose} colors={colors} title="Privacy & data" closeLabel="Close privacy and data">
    <Reveal index={0}><Group title="Your data on this device" colors={colors}>{deleteSection}</Group></Reveal>
    <Reveal index={1}><Group title="How messages are read" colors={colors}><View style={{ paddingHorizontal: 14 }}>{smsSection}</View></Group></Reveal>
    <Reveal index={2}>
      <Group title="Diagnostics" colors={colors}>
        {/* No clipboard library is installed, so this opens Android's share sheet, which has a Copy button. */}
        <ActionRow icon={<FileText size={18} color={palette.emerald} />} title="Copy diagnostics" subtitle="A log of recent sign-in and sync events to send when reporting a problem. Contains no tokens, passwords, e-mail addresses, account ids or amounts."
          action="Copy" onPress={() => { void Share.share({ message: diagnostics.format({ app: Constants.expoConfig?.version }) }).catch(() => undefined); }} last colors={colors} />
      </Group>
    </Reveal>
  </FullPage>;
}

/** Currency picker. Changes the symbol and number format only: amounts are not converted. */
export function CurrencySheet({ visible, onClose, colors, code, setCode }: { visible: boolean; onClose: () => void; colors: Colors; code: string; setCode: (c: string) => void }) {
  return <Sheet visible={visible} onClose={onClose} title="Currency" colors={colors}>
    <Text style={{ color: colors.muted, marginBottom: 12 }}>Choose how amounts are shown. Velnora does not convert between currencies; your recorded numbers stay the same.</Text>
    <Group title="Display currency" colors={colors}>
      {CURRENCIES.map((c, i) => <Tap key={c.code} onPress={() => { setCode(c.code); onClose(); }} label={c.name} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: i === CURRENCIES.length - 1 ? 0 : 1, borderBottomColor: colors.border }}>
        <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${palette.emerald}1F`, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.accentText, fontWeight: '700' }}>{c.symbol.trim()}</Text></View>
        <View style={{ flex: 1, marginLeft: 12 }}><Text style={{ color: colors.text, fontWeight: '700' }}>{c.name}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{c.code}</Text></View>
        {code === c.code ? <Check size={18} color={palette.emerald} /> : null}
      </Tap>)}
    </Group>
  </Sheet>;
}
