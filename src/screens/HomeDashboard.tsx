/**
 * Home dashboard (theme redesign). Presentation only: every figure comes from the existing calculations
 * (CashFlowSummary for the balance and monthly totals, LedgerHealth for "Today") and every action calls an existing flow
 * passed in by App. Colours come from the theme tokens, so the same components serve the dark and light themes.
 */
import { memo, useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palette, radius, space, tint } from '../../theme';
import { type } from '../../typography';
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, Bell, CalendarDays, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff,
  FileChart, Info, Plus, Search, Sliders as SlidersHorizontal, TrendingUp, Users, WifiOff,
} from '../../icons';
import { Sheet, readableOn, type Colors } from '../ui/common';
import { formatMinor } from '../ui/currency';
import type { CashFlowSummary, LedgerHealth } from '../services/cashFlowService';
import {
  DEFAULT_QUICK_ACCESS, QUICK_ACCESS_LABELS, QUICK_ACCESS_STORAGE_KEY, move, normalizeQuickAccess, reviewCta, serializeQuickAccess,
  setVisible, todaySummaryLine, visibleShortcuts, type QuickAccessId, type QuickAccessItem,
} from '../services/quickAccess';

export const HIDE_BALANCE_STORAGE_KEY = 'velnora.home.hideBalance.v1';
const HIDDEN_AMOUNT = '••••••';

