import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SkeletonDashboard } from '../ui/motion';
import { palette, shade, tint } from '../../theme';
import { type } from '../../typography';
import { Button, Card, CategoryIcon, Chip, EmptyBlock, HeroSurface, Input, Labeled, Segmented, Sheet, currencySymbol, formatPaise, type Colors } from '../ui/common';
import { currentMonth, deleteBudget, getBudgetProgress, saveBudget, type BudgetProgress, type BudgetState } from '../services/budgetService';
import { previousMonth } from '../services/analyticsService';
import { getServiceDb } from '../services/transactionService';
import type { CategoryView } from '../services/categoryService';

const STATE_TEXT: Record<BudgetState, string> = { within: 'Within budget', near: 'Near limit', exceeded: 'Over budget' };
/** Bar / pill fill per state. */
const stateFill = (s: BudgetState) => (s === 'within' ? palette.emerald : s === 'near' ? palette.warning : palette.danger);
/** Text-safe variant of the state colour (the state is also spelled out in words, never colour alone). */
const stateText = (s: BudgetState) => (s === 'within' ? palette.accentText : s === 'near' ? shade(palette.warning, 0.62) : palette.expenseText);

function Bar({ percent, state, label }: { percent: number; state: BudgetState; label: string }) {
  const shown = Math.max(0, Math.min(100, percent));
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: shown, text: `${percent}% used` }}
    style={{ height: 8, borderRadius: 4, backgroundColor: tint(stateFill(state), 0.18), overflow: 'hidden' }}>
    <View style={{ width: `${shown}%`, height: 8, borderRadius: 4, backgroundColor: stateFill(state) }} />
  </View>;
}

function StatePill({ state }: { state: BudgetState }) {
  return <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint(stateFill(state), 0.16) }}>
    <Text style={{ ...type.captionStrong, color: stateText(state) }}>{STATE_TEXT[state]}</Text></View>;
}

