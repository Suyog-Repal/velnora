import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { palette } from '../../theme';
import { ArrowDownLeft, ArrowUpRight, MapPin, ReceiptIcon, Search, WifiOff } from '../../icons';
import { CategoryIcon, Chip, EmptyBlock, formatPaise, type Colors } from '../ui/common';
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

export function filterTransactions(items: TransactionEntity[], f: { type: 'all' | 'income' | 'expense'; category: string | null; query: string }): TransactionEntity[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((t) =>
    !t.deleted_at &&
    (f.type === 'all' || t.direction === f.type) &&
    (!f.category || t.category.toLowerCase() === f.category.toLowerCase()) &&
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
  const colorOf = useMemo(() => new Map(categories.map((c) => [c.name.toLowerCase(), c.color])), [categories]);
  const iconOf = useMemo(() => new Map(categories.map((c) => [c.name.toLowerCase(), c.icon])), [categories]);
  const shown = useMemo(() => filterTransactions(transactions, { type, category, query }), [transactions, type, category, query]);
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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
      {(['all', 'expense', 'income'] as const).map((k) => <Chip key={k} label={k === 'all' ? 'All' : k === 'income' ? 'Income' : 'Expenses'} active={type === k} onPress={() => setType(k)} colors={colors} />)}
    </ScrollView>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
      <Chip label="All categories" active={!category} onPress={() => setCategory(null)} colors={colors} />
      {usedCategories.map((c) => <Chip key={c} label={c} active={category?.toLowerCase() === c.toLowerCase()} onPress={() => setCategory(c)} colors={colors} color={colorOf.get(c.toLowerCase())} />)}
    </ScrollView>
    {loading ? <EmptyBlock title="Loading…" text="Reading your saved transactions." colors={colors} />
      : transactions.length === 0 ? <View><EmptyBlock title="No transactions yet" text="Add your first income or expense. Everything is saved on this device first." colors={colors} /><Pressable onPress={onAdd}><Text style={{ color: palette.emerald, fontWeight: '800', textAlign: 'center' }}>Add transaction</Text></Pressable></View>
      : shown.length === 0 ? <EmptyBlock title="Nothing matches" text="Try a different search or clear the filters." colors={colors} />
      : groups.map((g) => <View key={g.label}><Text style={{ color: colors.muted, fontWeight: '800', fontSize: 12, marginVertical: 8 }}>{g.label.toUpperCase()}</Text>
        {g.items.map((t) => <TransactionCard key={t.id} tx={t} icon={iconOf.get(t.category.toLowerCase())} colors={colors} color={colorOf.get(t.category.toLowerCase()) ?? palette.navy} onPress={() => onOpen(t)} />)}</View>)}
  </View>;
}
