import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Animated, Easing, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { palette, radius, space, tint } from '../../theme';
import { type } from '../../typography';
import { ArrowDownLeft, ArrowUpRight, CATEGORY_ICON_MAP, Search, X } from '../../icons';
import type { Direction } from '../db/types';
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
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}26`, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color, fontWeight: '700', fontSize: size * 0.4 }}>{(label.trim().charAt(0) || '?').toUpperCase()}</Text></View>;
}

export function CategoryIcon({ icon, color, label, size = 40 }: { icon?: string | null; color: string; label: string; size?: number }) {
  // accepts local names (ShoppingCart) and server kebab-case names (shopping-cart)
  const pascal = icon ? icon.split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') : '';
  const Icon = pascal ? CATEGORY_ICON_MAP[pascal] ?? CATEGORY_ICON_MAP[icon ?? ''] : undefined;
  if (!Icon) return <Initial label={label} color={color} size={size} />;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}26`, alignItems: 'center', justifyContent: 'center' }}><Icon size={size * 0.5} color={color} /></View>;
}

/** Relative luminance of a #RRGGBB colour (WCAG). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const DARK_INK = '#0B1726';
/** White or dark ink, whichever has the higher contrast on `bg` (works for every accent and category colour). */
export function readableOn(bg: string): string {
  const l = luminance(bg);
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / (luminance(DARK_INK) + 0.05)) ? '#FFFFFF' : DARK_INK;
}

export function Chip({ label, active, onPress, colors, color }: { label: string; active: boolean; onPress: () => void; colors: Colors; color?: string }) {
  const tint = color ?? palette.emerald;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [ui.chip, { borderColor: active ? tint : colors.border, backgroundColor: active ? tint : colors.card, opacity: pressed ? 0.75 : 1 }]}>
    <Text style={{ color: active ? readableOn(tint) : colors.text, ...type.chip, ...(active ? { fontWeight: '700' as const } : null) }}>{label}</Text>
  </Pressable>;
}

/**
 * Income / Expense selector. The selected side is a solid fill with contrast-checked text and icon;
 * the other side is an outline with muted content, so the choice is clear in light and dark themes.
 * It only reports the choice: the caller's `value` is the single source of truth for the saved type.
 */
export function TypeToggle({ value, onChange, colors, expenseLabel = 'Expense', incomeLabel = 'Income' }: { value: Direction; onChange: (d: Direction) => void; colors: Colors; expenseLabel?: string; incomeLabel?: string }) {
  const option = (d: Direction, label: string, Icon: typeof ArrowUpRight) => {
    const active = value === d;
    const fill = d === 'expense' ? palette.dangerDeep : palette.emerald;
    const fg = active ? readableOn(fill) : colors.muted;
    return <Pressable key={d} onPress={() => onChange(d)} accessibilityRole="radio" accessibilityState={{ selected: active, checked: active }} accessibilityLabel={label}
      style={({ pressed }) => [ui.typeOption, { backgroundColor: active ? fill : colors.card, borderColor: active ? fill : colors.border, opacity: pressed ? 0.85 : 1 }]}>
      <View style={[ui.typeIcon, { backgroundColor: active ? (fg === '#FFFFFF' ? 'rgba(255,255,255,0.18)' : 'rgba(11,23,38,0.12)') : 'transparent' }]}><Icon color={active ? fg : (d === 'expense' ? palette.danger : palette.emerald)} size={16} strokeWidth={2} /></View>
      <Text style={{ color: active ? fg : colors.text, ...type.link }}>{label}</Text>
    </Pressable>;
  };
  return <View accessibilityRole="radiogroup" style={ui.typeRow}>{option('expense', expenseLabel, ArrowUpRight)}{option('income', incomeLabel, ArrowDownLeft)}</View>;
}

export function Button({ title, onPress, kind = 'primary', disabled, busy }: { title: string; onPress: () => void; kind?: 'primary' | 'danger' | 'ghost'; disabled?: boolean; busy?: boolean }) {
  const bg = kind === 'primary' ? palette.emerald : kind === 'danger' ? tint(palette.danger, 0.14) : 'transparent';
  const border = kind === 'ghost' ? { borderWidth: 1.5, borderColor: palette.emerald } : null;
  const fg = kind === 'primary' ? readableOn(palette.emerald) : kind === 'danger' ? palette.expenseText : palette.accentText;
  const off = disabled || busy;
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!busy }} disabled={off} onPress={onPress}
    style={({ pressed }) => [ui.button, border, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1, transform: [{ scale: pressed && !off ? 0.985 : 1 }] }]}>
    <Text style={{ ...type.button, color: fg }}>{busy ? 'Please wait…' : title}</Text>
  </Pressable>;
}


