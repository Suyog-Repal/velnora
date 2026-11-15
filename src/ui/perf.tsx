/**
 * Responsiveness helpers (no new dependencies).
 *
 *  - KeepAlive: a tab stays mounted after its first visit, so switching back is instant. While hidden it renders nothing
 *    new: it returns the exact element it last rendered, which makes React skip the whole subtree (no work on hidden tabs).
 *  - useProgressiveCount: long lists paint their first rows immediately and add the rest in small chunks on later frames,
 *    so opening a screen with hundreds of rows never blocks the tap that opened it.
 *  - useKeyboardHeight: the app draws edge-to-edge, where Android no longer resizes the window for the keyboard; screens
 *    use the height to keep the focused field visible above it.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Platform, View } from 'react-native';

/** True while the enclosing KeepAlive tab is the visible one (true outside any KeepAlive). */
const TabActive = createContext(true);
export const useTabActive = (): boolean => useContext(TabActive);

export function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  const last = useRef<ReactNode>(children);
  if (active) last.current = children;
  return <TabActive.Provider value={active}>
    <View style={active ? undefined : HIDDEN} pointerEvents={active ? 'auto' : 'none'}
      accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>
      {last.current}
    </View>
  </TabActive.Provider>;
}
const HIDDEN = { display: 'none' as const };

/** "The main scroll view is near its end": lists grow only then, so a screen never holds hundreds of unseen rows. */
const nearEndListeners = new Set<() => void>();
export function notifyNearEnd(): void { nearEndListeners.forEach((l) => l()); }

/**
 * How many of `total` rows to render now. Paints `initial` rows at once, fills up to `eager` rows over the next frames,
 * and beyond that adds `step` rows each time the screen is scrolled near its end (like an infinite list).
 * `resetKey` (e.g. the active filters) starts again from the top, so a new filter result also paints instantly.
 * Inside a hidden KeepAlive tab the list stops growing and, once the switch away has finished, shrinks back to
 * `initial`, so hiding or re-showing a tab never has to lay out hundreds of rows in the frame after the tap.
 */
export function useProgressiveCount(total: number, resetKey: string, initial = 24, step = 36, eager = 48): number {
  const active = useTabActive();
  const [state, setState] = useState({ key: resetKey, count: Math.min(total, initial) });
  let count = state.count;
  if (state.key !== resetKey) {            // new filter / search: start from the top again
    count = Math.min(total, initial);
    setState({ key: resetKey, count });
  }
  useEffect(() => {
    if (!active) {                          // hidden: shrink later, outside the frame of the tab switch
      if (count <= initial) return;
      const t = setTimeout(() => setState((s) => ({ key: s.key, count: Math.min(s.count, initial) })), 400);
      return () => clearTimeout(t);
    }
    if (count >= Math.min(total, eager)) return;
    const t = setTimeout(() => setState((s) => (s.key === resetKey ? { key: s.key, count: Math.min(total, eager, s.count + step) } : s)), 16);
    return () => clearTimeout(t);
  }, [active, count, total, resetKey, step, initial, eager]);
  useEffect(() => {
    if (!active || count >= total) return;
    const grow = () => setState((s) => (s.key === resetKey ? { key: s.key, count: Math.min(total, Math.max(s.count, eager) + step) } : s));
    nearEndListeners.add(grow);
    return () => { nearEndListeners.delete(grow); };
  }, [active, count, total, resetKey, step, eager]);
  return Math.min(count, total);
}

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => setHeight(e.endCoordinates?.height ?? 0));
    const b = Keyboard.addListener(hideEvt, () => setHeight(0));
    return () => { a.remove(); b.remove(); };
  }, []);
  return height;
}

/**
 * A callback with a stable identity that always calls the latest `fn` (the "useEvent" pattern). Passing these to
 * memoised children lets them skip re-rendering when only the parent's closures changed.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
