import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ChevronLeft, ChevronRight } from '../../icons';
import { palette, radius } from '../../theme';
import { type } from '../../typography';
import { formatMinor } from '../ui/currency';
import { currentMonth } from '../services/budgetService';
import { countsAsExpense, countsAsIncome } from '../services/ledgerRules';
import { getServiceDb } from '../services/transactionService';
import {
  buildDaily, buildMonthly, buildWeekly, hasActivity, loadPoints, monthLabel, niceScale, shiftMonth, totalsOf,
  type SeriesBucket, type SeriesView, type TxnPoint,
} from '../services/cashFlowSeries';
import type { Colors } from '../ui/common';

/** Day-wise / week-wise / month-wise income-vs-expense chart, drawn with plain Views (no chart dependency). */

const PLOT_HEIGHT = 150;
const DAILY_COL = 26;
const VIEWS: { id: SeriesView; label: string }[] = [{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }];

/** Axis labels only: compact, symbol-free (the currency is shown on every full amount). */
function compact(paise: number): string {
  const r = paise / 100;
  if (r >= 10_000_000) return `${+(r / 10_000_000).toFixed(1)}Cr`;
  if (r >= 100_000) return `${+(r / 100_000).toFixed(1)}L`;
  if (r >= 1000) return `${+(r / 1000).toFixed(1)}k`;
  return String(Math.round(r));
}

