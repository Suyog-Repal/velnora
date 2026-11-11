import { memo, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { palette, radius, tint } from '../../theme';
import { typo } from '../../typography';
import { ArrowDownLeft, ArrowUpRight, CalendarDays, MapPin, ReceiptIcon, Search, WifiOff, X } from '../../icons';
import { Button, CategoryIcon, Chip, EmptyBlock, SearchField, SectionLabel, Sheet, formatPaise, type Colors } from '../ui/common';
import { DateRangeFields } from '../ui/CalendarDatePicker';
import { formatRange, inDateRange, validateRange } from '../services/dateUtils';
import { sourceLabel } from '../services/ledgerRules';
import type { CategoryView } from '../services/categoryService';
import type { TransactionEntity } from '../db/types';

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** `from` / `to` are inclusive local calendar dates (YYYY-MM-DD) matched against the transaction's own date. */
export function filterTransactions(items: TransactionEntity[], f: { type: 'all' | 'income' | 'expense'; category: string | null; query: string; from?: string | null; to?: string | null }): TransactionEntity[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((t) =>
    !t.deleted_at &&
    (f.type === 'all' || t.direction === f.type) &&
    (!f.category || t.category.toLowerCase() === f.category.toLowerCase()) &&
    inDateRange(t.transaction_date, f.from, f.to) &&
    (!q || t.counterparty.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q) || t.category.toLowerCase().includes(q)));
}

type RowProps = { tx: TransactionEntity; color: string; icon?: string | null; colors: Colors; onPress: () => void; /** Inside a grouped list card: flat row with a divider instead of its own bordered card. */ grouped?: boolean; last?: boolean };

