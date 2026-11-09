import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { palette } from '../../theme';
import { type } from '../../typography';
import { Button, Card, Chip, EmptyBlock, Input, Labeled, Sheet, currencySymbol, formatPaise, type Colors } from '../ui/common';
import { currentMonth, deleteBudget, getBudgetProgress, saveBudget, type BudgetProgress, type BudgetState } from '../services/budgetService';
import { previousMonth } from '../services/analyticsService';
import { getServiceDb } from '../services/transactionService';
import type { CategoryView } from '../services/categoryService';

const STATE_COLOR: Record<BudgetState, string> = { within: palette.emerald, near: palette.warning, exceeded: palette.danger };
const STATE_TEXT: Record<BudgetState, string> = { within: 'Within budget', near: 'Near limit', exceeded: 'Over budget' };

export function BudgetsView({ scope, categories, colors, refreshKey }: { scope: string | null; categories: CategoryView[]; colors: Colors; refreshKey: number }) {
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState<BudgetProgress[]>([]);
  const [editing, setEditing] = useState<{ id?: string; category: string | null; amount: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => setRows(await getBudgetProgress(getServiceDb(), scope, month)), [scope, month]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const label = new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const save = async () => {
    if (!editing) return;
    setError('');
    const rupees = Number(editing.amount);
    if (!Number.isFinite(rupees) || rupees <= 0) { setError('Enter an amount greater than zero.'); return; }
    try { await saveBudget(getServiceDb(), scope, { id: editing.id, category: editing.category, amountPaise: Math.round(rupees * 100) }); setEditing(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the budget.'); }
  };

  return <View>
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
      <Chip label="This month" active={month === currentMonth()} onPress={() => setMonth(currentMonth())} colors={colors} />
      <Chip label="Last month" active={month === previousMonth(currentMonth())} onPress={() => setMonth(previousMonth(currentMonth()))} colors={colors} />
      <Text style={{ ...type.captionStrong, color: colors.muted, marginLeft: 'auto' }}>{label}</Text>
    </View>
    {rows.length === 0 ? <EmptyBlock title="No budgets yet" text="Set a monthly limit overall or for a category. Progress is calculated from your saved expenses." colors={colors} /> : rows.map((p) => {
      const color = STATE_COLOR[p.state];
      return <Card key={p.budget.id} colors={colors} style={{ marginBottom: 10 }} accessibilityLabel={`${p.budget.category ?? 'Overall monthly budget'}, ${STATE_TEXT[p.state]}`} onPress={() => setEditing({ id: p.budget.id, category: p.budget.category, amount: String(p.budget.amount_paise / 100) })}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><Text style={{ ...type.cardTitle, color: colors.text, flexShrink: 1 }}>{p.budget.category ?? 'Overall monthly budget'}</Text><Text style={{ ...type.captionStrong, color }}>{STATE_TEXT[p.state]}</Text></View>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: `${color}22`, marginVertical: 10, overflow: 'hidden' }}><View style={{ width: `${Math.min(100, p.percentUsed)}%`, height: 8, backgroundColor: color }} /></View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ ...type.caption, color: colors.muted, fontVariant: ['tabular-nums'], flexShrink: 1 }}>Spent {formatPaise(p.spentPaise)} of {formatPaise(p.budget.amount_paise)}</Text>
          <Text style={{ ...type.caption, color: colors.muted, fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 }}>{p.percentUsed}% · {p.remainingPaise >= 0 ? `${formatPaise(p.remainingPaise)} left` : `${formatPaise(-p.remainingPaise)} over`}</Text>
        </View>
      </Card>;
    })}
    <Button title="Add budget" onPress={() => { setError(''); setEditing({ category: null, amount: '' }); }} />

    <Sheet visible={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit budget' : 'New monthly budget'} colors={colors}>
      <Labeled label="APPLIES TO" colors={colors}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Chip label="Overall" active={editing?.category == null} onPress={() => editing && setEditing({ ...editing, category: null })} colors={colors} />
          {categories.filter((c) => c.type === 'expense').map((c) => <Chip key={c.id} label={c.name} color={c.color} active={editing?.category?.toLowerCase() === c.name.toLowerCase()} onPress={() => editing && setEditing({ ...editing, category: c.name })} colors={colors} />)}
        </ScrollView>
      </Labeled>
      <Labeled label={`MONTHLY LIMIT (${currencySymbol()})`} colors={colors}><Input colors={colors} value={editing?.amount ?? ''} onChangeText={(t) => editing && setEditing({ ...editing, amount: t })} keyboardType="decimal-pad" placeholder="e.g. 5000" /></Labeled>
      {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
      <Button title="Save budget" onPress={() => void save()} />
      {editing?.id ? <Button title="Delete budget" kind="danger" onPress={() => Alert.alert('Delete budget?', 'Your transactions are not affected.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { void deleteBudget(getServiceDb(), scope, editing.id!).then(() => { setEditing(null); return load(); }); } }])} /> : null}
    </Sheet>
  </View>;
}
