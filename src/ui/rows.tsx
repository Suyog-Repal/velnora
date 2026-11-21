import { useCallback, useRef, type ReactNode } from 'react';
import { Animated, LayoutAnimation, Platform, Pressable, Switch, Text, UIManager, View } from 'react-native';
import { palette, radius, tint } from '../../theme';
import { typo } from '../../typography';
import { ChevronRight } from '../../icons';
import { readableOn, type Colors } from './common';
import { useReduceMotion } from './motion';

/**
 * Shared rows for Profile, Settings and Privacy & data. One look everywhere:
 *  - NavRow     opens another screen or picker (chevron)
 *  - SwitchRow  a real on/off switch (whole row is the 48dp+ touch target; role "switch" with its state)
 *  - ValueRow   a label with its current value on the right (chevron only when it opens a picker)
 *  - InfoRow    plain explanatory text, not tappable
 *  - ActionRow  runs an action in place (no chevron: nothing opens), e.g. "Open settings", "Delete local data"
 * Subtitles describe what a setting does, never its current state.
 */

if (Platform.OS === 'android' && typeof UIManager.setLayoutAnimationEnabledExperimental === 'function') {
  try { UIManager.setLayoutAnimationEnabledExperimental(true); } catch { /* the new architecture animates layout without this */ }
}

/** Call right before a state change that shows/hides rows so the change animates (skipped with reduce-motion). */
export function useAnimateNext(): () => void {
  const reduce = useReduceMotion();
  return useCallback(() => { if (!reduce) { try { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); } catch { /* best effort */ } } }, [reduce]);
}

/** Pressable that gives tactile feedback (springs down on press, back on release). */
export function Tap({ onPress, children, disabled, style, label }: { onPress?: () => void; children: ReactNode; disabled?: boolean; style?: object; label?: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) => Animated.spring(scale, { toValue: value, friction: 7, tension: 220, useNativeDriver: true }).start();
  return <Pressable disabled={disabled || !onPress} onPress={onPress} onPressIn={() => to(0.97)} onPressOut={() => to(1)} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label}>
    <Animated.View style={[{ transform: [{ scale }] }, style]}>{children}</Animated.View>
  </Pressable>;
}

/** A rounded card of rows with an optional small-caps title above it. */
export function Group({ title, colors, children }: { title?: string; colors: Colors; children: ReactNode }) {
  return <View style={{ marginTop: title ? 22 : 16 }}>
    {title ? <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 }}>{title.toUpperCase()}</Text> : null}
    <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 20, overflow: 'hidden' }}>{children}</View>
  </View>;
}

type Tone = 'danger' | 'warning';
const toneColor = (tone?: Tone) => tone === 'danger' ? palette.danger : tone === 'warning' ? palette.warning : palette.emerald;