// ---------------------------------------------------------------------------------------------------------------- Header
export function HomeHeader({ greeting, initial, reviewCount, colors, dark, onProfile, onSearch, onNotifications }: {
  greeting: string; initial: string; reviewCount: number; colors: Colors; dark: boolean;
  onProfile: () => void; onSearch: () => void; onNotifications: () => void;
}) {
  const round = (pressed: boolean) => [s.headerBtn, { backgroundColor: pressed ? tint(palette.emerald, 0.16) : colors.card, borderColor: colors.border }];
  return <View style={s.header}>
    <Pressable onPress={onProfile} accessibilityRole="button" accessibilityLabel="Open profile" hitSlop={4}
      style={({ pressed }) => [s.avatar, { backgroundColor: dark ? palette.emeraldSoft : palette.emeraldSoft, borderColor: tint(palette.emerald, 0.35), opacity: pressed ? 0.8 : 1 }]}>
      <Text style={[type.cardTitle, { color: palette.accentText }]}>{initial}</Text>
    </Pressable>
    <View style={s.headerText}>
      <Text style={[type.overline, { color: palette.accentText }]}>VELNORA</Text>
      <Text style={[type.heading, { color: colors.text, marginTop: 2 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{greeting}</Text>
    </View>
    <Pressable onPress={onSearch} accessibilityRole="button" accessibilityLabel="Search transactions" hitSlop={4} style={({ pressed }) => round(pressed)}>
      <Search color={colors.text} size={20} strokeWidth={2} />
    </Pressable>
    <Pressable onPress={onNotifications} hitSlop={4} style={({ pressed }) => round(pressed)} accessibilityRole="button"
      accessibilityLabel={reviewCount > 0 ? `Review queue, ${reviewCount} transaction${reviewCount === 1 ? '' : 's'} to review` : 'Review queue'}>
      <Bell color={colors.text} size={20} strokeWidth={2} />
      {reviewCount > 0 ? <View style={[s.badge, { borderColor: colors.canvas }]}><Text style={s.badgeText}>{reviewCount > 99 ? '99+' : reviewCount}</Text></View> : null}
    </Pressable>
  </View>;
}

// ------------------------------------------------------------------------------------------------------- Offline status
/** Compact status line. Shown only in the existing offline condition (no invented "online" badge). */
export function SyncStatus({ offline, colors }: { offline: boolean; colors: Colors }) {
  if (!offline) return null;
  return <View style={s.status} accessibilityRole="text" accessibilityLiveRegion="polite">
    <WifiOff color={colors.muted} size={14} strokeWidth={2} />
    <Text style={[type.caption, { color: colors.muted, flex: 1 }]} numberOfLines={2}>
      <Text style={{ color: colors.text, fontWeight: '600' }}>Offline</Text> · Working from local data; sync resumes when you reconnect.
    </Text>
  </View>;
}

// ------------------------------------------------------------------------------------------------------ Recorded balance
export const RecordedBalanceCard = memo(function RecordedBalanceCard({ balancePaise, colors, dark }: { balancePaise: number; colors: Colors; dark: boolean }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => { AsyncStorage.getItem(HIDE_BALANCE_STORAGE_KEY).then((v) => setHidden(v === '1')).catch(() => undefined); }, []);
  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    AsyncStorage.setItem(HIDE_BALANCE_STORAGE_KEY, next ? '1' : '0').catch(() => undefined);
  };
  const explain = () => Alert.alert('Recorded balance',
    'All income minus all expenses you have recorded in Velnora (added by you, imported, or detected from bank messages). It is not read from your bank, so it can differ from your actual account balance.');
  // Dark: restrained emerald-charcoal surface. Light: a clean emerald tint. Solid (no gradient layer to mis-size).
  const surface = dark ? '#13271F' : '#EAF6F0';
  const ink = dark ? palette.darkText : palette.ink;
  const sub = dark ? palette.darkMuted : palette.muted;
  const negative = balancePaise < 0;
  const amount = hidden ? HIDDEN_AMOUNT : formatMinor(balancePaise);
  return <View style={[s.balance, { backgroundColor: surface, borderColor: dark ? '#24493C' : '#CDEBDD' }]}
    accessible accessibilityLabel={`Recorded balance ${hidden ? 'hidden' : amount}. Based on transactions recorded in Velnora. Not a verified bank balance.`}>
    <View style={s.balanceTop}>
      <Pressable onPress={explain} accessibilityRole="button" accessibilityLabel="What is the recorded balance?" hitSlop={8} style={s.balanceTitle}>
        <Text style={[type.cardTitle, { color: ink }]}>Recorded Balance</Text>
        <Info color={sub} size={16} strokeWidth={2} />
      </Pressable>
      <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'} hitSlop={10} style={s.eye}>
        {hidden ? <EyeOff color={sub} size={20} strokeWidth={2} /> : <Eye color={sub} size={20} strokeWidth={2} />}
      </Pressable>
    </View>
    <Text style={[type.amountHero, { color: negative && !hidden ? palette.expenseText : ink, marginTop: space.sm }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{amount}</Text>
    <Text style={[type.caption, { color: sub, marginTop: space.sm }]}>Based on transactions recorded in Velnora.</Text>
    <View style={[s.disclaimer, { backgroundColor: dark ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.85)', borderColor: dark ? 'rgba(255,255,255,0.06)' : '#D7EEE3' }]}>
      <Info color={palette.accentText} size={13} strokeWidth={2.2} />
      <Text style={[type.captionStrong, { color: ink }]}>Not a verified bank balance.</Text>
    </View>
  </View>;
});

// ------------------------------------------------------------------------------------------------ Income / expenses month
function SummaryCard({ title, value, color, Icon, colors, onPress, hint, footer }: { footer?: ReactNode; title: string; value: string; color: string; Icon: typeof ArrowDownLeft; colors: Colors; onPress: () => void; hint: string }) {
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title} this month, ${value}`} accessibilityHint={hint}
    android_ripple={{ color: tint(color, 0.12) }}
    style={({ pressed }) => [s.summary, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] }]}>
    <View style={s.summaryHead}>
      <View style={[s.summaryIcon, { backgroundColor: tint(color, 0.14) }]}><Icon color={color} size={16} strokeWidth={2.2} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[type.captionStrong, { color: colors.text }]} numberOfLines={1}>{title}</Text>
        <Text style={[type.caption, { color: colors.muted }]} numberOfLines={1}>This month</Text>
      </View>
      <ChevronRight color={colors.faint ?? colors.muted} size={16} strokeWidth={2} />
    </View>
    <Text style={[type.amountMd, { color, marginTop: space.md }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{value}</Text>
    {footer}
  </Pressable>;
}

export const MonthlySummary = memo(function MonthlySummary({ cashFlow, colors, onIncome, onExpenses, owedBackPaise = 0, onOwedBack }: { cashFlow: CashFlowSummary; colors: Colors; onIncome: () => void; onExpenses: () => void; owedBackPaise?: number; onOwedBack?: () => void }) {
  return <View style={s.summaryRow}>
    <SummaryCard title="Income" value={formatMinor(cashFlow.monthIncomePaise)} color={palette.accentText} Icon={ArrowDownLeft} colors={colors} onPress={onIncome} hint="Shows your income transactions" />
    <SummaryCard title="Expenses" value={formatMinor(cashFlow.monthExpensePaise)} color={palette.expenseText} Icon={ArrowUpRight} colors={colors} onPress={onExpenses} hint="Shows your expense transactions"
      footer={owedBackPaise > 0 && onOwedBack ? <Pressable onPress={onOwedBack} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${formatMinor(owedBackPaise)} owed back by friends. Open Friends`} style={{ marginTop: space.sm }}>
        <Text style={[type.caption, { color: palette.accentText }]} numberOfLines={1}>{formatMinor(owedBackPaise)} owed back by friends</Text>
      </Pressable> : null} />
  </View>;
});

// ------------------------------------------------------------------------------------------------------------ Quick Access
const QUICK_ICON: Record<QuickAccessId, typeof Plus> = { add: Plus, split: Users, expected: CalendarDays, report: FileChart };
/** Two-line tile captions (the Customize list uses the single-line QUICK_ACCESS_LABELS). */
const TILE_LABEL: Record<QuickAccessId, string> = {
  add: 'Add\nTransaction', split: 'Split', expected: 'Expected\nPayment', report: 'Monthly\nReport',
};
const quickColor = (id: QuickAccessId): string => (id === 'add' ? palette.accentText : id === 'split' ? palette.amber : id === 'expected' ? palette.info : palette.report);

function QuickAccessTile({ id, colors, onPress }: { id: QuickAccessId; colors: Colors; onPress: () => void }) {
  const Icon = QUICK_ICON[id];
  const color = quickColor(id);
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={QUICK_ACCESS_LABELS[id]} android_ripple={{ color: tint(color, 0.14), borderless: false }}
    style={({ pressed }) => [s.tile, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.88 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
    <View style={[s.tileIcon, { backgroundColor: tint(color, 0.16) }]}><Icon color={color} size={20} strokeWidth={2} /></View>
    <Text style={[s.tileLabel, { color: colors.text }]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.85}>{TILE_LABEL[id]}</Text>
  </Pressable>;
}

export const QuickAccessSection = memo(function QuickAccessSection({ colors, onAction }: { colors: Colors; onAction: (id: QuickAccessId) => void }) {
  const [items, setItems] = useState<QuickAccessItem[]>(() => DEFAULT_QUICK_ACCESS.map((i) => ({ ...i })));
  const [editing, setEditing] = useState(false);
  useEffect(() => { AsyncStorage.getItem(QUICK_ACCESS_STORAGE_KEY).then((v) => { if (v) setItems(normalizeQuickAccess(v)); }).catch(() => undefined); }, []);
  const save = (next: QuickAccessItem[]) => { setItems(next); AsyncStorage.setItem(QUICK_ACCESS_STORAGE_KEY, serializeQuickAccess(next)).catch(() => undefined); };
  const shown = visibleShortcuts(items);
  return <View>
    <View style={s.sectionHead}>
      <Text style={[type.section, { color: colors.text }]}>Quick Access</Text>
      <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel="Customize quick access" hitSlop={8} style={s.customize}>
        <SlidersHorizontal color={colors.muted} size={16} strokeWidth={2} />
        <Text style={[type.captionStrong, { color: colors.muted }]}>Customize</Text>
      </Pressable>
    </View>
    {shown.length ? <View style={s.tiles}>{shown.map((id) => <QuickAccessTile key={id} id={id} colors={colors} onPress={() => onAction(id)} />)}</View>
      : <Pressable onPress={() => setEditing(true)} style={[s.emptyTiles, { borderColor: colors.border }]} accessibilityRole="button">
        <Text style={[type.caption, { color: colors.muted }]}>All shortcuts are hidden. Tap to choose which ones to show.</Text>
      </Pressable>}
    <Sheet visible={editing} onClose={() => setEditing(false)} title="Customize Quick Access" colors={colors}>
      <Text style={[type.caption, { color: colors.muted, marginBottom: space.md }]}>Choose which shortcuts appear on Home and their order. Saved on this device.</Text>
      {items.map((item, i) => {
        const Icon = QUICK_ICON[item.id]; const color = quickColor(item.id);
        return <View key={item.id} style={[s.editRow, { borderBottomColor: colors.border, borderBottomWidth: i === items.length - 1 ? 0 : 1 }]}>
          <View style={[s.tileIcon, { width: 36, height: 36, backgroundColor: tint(color, 0.16) }]}><Icon color={color} size={18} strokeWidth={2} /></View>
          <Text style={[type.bodyStrong, { color: colors.text, flex: 1 }]}>{QUICK_ACCESS_LABELS[item.id]}</Text>
          <Pressable onPress={() => save(move(items, item.id, -1))} disabled={i === 0} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Move ${QUICK_ACCESS_LABELS[item.id]} up`} style={[s.moveBtn, { opacity: i === 0 ? 0.3 : 1 }]}>
            <ChevronUp color={colors.text} size={18} />
          </Pressable>
          <Pressable onPress={() => save(move(items, item.id, 1))} disabled={i === items.length - 1} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Move ${QUICK_ACCESS_LABELS[item.id]} down`} style={[s.moveBtn, { opacity: i === items.length - 1 ? 0.3 : 1 }]}>
            <ChevronDown color={colors.text} size={18} />
          </Pressable>
          <Switch value={item.visible} onValueChange={(v) => save(setVisible(items, item.id, v))} accessibilityLabel={`Show ${QUICK_ACCESS_LABELS[item.id]}`}
            trackColor={{ true: tint(palette.emerald, 0.55), false: colors.border }} thumbColor={item.visible ? palette.emerald : colors.muted} />
        </View>;
      })}
      <Pressable onPress={() => save(DEFAULT_QUICK_ACCESS.map((x) => ({ ...x })))} accessibilityRole="button" style={{ marginTop: space.lg, alignSelf: 'flex-start' }}>
        <Text style={[type.link, { color: palette.accentText }]}>Reset to default</Text>
      </Pressable>
    </Sheet>
  </View>;
});

// ------------------------------------------------------------------------------------------------------------------ Today
export const TodayActivityCard = memo(function TodayActivityCard({ health, colors, dark, onReview, onOpenList }: { health: LedgerHealth; colors: Colors; dark: boolean; onReview: () => void; onOpenList: () => void }) {
  const row = (icon: ReactNode, text: ReactNode) => <View style={s.todayRow}>{icon}<Text style={[type.caption, { color: colors.muted, flex: 1 }]}>{text}</Text></View>;
  return <View style={[s.today, { backgroundColor: colors.card, borderColor: colors.border }]}>
    <Pressable onPress={onOpenList} accessibilityRole="button" accessibilityLabel="Today. Open transactions" style={s.todayHead}>
      <View style={[s.summaryIcon, { width: 34, height: 34, backgroundColor: colors.canvas2 ?? colors.canvas }]}><CalendarDays color={colors.text} size={18} strokeWidth={2} /></View>
      <View style={{ flex: 1 }}>
        <Text style={[type.cardTitle, { color: colors.text }]}>Today</Text>
        <Text style={[type.caption, { color: colors.muted, marginTop: 2 }]}>
          In <Text style={{ color: palette.accentText, fontWeight: '600' }}>{formatMinor(health.todayIncomePaise)}</Text>
          {' · '}Out <Text style={{ color: palette.expenseText, fontWeight: '600' }}>{formatMinor(health.todayExpensePaise)}</Text>
          {' · '}Net <Text style={{ color: colors.text, fontWeight: '600' }}>{formatMinor(health.todayNetPaise)}</Text>
        </Text>
      </View>
      <ChevronRight color={colors.muted} size={18} strokeWidth={2} />
    </Pressable>
    {row(<TrendingUp color={colors.muted} size={15} strokeWidth={2} />, todaySummaryLine(health))}
    {health.monthUnverifiedExpensePaise > 0 ? <View style={[s.notice, { backgroundColor: dark ? colors.elevated ?? colors.canvas : colors.canvas2 ?? colors.canvas }]}>
      <Info color={colors.muted} size={16} strokeWidth={2} />
      <Text style={[type.caption, { color: colors.text, flex: 1 }]}>{formatMinor(health.monthUnverifiedExpensePaise)} of this month's spending is detected and not yet confirmed.</Text>
    </View> : null}
    {health.needsReviewCount > 0 ? <Pressable onPress={onReview} accessibilityRole="button" hitSlop={6} style={s.reviewCta}>
      <Text style={[type.link, { color: palette.accentText }]}>{reviewCta(health.needsReviewCount)}</Text>
      <ArrowRight color={palette.accentText} size={17} strokeWidth={2.2} />
    </Pressable> : null}
  </View>;
});

/** Floating add button: the existing transaction form, visually secondary to Quick Access. */
export function fabColors(): { bg: string; fg: string } {
  return { bg: palette.emerald, fg: readableOn(palette.emerald) };
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerText: { flex: 1, minWidth: 0 },
  headerBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: '#D9434F', borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 10.5, lineHeight: 13, fontWeight: '700' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.md },
  balance: { borderRadius: radius.xl, borderWidth: 1, padding: space.xl, overflow: 'hidden' },
  balanceTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  balanceTitle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  eye: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  disclaimer: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: space.md, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1 },
  summaryRow: { flexDirection: 'row', gap: space.md, marginTop: space.md },
  summary: { flex: 1, minWidth: 0, borderRadius: radius.lg, borderWidth: 1, padding: 14, overflow: 'hidden' },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xxl, marginBottom: space.md },
  customize: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, minWidth: 0, minHeight: 104, borderRadius: radius.lg, borderWidth: 1, paddingVertical: 14, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'flex-start', gap: 9, overflow: 'hidden' },
  tileIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { ...type.captionStrong, textAlign: 'center' },
  emptyTiles: { borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.lg, padding: space.lg },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  moveBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  today: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, marginTop: space.lg, gap: space.md },
  todayHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  todayRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  reviewCta: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 40 },
});
