import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { palette } from '../../theme';
import { CATEGORY_ICON_MAP, X } from '../../icons';
import { formatMinor } from './currency';

export type Colors = { canvas: string; card: string; border: string; text: string; muted: string };

export { currencySymbol } from './currency';
export const formatPaise = (paise: number): string => formatMinor(paise);

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => NetInfo.addEventListener((s) => setOnline(s.isConnected !== false && s.isInternetReachable !== false)), []);
  return online;
}

export function Initial({ label, color, size = 40 }: { label: string; color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}26`, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color, fontWeight: '800', fontSize: size * 0.4 }}>{(label.trim().charAt(0) || '?').toUpperCase()}</Text></View>;
}

export function CategoryIcon({ icon, color, label, size = 40 }: { icon?: string | null; color: string; label: string; size?: number }) {
  // accepts local names (ShoppingCart) and server kebab-case names (shopping-cart)
  const pascal = icon ? icon.split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') : '';
  const Icon = pascal ? CATEGORY_ICON_MAP[pascal] ?? CATEGORY_ICON_MAP[icon ?? ''] : undefined;
  if (!Icon) return <Initial label={label} color={color} size={size} />;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}26`, alignItems: 'center', justifyContent: 'center' }}><Icon size={size * 0.5} color={color} /></View>;
}

export function Chip({ label, active, onPress, colors, color }: { label: string; active: boolean; onPress: () => void; colors: Colors; color?: string }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} style={[ui.chip, { borderColor: active ? (color ?? palette.emerald) : colors.border, backgroundColor: active ? `${color ?? palette.emerald}22` : colors.card }]}>
    <Text style={{ color: active ? (color ?? palette.emerald) : colors.muted, fontWeight: '700', fontSize: 13 }}>{label}</Text>
  </Pressable>;
}

export function Button({ title, onPress, kind = 'primary', disabled, busy }: { title: string; onPress: () => void; kind?: 'primary' | 'danger' | 'ghost'; disabled?: boolean; busy?: boolean }) {
  const bg = kind === 'primary' ? palette.emerald : kind === 'danger' ? '#FCE7EA' : 'transparent';
  const border = kind === 'ghost' ? { borderWidth: 1, borderColor: palette.emerald } : null;
  const fg = kind === 'primary' ? '#FFFFFF' : kind === 'danger' ? palette.danger : palette.emerald;
  return <Pressable accessibilityRole="button" disabled={disabled || busy} onPress={onPress} style={[ui.button, border, { backgroundColor: bg, opacity: disabled || busy ? 0.6 : 1 }]}><Text style={{ color: fg, fontWeight: '800' }}>{busy ? 'Please wait…' : title}</Text></Pressable>;
}

export function Labeled({ label, colors, children, hint }: { label: string; colors: Colors; children: ReactNode; hint?: string }) {
  return <View style={{ marginBottom: 14 }}><Text style={[ui.label, { color: colors.muted }]}>{label}</Text>{children}{hint ? <Text style={[ui.hint, { color: colors.muted }]}>{hint}</Text> : null}</View>;
}

export function Input({ colors, ...props }: TextInputProps & { colors: Colors }) {
  return <TextInput placeholderTextColor={colors.muted} {...props} style={[ui.input, { borderColor: colors.border, backgroundColor: colors.card, color: colors.text }, props.style]} />;
}

/** Bottom sheet: slides up, dims the backdrop, scrolls, and stays above the keyboard. */
export function Sheet({ visible, onClose, title, colors, children }: { visible: boolean; onClose: () => void; title: string; colors: Colors; children: ReactNode }) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={ui.backdrop}>
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior="padding">
        <View style={[ui.sheet, { backgroundColor: colors.canvas }]}>
          <View style={ui.sheetHeader}><Text style={[ui.sheetTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text><Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close"><X color={colors.muted} /></Pressable></View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}

export function EmptyBlock({ title, text, colors }: { title: string; text: string; colors: Colors }) {
  return <View style={[ui.empty, { backgroundColor: colors.card, borderColor: colors.border }]}><Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{title}</Text><Text style={{ color: colors.muted, textAlign: 'center', marginTop: 6 }}>{text}</Text></View>;
}

export const ui = StyleSheet.create({
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  button: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginTop: 8 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
  hint: { fontSize: 12, marginTop: 4 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: 'rgba(8,24,39,0.55)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18 },
  sheetTitle: { fontSize: 18, fontWeight: '800', flex: 1, marginRight: 12 },
  empty: { borderWidth: 1, borderRadius: 18, padding: 24, alignItems: 'center', marginVertical: 8 },
});
