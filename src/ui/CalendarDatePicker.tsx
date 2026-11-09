import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { palette } from '../../theme';
import { CalendarDays, ChevronLeft, ChevronRight } from '../../icons';
import { MONTH_NAMES, WEEKDAYS_SHORT, formatDisplayDate, isWithin, localYmd, monthCells, parseYmd, shiftMonth, toYmd, validateRange, type Ymd } from '../services/dateUtils';
import { readableOn, type Colors } from './common';

/**
 * The one calendar used everywhere (add/edit transaction, Transactions date filter, Analytics custom range).
 * Values are local 'YYYY-MM-DD' strings, so nothing here can shift by a timezone.
 */
export function CalendarDatePicker({ value, onChange, min, max, colors }: {
  value: Ymd | null; onChange: (ymd: Ymd) => void; min?: Ymd | null; max?: Ymd | null; colors: Colors;
}) {
  const today = localYmd();
  const seed = parseYmd(value) ?? parseYmd(today)!;
  const [view, setView] = useState({ year: seed.year, month0: seed.month0 });
  // Re-centre when the selected value is changed from outside (e.g. the picker is reopened with a different date).
  useEffect(() => { const p = parseYmd(value); if (p) setView({ year: p.year, month0: p.month0 }); }, [value]);

  const cells = monthCells(view.year, view.month0);
  const first = toYmd(view.year, view.month0, 1);
  const last = toYmd(view.year, view.month0, cells.filter(Boolean).length);
  const canPrev = !min || first > min;
  const canNext = !max || last < max;
  const go = (delta: number) => setView((v) => shiftMonth(v.year, v.month0, delta));
  const accent = palette.emerald;

  return <View accessibilityLabel={`Calendar, ${MONTH_NAMES[view.month0]} ${view.year}`}>
    <View style={s.header}>
      <Pressable onPress={() => go(-1)} disabled={!canPrev} hitSlop={8} accessibilityRole="button" accessibilityLabel="Previous month" style={[s.nav, { borderColor: colors.border, opacity: canPrev ? 1 : 0.3 }]}><ChevronLeft size={20} color={colors.text} /></Pressable>
      <Text style={[s.title, { color: colors.text }]} accessibilityRole="header">{MONTH_NAMES[view.month0]} {view.year}</Text>
      <Pressable onPress={() => go(1)} disabled={!canNext} hitSlop={8} accessibilityRole="button" accessibilityLabel="Next month" style={[s.nav, { borderColor: colors.border, opacity: canNext ? 1 : 0.3 }]}><ChevronRight size={20} color={colors.text} /></Pressable>
    </View>
    <View style={s.row}>{WEEKDAYS_SHORT.map((d) => <Text key={d} style={[s.weekday, { color: colors.muted }]}>{d}</Text>)}</View>
    <View style={s.grid}>
      {cells.map((day, i) => {
        if (day === null) return <View key={`b${i}`} style={s.cell} />;
        const ymd = toYmd(view.year, view.month0, day);
        const selected = ymd === value;
        const isToday = ymd === today;
        const enabled = isWithin(ymd, min, max);
        return <View key={ymd} style={s.cell}>
          <Pressable disabled={!enabled} onPress={() => onChange(ymd)} accessibilityRole="button" accessibilityState={{ selected, disabled: !enabled }}
            accessibilityLabel={`${formatDisplayDate(ymd)}${isToday ? ', today' : ''}`}
            style={[s.day, selected && { backgroundColor: accent }, !selected && isToday && { borderWidth: 1.5, borderColor: accent }]}>
            <Text style={{ color: selected ? readableOn(accent) : enabled ? colors.text : colors.muted, opacity: enabled ? 1 : 0.35, fontWeight: selected || isToday ? '800' : '500', fontSize: 14 }}>{day}</Text>
          </Pressable>
        </View>;
      })}
    </View>
  </View>;
}