export function SpendingOverview({ scope, refreshKey, colors, renderTransaction, transactions }: {
  scope: string | null;
  /** Changes whenever transactions are added / edited / deleted / synced, so the chart re-queries. */
  refreshKey: unknown;
  colors: Colors;
  transactions: { id: string; date: string; direction: string }[];
  renderTransaction: (id: string) => ReactNode;
}) {
  const nowMonth = currentMonth();
  const [month, setMonth] = useState(nowMonth);
  const [view, setView] = useState<SeriesView>('daily');
  const [points, setPoints] = useState<TxnPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Monthly view needs 6 months of history; daily/weekly need only the selected month. One query either way.
  const fromMonth = view === 'monthly' ? shiftMonth(month, -5) : month;
  useEffect(() => {
    let live = true;
    let db;
    try { db = getServiceDb(); } catch { return; }
    loadPoints(db, scope, fromMonth, month)
      .then((p) => { if (live) { setPoints(p); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [scope, fromMonth, month, refreshKey]);

  const buckets = useMemo<SeriesBucket[]>(() => {
    const p = points ?? [];
    return view === 'daily' ? buildDaily(p, month) : view === 'weekly' ? buildWeekly(p, month) : buildMonthly(p, month);
  }, [points, view, month]);

  // Header totals always describe the selected month, with the same rows the chart uses.
  const monthTotals = useMemo(() => {
    const p = (points ?? []).filter((x) => { const d = new Date(x.date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === month; });
    return totalsOf(buildDaily(p, month), p);
  }, [points, month]);

  // Default selection: the bucket holding today in the current month, otherwise the last bucket; reset on view/month change.
  useEffect(() => {
    const now = new Date();
    const today = month === nowMonth ? buckets.find((b) => b.from.d <= now.getDate() && b.to.d >= now.getDate()) : undefined;
    setSelected((today ?? buckets[buckets.length - 1])?.key ?? null);
  }, [view, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = hasActivity(buckets);
  const current = buckets.find((b) => b.key === selected) ?? null;
  const net = monthTotals.netPaise;
  const canNext = month < nowMonth;
  const signed = (p: number) => `${p > 0 ? '+' : ''}${formatMinor(p)}`;
  const netColor = net > 0 ? palette.accentText : net < 0 ? palette.expenseText : colors.text;

  const inRange = (b: SeriesBucket) => transactions.filter((t) => {
    const d = new Date(t.date);
    const key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
    return (countsAsIncome(t) || countsAsExpense(t))
      && key >= b.from.y * 10000 + b.from.m * 100 + b.from.d && key <= b.to.y * 10000 + b.to.m * 100 + b.to.d;
  });
  const listed = current && view !== 'monthly' ? inRange(current).slice(0, 3) : [];

  return <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 16 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Pressable onPress={() => setMonth(shiftMonth(month, -1))} accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={8}
        style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
        <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
      </Pressable>
      <Text style={{ ...type.cardTitle, color: colors.text }} accessibilityRole="header">{monthLabel(month)}</Text>
      <Pressable onPress={() => canNext && setMonth(shiftMonth(month, 1))} disabled={!canNext} accessibilityRole="button" accessibilityLabel="Next month" accessibilityState={{ disabled: !canNext }} hitSlop={8}
        style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: !canNext ? 0.3 : pressed ? 0.6 : 1 })}>
        <ChevronRight size={22} color={colors.text} strokeWidth={2} />
      </Pressable>
    </View>

    <Text style={{ ...type.amountMd, color: netColor, textAlign: 'center', marginTop: 2 }} accessibilityLabel={`Net cash flow ${signed(net)}`} numberOfLines={1} adjustsFontSizeToFit>{signed(net)}</Text>
    <Text style={{ ...type.caption, color: colors.muted, textAlign: 'center' }}>Net cash flow</Text>
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
      <Summary label="Income" value={formatMinor(monthTotals.incomePaise)} dot={palette.emerald} colors={colors} />
      <Summary label="Expenses" value={formatMinor(monthTotals.expensePaise)} dot={palette.danger} colors={colors} />
    </View>

    <View accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: colors.canvas, borderRadius: radius.pill, padding: 3, marginTop: 14, borderWidth: 1, borderColor: colors.border }}>
      {VIEWS.map((v) => {
        const on = view === v.id;
        return <Pressable key={v.id} onPress={() => setView(v.id)} accessibilityRole="tab" accessibilityState={{ selected: on }}
          style={{ flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: on ? palette.emerald : 'transparent' }}>
          <Text style={{ ...type.chip, color: on ? palette.navy : colors.muted }}>{v.label}</Text>
        </Pressable>;
      })}
    </View>

    {points === null && !failed ? <Text style={{ ...type.caption, color: colors.muted, textAlign: 'center', marginVertical: 40 }}>Loading…</Text>
      : failed ? <Text style={{ ...type.body, color: colors.muted, textAlign: 'center', marginVertical: 40 }}>Couldn't load your cash flow. Pull to refresh or reopen the app.</Text>
      : !active ? <View style={{ alignItems: 'center', paddingVertical: 36 }}>
          <Text style={{ ...type.cardTitle, color: colors.text }}>No transactions in {monthLabel(month)}</Text>
          <Text style={{ ...type.caption, color: colors.muted, marginTop: 4, textAlign: 'center' }}>Income and expenses you record will appear here day by day.</Text>
        </View>
      : <>
        <Legend colors={colors} />
        <Chart buckets={buckets} view={view} selected={selected} onSelect={setSelected} colors={colors} />
        {current ? <View style={{ marginTop: 12, padding: 12, borderRadius: radius.md, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border }} accessibilityLiveRegion="polite">
          <Text style={{ ...type.captionStrong, color: colors.muted }}>{current.detail}</Text>
          <View style={{ flexDirection: 'row', marginTop: 6, gap: 8 }}>
            <Detail label="Income" value={formatMinor(current.incomePaise)} color={palette.accentText} colors={colors} />
            <Detail label="Expenses" value={formatMinor(current.expensePaise)} color={palette.expenseText} colors={colors} />
            <Detail label="Net" value={signed(current.netPaise)} color={current.netPaise < 0 ? palette.expenseText : current.netPaise > 0 ? palette.accentText : colors.text} colors={colors} />
          </View>
          {listed.length ? <View style={{ marginTop: 10 }}>{listed.map((t) => <View key={t.id}>{renderTransaction(t.id)}</View>)}</View> : null}
        </View> : null}
      </>}
  </View>;
}

function Summary({ label, value, dot, colors }: { label: string; value: string; dot: string; colors: Colors }) {
  return <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 12, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.border }}>
    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot }} />
    <View style={{ flex: 1 }}>
      <Text style={{ ...type.caption, color: colors.muted }}>{label}</Text>
      <Text style={{ ...type.amountSm, color: colors.text }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  </View>;
}

function Detail({ label, value, color, colors }: { label: string; value: string; color: string; colors: Colors }) {
  return <View style={{ flex: 1 }}>
    <Text style={{ ...type.caption, color: colors.muted }}>{label}</Text>
    <Text style={{ ...type.amountSm, color }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
  </View>;
}

function Legend({ colors }: { colors: Colors }) {
  return <View style={{ flexDirection: 'row', gap: 16, marginTop: 14, marginBottom: 6 }}>
    {[['Income', palette.emerald], ['Expenses', palette.danger]].map(([l, c]) => <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: c }} /><Text style={{ ...type.caption, color: colors.muted }}>{l}</Text>
    </View>)}
  </View>;
}

