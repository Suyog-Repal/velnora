import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Animated, Easing, Pressable, Text, View } from 'react-native';
import { ACCENTS, palette, type AccentId, type ThemeMode } from '../../theme';
import { Bell, Check, ChevronRight, FileText, LogOut, MessageSquare, ReceiptIcon, Settings, Sliders, TagIcon as Tag, UserRound, WalletCards, WifiOff } from '../../icons';
import { currencySymbol, formatPaise, type Colors } from '../ui/common';
import { readableOn } from '../ui/common';
import { useSmsPermission } from '../ui/useSmsPermission';
import { useCapturePermissions } from '../ui/useCapturePermissions';
import { countsAsExpense } from '../services/ledgerRules';
import { getServiceDb } from '../services/transactionService';
import { getReviewPref, reviewPrefLabel, runReviewPass, setReviewPref, type ReviewNotificationPref } from '../services/reviewNotifications';
import { checkInLabel, getCheckInPrefs, setCheckInPrefs, syncCheckInSchedule, type CheckInPrefs } from '../services/dailyCheckIn';
import { TimePickerModal } from '../ui/TimePicker';
import { appNotificationsLabel, notificationAccessLabel, smsPermissionLabel } from '../services/smsPermissionPolicy';
import type { Session, TransactionEntity } from '../db/types';

/** Fades + lifts a block in; blocks are staggered by `index` so the page assembles instead of popping in. */
export function Reveal({ index, children }: { index: number; children: ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(v, { toValue: 1, duration: 420, delay: 60 + index * 70, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(); }, [v, index]);
  return <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] }}>{children}</Animated.View>;
}

/** Pressable that gives tactile feedback (springs down on press, back on release). */
export function Tap({ onPress, children, disabled, style, label }: { onPress?: () => void; children: ReactNode; disabled?: boolean; style?: object; label?: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) => Animated.spring(scale, { toValue: value, friction: 7, tension: 220, useNativeDriver: true }).start();
  return <Pressable disabled={disabled || !onPress} onPress={onPress} onPressIn={() => to(0.97)} onPressOut={() => to(1)} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label}>
    <Animated.View style={[{ transform: [{ scale }] }, style]}>{children}</Animated.View>
  </Pressable>;
}

export function Group({ title, colors, children }: { title: string; colors: Colors; children: ReactNode }) {
  return <View style={{ marginTop: 22 }}>
    <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 }}>{title.toUpperCase()}</Text>
    <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 20, overflow: 'hidden' }}>{children}</View>
  </View>;
}

export function Row({ icon, title, value, colors, onPress, last, tone }: { icon: ReactNode; title: string; value?: string; colors: Colors; onPress?: () => void; last?: boolean; tone?: 'danger' }) {
  const tint = tone === 'danger' ? palette.danger : palette.emerald;
  return <Tap onPress={onPress} label={title} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border }}>
    <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${tint}1F`, alignItems: 'center', justifyContent: 'center' }}>{icon}</View>
    <View style={{ flex: 1, marginLeft: 12 }}>
      <Text style={{ color: tone === 'danger' ? palette.expenseText : colors.text, fontWeight: '700', fontSize: 15 }}>{title}</Text>
      {value ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{value}</Text> : null}
    </View>
    {onPress ? <ChevronRight size={18} color={colors.muted} /> : null}
  </Tap>;
}

const MODES: { id: ThemeMode; label: string }[] = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System' }];

export function ModeSwitch({ mode, setMode, colors }: { mode: ThemeMode; setMode: (m: ThemeMode) => void; colors: Colors }) {
  const [width, setWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const index = MODES.findIndex((m) => m.id === mode);
  const inner = Math.max(0, width - 8);
  useEffect(() => { if (inner) Animated.spring(x, { toValue: index * (inner / MODES.length), friction: 9, tension: 120, useNativeDriver: true }).start(); }, [index, inner, x]);
  return <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', backgroundColor: colors.canvas, borderRadius: 14, padding: 4, borderWidth: 1, borderColor: colors.border }}>
    {inner > 0 ? <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 4, left: 4, width: inner / MODES.length, bottom: 4, borderRadius: 11, backgroundColor: palette.emerald, transform: [{ translateX: x }] }} /> : null}
    {MODES.map((m) => <Pressable key={m.id} onPress={() => setMode(m.id)} accessibilityRole="button" accessibilityState={{ selected: mode === m.id }} style={{ flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontWeight: '600', fontSize: 13, color: mode === m.id ? readableOn(palette.emerald) : colors.muted }}>{m.label}</Text>
    </Pressable>)}
  </View>;
}

export function Swatch({ id, main, label, active, onPress, colors }: { id: AccentId; main: string; label: string; active: boolean; onPress: () => void; colors: Colors }) {
  const s = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => { Animated.spring(s, { toValue: active ? 1 : 0, friction: 6, tension: 150, useNativeDriver: true }).start(); }, [active, s]);
  return <Pressable key={id} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label} theme`} accessibilityState={{ selected: active }} style={{ alignItems: 'center', flex: 1 }}>
    <Animated.View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: main, alignItems: 'center', justifyContent: 'center', transform: [{ scale: s.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] }) }], borderWidth: 3, borderColor: active ? colors.text : 'transparent' }}>
      <Animated.View style={{ opacity: s }}><Check size={18} color="#FFFFFF" /></Animated.View>
    </Animated.View>
    <Text style={{ color: active ? colors.text : colors.muted, fontSize: 12, fontWeight: '700', marginTop: 6 }}>{label}</Text>
  </Pressable>;
}