/** Centered dialog hosting the calendar with Cancel / OK. Nothing changes until OK is pressed. */
export function DatePickerModal({ visible, title = 'Select date', value, min, max, colors, onCancel, onConfirm }: {
  visible: boolean; title?: string; value: Ymd | null; min?: Ymd | null; max?: Ymd | null; colors: Colors; onCancel: () => void; onConfirm: (ymd: Ymd) => void;
}) {
  const [draft, setDraft] = useState<Ymd | null>(value);
  useEffect(() => { if (visible) setDraft(value ?? (isWithin(localYmd(), min, max) ? localYmd() : min ?? max ?? localYmd())); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
    <View style={s.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Close date picker" />
      <View style={[s.dialog, { backgroundColor: colors.canvas, borderColor: colors.border }]}>
        <Text style={[s.dialogTitle, { color: colors.muted }]}>{title.toUpperCase()}</Text>
        <Text style={[s.dialogValue, { color: colors.text }]}>{draft ? formatDisplayDate(draft) : 'Select a date'}</Text>
        <CalendarDatePicker value={draft} onChange={setDraft} min={min} max={max} colors={colors} />
        <View style={s.actions}>
          <Pressable onPress={() => setDraft(isWithin(localYmd(), min, max) ? localYmd() : draft)} accessibilityRole="button" style={s.textBtn}><Text style={{ color: palette.accentText, fontWeight: '700' }}>Today</Text></Pressable>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onCancel} accessibilityRole="button" style={s.textBtn}><Text style={{ color: colors.muted, fontWeight: '700' }}>Cancel</Text></Pressable>
          <Pressable disabled={!draft} onPress={() => draft && onConfirm(draft)} accessibilityRole="button" style={[s.textBtn, { opacity: draft ? 1 : 0.4 }]}><Text style={{ color: palette.accentText, fontWeight: '700' }}>OK</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

/** Tappable form field showing a date (or placeholder) that opens the calendar dialog. */
export function DateField({ value, onChange, min, max, colors, title, placeholder = 'Select date', accessibilityLabel }: {
  value: Ymd | null; onChange: (ymd: Ymd) => void; min?: Ymd | null; max?: Ymd | null; colors: Colors; title?: string; placeholder?: string; accessibilityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${accessibilityLabel ?? title ?? 'Date'}: ${value ? formatDisplayDate(value) : placeholder}`}
      style={({ pressed }) => [s.field, { backgroundColor: colors.card, borderColor: pressed || open ? palette.emerald : colors.border, borderWidth: pressed || open ? 1.5 : 1 }]}>
      <CalendarDays size={18} color={open ? palette.emerald : colors.muted} strokeWidth={2} />
      <Text numberOfLines={1} style={{ flex: 1, marginLeft: 10, color: value ? colors.text : colors.muted, fontSize: 16 }}>{value ? formatDisplayDate(value) : placeholder}</Text>
    </Pressable>
    <DatePickerModal visible={open} title={title} value={value} min={min} max={max} colors={colors} onCancel={() => setOpen(false)} onConfirm={(v) => { setOpen(false); onChange(v); }} />
  </>;
}

/**
 * Start + End fields sharing the calendar. Picking a start after the current end moves the end to match;
 * the end calendar cannot go before the start. A validation message appears if the range is ever invalid.
 */
export function DateRangeFields({ from, to, onChange, colors }: { from: Ymd | null; to: Ymd | null; onChange: (from: Ymd | null, to: Ymd | null) => void; colors: Colors }) {
  const check = from && to ? validateRange(from, to) : null;
  return <View>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}>
        <Text style={[s.fieldLabel, { color: colors.muted }]}>START</Text>
        <DateField value={from} colors={colors} title="Start date" placeholder="Select date" accessibilityLabel="Start date"
          onChange={(v) => onChange(v, to && to < v ? v : to)} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.fieldLabel, { color: colors.muted }]}>END</Text>
        <DateField value={to} min={from} colors={colors} title="End date" placeholder="Select date" accessibilityLabel="End date"
          onChange={(v) => onChange(from, v)} />
      </View>
    </View>
    {check && !check.ok ? <Text style={{ color: palette.expenseText, marginTop: 6, fontSize: 12 }} accessibilityLiveRegion="polite">{check.error}</Text> : null}
  </View>;
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  nav: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row' },
  weekday: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 12, fontWeight: '700', paddingVertical: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  day: { width: '86%', aspectRatio: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(8,24,39,0.55)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  dialog: { width: '100%', maxWidth: 380, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 18 },
  dialogTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 1 },
  dialogValue: { fontSize: 22, fontWeight: '700', marginTop: 4, marginBottom: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  textBtn: { minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  field: { minHeight: 48, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
  fieldLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.6, marginBottom: 6 },
});