export function BudgetsView({ scope, categories, colors, refreshKey }: { scope: string | null; categories: CategoryView[]; colors: Colors; refreshKey: number }) {
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState<BudgetProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<{ id?: string; category: string | null; amount: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try { setRows(await getBudgetProgress(getServiceDb(), scope, month)); }
    catch { setLoadError('Your budgets could not be loaded. Please try again.'); }
    finally { setLoading(false); }
  }, [scope, month]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const iconOf = useMemo(() => new Map(categories.map((c) => [c.name.toLowerCase(), c])), [categories]);
  const label = new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const overall = rows.find((p) => p.budget.category === null) ?? null;
  const byCategory = rows.filter((p) => p.budget.category !== null);
  const edit = (p: BudgetProgress) => setEditing({ id: p.budget.id, category: p.budget.category, amount: String(p.budget.amount_paise / 100) });

  const save = async () => {
    if (!editing) return;
    setError('');
    const rupees = Number(editing.amount);
    if (!Number.isFinite(rupees) || rupees <= 0) { setError('Enter an amount greater than zero.'); return; }
    try { await saveBudget(getServiceDb(), scope, { id: editing.id, category: editing.category, amountPaise: Math.round(rupees * 100) }); setEditing(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the budget.'); }
  };

  return <View>
    <Segmented colors={colors} value={month === currentMonth() ? 'this' : 'prev'} onChange={(v) => { setLoading(true); setMonth(v === 'this' ? currentMonth() : previousMonth(currentMonth())); }} options={[['this', 'This month'], ['prev', 'Last month']] as const} />
    <Text style={{ ...type.captionStrong, color: colors.muted, marginTop: 10, marginBottom: 12 }}>{label.toUpperCase()}</Text>

    {loading ? <SkeletonDashboard cardColor={colors.card} borderColor={colors.border} />
    : loadError ? <View><EmptyBlock title="Couldn't load budgets" text={loadError} colors={colors} /><Button title="Try again" kind="ghost" onPress={() => { setLoading(true); void load(); }} /></View>
    : rows.length === 0 ? <EmptyBlock title="No budgets yet" text="Set a monthly limit overall or for a category. Progress is calculated from your saved expenses." colors={colors} />
    : <View>
      {overall ? <HeroSurface style={{ marginBottom: 16 }} accessibilityLabel={`Overall monthly budget, ${STATE_TEXT[overall.state]}, ${formatPaise(overall.spentPaise)} of ${formatPaise(overall.budget.amount_paise)}. Tap to edit`} onPress={() => edit(overall)}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <Text style={{ ...type.label, color: palette.onNavyMuted }}>OVERALL MONTHLY BUDGET</Text>
          <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.16)' }}><Text style={{ ...type.captionStrong, color: palette.onNavy }}>{STATE_TEXT[overall.state]}</Text></View>
        </View>
        <Text style={{ ...type.amountHero, color: overall.remainingPaise >= 0 ? palette.onNavy : palette.expenseOnNavy, marginTop: 8 }} numberOfLines={1} adjustsFontSizeToFit>{formatPaise(Math.abs(overall.remainingPaise))}</Text>
        <Text style={{ ...type.caption, color: palette.onNavySoft, marginBottom: 14 }}>{overall.remainingPaise >= 0 ? 'left to spend' : 'over budget'}</Text>
        <View accessible accessibilityRole="progressbar" accessibilityLabel="Overall budget used" accessibilityValue={{ min: 0, max: 100, now: Math.max(0, Math.min(100, overall.percentUsed)), text: `${overall.percentUsed}% used` }} style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}>
          <View style={{ width: `${Math.max(0, Math.min(100, overall.percentUsed))}%`, height: 8, borderRadius: 4, backgroundColor: overall.state === 'within' ? palette.incomeOnHero : overall.state === 'near' ? '#FFD27A' : palette.expenseOnNavy }} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
          <Text style={{ ...type.caption, color: palette.onNavySoft, fontVariant: ['tabular-nums'], flexShrink: 1 }}>Spent {formatPaise(overall.spentPaise)}</Text>
          <Text style={{ ...type.caption, color: palette.onNavySoft, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' }}>{overall.percentUsed}% of {formatPaise(overall.budget.amount_paise)}</Text>
        </View>
      </HeroSurface> : null}

      {byCategory.length ? <Text style={{ ...type.section, color: colors.text, marginBottom: 10 }}>Category budgets</Text> : null}
      {byCategory.map((p) => {
        const cat = iconOf.get((p.budget.category ?? '').toLowerCase());
        const name = p.budget.category ?? '';
        return <Card key={p.budget.id} colors={colors} style={{ marginBottom: 10, padding: 14 }} accessibilityLabel={`${name}, ${STATE_TEXT[p.state]}, ${formatPaise(p.spentPaise)} of ${formatPaise(p.budget.amount_paise)}`} onPress={() => edit(p)}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <CategoryIcon icon={cat?.icon} color={cat?.color ?? palette.navy} label={name} size={36} />
            <View style={{ flex: 1, marginHorizontal: 10, minWidth: 0 }}>
              <Text style={{ ...type.cardTitle, color: colors.text }} numberOfLines={1}>{name}</Text>
              <Text style={{ ...type.caption, color: colors.muted, fontVariant: ['tabular-nums'] }} numberOfLines={1}>{formatPaise(p.spentPaise)} of {formatPaise(p.budget.amount_paise)}</Text>
            </View>
            <StatePill state={p.state} />
          </View>
          <View style={{ marginTop: 10 }}><Bar percent={p.percentUsed} state={p.state} label={`${name} budget used`} /></View>
          <Text style={{ ...type.caption, color: p.remainingPaise >= 0 ? colors.muted : palette.expenseText, marginTop: 6, fontVariant: ['tabular-nums'] }}>{p.percentUsed}% · {p.remainingPaise >= 0 ? `${formatPaise(p.remainingPaise)} left` : `${formatPaise(-p.remainingPaise)} over`}</Text>
        </Card>;
      })}
    </View>}
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