function Stat({ label, value, colors }: { label: string; value: string; colors: Colors }) {
  return <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
    <Text style={{ color: palette.onNavyMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.6 }}>{label}</Text>
    <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600', marginTop: 4 }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
  </View>;
}

export function AppearanceCard({ mode, setMode, accent, setAccent, colors }: { mode: ThemeMode; setMode: (m: ThemeMode) => void; accent: AccentId; setAccent: (a: AccentId) => void; colors: Colors }) {
  return <Group title="Appearance" colors={colors}>
    <View style={{ padding: 14 }}>
      <Text style={{ color: colors.text, fontWeight: '700', marginBottom: 10 }}>Theme</Text>
      <ModeSwitch mode={mode} setMode={setMode} colors={colors} />
      <Text style={{ color: colors.text, fontWeight: '700', marginTop: 18, marginBottom: 12 }}>Accent colour</Text>
      <View style={{ flexDirection: 'row' }}>{ACCENTS.map((a) => <Swatch key={a.id} id={a.id} main={a.main} label={a.label} active={accent === a.id} onPress={() => setAccent(a.id)} colors={colors} />)}</View>
    </View>
  </Group>;
}

export function profileStats(transactions: TransactionEntity[], now = new Date()) {
  let spentPaise = 0; let pending = 0; let failed = 0; let count = 0;
  for (const t of transactions) {
    if (t.deleted_at) continue;
    count += 1;
    if (t.sync_status !== 'synced' && t.user_id) pending += 1;
    if (t.sync_status === 'failed' && t.user_id) failed += 1; // rejected by the server: also counted in `pending`
    const d = new Date(t.transaction_date);
    if (countsAsExpense(t) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) spentPaise += t.amount_paise;
  }
  return { count, spentPaise, pending, failed };
}

