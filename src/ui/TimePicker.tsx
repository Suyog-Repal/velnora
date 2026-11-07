import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { palette } from '../../theme';
import { Clock } from '../../icons';
import { formatDisplayTime, localHm, parseHm, toHm } from '../services/dateUtils';
import { readableOn, type Colors } from './common';

const SIZE = 248;
const C = SIZE / 2;
const R = 96;          // radius of the number ring
const KNOB = 38;

const pad = (n: number) => String(n).padStart(2, '0');

/** Angle (0° = 12 o'clock, clockwise) of a touch point on the dial. */
function touchAngle(e: GestureResponderEvent): number {
  const { locationX, locationY } = e.nativeEvent;
  const deg = (Math.atan2(locationX - C, -(locationY - C)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Clock-style 12-hour time picker (hour dial → minute dial, AM/PM, Cancel/OK). Values are local 'HH:mm' strings.
 * Built from plain views so it needs no native module; the dial reads the touch position directly, so any minute
 * can be chosen by dragging.
 */
export function TimePickerModal({ visible, value, colors, onCancel, onConfirm, title = 'Select time' }: {
  visible: boolean; value: string | null; colors: Colors; onCancel: () => void; onConfirm: (hm: string) => void; title?: string;
}) {
  const [hour12, setHour12] = useState(12);
  const [minute, setMinute] = useState(0);
  const [pm, setPm] = useState(false);
  const [mode, setMode] = useState<'hour' | 'minute'>('hour');

  useEffect(() => {
    if (!visible) return;
    const t = parseHm(value) ?? parseHm(localHm())!;
    setHour12(t.hour % 12 === 0 ? 12 : t.hour % 12); setMinute(t.minute); setPm(t.hour >= 12); setMode('hour');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (e: GestureResponderEvent) => {
    const a = touchAngle(e);
    if (mode === 'hour') { const h = Math.round(a / 30) % 12; setHour12(h === 0 ? 12 : h); } else setMinute(Math.round(a / 6) % 60);
  };
  const hour24 = (hour12 % 12) + (pm ? 12 : 0);
  const handAngle = mode === 'hour' ? (hour12 % 12) * 30 : minute * 6;
  const rad = (handAngle * Math.PI) / 180;
  const knobX = C + R * Math.sin(rad);
  const knobY = C - R * Math.cos(rad);
  const accent = palette.emerald;
  const onAccent = readableOn(accent);
  const labels = mode === 'hour' ? Array.from({ length: 12 }, (_, i) => ({ text: String(i + 1), angle: (i + 1) * 30, selected: (i + 1) === hour12 }))
    : Array.from({ length: 12 }, (_, i) => ({ text: pad(i * 5), angle: i * 30, selected: i * 5 === minute }));
  const knobLabel = mode === 'hour' ? String(hour12) : minute % 5 === 0 ? pad(minute) : '';

  const seg = (label: string, active: boolean, onPress: () => void, a11y: string) => <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected: active }}
    style={[s.segBtn, { backgroundColor: active ? accent : colors.card, borderColor: active ? accent : colors.border }]}><Text style={{ color: active ? onAccent : colors.text, fontWeight: '800', fontSize: 13 }}>{label}</Text></Pressable>;

  return <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
    <View style={s.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Close time picker" />
      <View style={[s.dialog, { backgroundColor: colors.canvas, borderColor: colors.border }]}>
        <Text style={[s.dialogTitle, { color: colors.muted }]}>{title.toUpperCase()}</Text>
        <View style={s.readout}>
          <Pressable onPress={() => setMode('hour')} accessibilityRole="button" accessibilityLabel={`Hour ${hour12}`} style={[s.digits, { backgroundColor: mode === 'hour' ? `${accent}26` : colors.card }]}><Text style={[s.digitText, { color: mode === 'hour' ? accent : colors.text }]}>{pad(hour12)}</Text></Pressable>
          <Text style={[s.digitText, { color: colors.text, marginHorizontal: 4 }]}>:</Text>
          <Pressable onPress={() => setMode('minute')} accessibilityRole="button" accessibilityLabel={`Minute ${minute}`} style={[s.digits, { backgroundColor: mode === 'minute' ? `${accent}26` : colors.card }]}><Text style={[s.digitText, { color: mode === 'minute' ? accent : colors.text }]}>{pad(minute)}</Text></Pressable>
          <View style={{ marginLeft: 12, gap: 6 }}>{seg('AM', !pm, () => setPm(false), 'AM')}{seg('PM', pm, () => setPm(true), 'PM')}</View>
        </View>

        <View style={[s.dial, { backgroundColor: colors.card, borderColor: colors.border }]}
          onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
          onResponderGrant={pick} onResponderMove={pick}
          onResponderRelease={() => { if (mode === 'hour') setMode('minute'); }}
          accessibilityLabel={mode === 'hour' ? 'Clock face: choose the hour' : 'Clock face: choose the minute'}>
          <View pointerEvents="none" style={{ position: 'absolute', left: C - 1, top: C - R, width: 2, height: 2 * R, transform: [{ rotate: `${handAngle}deg` }] }}><View style={{ height: R, backgroundColor: accent }} /></View>
          <View pointerEvents="none" style={{ position: 'absolute', left: C - 4, top: C - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: accent }} />
          {labels.map((l) => {
            const r = (l.angle * Math.PI) / 180;
            // The wrapper View (not the Text) carries pointerEvents="none": Text ignores it on Android, which made touches
            // on a number report coordinates relative to the label instead of the dial.
            return <View key={l.text} pointerEvents="none" style={{ position: 'absolute', left: C + R * Math.sin(r) - 16, top: C - R * Math.cos(r) - 16, width: 32, height: 32 }}>
              <Text style={[s.dialNum, { color: l.selected ? 'transparent' : colors.text }]}>{l.text}</Text>
            </View>;
          })}
          <View pointerEvents="none" style={{ position: 'absolute', left: knobX - KNOB / 2, top: knobY - KNOB / 2, width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: accent, alignItems: 'center', justifyContent: 'center' }}>
            {knobLabel ? <Text style={{ color: onAccent, fontWeight: '800', fontSize: 15 }}>{knobLabel}</Text> : <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: onAccent }} />}
          </View>
        </View>

        <View style={s.actions}>
          <Text style={{ color: colors.muted, flex: 1, fontSize: 12 }}>{mode === 'hour' ? 'Tap or drag to pick the hour' : 'Drag to pick the minute'}</Text>
          <Pressable onPress={onCancel} accessibilityRole="button" style={s.textBtn}><Text style={{ color: colors.muted, fontWeight: '800' }}>Cancel</Text></Pressable>
          <Pressable onPress={() => onConfirm(toHm(hour24, minute))} accessibilityRole="button" style={s.textBtn}><Text style={{ color: accent, fontWeight: '800' }}>OK</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

/** Tappable form field showing a time that opens the clock dialog. */
export function TimeField({ value, onChange, colors, title, accessibilityLabel }: { value: string; onChange: (hm: string) => void; colors: Colors; title?: string; accessibilityLabel?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${accessibilityLabel ?? 'Time'}: ${formatDisplayTime(value)}`}
      style={[s.field, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Clock size={18} color={colors.muted} />
      <Text numberOfLines={1} style={{ flex: 1, marginLeft: 10, color: colors.text, fontSize: 15 }}>{formatDisplayTime(value) || 'Select time'}</Text>
    </Pressable>
    <TimePickerModal visible={open} value={value} title={title} colors={colors} onCancel={() => setOpen(false)} onConfirm={(v) => { setOpen(false); onChange(v); }} />
  </>;
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(8,24,39,0.55)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  dialog: { width: '100%', maxWidth: 340, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 18, alignItems: 'center' },
  dialogTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1, alignSelf: 'flex-start' },
  readout: { flexDirection: 'row', alignItems: 'center', marginTop: 10, marginBottom: 16 },
  digits: { minWidth: 76, height: 64, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  digitText: { fontSize: 40, fontWeight: '800' },
  segBtn: { width: 52, height: 30, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dial: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 1 },
  dialNum: { width: 32, height: 32, textAlign: 'center', textAlignVertical: 'center', lineHeight: 32, fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', marginTop: 12 },
  textBtn: { minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  field: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
});