function TransactionCardBase({ tx, color, icon, colors, onPress, grouped, last }: RowProps) {
  const income = tx.direction === 'income';
  const time = new Date(tx.transaction_date).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const hasLoc = tx.location_lat != null && tx.location_lng != null;
  const hasReceipt = !!(tx.receipt_local_path || tx.receipt_remote_id);
  const needsReview = tx.verification_status === 'needs_review';
  const syncLabel = tx.user_id && tx.sync_status !== 'synced' ? (tx.sync_status === 'failed' ? 'Sync failed' : 'Pending sync') : null;
  const source = sourceLabel(tx);
  const detected = source !== 'MANUAL';
  const base = grouped
    ? { borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border, paddingVertical: 12 }
    : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 14, marginBottom: 10 };
  const amountText = `${income ? '+' : '-'}${formatPaise(tx.amount_paise)}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${income ? 'Income' : 'Expense'}, ${tx.counterparty}, ${tx.category}, ${formatPaise(tx.amount_paise)}${needsReview ? ', needs review' : ''}${syncLabel ? `, ${syncLabel.toLowerCase()}` : ''}`} onPress={onPress}
    android_ripple={{ color: tint(palette.emerald, 0.1) }}
    style={[{ flexDirection: 'row', alignItems: 'center', minHeight: 64 }, base]}>
    <CategoryIcon icon={icon} label={tx.counterparty} color={color} />
    <View style={{ flex: 1, marginHorizontal: 12, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ ...typo.cardTitle, color: colors.text }}>{tx.counterparty}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
        <Text numberOfLines={1} style={{ ...typo.caption, color: colors.muted, flexShrink: 1 }}>{tx.category} · {time}{tx.payment_method ? ` · ${tx.payment_method}` : ''}</Text>
        {hasLoc ? <View style={{ marginLeft: 6 }} accessibilityLabel="Has location"><MapPin size={12} color={colors.muted} /></View> : null}
        {hasReceipt ? <View style={{ marginLeft: 6 }} accessibilityLabel="Has receipt"><ReceiptIcon size={12} color={colors.muted} /></View> : null}
      </View>
      {detected ? <Text numberOfLines={1} style={{ ...typo.captionStrong, color: palette.accentText, marginTop: 2 }}>{source}</Text> : null}
    </View>
    <View style={{ alignItems: 'flex-end', flexShrink: 0, maxWidth: '42%' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {income ? <ArrowDownLeft size={14} color={palette.accentText} /> : <ArrowUpRight size={14} color={palette.expenseText} />}
        <Text style={{ ...typo.amountSm, color: income ? palette.accentText : palette.expenseText, marginLeft: 2, flexShrink: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{amountText}</Text>
      </View>
      {needsReview ? <View style={{ marginTop: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: tint(palette.warning, 0.16) }}><Text style={{ ...typo.captionStrong, color: palette.expenseText }}>Needs review</Text></View> : null}
      {syncLabel ? <Text style={{ ...typo.caption, color: tx.sync_status === 'failed' ? palette.expenseText : colors.muted, marginTop: needsReview ? 2 : 4 }}>{syncLabel}</Text> : null}
    </View>
  </Pressable>;
}
export const TransactionCard = memo(TransactionCardBase);

export function TransactionsView({ transactions, categories, colors, loading, online, onOpen, onAdd, initialCategory }: {
  transactions: TransactionEntity[]; categories: CategoryView[]; colors: Colors; loading: boolean; online: boolean;
  onOpen: (tx: TransactionEntity) => void; onAdd: () => void; initialCategory?: string | null;
}) {
  const [type, setType] = useState<'all' | 'income' | 'expense'>('all');
  const [category, setCategory] = useState<string | null>(initialCategory ?? null);
  const [query, setQuery] = useState('');
  // Applied date range (inclusive, local calendar dates) and the draft being edited in the sheet.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [showDates, setShowDates] = useState(false);
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const draftCheck = validateRange(draft.from, draft.to);
  const colorOf = useMemo(() => new Map(categories.map((c) => [c.name.toLowerCase(), c.color])), [categories]);
  const iconOf = useMemo(() => new Map(categories.map((c) => [c.name.toLowerCase(), c.icon])), [categories]);
  const shown = useMemo(() => filterTransactions(transactions, { type, category, query, from: range?.from, to: range?.to }), [transactions, type, category, query, range]);
  const groups = useMemo(() => {
    const out: { label: string; items: TransactionEntity[] }[] = [];
    for (const t of shown) {
      const label = dayLabel(t.transaction_date);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(t); else out.push({ label, items: [t] });
    }
    return out;
  }, [shown]);
  const usedCategories = useMemo(() => [...new Set(transactions.filter((t) => !t.deleted_at).map((t) => t.category))].sort(), [transactions]);

  const filtersActive = type !== 'all' || !!category || !!range || !!query.trim();
  const clearAll = () => { setType('all'); setCategory(null); setRange(null); setQuery(''); };
  const TYPES = [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']] as const;
  return <View>
    {!online ? <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}><WifiOff size={14} color={colors.muted} /><Text style={{ ...typo.caption, color: colors.muted, marginLeft: 6 }}>Offline · showing data saved on this device</Text></View> : null}
    <SearchField colors={colors} value={query} onChangeText={setQuery} placeholder="Search merchant, category or note" accessibilityLabel="Search transactions" />
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: tint(palette.emerald, 0.1), borderRadius: radius.pill, padding: 3, marginBottom: 12 }}>
      {TYPES.map(([k, label]) => { const on = type === k; return <Pressable key={k} onPress={() => setType(k)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={label}
        style={{ flex: 1, minHeight: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.card : 'transparent', borderWidth: on ? 1 : 0, borderColor: colors.border }}>
        <Text style={{ ...typo.chip, color: on ? palette.accentText : colors.muted }}>{label}</Text></Pressable>; })}
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
      <Pressable onPress={() => { setDraft({ from: range?.from ?? null, to: range?.to ?? null }); setShowDates(true); }} accessibilityRole="button" accessibilityLabel={range ? `Date filter: ${formatRange(range.from, range.to)}` : 'Filter by date range'}
        style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: range ? palette.emerald : colors.border, backgroundColor: range ? tint(palette.emerald, 0.12) : colors.card, borderRadius: 20, paddingHorizontal: 14, minHeight: 40 }}>
        <CalendarDays size={16} color={range ? palette.accentText : colors.muted} />
        <Text numberOfLines={1} style={{ marginLeft: 8, color: range ? colors.text : colors.muted, ...typo.chip, flexShrink: 1 }}>{range ? formatRange(range.from, range.to) : 'All dates'}</Text>
      </Pressable>
      {range ? <Pressable onPress={() => setRange(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear date filter" style={{ marginLeft: 8, width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }}><X size={16} color={colors.muted} /></Pressable> : null}
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }} keyboardShouldPersistTaps="handled">
      <Chip label="All categories" active={!category} onPress={() => setCategory(null)} colors={colors} />
      {usedCategories.map((c) => <Chip key={c} label={c} active={category?.toLowerCase() === c.toLowerCase()} onPress={() => setCategory(c)} colors={colors} color={colorOf.get(c.toLowerCase())} />)}
    </ScrollView>
    {!loading && transactions.length > 0 ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}>
      <Text style={{ ...typo.caption, color: colors.muted }} accessibilityLiveRegion="polite">{shown.length} transaction{shown.length === 1 ? '' : 's'}{filtersActive ? ' (filtered)' : ''}</Text>
      {filtersActive ? <Pressable onPress={clearAll} accessibilityRole="button" accessibilityLabel="Clear all filters and search" hitSlop={8} style={{ minHeight: 32, justifyContent: 'center' }}><Text style={{ ...typo.link, color: palette.accentText }}>Clear all</Text></Pressable> : null}
    </View> : null}
    {loading ? <View style={{ alignItems: 'center', paddingVertical: 40 }}><ActivityIndicator color={palette.emerald} /><Text style={{ ...typo.caption, color: colors.muted, marginTop: 10 }}>Reading your saved transactions…</Text></View>
      : transactions.length === 0 ? <View><EmptyBlock title="No transactions yet" text="Add your first income or expense. Everything is saved on this device first." colors={colors} /><Pressable onPress={onAdd} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: palette.accentText, fontWeight: '700', textAlign: 'center' }}>Add transaction</Text></Pressable></View>
      : shown.length === 0 ? <View><EmptyBlock title={query.trim() ? 'No results' : 'Nothing matches'} text={query.trim() ? `No transactions match "${query.trim()}" with the current filters.` : range ? `No transactions between ${formatRange(range.from, range.to)} with the current filters. Try a wider date range or clear the filters.` : 'Try a different search or clear the filters.'} colors={colors} /><Pressable onPress={clearAll} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: palette.accentText, fontWeight: '700', textAlign: 'center' }}>Clear filters</Text></Pressable></View>
      : groups.map((g) => <View key={g.label}><SectionLabel colors={colors} style={{ marginTop: 12 }}>{g.label}</SectionLabel>
        <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: 14, overflow: 'hidden' }}>
          {g.items.map((t, i) => <TransactionCard key={t.id} grouped last={i === g.items.length - 1} tx={t} icon={iconOf.get(t.category.toLowerCase())} colors={colors} color={colorOf.get(t.category.toLowerCase()) ?? palette.navy} onPress={() => onOpen(t)} />)}
        </View></View>)}
    <Sheet visible={showDates} onClose={() => setShowDates(false)} title="Filter by date" colors={colors} footer={<>
      <Button title="Apply" disabled={!draftCheck.ok} onPress={() => { if (draft.from && draft.to && draftCheck.ok) { setRange({ from: draft.from, to: draft.to }); setShowDates(false); } }} />
      <Button title="Clear filter" kind="ghost" onPress={() => { setRange(null); setDraft({ from: null, to: null }); setShowDates(false); }} />
    </>}>
      <Text style={{ color: colors.muted, marginBottom: 12, fontSize: 13 }}>Show transactions dated from the start date to the end date, both included. Works offline on data saved on this device.</Text>
      <DateRangeFields from={draft.from} to={draft.to} colors={colors} onChange={(from, to) => setDraft({ from, to })} />
    </Sheet>
  </View>;
}