export function ProfileView({ session, colors, mode, accent, transactions, online, onOpenSettings, onOpenCurrency, currencyLabel, onOpenCategories, onOpenAliases, onOpenReview, onOpenAccounts, onOpenImport, onOpenImportPdf, reviewCount, onSignIn, onCreate, onLogout, accountSections }: {
  session: Session | null; colors: Colors; mode: ThemeMode; accent: AccentId;
  transactions: TransactionEntity[]; online: boolean; onOpenSettings: () => void; onOpenCurrency: () => void; currencyLabel: string; onOpenCategories: () => void; onOpenAliases: () => void; onOpenReview: () => void; onOpenAccounts: () => void; onOpenImport: () => void; onOpenImportPdf: () => void; reviewCount: number; onSignIn: () => void; onCreate: () => void; onLogout: () => void;
  /** Real, existing account controls (delete local data, SMS status) rendered inside the Privacy card. */
  accountSections?: ReactNode;
}) {
  const stats = profileStats(transactions);
  const name = session?.user.full_name ?? 'Guest';
  const status = !session ? 'Guest · on this device' : !online ? 'Offline' : stats.pending > 0 ? `${stats.pending} waiting to sync${stats.failed > 0 ? ` (${stats.failed} rejected by server)` : ''}` : 'All synced';
  const avatarPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(avatarPulse, { toValue: 1, duration: 700, delay: 120, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true }).start(); }, [avatarPulse]);
  let i = 0;
  const sms = useSmsPermission();
  const capture = useCapturePermissions();
  const [reviewPref, setReviewPrefState] = useState<ReviewNotificationPref>('all');
  useEffect(() => { void getReviewPref(getServiceDb()).then(setReviewPrefState).catch(() => undefined); }, []);
  const cycleReviewPref = () => {
    const next: ReviewNotificationPref = reviewPref === 'all' ? 'duplicates' : reviewPref === 'duplicates' ? 'off' : 'all';
    setReviewPrefState(next);
    // Turning reminders on while Android blocks notifications: ask now (Android 13+ dialog) or send to Settings if it was refused for good.
    if (next !== 'off' && capture.appNotificationsAvailable && !capture.appNotifications) void capture.toggleAppNotifications();
    void setReviewPref(getServiceDb(), next).then(() => runReviewPass(getServiceDb(), session?.user.id ?? null)).catch(() => undefined);
  };
  const [checkIn, setCheckInState] = useState<CheckInPrefs>({ enabled: true, time: '21:00' });
  const [pickCheckInTime, setPickCheckInTime] = useState(false);
  useEffect(() => { void getCheckInPrefs(getServiceDb()).then(setCheckInState).catch(() => undefined); }, []);
  const updateCheckIn = (change: Partial<CheckInPrefs>) => {
    setCheckInState((current) => ({ ...current, ...change }));
    // Ask for notification permission the moment the check-in is switched on (Android 13+ dialog, or Settings if refused for good).
    if (change.enabled && capture.appNotificationsAvailable && !capture.appNotifications) void capture.toggleAppNotifications();
    void setCheckInPrefs(getServiceDb(), change).then(() => syncCheckInSchedule(getServiceDb())).catch(() => undefined);
  };
  // Granted → open Android's permission page to manage it. Not granted → ask; if that does not work, explain and offer Settings.
  const onSmsPress = () => {
    if (!sms.available) return;
    if (sms.granted) { sms.openSettings(); return; }
    void sms.requestWithGuidance(true);
  };

  return <View>
    <Reveal index={i++}>
      <View style={{ backgroundColor: palette.navy, borderRadius: 28, padding: 20, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', right: -40, top: -50, width: 180, height: 180, borderRadius: 90, backgroundColor: palette.emerald, opacity: 0.22 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Animated.View style={{ width: 68, height: 68, borderRadius: 34, backgroundColor: palette.emerald, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.35)', transform: [{ scale: avatarPulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }], opacity: avatarPulse }}>
            {session ? <Text style={{ color: '#FFFFFF', fontSize: 28, fontWeight: '700' }}>{name.charAt(0).toUpperCase()}</Text> : <UserRound size={30} color="#FFFFFF" />}
          </Animated.View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ color: '#FFFFFF', fontSize: 22, fontWeight: '700' }} numberOfLines={1}>{name}</Text>
            <Text style={{ color: palette.onNavySoft, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{session?.user.email ?? 'Not signed in'}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 14, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 }}>
          {session && !online ? <WifiOff size={12} color="#FFFFFF" /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: !session ? '#E8B95F' : stats.pending > 0 ? '#E8B95F' : '#4ADE80' }} />}
          <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700', marginLeft: 6 }}>{status}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <Stat label="TRANSACTIONS" value={String(stats.count)} colors={colors} />
          <Stat label="SPENT THIS MONTH" value={formatPaise(stats.spentPaise)} colors={colors} />
        </View>
      </View>
    </Reveal>

    {!session ? <Reveal index={i++}>
      <View style={{ marginTop: 16, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16 }}>
        <Text style={{ color: colors.text, fontWeight: '600', fontSize: 16 }}>Sync across devices</Text>
        <Text style={{ color: colors.muted, marginTop: 4, marginBottom: 12 }}>Your data is stored only on this device. Create a free account to back it up and sync. You choose what to import.</Text>
        <Tap onPress={onCreate} style={{ backgroundColor: palette.emerald, borderRadius: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: readableOn(palette.emerald), fontWeight: '700' }}>Create an account</Text></Tap>
        <Tap onPress={onSignIn} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}><Text style={{ color: palette.accentText, fontWeight: '700' }}>I already have an account</Text></Tap>
      </View>
    </Reveal> : null}

    <Reveal index={i++}>
      <Group title="Your data" colors={colors}>
        <Row icon={<Tag size={18} color={palette.emerald} />} title="Categories" value="Create, edit and organise" colors={colors} onPress={onOpenCategories} />
        <Row icon={<Sliders size={18} color={palette.emerald} />} title="Merchant names" value={session ? 'Corrections Velnora remembers' : 'Sign in to use'} colors={colors} onPress={onOpenAliases} />
        <Row icon={<Check size={18} color={palette.emerald} />} title="Review transactions" value={reviewCount > 0 ? `${reviewCount} missing a category or details` : 'Nothing to review'} colors={colors} onPress={onOpenReview} />
        <Row icon={<WalletCards size={18} color={palette.emerald} />} title="Accounts" value="Found from your bank messages" colors={colors} onPress={onOpenAccounts} />
        <Row icon={<ReceiptIcon size={18} color={palette.emerald} />} title="Import CSV" value="Add or match from a CSV file" colors={colors} onPress={onOpenImport} />
        <Row icon={<FileText size={18} color={palette.emerald} />} title="Import PDF Statement" value="Import transactions from your bank statement PDF." colors={colors} onPress={onOpenImportPdf} last />
      </Group>
    </Reveal>

    <Reveal index={i++}>
      <Group title="Preferences" colors={colors}>
        <Row icon={<Settings size={18} color={palette.emerald} />} title="Settings" value={`Theme · ${mode === 'system' ? 'System' : mode === 'dark' ? 'Dark' : 'Light'}, ${ACCENTS.find((x) => x.id === accent)?.label ?? ''} accent`} colors={colors} onPress={onOpenSettings} />
        <Row icon={<MessageSquare size={18} color={palette.emerald} />} title="Bank SMS detection" value={smsPermissionLabel(sms)} colors={colors} onPress={sms.available ? onSmsPress : undefined} />
        <Row icon={<WalletCards size={18} color={palette.emerald} />} title="Payment-app alerts" value={notificationAccessLabel({ available: capture.accessAvailable, granted: capture.access })} colors={colors} onPress={capture.accessAvailable ? () => { capture.openAccessSettings(); } : undefined} />
        <Row icon={<Bell size={18} color={palette.emerald} />} title="Velnora notifications" value={appNotificationsLabel({ available: capture.appNotificationsAvailable, granted: capture.appNotifications })} colors={colors} onPress={capture.appNotificationsAvailable ? () => { void capture.toggleAppNotifications(); } : undefined} />
        <Row icon={<Check size={18} color={palette.emerald} />} title="Review reminders" value={reviewPrefLabel(reviewPref, !capture.appNotificationsAvailable || capture.appNotifications)} colors={colors} onPress={cycleReviewPref} />
        <Row icon={<Bell size={18} color={palette.emerald} />} title="Daily check-in" value={checkInLabel(checkIn, !capture.appNotificationsAvailable || capture.appNotifications)} colors={colors} onPress={() => updateCheckIn({ enabled: !checkIn.enabled })} />
        {checkIn.enabled ? <Row icon={<Bell size={18} color={palette.emerald} />} title="Check-in time" value={checkInLabel({ enabled: true, time: checkIn.time })} colors={colors} onPress={() => setPickCheckInTime(true)} /> : null}
        <Row icon={<Text style={{ color: palette.accentText, fontWeight: '600', fontSize: 16 }}>{currencySymbol()}</Text>} title="Currency" value={currencyLabel} colors={colors} onPress={onOpenCurrency} last />
      </Group>
    </Reveal>

    {session && accountSections ? <Reveal index={i++}><Group title="Privacy & data" colors={colors}><View style={{ paddingHorizontal: 14 }}>{accountSections}</View></Group></Reveal> : null}

    {session ? <Reveal index={i++}>
      <View style={{ marginTop: 22 }}>
        <Tap onPress={() => Alert.alert('Sign out?', 'Your data stays on this device and syncs again when you sign back in.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: onLogout }])}
          label="Sign out" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: `${palette.danger}66`, backgroundColor: `${palette.danger}10` }}>
          <LogOut size={18} color={palette.danger} /><Text style={{ color: palette.expenseText, fontWeight: '700', marginLeft: 8 }}>Sign out</Text>
        </Tap>
      </View>
    </Reveal> : null}

    <TimePickerModal visible={pickCheckInTime} value={checkIn.time} colors={colors} title="Daily check-in time" onCancel={() => setPickCheckInTime(false)} onConfirm={(hm) => { setPickCheckInTime(false); updateCheckIn({ time: hm }); }} />

    <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 24, fontSize: 12 }}>Velnora · Personal Finance & Expense Tracker</Text>
  </View>;
}
