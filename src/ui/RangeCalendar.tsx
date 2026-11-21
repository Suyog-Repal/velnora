import { memo, useCallback, useMemo } from 'react';
import { FlatList, StyleSheet, Text, View, Pressable, useWindowDimensions } from 'react-native';
import { palette, tint } from '../../theme';
import { typo } from '../../typography';
import { MONTH_NAMES, WEEKDAYS_SHORT, formatDisplayDate, monthCells, toYmd, type Ymd } from '../services/dateUtils';
import type { DateSelection, DayMarks, MonthRef } from '../services/calendarMarks';
import { readableOn, type Colors } from './common';

/**
 * Scrolling month list for the Transactions date filter: newest month first, going back in time. Each day shows an
 * expense dot (left slot) and/or an income dot (right slot) so the two are told apart by position, not only colour.
 * Presentational only: the parent owns the selection and the data (see services/calendarMarks.ts).
 */

const DAY = 36;
const ROW = 52;
const MONTH_HEADER = 38;
const MONTH_GAP = 6;
const DOT = 6;

const rowsOf = (m: MonthRef) => monthCells(m.year, m.month0).length / 7;
const heightOf = (m: MonthRef) => MONTH_HEADER + rowsOf(m) * ROW + MONTH_GAP;

/** Legend chip: the same two-slot dot layout the days use. */
function LegendItem({ kind, label, colors }: { kind: 'expense' | 'income'; label: string; colors: Colors }) {
  return <View style={s.legendItem} accessible accessibilityLabel={`${label} dot: ${kind === 'expense' ? 'left' : 'right'} under the date`}>
    <Dots expense={kind === 'expense'} income={kind === 'income'} />
    <Text style={{ ...typo.caption, color: colors.muted, marginLeft: 6 }}>{label}</Text>
  </View>;
}

function Dots({ expense, income }: { expense: boolean; income: boolean }) {
  return <View style={s.dots}>
    <View style={[s.dot, expense && { backgroundColor: palette.expenseText }]} />
    <View style={[s.dot, income && { backgroundColor: palette.emerald }]} />
  </View>;
}

function dayDescription(ymd: Ymd, today: Ymd, expense: boolean, income: boolean, selected: boolean, inRange: boolean): string {
  const parts = [formatDisplayDate(ymd)];
  if (ymd === today) parts.push('today');
  parts.push(expense && income ? 'expenses and income' : expense ? 'expenses' : income ? 'income' : 'no transactions');
  if (selected) parts.push('selected'); else if (inRange) parts.push('in selected range');
  return parts.join(', ');
}

const MonthBlock = memo(function MonthBlock({ month, marks, selection, today, colors, onPick }: {
  month: MonthRef; marks: DayMarks; selection: DateSelection; today: Ymd; colors: Colors; onPick: (ymd: Ymd) => void;
}) {
  const cells = monthCells(month.year, month.month0);
  const { from, to } = selection;
  const range = !!from && !!to && from !== to;
  const accent = palette.emerald;
  return <View style={{ height: heightOf(month), paddingBottom: MONTH_GAP }}>
    <Text accessibilityRole="header" style={{ ...typo.cardTitle, color: colors.text, height: MONTH_HEADER, paddingTop: 10 }}>{MONTH_NAMES[month.month0]} {month.year}</Text>
    <View style={s.grid}>
      {cells.map((day, i) => {
        if (day === null) return <View key={`b${i}`} style={s.cell} />;
        const ymd = toYmd(month.year, month.month0, day);
        const future = ymd > today;
        const mark = marks.get(ymd);
        const expense = !future && !!mark && mark.expenseCount > 0;
        const income = !future && !!mark && mark.incomeCount > 0;
        const isFrom = ymd === from; const isTo = ymd === to;
        const selected = isFrom || isTo;
        const inRange = !!from && !!to && ymd > from && ymd < to;
        return <View key={ymd} style={s.cell}>
          {range && (inRange || isFrom || isTo) ? <View pointerEvents="none" style={[s.band, { backgroundColor: tint(accent, 0.16), left: isFrom ? '50%' : 0, right: isTo ? '50%' : 0 }]} /> : null}
          <Pressable disabled={future} onPress={() => onPick(ymd)} accessibilityRole="button"
            accessibilityState={{ selected, disabled: future }} accessibilityLabel={dayDescription(ymd, today, expense, income, selected, inRange)}
            style={[s.day, selected && { backgroundColor: accent }, !selected && ymd === today && { borderWidth: 1.5, borderColor: accent }]}>
            <Text style={{ color: selected ? readableOn(accent) : future ? colors.muted : colors.text, opacity: future ? 0.35 : 1, fontWeight: selected || ymd === today ? '800' : '500', fontSize: 14 }}>{day}</Text>
          </Pressable>
          <Dots expense={expense} income={income} />
        </View>;
      })}
    </View>
  </View>;
});

export function RangeCalendar({ months, marks, selection, today, colors, onPick }: {
  months: MonthRef[]; marks: DayMarks; selection: DateSelection; today: Ymd; colors: Colors; onPick: (ymd: Ymd) => void;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const listHeight = Math.max(260, Math.min(430, Math.round(windowHeight * 0.44)));
  const offsets = useMemo(() => { let y = 0; return months.map((m) => { const o = y; y += heightOf(m); return o; }); }, [months]);
  const getItemLayout = useCallback((_: unknown, index: number) => ({ length: heightOf(months[index]), offset: offsets[index], index }), [months, offsets]);
  // Open on the month of an existing selection so it is in view; otherwise on the current month (index 0).
  const startIndex = useMemo(() => {
    if (!selection.from) return 0;
    const i = months.findIndex((m) => toYmd(m.year, m.month0, 1) <= selection.from! && selection.from! <= toYmd(m.year, m.month0, 31));
    return Math.max(0, i);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const keyOf = useCallback((m: MonthRef) => `${m.year}-${m.month0}`, []);
  const renderItem = useCallback(({ item }: { item: MonthRef }) => <MonthBlock month={item} marks={marks} selection={selection} today={today} colors={colors} onPick={onPick} />, [marks, selection, today, colors, onPick]);

  return <View>
    <View style={s.legend}>
      <LegendItem kind="expense" label="Expense" colors={colors} />
      <LegendItem kind="income" label="Income" colors={colors} />
    </View>
    <View style={[s.weekdays, { backgroundColor: colors.canvas2 ?? colors.card, borderColor: colors.border }]}>
      {WEEKDAYS_SHORT.map((d) => <Text key={d} style={[s.weekday, { color: colors.muted }]}>{d}</Text>)}
    </View>
    <FlatList style={{ height: listHeight }} data={months} keyExtractor={keyOf} renderItem={renderItem} getItemLayout={getItemLayout}
      initialScrollIndex={startIndex} initialNumToRender={2} maxToRenderPerBatch={2} windowSize={5}
      nestedScrollEnabled showsVerticalScrollIndicator accessibilityLabel={`Calendar, ${months.length} month${months.length === 1 ? '' : 's'}, newest first`} />
  </View>;
}

const s = StyleSheet.create({
  legend: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  weekdays: { flexDirection: 'row', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  weekday: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 12, fontWeight: '700', paddingVertical: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, height: ROW, alignItems: 'center' },
  band: { position: 'absolute', top: 2, height: DAY },
  day: { width: DAY, height: DAY, marginTop: 2, borderRadius: DAY / 2, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', width: DOT * 2 + 4, justifyContent: 'space-between', marginTop: 4, height: DOT },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});
