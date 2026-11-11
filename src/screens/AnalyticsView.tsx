import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { palette } from '../../theme';
import { type } from '../../typography';
import { Button, Card, EmptyBlock, Segmented, formatPaise, type Colors } from '../ui/common';
import { DateRangeFields } from '../ui/CalendarDatePicker';
import { formatRange, rangeToIsoInterval, validateRange } from '../services/dateUtils';
import { CategoryPieChart, pct } from './PieChart';
import { categoryBreakdown, previousMonth, type CategoryBreakdown } from '../services/analyticsService';
import { listCategories } from '../services/categoryService';
import { monthLabel } from '../services/cashFlowSeries';
import { currentMonth, monthRange } from '../services/budgetService';
import { getServiceDb } from '../services/transactionService';
import { MonthlyReportView } from './MonthlyReportView';

export function AnalyticsView({ scope, colors, refreshKey, onDrill }: { scope: string | null; colors: Colors; refreshKey: number; onDrill: (category: string) => void }) {
  const [section, setSection] = useState<'spending' | 'report'>('spending');
  const [period, setPeriod] = useState<'this' | 'prev' | 'custom'>('this');
  const [from, setFrom] = useState<string | null>(null); const [to, setTo] = useState<string | null>(null);
  const [customRange, setCustomRange] = useState<{ start: string; end: string; label: string } | null>(null);
  const [error, setError] = useState('');
  const [data, setData] = useState<CategoryBreakdown | null>(null);
  const [icons, setIcons] = useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const cm = currentMonth();
    const range = period === 'this' ? monthRange(cm) : period === 'prev' ? monthRange(previousMonth(cm)) : customRange;
    setSelected(null); setLoadError('');
    if (!range) { setData(null); setLoading(false); return; }
    setLoading(true);
    try {
      const db = getServiceDb();
      setData(await categoryBreakdown(db, scope, range));
      setIcons(new Map((await listCategories(db, scope)).map((c) => [c.name.toLowerCase(), c.icon])));
    } catch { setData(null); setLoadError('Your spending could not be loaded. Please try again.'); }
    finally { setLoading(false); }
  }, [period, customRange, scope]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const applyCustom = () => {
    const check = validateRange(from, to);
    if (!check.ok) { setError(check.error); return; }
    const interval = rangeToIsoInterval(from!, to!); // end date inclusive: [start of start day, start of the day after end day)
    if (!interval) { setError('Select valid dates.'); return; }
    setError(''); setCustomRange({ ...interval, label: formatRange(from, to) });
  };
  const slice = data?.slices.find((s) => s.category === selected);
  const periodLabel = period === 'this' ? monthLabel(currentMonth()) : period === 'prev' ? monthLabel(previousMonth(currentMonth())) : customRange?.label ?? 'Custom range';
  // Descriptive facts straight from the breakdown (slices are sorted by amount, so the first is the largest).
  const top = useMemo(() => (data && !data.isEmpty ? data.slices[0] : null), [data]);

  const switcher = <View style={{ marginBottom: 14 }}><Segmented colors={colors} value={section} onChange={setSection} options={[['spending', 'Spending'], ['report', 'Monthly report']] as const} /></View>;
  if (section === 'report') return <View>{switcher}<MonthlyReportView scope={scope} colors={colors} refreshKey={refreshKey} /></View>;

  return <View>
    {switcher}
    <Segmented colors={colors} value={period} onChange={setPeriod} options={[['this', 'This month'], ['prev', 'Last month'], ['custom', 'Custom']] as const} />
    {period === 'custom' ? <Card colors={colors} style={{ marginTop: 14 }}>
      <Text style={{ ...type.cardTitle, color: colors.text, marginBottom: 12 }}>Custom date range</Text>
      <DateRangeFields from={from} to={to} colors={colors} onChange={(f, t) => { setFrom(f); setTo(t); setError(''); }} />
      {error ? <Text style={{ ...type.caption, color: palette.expenseText, marginTop: 6 }} accessibilityLiveRegion="polite">{error}</Text> : null}
      <Button title="Apply" onPress={applyCustom} disabled={!from || !to || (from > to)} />
    </Card> : null}

    {loading ? <View style={{ alignItems: 'center', paddingVertical: 48 }}><ActivityIndicator color={palette.emerald} /><Text style={{ ...type.caption, color: colors.muted, marginTop: 10 }}>Loading your spending…</Text></View>
      : loadError ? <View style={{ marginTop: 14 }}><EmptyBlock title="Couldn't load analytics" text={loadError} colors={colors} /><Button title="Try again" kind="ghost" onPress={() => void load()} /></View>
      : !data || data.isEmpty
        ? <View style={{ marginTop: 14 }}><EmptyBlock title={period === 'custom' && !customRange ? 'Pick a date range' : `No spending in ${periodLabel}`} text={period === 'custom' && !customRange ? 'Choose start and end dates to see where your money went.' : 'Add expenses and they will be grouped by category here.'} colors={colors} /></View>
        : <View>
          <Card colors={colors} style={{ marginTop: 14 }}>
            <Text style={{ ...type.captionStrong, color: colors.muted }}>{periodLabel.toUpperCase()}</Text>
            <Text style={{ ...type.amountLg, color: palette.expenseText, marginTop: 6 }} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`Total spent ${formatPaise(data.totalPaise)}`}>{formatPaise(data.totalPaise)}</Text>
            <Text style={{ ...type.caption, color: colors.muted, marginTop: 2 }}>Total spent · {data.slices.length} categor{data.slices.length === 1 ? 'y' : 'ies'}</Text>
            {top ? <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={{ ...type.caption, color: colors.muted }}>Largest category</Text>
              <Text style={{ ...type.bodyStrong, color: colors.text, marginTop: 2 }} numberOfLines={1}>{top.category} · {formatPaise(top.totalPaise)} ({pct(top.percentTenths)})</Text>
            </View> : null}
          </Card>
          <Text style={{ ...type.section, color: colors.text, marginTop: 22, marginBottom: 10 }}>Spending by category</Text>
          <CategoryPieChart slices={data.slices} total={data.totalPaise} selected={selected} onSelect={setSelected} colors={colors} icons={icons} />
          {slice ? <Card colors={colors} style={{ marginTop: 12 }}>
            <Text style={{ ...type.cardTitle, color: colors.text }} numberOfLines={1}>{slice.category}</Text>
            <Text style={{ ...type.body, color: colors.muted, marginTop: 2, fontVariant: ['tabular-nums'] }}>{formatPaise(slice.totalPaise)} · {pct(slice.percentTenths)} of spending</Text>
            <Button title="View transactions" kind="ghost" onPress={() => onDrill(slice.category)} />
          </Card> : null}
        </View>}
  </View>;
}