/** Standard surface: every card in the app (balance excluded, it is navy) uses this padding, radius and border. */
export function Card({ colors, children, style, onPress, accessibilityLabel }: { colors: Colors; children: ReactNode; style?: ViewStyle; onPress?: () => void; accessibilityLabel?: string }) {
  const base: ViewStyle = { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: space.lg + 2 };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} android_ripple={{ color: tint(palette.accentText, 0.1) }}
    style={({ pressed }) => [base, style, pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] }]}>{children}</Pressable>;
}

/** Small uppercase caption above a group of rows. */
export function SectionLabel({ children, colors, style }: { children: string; colors: Colors; style?: TextStyle }) {
  return <Text style={[type.label, { color: colors.muted, marginTop: space.sm, marginBottom: space.sm }, style]}>{children.toUpperCase()}</Text>;
}

/** Search input with a visible focus state. */
export function SearchField({ colors, value, onChangeText, placeholder, accessibilityLabel }: { colors: Colors; value: string; onChangeText: (t: string) => void; placeholder: string; accessibilityLabel?: string }) {
  const [focused, setFocused] = useState(false);
  return <View style={[ui.search, { backgroundColor: colors.card, borderColor: focused ? palette.emerald : colors.border, borderWidth: focused ? 1.5 : 1 }]}>
    <Search size={18} color={focused ? palette.emerald : colors.muted} strokeWidth={2} />
    <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} accessibilityLabel={accessibilityLabel ?? placeholder}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} returnKeyType="search" style={[ui.searchInput, { color: colors.text }]} />
    {value ? <Pressable onPress={() => onChangeText('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search"><X size={16} color={colors.muted} strokeWidth={2} /></Pressable> : null}
  </View>;
}

/** Round 40dp icon button (close, clear, profile). */
export function IconButton({ children, onPress, colors, label, size = 40 }: { children: ReactNode; onPress: () => void; colors: Colors; label: string; size?: number }) {
  return <Pressable onPress={onPress} hitSlop={Math.max(0, (48 - size) / 2)} accessibilityRole="button" accessibilityLabel={label}
    style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? tint(palette.emerald, 0.12) : colors.card, alignItems: 'center', justifyContent: 'center' })}>{children}</Pressable>;
}

export function Labeled({ label, colors, children, hint }: { label: string; colors: Colors; children: ReactNode; hint?: string }) {
  return <View style={{ marginBottom: 14 }}><Text style={[ui.label, { color: colors.muted }]}>{label}</Text>{children}{hint ? <Text style={[ui.hint, { color: colors.muted }]}>{hint}</Text> : null}</View>;
}

export function Input({ colors, ...props }: TextInputProps & { colors: Colors }) {
  const [focused, setFocused] = useState(false);
  return <TextInput placeholderTextColor={colors.muted} {...props}
    onFocus={(e) => { setFocused(true); props.onFocus?.(e); }} onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
    style={[ui.input, { borderColor: focused ? palette.emerald : colors.border, borderWidth: focused ? 1.5 : 1, backgroundColor: colors.card, color: colors.text }, props.style]} />;
}

/** True while the software keyboard is on screen. */
export function useKeyboardVisible(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setShown(true));
    const b = Keyboard.addListener(hideEvt, () => setShown(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  return shown;
}

/**
 * Bottom sheet used for every form in the app.
 *
 * Keyboard handling (one mechanism only): the modal is drawn edge-to-edge, so Android does not resize it for the
 * keyboard; the full-screen KeyboardAvoidingView measures how much of it the keyboard covers and pads exactly that
 * much (0 if the window did resize). The sheet is capped at 92% of the remaining height, its body scrolls, and the
 * optional `footer` (primary action) sits outside the scroll area so it always stays above the keyboard.
 */
export function Sheet({ visible, onClose, title, colors, children, footer, headerAction }: { visible: boolean; onClose: () => void; title: string; colors: Colors; children: ReactNode; footer?: ReactNode; /** Optional button shown left of the close button (e.g. edit). */ headerAction?: ReactNode }) {
  const keyboard = useKeyboardVisible();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const contentRef = useRef<ComponentRef<typeof View>>(null);
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) return;
    rise.setValue(0);
    Animated.timing(rise, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [visible, rise]);
  // After the keyboard opens (and the sheet shrinks), bring the focused field back into view.
  useEffect(() => {
    if (!keyboard) return;
    const t = setTimeout(() => {
      const focused = TextInput.State.currentlyFocusedInput?.() as unknown as { measureLayout?: (rel: unknown, ok: (x: number, y: number) => void, fail?: () => void) => void } | null;
      if (!focused?.measureLayout || !contentRef.current) return;
      try { focused.measureLayout(contentRef.current, (_x, y) => scrollRef.current?.scrollTo({ y: Math.max(0, y - 72), animated: true }), () => undefined); } catch { /* best effort */ }
    }, 80);
    return () => clearTimeout(t);
  }, [keyboard]);
  // A Modal is its own Android window, so it needs its own SafeAreaProvider; without it the bottom inset reads 0 and the
  // footer buttons slide under the system navigation bar.
  return <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
    <SafeAreaProvider style={{ flex: 1 }}>
    <KeyboardAvoidingView behavior="padding" style={ui.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <Animated.View style={[ui.sheet, { backgroundColor: colors.canvas, borderColor: colors.border, opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [48, 0] }) }] }]}>
        <View style={[ui.grabber, { backgroundColor: colors.border }]} />
        <View style={ui.sheetHeader}><Text style={[ui.sheetTitle, { color: colors.text, flex: 1 }]} numberOfLines={1}>{title}</Text>{headerAction ? <View style={{ marginRight: 10 }}>{headerAction}</View> : null}<Pressable onPress={onClose} hitSlop={14} accessibilityRole="button" accessibilityLabel="Close" style={[ui.closeButton, { backgroundColor: colors.card, borderColor: colors.border }]}><X color={colors.muted} size={18} /></Pressable></View>
        <ScrollView ref={scrollRef} style={ui.sheetScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: footer ? 12 : 28 }}>
          <View ref={contentRef} collapsable={false}>{children}</View>
        </ScrollView>
        {footer ? <View style={[ui.sheetFooter, { borderTopColor: colors.border, backgroundColor: colors.canvas }]}>{footer}</View> : null}
        {/* Navigation-bar inset only while the keyboard is closed (the keyboard already covers that strip). */}
        <SafeAreaView edges={keyboard ? [] : ['bottom']} />
      </Animated.View>
    </KeyboardAvoidingView>
    </SafeAreaProvider>
  </Modal>;
}