function Chart({ buckets, view, selected, onSelect, colors }: { buckets: SeriesBucket[]; view: SeriesView; selected: string | null; onSelect: (key: string) => void; colors: Colors }) {
  // Measured, not estimated: the real plot width depends on screen padding, card padding and the axis column.
  const [measured, setMeasured] = useState(0);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const max = Math.max(0, ...buckets.map((b) => Math.max(b.incomePaise, b.expensePaise)));
  const scale = niceScale(max, 3);
  const AXIS_W = 40;
  const avail = measured;
  const colW = avail === 0 ? DAILY_COL : view === 'daily' ? Math.max(DAILY_COL, Math.floor(avail / buckets.length)) : Math.min(88, Math.max(24, Math.floor(avail / buckets.length)));
  const total = colW * buckets.length;
  const barW = Math.max(6, Math.min(view === 'daily' ? 9 : 20, Math.floor((colW - 6) / 2)));
  const h = (v: number) => (v > 0 ? Math.max(3, Math.round((v / scale.max) * PLOT_HEIGHT)) : 0);
  const selIndex = buckets.findIndex((b) => b.key === selected);

  useEffect(() => {
    if (avail > 0 && total > avail && selIndex >= 0) scroller.current?.scrollTo({ x: Math.max(0, selIndex * colW - avail / 2 + colW / 2), animated: false });
  }, [view, buckets.length, avail]); // eslint-disable-line react-hooks/exhaustive-deps

  return <View style={{ flexDirection: 'row' }}>
    <View style={{ width: AXIS_W, height: PLOT_HEIGHT, marginTop: 6 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {scale.ticks.map((t) => <Text key={t} style={{ ...type.caption, color: colors.muted, position: 'absolute', right: 6, bottom: (t / scale.max) * PLOT_HEIGHT - 8, fontVariant: ['tabular-nums'] }}>{compact(t)}</Text>)}
    </View>
    <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} scrollEnabled={total > avail} style={{ flex: 1 }} onLayout={(e) => setMeasured(Math.floor(e.nativeEvent.layout.width))}>
      <View style={{ width: Math.max(total, avail) }}>
        <View style={{ height: PLOT_HEIGHT, marginTop: 6 }}>
          {scale.ticks.map((t) => <View key={t} style={{ position: 'absolute', left: 0, right: 0, bottom: (t / scale.max) * PLOT_HEIGHT, height: 1, backgroundColor: colors.border }} />)}
          <View style={{ flexDirection: 'row', height: PLOT_HEIGHT }}>
            {buckets.map((b) => {
              const on = b.key === selected;
              return <Pressable key={b.key} onPress={() => onSelect(b.key)} accessibilityRole="button" accessibilityState={{ selected: on }}
                accessibilityLabel={`${b.detail}. Income ${formatMinor(b.incomePaise)}. Expenses ${formatMinor(b.expensePaise)}.`}
                style={{ width: colW, height: PLOT_HEIGHT, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 2, backgroundColor: on ? `${palette.emerald}1F` : 'transparent', borderRadius: 6 }}>
                <View style={{ width: barW, height: h(b.incomePaise), backgroundColor: palette.emerald, borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />
                <View style={{ width: barW, height: h(b.expensePaise), backgroundColor: palette.danger, borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />
              </Pressable>;
            })}
          </View>
        </View>
        <View style={{ flexDirection: 'row', marginTop: 4 }}>
          {buckets.map((b, i) => {
            // Daily labels thin out to every 5th day (and day 1) so they never collide on narrow screens.
            const show = view !== 'daily' || colW >= 34 || i === 0 || (i + 1) % 5 === 0;
            return <View key={b.key} style={{ width: colW, alignItems: 'center' }}>
              <Text numberOfLines={1} style={{ ...type.caption, color: b.key === selected ? colors.text : colors.muted, fontWeight: b.key === selected ? '700' : '400', fontVariant: ['tabular-nums'] }}>{show ? b.label : ''}</Text>
            </View>;
          })}
        </View>
      </View>
    </ScrollView>
  </View>;
}
