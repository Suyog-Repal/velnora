/**
 * Velnora motion system: one set of durations / easing, one reduce-motion source, and reusable pieces
 * (entrance animation for dialogs and toasts, shimmer skeletons for real loading states).
 * React Native's Animated with the native driver only: no new dependency, smooth on mid-range Android, and nothing here
 * blocks touches (animations are visual only).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, type DimensionValue, type ViewStyle } from 'react-native';
import { isDarkScheme, radius, space } from '../../theme';

/** Durations (ms) and easing used everywhere, so every transition feels the same. */
export const MOTION = {
  /** Press-in feedback. */
  press: 90,
  /** Small state changes: tab pill, toggles, release after a press. */
  fast: 160,
  /** Screen / tab transitions, dialogs. */
  base: 220,
  /** Bottom sheets. */
  sheet: 260,
  /** One shimmer sweep across a skeleton. */
  shimmer: 1200,
  easeOut: Easing.out(Easing.cubic),
} as const;

// ---- reduce motion: one AccessibilityInfo subscription for the whole app ---------------------------------------------
let reduced = false;
let subscribed = false;
const reduceListeners = new Set<(v: boolean) => void>();
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  AccessibilityInfo.isReduceMotionEnabled().then((v) => { reduced = v; reduceListeners.forEach((l) => l(v)); }).catch(() => undefined);
  AccessibilityInfo.addEventListener('reduceMotionChanged', (v: boolean) => { reduced = v; reduceListeners.forEach((l) => l(v)); });
}
/** The system "remove animations" setting, kept up to date. When true, motion is replaced by instant changes. */
export function useReduceMotion(): boolean {
  const [value, setValue] = useState(reduced);
  useEffect(() => {
    ensureSubscribed();
    reduceListeners.add(setValue);
    setValue(reduced);
    return () => { reduceListeners.delete(setValue); };
  }, []);
  return value;
}

/**
 * Entrance for dialogs, pickers and toasts: fade + gentle scale (0.96 -> 1) or lift. Restarts cleanly each time
 * `visible` turns true (a running animation is stopped first, so rapid open/close never stacks animations).
 */
export function useEntrance(visible: boolean, kind: 'scale' | 'lift' = 'scale'): ViewStyle {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    v.stopAnimation();
    if (!visible) { v.setValue(0); return; }
    if (reduce) { v.setValue(1); return; }
    v.setValue(0);
    const anim = Animated.timing(v, { toValue: 1, duration: MOTION.base, easing: MOTION.easeOut, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [visible, reduce, v]);
  return useMemo(() => ({
    opacity: v,
    transform: kind === 'scale'
      ? [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }]
      : [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  }) as unknown as ViewStyle, [v, kind]);
}

// ---- skeletons -------------------------------------------------------------------------------------------------------
const ShimmerContext = createContext<{ progress: Animated.Value; reduce: boolean } | null>(null);

/**
 * Wraps a set of skeleton blocks and drives ONE looping native animation for all of them. Use it only while data is
 * genuinely being read (never as an artificial delay); the loop stops when the group unmounts.
 */
export function SkeletonGroup({ children, label = 'Loading' }: { children: ReactNode; label?: string }) {
  const reduce = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: MOTION.shimmer, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => { loop.stop(); progress.setValue(0); };
  }, [reduce, progress]);
  const ctx = useMemo(() => ({ progress, reduce }), [progress, reduce]);
  return <ShimmerContext.Provider value={ctx}>
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }}>{children}</View>
  </ShimmerContext.Provider>;
}

/** One placeholder block (text line, avatar, amount). Base colour and highlight follow the active theme. */
export function SkeletonBlock({ width = '100%', height = 12, round = false, style }: { width?: DimensionValue; height?: number; round?: boolean; style?: ViewStyle }) {
  const ctx = useContext(ShimmerContext);
  const dark = isDarkScheme(); // colours follow the active scheme
  const base = dark ? '#232A28' : '#E6ECE9';
  const highlight = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.65)';
  const translateX = ctx && !ctx.reduce ? ctx.progress.interpolate({ inputRange: [0, 1], outputRange: [-160, 360] }) : null;
  return <View style={[{ width, height, borderRadius: round ? height / 2 : radius.sm / 2 + 2, backgroundColor: base, overflow: 'hidden' }, style]}>
    {translateX ? <Animated.View style={[StyleSheet.absoluteFill, { width: 120, backgroundColor: highlight, transform: [{ translateX }, { skewX: '-18deg' }] }]} /> : null}
  </View>;
}

/** Placeholder for a list of transaction / person rows (same row height as the real rows: no layout jump). */
export function SkeletonRows({ count = 6, cardColor, borderColor, inGroup = false }: { count?: number; cardColor: string; borderColor: string; /** already inside a SkeletonGroup */ inGroup?: boolean }) {
  const rows = (
    <View style={{ backgroundColor: cardColor, borderColor, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: 14, marginTop: space.md }}>
      {Array.from({ length: count }, (_, i) => <View key={i} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: 12, borderBottomWidth: i === count - 1 ? 0 : 1, borderBottomColor: borderColor }}>
        <SkeletonBlock width={40} height={40} round />
        <View style={{ flex: 1, marginHorizontal: 12, gap: 8 }}>
          <SkeletonBlock width={`${55 + ((i * 13) % 30)}%`} height={13} />
          <SkeletonBlock width={`${35 + ((i * 17) % 25)}%`} height={10} />
        </View>
        <SkeletonBlock width={64} height={14} />
      </View>)}
    </View>
  );
  return inGroup ? rows : <SkeletonGroup>{rows}</SkeletonGroup>;
}

/** Placeholder for summary cards + a chart/list area (Analytics, Budgets). */
export function SkeletonDashboard({ cardColor, borderColor }: { cardColor: string; borderColor: string }) {
  const card = { flex: 1, backgroundColor: cardColor, borderColor, borderWidth: 1, borderRadius: radius.lg, padding: 14, gap: 10 } as const;
  return <SkeletonGroup>
    <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
      {[0, 1].map((i) => <View key={i} style={card}><SkeletonBlock width="50%" height={11} /><SkeletonBlock width="70%" height={20} /></View>)}
    </View>
    <View style={[card, { flex: undefined, marginTop: space.md, height: 180, justifyContent: 'flex-end', flexDirection: 'row', alignItems: 'flex-end', gap: 12, padding: 18 }]}>
      {[60, 110, 80, 140, 95, 120].map((h, i) => <SkeletonBlock key={i} width={18} height={h} />)}
    </View>
    <SkeletonRows count={3} cardColor={cardColor} borderColor={borderColor} inGroup />
  </SkeletonGroup>;
}

