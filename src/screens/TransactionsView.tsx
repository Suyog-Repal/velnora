import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { palette } from '../../theme';
import { ArrowDownLeft, ArrowUpRight, CalendarDays, MapPin, ReceiptIcon, Search, WifiOff, X } from '../../icons';
import { Button, CategoryIcon, Chip, EmptyBlock, Sheet, formatPaise, type Colors } from '../ui/common';
import { DateRangeFields } from '../ui/CalendarDatePicker';
import { formatRange, inDateRange, validateRange } from '../services/dateUtils';
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

export function TransactionCard({ tx, color, icon, colors, onPress }: { tx: TransactionEntity; color: string; icon?: string | null; colors: Colors; onPress: () => void }) {
  const income = tx.direction === 'income';
  const time = new Date(tx.transaction_date).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const hasLoc = tx.location_lat != null && tx.location_lng != null;
  const hasReceipt = !!(tx.receipt_local_path || tx.receipt_remote_id);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${tx.counterparty}, ${formatPaise(tx.amount_paise)}`} onPress={onPress}
    style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 12, marginBottom: 8, minHeight: 64 }}>
    <CategoryIcon icon={icon} label={tx.counterparty} color={color} />
    <View style={{ flex: 1, marginHorizontal: 12 }}>
      <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '700', fontSize: 15 }}>{tx.counterparty}</Text>
      <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{tx.category} · {time}{tx.payment_method ? ` · ${tx.payment_method}` : ''}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
        <Text style={{ fontSize: 10, fontWeight: '800', color: tx.source === 'sms' ? palette.emerald : colors.muted }}>{tx.source === 'sms' ? 'SMS' : 'MANUAL'}</Text>
        {hasLoc ? <View style={{ marginLeft: 8 }}><MapPin size={12} color={colors.muted} /></View> : null}
        {hasReceipt ? <View style={{ marginLeft: 8 }}><ReceiptIcon size={12} color={colors.muted} /></View> : null}
        {tx.sync_status !== 'synced' && tx.user_id ? <Text style={{ fontSize: 10, color: colors.muted, marginLeft: 8 }}>Pending sync</Text> : null}
      </View>
    </View>
    <View style={{ alignItems: 'flex-end' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>{income ? <ArrowDownLeft size={14} color={palette.emerald} /> : <ArrowUpRight size={14} color={palette.danger} />}
        <Text style={{ color: income ? palette.emerald : palette.danger, fontWeight: '800', fontSize: 15, marginLeft: 2 }}>{income ? '+' : '-'}{formatPaise(tx.amount_paise)}</Text></View>
    </View>
  </Pressable>;
}

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

  return <View>
    {!online ? <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}><WifiOff size={14} color={colors.muted} /><Text style={{ color: colors.muted, marginLeft: 6, fontSize: 12 }}>Offline · showing data saved on this device</Text></View> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 12, marginBottom: 12 }}>
      <Search size={16} color={colors.muted} />
      <TextInput value={query} onChangeText={setQuery} placeholder="Search merchant or description" placeholderTextColor={colors.muted} style={{ flex: 1, minHeight: 46, marginLeft: 8, color: colors.text }} accessibilityLabel="Search transactions" />
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
      <Pressable onPress={() => { setDraft({ from: range?.from ?? null, to: range?.to ?? null }); setShowDates(true); }} accessibilityRole="button" accessibilityLabel={range ? `Date filter: ${formatRange(range.from, range.to)}` : 'Filter by date range'}
        style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: range ? palette.emerald : colors.border, backgroundColor: range ? `${palette.emerald}1F` : colors.card, borderRadius: 18, paddingHorizontal: 12, minHeight: 36 }}>
        <CalendarDays size={16} color={range ? palette.emerald : colors.muted} />
        <Text numberOfLines={1} style={{ marginLeft: 8, color: range ? colors.text : colors.muted, fontWeight: range ? '800' : '600', fontSize: 13, flexShrink: 1 }}>{range ? formatRange(range.from, range.to) : 'All dates'}</Text>
      </Pressable>
      {range ? <Pressable onPress={() => setRange(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear date filter" style={{ marginLeft: 8, width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }}><X size={16} color={colors.muted} /></Pressable> : null}
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
      {(['all', 'expense', 'income'] as const).map((k) => <Chip key={k} label={k === 'all' ? 'All' : k === 'income' ? 'Income' : 'Expenses'} active={type === k} onPress={() => setType(k)} colors={colors} />)}
    </ScrollView>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
      <Chip label="All categories" active={!category} onPress={() => setCategory(null)} colors={colors} />
      {usedCategories.map((c) => <Chip key={c} label={c} active={category?.toLowerCase() === c.toLowerCase()} onPress={() => setCategory(c)} colors={colors} color={colorOf.get(c.toLowerCase())} />)}
    </ScrollView>
    {loading ? <EmptyBlock title="Loading…" text="Reading your saved transactions." colors={colors} />
      : transactions.length === 0 ? <View><EmptyBlock title="No transactions yet" text="Add your first income or expense. Everything is saved on this device first." colors={colors} /><Pressable onPress={onAdd}><Text style={{ color: palette.emerald, fontWeight: '800', textAlign: 'center' }}>Add transaction</Text></Pressable></View>
      : shown.length === 0 ? <EmptyBlock title="Nothing matches" text={range ? `No transactions between ${formatRange(range.from, range.to)} with the current filters. Try a wider date range or clear the filters.` : 'Try a different search or clear the filters.'} colors={colors} />
      : groups.map((g) => <View key={g.label}><Text style={{ color: colors.muted, fontWeight: '800', fontSize: 12, marginVertical: 8 }}>{g.label.toUpperCase()}</Text>
        {g.items.map((t) => <TransactionCard key={t.id} tx={t} icon={iconOf.get(t.category.toLowerCase())} colors={colors} color={colorOf.get(t.category.toLowerCase()) ?? palette.navy} onPress={() => onOpen(t)} />)}</View>)}
    <Sheet visible={showDates} onClose={() => setShowDates(false)} title="Filter by date" colors={colors} footer={<>
      <Button title="Apply" disabled={!draftCheck.ok} onPress={() => { if (draft.from && draft.to && draftCheck.ok) { setRange({ from: draft.from, to: draft.to }); setShowDates(false); } }} />
      <Button title="Clear filter" kind="ghost" onPress={() => { setRange(null); setDraft({ from: null, to: null }); setShowDates(false); }} />
    </>}>
      <Text style={{ color: colors.muted, marginBottom: 12, fontSize: 13 }}>Show transactions dated from the start date to the end date, both included. Works offline on data saved on this device.</Text>
      <DateRangeFields from={draft.from} to={draft.to} colors={colors} onChange={(from, to) => setDraft({ from, to })} />
    </Sheet>
  </View>;
}
