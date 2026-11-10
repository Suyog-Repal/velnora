import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { palette } from '../../theme';
import { type } from '../../typography';
import { Button, Card, Chip, EmptyBlock, SectionLabel, formatPaise, type Colors } from '../ui/common';
import { DateRangeFields } from '../ui/CalendarDatePicker';
import { rangeToIsoInterval, validateRange } from '../services/dateUtils';
import { CategoryPieChart, pct } from './PieChart';
import { categoryBreakdown, previousMonth, type CategoryBreakdown } from '../services/analyticsService';
import { currentMonth, monthRange } from '../services/budgetService';
import { getServiceDb } from '../services/transactionService';
import { MonthlyReportView } from './MonthlyReportView';

export function AnalyticsView({ scope, colors, refreshKey, onDrill }: { scope: string | null; colors: Colors; refreshKey: number; onDrill: (category: string) => void }) {
  const [section, setSection] = useState<'spending' | 'report'>('spending');
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

  const switcher = <View style={{ flexDirection: 'row', marginBottom: 14 }}>
    <Chip label="Spending" active={section === 'spending'} onPress={() => setSection('spending')} colors={colors} />
    <Chip label="Monthly report" active={section === 'report'} onPress={() => setSection('report')} colors={colors} />
  </View>;
  if (section === 'report') return <View>{switcher}<MonthlyReportView scope={scope} colors={colors} refreshKey={refreshKey} /></View>;

  return <View>
    {switcher}
    <SectionLabel colors={colors} style={{ marginTop: 0 }}>Period</SectionLabel>
    <View style={{ flexDirection: 'row', marginBottom: 14 }}>
      <Chip label="This month" active={period === 'this'} onPress={() => setPeriod('this')} colors={colors} />
      <Chip label="Last month" active={period === 'prev'} onPress={() => setPeriod('prev')} colors={colors} />
      <Chip label="Custom" active={period === 'custom'} onPress={() => setPeriod('custom')} colors={colors} />
    </View>
    {period === 'custom' ? <Card colors={colors} style={{ marginBottom: 14 }}>
      <Text style={{ ...type.cardTitle, color: colors.text, marginBottom: 12 }}>Custom date range</Text>
      <DateRangeFields from={from} to={to} colors={colors} onChange={(f, t) => { setFrom(f); setTo(t); setError(''); }} />
      {error ? <Text style={{ color: palette.expenseText, marginTop: 6 }} accessibilityLiveRegion="polite">{error}</Text> : null}
      <Button title="Apply" onPress={applyCustom} disabled={!from || !to || (from > to)} />
    </Card> : null}
    {!data || data.isEmpty
      ? <EmptyBlock title={period === 'custom' && !customRange ? 'Pick a date range' : 'No spending in this period'} text={period === 'custom' && !customRange ? 'Choose start and end dates to see where your money went.' : 'Add expenses and they will be grouped by category here.'} colors={colors} />
      : <View>
        <SectionLabel colors={colors}>Spending by category</SectionLabel>
        <CategoryPieChart slices={data.slices} total={data.totalPaise} selected={selected} onSelect={setSelected} colors={colors} />
        {slice ? <Card colors={colors} style={{ marginTop: 12 }}>
          <Text style={{ ...type.cardTitle, color: colors.text }}>{slice.category}</Text>
          <Text style={{ ...type.body, color: colors.muted, marginTop: 2, fontVariant: ['tabular-nums'] }}>{formatPaise(slice.totalPaise)} · {pct(slice.percentTenths)} of spending</Text>
          <Button title="View transactions" kind="ghost" onPress={() => onDrill(slice.category)} />
        </Card> : null}
      </View>}
  </View>;
}
