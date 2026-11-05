import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { palette } from '../../theme';
import { Button, Chip, EmptyBlock, Input, formatPaise, type Colors } from '../ui/common';
import { CategoryPieChart, pct } from './PieChart';
import { categoryBreakdown, previousMonth, type CategoryBreakdown } from '../services/analyticsService';
import { currentMonth, monthRange } from '../services/budgetService';
import { getServiceDb } from '../services/transactionService';
import { parseLocalDateTime } from '../services/transactionDetails';

export function AnalyticsView({ scope, colors, refreshKey, onDrill }: { scope: string | null; colors: Colors; refreshKey: number; onDrill: (category: string) => void }) {
  const [period, setPeriod] = useState<'this' | 'prev' | 'custom'>('this');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [customRange, setCustomRange] = useState<{ start: string; end: string } | null>(null);
  const [error, setError] = useState('');
  const [data, setData] = useState<CategoryBreakdown | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const cm = currentMonth();
    const range = period === 'this' ? monthRange(cm) : period === 'prev' ? monthRange(previousMonth(cm)) : customRange;
    if (!range) { setData(null); return; }
    setData(await categoryBreakdown(getServiceDb(), scope, range)); setSelected(null);
  }, [period, customRange, scope]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const applyCustom = () => {
    const s = parseLocalDateTime(from, '00:00'); const e = parseLocalDateTime(to, '00:00');
    if (!s || !e) { setError('Enter both dates as YYYY-MM-DD.'); return; }
    if (e < s) { setError('The end date must be after the start date.'); return; }
    setError(''); setCustomRange({ start: s, end: new Date(new Date(e).getTime() + 86400000).toISOString() }); // end date inclusive
  };
  const slice = data?.slices.find((s) => s.category === selected);

  return <View>
    <View style={{ flexDirection: 'row', marginBottom: 12 }}>
      <Chip label="This month" active={period === 'this'} onPress={() => setPeriod('this')} colors={colors} />
      <Chip label="Last month" active={period === 'prev'} onPress={() => setPeriod('prev')} colors={colors} />
      <Chip label="Custom" active={period === 'custom'} onPress={() => setPeriod('custom')} colors={colors} />
    </View>
    {period === 'custom' ? <View style={{ marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}><View style={{ flex: 1 }}><Input colors={colors} value={from} onChangeText={setFrom} placeholder="From YYYY-MM-DD" autoCapitalize="none" /></View><View style={{ flex: 1 }}><Input colors={colors} value={to} onChangeText={setTo} placeholder="To YYYY-MM-DD" autoCapitalize="none" /></View></View>
      {error ? <Text style={{ color: palette.danger, marginTop: 6 }}>{error}</Text> : null}
      <Button title="Apply" kind="ghost" onPress={applyCustom} />
    </View> : null}
    {!data || data.isEmpty
      ? <EmptyBlock title={period === 'custom' && !customRange ? 'Pick a date range' : 'No spending in this period'} text={period === 'custom' && !customRange ? 'Choose start and end dates to see where your money went.' : 'Add expenses and they will be grouped by category here.'} colors={colors} />
      : <View>
        <CategoryPieChart slices={data.slices} total={data.totalPaise} selected={selected} onSelect={setSelected} colors={colors} />
        {slice ? <View style={{ marginTop: 10, padding: 14, borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{slice.category}</Text>
          <Text style={{ color: colors.muted, marginTop: 2 }}>{formatPaise(slice.totalPaise)} · {pct(slice.percentTenths)} of spending</Text>
          <Button title="View transactions" kind="ghost" onPress={() => onDrill(slice.category)} />
        </View> : null}
      </View>}
  </View>;
}
