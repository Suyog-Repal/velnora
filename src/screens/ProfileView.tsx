import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Animated, Easing, Pressable, Text, View } from 'react-native';
import { ACCENTS, palette, type AccentId, type ThemeMode } from '../../theme';
import { Check, FileText, LogOut, ReceiptIcon, Settings, ShieldCheck, Sliders, TagIcon as Tag, UserRound, WalletCards, WifiOff } from '../../icons';
import { formatPaise, Sheet, type Colors } from '../ui/common';
import { readableOn } from '../ui/common';
import { Group, NavRow, Tap } from '../ui/rows';
import { PaymentDetailsSheet } from './PaymentDetails';
import { useReduceMotion } from '../ui/motion';
import { profileCashFigures, type CashFlowSummary, type LedgerHealth } from '../services/cashFlowService';
import type { Session, TransactionEntity } from '../db/types';

// Tap and Group now live with the shared rows; re-exported so existing imports keep working.
export { Group, Tap };

/** Fades + lifts a block in; blocks are staggered by `index` so the page assembles instead of popping in. */
export function Reveal({ index, children }: { index: number; children: ReactNode }) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) { v.setValue(1); return; }
    Animated.timing(v, { toValue: 1, duration: 420, delay: 60 + index * 70, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [v, index, reduce]);
  return <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] }}>{children}</Animated.View>;
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

/** Sync status of the loaded rows. Money and the transaction total are not worked out here: see profileCashFigures. */
export function profileStats(transactions: TransactionEntity[]) {
  let pending = 0; let failed = 0;
  for (const t of transactions) {
    if (t.deleted_at) continue;
    if (t.sync_status !== 'synced' && t.user_id) pending += 1;
    if (t.sync_status === 'failed' && t.user_id) failed += 1; // rejected by the server: also counted in `pending`
  }
  return { pending, failed };
}

