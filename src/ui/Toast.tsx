import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { palette } from '../../theme';
import { MOTION, useReduceMotion } from './motion';
import { Check, WifiOff } from '../../icons';
import { createSyncNotifier, type ToastKind } from '../services/syncNotices';

type ToastItem = { id: number; message: string; kind: ToastKind; key: string };
type Listener = (t: ToastItem) => void;

let listener: Listener | null = null;
let counter = 0;

/** Show a lightweight toast. Messages with the same `key` replace each other instead of stacking. */
export function showToast(message: string, kind: ToastKind = 'success', key: string = message): void {
  listener?.({ id: ++counter, message, kind, key });
}

/** App-wide notifier: local-save confirmations and (only after the backend confirms) sync results. */
export const notices = createSyncNotifier(showToast);

const DURATION_MS = 2800;

/** Mount once near the app root. Renders at most one toast, above the bottom navigation, never blocking touches. */
export function ToastHost({ bottom = 96 }: { bottom?: number }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShown = useRef<{ key: string; message: string; at: number } | null>(null);

  const reduce = useReduceMotion();
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  useEffect(() => {
    listener = (t) => {
      const last = lastShown.current;
      // Drop an identical toast that is already on screen (e.g. two sync results back to back).
      if (last && last.key === t.key && last.message === t.message && Date.now() - last.at < DURATION_MS) return;
      lastShown.current = { key: t.key, message: t.message, at: Date.now() };
      setItem(t);
      if (timer.current) clearTimeout(timer.current);
      opacity.stopAnimation();
      opacity.setValue(reduceRef.current ? 1 : 0);
      if (!reduceRef.current) Animated.timing(opacity, { toValue: 1, duration: MOTION.fast, easing: MOTION.easeOut, useNativeDriver: true }).start();
      timer.current = setTimeout(() => Animated.timing(opacity, { toValue: 0, duration: reduceRef.current ? 0 : MOTION.base, useNativeDriver: true }).start(({ finished }) => { if (finished) setItem(null); }), DURATION_MS);
    };
    return () => { listener = null; if (timer.current) clearTimeout(timer.current); };
  }, [opacity]);

  if (!item) return null;
  const warn = item.kind === 'warning';
  return <View pointerEvents="none" style={[s.wrap, { bottom }]}>
    <Animated.View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[s.toast, { opacity, backgroundColor: palette.navy, transform: [{ translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }, { scale: opacity.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] }]}>
      {warn ? <WifiOff size={16} color="#F5C77E" /> : <Check size={16} color={palette.emerald} strokeWidth={3} />}
      <Text style={s.text}>{item.message}</Text>
    </Animated.View>
  </View>;
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center', zIndex: 50 },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, maxWidth: 420, elevation: 8 },
  text: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, flexShrink: 1 },
});