export function EmptyBlock({ title, text, colors }: { title: string; text: string; colors: Colors }) {
  return <View style={[ui.empty, { backgroundColor: colors.card, borderColor: colors.border }]}><Text style={{ color: colors.text, ...type.cardTitle }}>{title}</Text><Text style={{ color: colors.muted, textAlign: 'center', marginTop: 6 }}>{text}</Text></View>;
}

export const ui = StyleSheet.create({
  chip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', marginRight: 8 },
  search: { minHeight: 48, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10, marginBottom: 12 },
  searchInput: { flex: 1, minHeight: 46, ...type.body },
  button: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginTop: 8 },
  label: { ...type.label, marginBottom: 6 },
  hint: { ...type.caption, marginTop: 4 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 14, ...type.body },
  backdrop: { flex: 1, backgroundColor: 'rgba(8,24,39,0.55)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl + 2, borderTopRightRadius: radius.xl + 2, maxHeight: '92%', flexShrink: 1, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12 },
  sheetTitle: { ...type.heading, flex: 1, marginRight: 12 },
  closeButton: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sheetFooter: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12, borderTopWidth: StyleSheet.hairlineWidth },
  typeRow: { flexDirection: 'row', gap: 10 },
  typeOption: { flex: 1, minHeight: 50, borderRadius: 14, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 10 },
  typeIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  empty: { borderWidth: 1, borderRadius: radius.lg, padding: 24, alignItems: 'center', marginVertical: 8 },
});

/** Pill-shaped segmented control: one option selected, each option a 40dp-tall tab with an accessible selected state. */
export function Segmented<T extends string>({ options, value, onChange, colors }: { options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void; colors: Colors }) {
  return <View accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: tint(palette.emerald, 0.1), borderRadius: radius.pill, padding: 3 }}>
    {options.map(([k, label]) => { const on = value === k; return <Pressable key={k} onPress={() => onChange(k)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={label}
      style={{ flex: 1, minHeight: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, backgroundColor: on ? colors.card : 'transparent', borderWidth: on ? 1 : 0, borderColor: colors.border }}>
      <Text style={{ ...type.chip, color: on ? palette.accentText : colors.muted }} numberOfLines={1}>{label}</Text></Pressable>; })}
  </View>;
}

/** Gradient summary surface (the same treatment as the Home balance card): darkened accent shades, white text inside. */
export function HeroSurface({ children, style, accessibilityLabel, onPress }: { children: ReactNode; style?: ViewStyle; accessibilityLabel?: string; onPress?: () => void }) {
  const inner = <>
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
      <Defs><LinearGradient id="velnoraHero" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={palette.heroStart} /><Stop offset="1" stopColor={palette.heroEnd} /></LinearGradient></Defs>
      <Path d="M0 0H2000V2000H0Z" fill="url(#velnoraHero)" />
      <Circle cx="92%" cy="6%" r="80" fill="#FFFFFF" fillOpacity={0.06} />
    </Svg>
    {children}
  </>;
  const base: ViewStyle = { borderRadius: radius.xl, padding: space.xl, overflow: 'hidden', backgroundColor: palette.heroEnd };
  if (!onPress) return <View style={[base, style]}>{inner}</View>;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={({ pressed }) => [base, style, pressed && { opacity: 0.92 }]}>{inner}</Pressable>;
}
