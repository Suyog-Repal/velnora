import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { palette } from '../../theme';
import { Button, Chip, EmptyBlock, formatPaise, type Colors } from '../ui/common';
import { DateRangeFields } from '../ui/CalendarDatePicker';
import { rangeToIsoInterval, validateRange } from '../services/dateUtils';
import { CategoryPieChart, pct } from './PieChart';
import { categoryBreakdown, previousMonth, type CategoryBreakdown } from '../services/analyticsService';
import { currentMonth, monthRange } from '../services/budgetService';
import { getServiceDb } from '../services/transactionService';

export function AnalyticsView({ scope, colors, refreshKey, onDrill }: { scope: string | null; colors: Colors; refreshKey: number; onDrill: (category: string) => void }) {
  const [period, setPeriod] = useState<'this' | 'prev' | 'custom'>('this');
  const [from, setFrom] = useState<string | null>(null); const [to, setTo] = useState<string | null>(null);
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
    const check = validateRange(from, to);
    if (!check.ok) { setError(check.error); return; }
    const interval = rangeToIsoInterval(from!, to!); // end date inclusive: [start of start day, start of the day after end day)
    if (!interval) { setError('Select valid dates.'); return; }
    setError(''); setCustomRange(interval);
  };
  const slice = data?.slices.find((s) => s.category === selected);

  return <View>
    <View style={{ flexDirection: 'row', marginBottom: 12 }}>
      <Chip label="This month" active={period === 'this'} onPress={() => setPeriod('this')} colors={colors} />
      <Chip label="Last month" active={period === 'prev'} onPress={() => setPeriod('prev')} colors={colors} />
      <Chip label="Custom" active={period === 'custom'} onPress={() => setPeriod('custom')} colors={colors} />
    </View>
    {period === 'custom' ? <View style={{ marginBottom: 12, padding: 14, borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.text, fontWeight: '800', marginBottom: 10 }}>Custom date range</Text>
      <DateRangeFields from={from} to={to} colors={colors} onChange={(f, t) => { setFrom(f); setTo(t); setError(''); }} />
      {error ? <Text style={{ color: palette.danger, marginTop: 6 }} accessibilityLiveRegion="polite">{error}</Text> : null}
      <Button title="Apply" onPress={applyCustom} disabled={!from || !to || (from > to)} />
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