export function ProfileView({ session, displayName, onEditName, colors, transactions, cashFlow, health, online, onOpenSettings, onOpenPrivacy, onOpenCategories, onOpenAliases, onOpenReview, onOpenAccounts, onOpenImport, onOpenImportPdf, reviewCount, onSignIn, onCreate, onLogout }: {
  session: Session | null; displayName: string | null; onEditName: () => void; colors: Colors;
  transactions: TransactionEntity[]; cashFlow: CashFlowSummary; health: LedgerHealth; online: boolean; onOpenSettings: () => void; onOpenPrivacy: () => void; onOpenCategories: () => void; onOpenAliases: () => void; onOpenReview: () => void; onOpenAccounts: () => void; onOpenImport: () => void; onOpenImportPdf: () => void; reviewCount: number; onSignIn: () => void; onCreate: () => void; onLogout: () => void;
}) {
  const stats = profileStats(transactions);
  const cash = profileCashFigures(cashFlow, health);
  const status = !session ? 'Stored on this device only' : !online ? 'Offline' : stats.pending > 0 ? `${stats.pending} waiting to sync${stats.failed > 0 ? ` (${stats.failed} rejected by server)` : ''}` : 'All synced';
  const avatarPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(avatarPulse, { toValue: 1, duration: 700, delay: 120, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true }).start(); }, [avatarPulse]);
  let i = 0;
  const [importChoice, setImportChoice] = useState(false);
  const [showPay, setShowPay] = useState(false);
  // Close the choice first, then open the chosen import flow (both are modal sheets).
  const chooseImport = (open: () => void) => { setImportChoice(false); open(); };

  return <View>
    <Reveal index={i++}>
      <View style={{ backgroundColor: palette.navy, borderRadius: 28, padding: 20, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', right: -40, top: -50, width: 180, height: 180, borderRadius: 90, backgroundColor: palette.emerald, opacity: 0.22 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Animated.View style={{ width: 68, height: 68, borderRadius: 34, backgroundColor: palette.emerald, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.35)', transform: [{ scale: avatarPulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }], opacity: avatarPulse }}>
            {displayName ? <Text style={{ color: '#FFFFFF', fontSize: 28, fontWeight: '700' }}>{Array.from(displayName)[0].toUpperCase()}</Text> : <UserRound size={30} color="#FFFFFF" />}
          </Animated.View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Pressable onPress={onEditName} accessibilityRole="button" accessibilityLabel={displayName ? `Name: ${displayName}. Edit` : 'Add your name'} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
              {displayName ? <Text style={{ color: '#FFFFFF', fontSize: 20, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>{displayName}</Text> : null}
              <Text style={{ color: palette.onNavySoft, fontSize: 13, marginLeft: displayName ? 10 : 0 }}>{displayName ? 'Edit' : 'Add your name'}</Text>
            </Pressable>
            <Text style={{ color: palette.onNavySoft, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{session?.user.email ?? 'Not signed in'}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 14, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 }}>
          {session && !online ? <WifiOff size={12} color="#FFFFFF" /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: !session ? '#E8B95F' : stats.pending > 0 ? '#E8B95F' : '#4ADE80' }} />}
          <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700', marginLeft: 6 }}>{status}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <Stat label="TRANSACTIONS" value={String(cash.transactionCount)} colors={colors} />
          <Stat label="SPENT THIS MONTH" value={formatPaise(cash.spentPaise)} colors={colors} />
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
        <NavRow icon={<Tag size={18} color={palette.emerald} />} title="Categories" subtitle="Create, edit and organise" colors={colors} onPress={onOpenCategories} />
        <NavRow icon={<Sliders size={18} color={palette.emerald} />} title="Merchant names" subtitle="Corrections Velnora remembers" colors={colors} onPress={onOpenAliases} />
        <NavRow icon={<Check size={18} color={palette.emerald} />} title="Review transactions" subtitle="Payments that need a category or details" badge={reviewCount} colors={colors} onPress={onOpenReview} />
        <NavRow icon={<WalletCards size={18} color={palette.emerald} />} title="Accounts" subtitle="Found from your bank messages" colors={colors} onPress={onOpenAccounts} />
        <NavRow icon={<ReceiptIcon size={18} color={palette.emerald} />} title="Payment details" subtitle="Your UPI ID and QR for payment requests" colors={colors} onPress={() => setShowPay(true)} />
        <NavRow icon={<FileText size={18} color={palette.emerald} />} title="Import" subtitle="From a CSV file or a PDF statement" colors={colors} onPress={() => setImportChoice(true)} last />
      </Group>
    </Reveal>

    <Reveal index={i++}>
      <Group colors={colors}>
        <NavRow icon={<Settings size={18} color={palette.emerald} />} title="Settings" subtitle="Appearance, capture, notifications, currency" colors={colors} onPress={onOpenSettings} last={!session} />
        {session ? <NavRow icon={<ShieldCheck size={18} color={palette.emerald} />} title="Privacy & data" subtitle="Delete local data, how messages are read" colors={colors} onPress={onOpenPrivacy} last /> : null}
      </Group>
    </Reveal>

    {session ? <Reveal index={i++}>
      <View style={{ marginTop: 22 }}>
        <Tap onPress={() => Alert.alert('Sign out?', 'Your data stays on this device and syncs again when you sign back in.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: onLogout }])}
          label="Sign out" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: `${palette.danger}66`, backgroundColor: `${palette.danger}10` }}>
          <LogOut size={18} color={palette.danger} /><Text style={{ color: palette.expenseText, fontWeight: '700', marginLeft: 8 }}>Sign out</Text>
        </Tap>
      </View>
    </Reveal> : null}

    <PaymentDetailsSheet visible={showPay} onClose={() => setShowPay(false)} scope={session?.user.id ?? null} colors={colors} />
    <Sheet visible={importChoice} onClose={() => setImportChoice(false)} title="Import transactions" colors={colors}>
      <Group colors={colors}>
        <NavRow icon={<ReceiptIcon size={18} color={palette.emerald} />} title="CSV file" subtitle="Add or match from a CSV file" colors={colors} onPress={() => chooseImport(onOpenImport)} />
        <NavRow icon={<FileText size={18} color={palette.emerald} />} title="PDF statement" subtitle="Import from your bank statement PDF" colors={colors} onPress={() => chooseImport(onOpenImportPdf)} last />
      </Group>
    </Sheet>

    <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 24, fontSize: 12 }}>Velnora · Personal Finance & Expense Tracker</Text>
  </View>;
}