function IconTile({ icon, tone }: { icon: ReactNode; tone?: Tone }) {
  return <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${toneColor(tone)}1F`, alignItems: 'center', justifyContent: 'center' }}>{icon}</View>;
}

function RowText({ title, subtitle, colors, tone }: { title: string; subtitle?: string; colors: Colors; tone?: Tone }) {
  return <View style={{ flex: 1, marginLeft: 12 }}>
    <Text style={{ color: tone === 'danger' ? palette.expenseText : colors.text, fontWeight: '700', fontSize: 15 }}>{title}</Text>
    {subtitle ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{subtitle}</Text> : null}
  </View>;
}

const rowBox = (colors: Colors, last?: boolean) => ({ flexDirection: 'row' as const, alignItems: 'center' as const, minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border });

export function NavRow({ icon, title, subtitle, badge, onPress, last, colors }: {
  icon: ReactNode; title: string; subtitle?: string; /** Count pill shown before the chevron (e.g. items to review). */ badge?: number; onPress: () => void; last?: boolean; colors: Colors;
}) {
  return <Tap onPress={onPress} label={badge ? `${title}, ${badge} to review` : title} style={rowBox(colors, last)}>
    <IconTile icon={icon} />
    <RowText title={title} subtitle={subtitle} colors={colors} />
    {badge ? <View style={{ minWidth: 24, height: 24, paddingHorizontal: 7, borderRadius: 12, backgroundColor: palette.emerald, alignItems: 'center', justifyContent: 'center', marginRight: 8 }}><Text style={{ color: readableOn(palette.emerald), fontSize: 12, fontWeight: '700' }}>{badge > 99 ? '99+' : badge}</Text></View> : null}
    <ChevronRight size={18} color={colors.muted} />
  </Tap>;
}

export function SwitchRow({ icon, title, subtitle, value, onValueChange, disabled, last, colors }: {
  icon?: ReactNode; title: string; subtitle?: string; value: boolean; onValueChange: (next: boolean) => void; disabled?: boolean; last?: boolean; colors: Colors;
}) {
  return <Pressable onPress={() => onValueChange(!value)} disabled={disabled} accessibilityRole="switch" accessibilityLabel={title} accessibilityHint={subtitle}
    accessibilityState={{ checked: value, disabled: !!disabled }} style={[rowBox(colors, last), disabled && { opacity: 0.5 }]}>
    {icon ? <IconTile icon={icon} /> : null}
    <RowText title={title} subtitle={subtitle} colors={colors} />
    {/* The row is the control; the switch only draws the state, so there is one touch target and one accessibility node. */}
    <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Switch value={value} disabled={disabled} trackColor={{ false: colors.border, true: palette.emerald }} thumbColor="#FFFFFF" ios_backgroundColor={colors.border} />
    </View>
  </Pressable>;
}

export function ValueRow({ icon, title, value, onPress, last, colors }: { icon?: ReactNode; title: string; value: string; /** Set when the row opens a picker: shows a chevron. */ onPress?: () => void; last?: boolean; colors: Colors }) {
  const body = <>
    {icon ? <IconTile icon={icon} /> : null}
    <RowText title={title} colors={colors} />
    <Text style={{ color: palette.accentText, fontWeight: '700', fontSize: 15, marginLeft: 8 }}>{value}</Text>
    {onPress ? <ChevronRight size={18} color={colors.muted} style={{ marginLeft: 4 }} /> : null}
  </>;
  return onPress
    ? <Tap onPress={onPress} label={`${title}, ${value}`} style={rowBox(colors, last)}>{body}</Tap>
    : <View accessible accessibilityLabel={`${title}, ${value}`} style={rowBox(colors, last)}>{body}</View>;
}

export function InfoRow({ text, last, colors }: { text: string; last?: boolean; colors: Colors }) {
  return <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border }}>
    <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>{text}</Text>
  </View>;
}

/** Runs something in place (no chevron: nothing opens). `action` is a short label shown at the right, e.g. "Open settings". */
export function ActionRow({ icon, title, subtitle, action, onPress, tone, last, colors }: {
  icon?: ReactNode; title: string; subtitle?: string; action?: string; onPress: () => void; tone?: Tone; last?: boolean; colors: Colors;
}) {
  return <Tap onPress={onPress} label={title} style={rowBox(colors, last)}>
    {icon ? <IconTile icon={icon} tone={tone} /> : null}
    <RowText title={title} subtitle={subtitle} colors={colors} tone={tone} />
    {action ? <Text style={{ color: tone === 'danger' ? palette.expenseText : palette.accentText, fontWeight: '700', fontSize: 14, marginLeft: 8 }}>{action}</Text> : null}
  </Tap>;
}

/** Two-or-more way choice inside a card (e.g. "All payments" / "Duplicates only"). */
export function Segmented<T extends string>({ label, options, value, onChange, colors }: { label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (next: T) => void; colors: Colors }) {
  return <View style={{ paddingHorizontal: 14, paddingTop: 2, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 6 }}>{label}</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', backgroundColor: tint(palette.emerald, 0.1), borderRadius: radius.pill, padding: 3 }}>
      {options.map(([key, text]) => { const on = value === key; return <Pressable key={key} onPress={() => onChange(key)} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={text}
        style={{ flex: 1, minHeight: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.card : 'transparent', borderWidth: on ? 1 : 0, borderColor: colors.border }}>
        <Text style={{ ...typo.chip, color: on ? palette.accentText : colors.muted }}>{text}</Text></Pressable>; })}
    </View>
  </View>;
}
