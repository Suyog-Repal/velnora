/**
 * Full-screen attachment viewer used by the Add and Edit Transaction forms.
 * Pinch to zoom (around the fingers), double-tap to zoom in / out, pan while zoomed, swipe between attachments when not
 * zoomed, reset, counter, delete with confirmation. Built on React Native's own responder system (no gesture library).
 * The page on screen is decoded at full resolution (resizeMethod "none" = Fresco DownsampleMode.NEVER; "scale" still lets
 * Fresco downsample large bitmaps, which blurred small receipt print). Neighbouring pages stay downsampled to bound memory.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Image, Modal, PanResponder, Pressable, StatusBar, StyleSheet, Text, View, useWindowDimensions, type GestureResponderEvent, type NativeTouchEvent } from 'react-native';
import { RotateCcw, Trash, X } from '../../icons';
import { clampScale, clampTranslate, distance, doubleTapScale, fitContain, maxScaleFor, midpoint, zoomAround, type Point, type Size } from '../ui/zoomMath';

export interface ViewerItem { key: string; uri: string | null; type: 'photo' | 'scan'; width?: number | null; height?: number | null }

const DOUBLE_TAP_MS = 280;
const TAP_SLOP = 12;

function ZoomableImageBase({ item, view, active, onZoomChange, onPinchStart }: {
  item: ViewerItem; view: Size; active: boolean; onZoomChange: (zoomed: boolean) => void; onPinchStart: () => void;
}) {
  const [natural, setNatural] = useState<Size | null>(item.width && item.height ? { width: item.width, height: item.height } : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (natural || !item.uri) return;
    Image.getSize(item.uri, (width, height) => setNatural({ width, height }), () => setFailed(true));
  }, [item.uri, natural]);

  const fitted = useMemo(() => fitContain(natural ?? view, view), [natural, view]);
  const maxScale = useMemo(() => maxScaleFor(natural ?? view, fitted), [natural, view, fitted]);

  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const cur = useRef({ s: 1, x: 0, y: 0 });
  const start = useRef({ s: 1, x: 0, y: 0, focal: { x: 0, y: 0 } as Point, dist: 0, touches: 0 });
  const zoomedRef = useRef(false);

  const apply = (s: number, x: number, y: number) => {
    cur.current = { s, x, y };
    scale.setValue(s); tx.setValue(x); ty.setValue(y);
    const z = s > 1.01;
    if (z !== zoomedRef.current) { zoomedRef.current = z; onZoomChange(z); }
  };
  const animateTo = (s: number, x: number, y: number) => {
    cur.current = { s, x, y };
    const z = s > 1.01;
    if (z !== zoomedRef.current) { zoomedRef.current = z; onZoomChange(z); }
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true, friction: 9, tension: 80 }),
      Animated.spring(tx, { toValue: x, useNativeDriver: true, friction: 9, tension: 80 }),
      Animated.spring(ty, { toValue: y, useNativeDriver: true, friction: 9, tension: 80 }),
    ]).start();
  };
  // Leaving a page resets it (fit to screen).
  useEffect(() => { if (!active && cur.current.s !== 1) apply(1, 0, 0); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const rel = (t: NativeTouchEvent): Point => ({ x: t.pageX - view.width / 2, y: t.pageY - view.height / 2 });
  const begin = (touches: readonly NativeTouchEvent[]) => {
    const c = cur.current;
    if (touches.length >= 2) {
      const a = rel(touches[0]); const b = rel(touches[1]);
      start.current = { s: c.s, x: c.x, y: c.y, focal: midpoint(a, b), dist: Math.max(1, distance(a, b)), touches: 2 };
    } else if (touches.length === 1) {
      start.current = { s: c.s, x: c.x, y: c.y, focal: rel(touches[0]), dist: 0, touches: 1 };
    }
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length >= 2 || cur.current.s > 1.01,
    onStartShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length >= 2,
    onMoveShouldSetPanResponder: (e, g) => e.nativeEvent.touches.length >= 2 || (cur.current.s > 1.01 && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2)),
    onMoveShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length >= 2,
    onPanResponderGrant: (e) => begin(e.nativeEvent.touches),
    onPanResponderMove: (e) => {
      const touches = e.nativeEvent.touches;
      if (touches.length >= 2) {
        if (start.current.touches !== 2) begin(touches); // second finger joined mid-gesture
        const a = rel(touches[0]); const b = rel(touches[1]);
        const st = start.current;
        const s = clampScale(st.s * (distance(a, b) / st.dist), maxScale, 0.85);
        const t = zoomAround({ x: st.x, y: st.y }, st.s, s, st.focal, midpoint(a, b));
        const c = clampTranslate(t, Math.max(1, s), fitted, view);
        apply(s, s < 1 ? 0 : c.x, s < 1 ? 0 : c.y);
      } else if (touches.length === 1) {
        if (start.current.touches !== 1) begin(touches); // one finger lifted: continue as a pan from here
        const p = rel(touches[0]); const st = start.current;
        const c = clampTranslate({ x: st.x + (p.x - st.focal.x), y: st.y + (p.y - st.focal.y) }, cur.current.s, fitted, view);
        apply(cur.current.s, c.x, c.y);
      }
    },
    onPanResponderRelease: () => {
      start.current.touches = 0;
      if (cur.current.s < 1) animateTo(1, 0, 0);
    },
    // While zoomed the pan belongs to the image, so the list cannot steal it and swipe away mid-pan.
    onPanResponderTerminationRequest: () => cur.current.s <= 1.01,
    onPanResponderTerminate: () => { start.current.touches = 0; if (cur.current.s < 1) animateTo(1, 0, 0); },
  }), [fitted, view, maxScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Double tap: detected from raw touch events, independently of who owns the responder.
  const tap = useRef({ at: 0, x: 0, y: 0, downX: 0, downY: 0, downAt: 0, multi: false });
  const onTouchStart = (e: GestureResponderEvent) => {
    const t = e.nativeEvent;
    if (t.touches.length >= 2) { tap.current.multi = true; onPinchStart(); return; }
    tap.current.multi = false; tap.current.downX = t.pageX; tap.current.downY = t.pageY; tap.current.downAt = Date.now();
  };
  const onTouchEnd = (e: GestureResponderEvent) => {
    const t = e.nativeEvent;
    if (tap.current.multi || t.touches.length > 0) return;
    const moved = Math.hypot(t.pageX - tap.current.downX, t.pageY - tap.current.downY);
    if (moved > TAP_SLOP || Date.now() - tap.current.downAt > 300) { tap.current.at = 0; return; }
    const now = Date.now();
    if (now - tap.current.at < DOUBLE_TAP_MS && Math.hypot(t.pageX - tap.current.x, t.pageY - tap.current.y) < 40) {
      tap.current.at = 0;
      const c = cur.current;
      if (c.s > 1.01) { animateTo(1, 0, 0); return; }
      const target = doubleTapScale(fitted, view, maxScale);
      const q = { x: t.pageX - view.width / 2, y: t.pageY - view.height / 2 };
      const next = clampTranslate(zoomAround({ x: c.x, y: c.y }, c.s, target, q, q), target, fitted, view);
      animateTo(target, next.x, next.y);
    } else {
      tap.current = { ...tap.current, at: now, x: t.pageX, y: t.pageY };
    }
  };

  const resetRef = useRef(() => animateTo(1, 0, 0));
  resetRef.current = () => animateTo(1, 0, 0);
  ZoomRegistry.set(item.key, () => resetRef.current());
  useEffect(() => () => { ZoomRegistry.delete(item.key); }, [item.key]);

  return <View style={{ width: view.width, height: view.height, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} {...responder.panHandlers}>
    {!item.uri ? <View style={{ alignItems: 'center' }}><ActivityIndicator color="#FFFFFF" /><Text style={styles.dim}>Loading the original…</Text></View>
      : failed ? <Text style={styles.dim}>This image could not be opened. It may have been removed from the device.</Text>
        : <Animated.Image source={{ uri: item.uri }} resizeMode="contain" resizeMethod={active ? "none" : "resize"} fadeDuration={0}
          onError={() => setFailed(true)} accessibilityLabel={item.type === 'scan' ? 'Receipt' : 'Photo'}
          style={{ width: fitted.width, height: fitted.height, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }} />}
  </View>;
}
const ZoomableImage = memo(ZoomableImageBase);
const ZoomRegistry = new Map<string, () => void>();

export function AttachmentViewer({ visible, items, initialIndex, onClose, onDelete }: {
  visible: boolean; items: ViewerItem[]; initialIndex: number; onClose: () => void;
  /** When given, a delete button removes the shown attachment (after confirmation). */
  onDelete?: (key: string) => void;
}) {
  const { width, height } = useWindowDimensions();
  const view = useMemo(() => ({ width, height }), [width, height]);
  const [index, setIndex] = useState(initialIndex);
  const [zoomed, setZoomed] = useState(false);
  const [pinching, setPinching] = useState(false);
  const listRef = useRef<FlatList<ViewerItem>>(null);
  useEffect(() => { if (visible) { setIndex(Math.min(initialIndex, Math.max(0, items.length - 1))); setZoomed(false); } }, [visible, initialIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (visible && items.length === 0) onClose(); }, [visible, items.length, onClose]);
  const current = items[Math.min(index, items.length - 1)];

  const onZoomChange = useCallback((z: boolean) => { setZoomed(z); if (!z) setPinching(false); }, []);
  const onPinchStart = useCallback(() => setPinching(true), []);
  const confirmDelete = () => {
    if (!current || !onDelete) return;
    Alert.alert('Remove this attachment?', `The ${current.type === 'scan' ? 'receipt' : 'photo'} is removed from this transaction when you save.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        const key = current.key;
        const nextIndex = Math.max(0, Math.min(index, items.length - 2));
        setIndex(nextIndex);
        onDelete(key);
      } },
    ]);
  };

  return <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent transparent={false} supportedOrientations={['portrait', 'landscape']}>
    <StatusBar barStyle="light-content" />
    <View style={styles.root}>
      <FlatList ref={listRef} data={items} horizontal pagingEnabled keyExtractor={(i) => i.key}
        initialScrollIndex={Math.min(initialIndex, Math.max(0, items.length - 1))}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        scrollEnabled={!zoomed && !pinching} showsHorizontalScrollIndicator={false} windowSize={3} initialNumToRender={1} maxToRenderPerBatch={1}
        onTouchEnd={() => { if (!zoomed) setPinching(false); }}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item, index: i }) => <ZoomableImage item={item} view={view} active={i === index} onZoomChange={onZoomChange} onPinchStart={onPinchStart} />} />

      <View style={styles.top} pointerEvents="box-none">
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close viewer" style={styles.round}><X color="#FFFFFF" size={22} /></Pressable>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.counter} accessibilityLiveRegion="polite">{items.length ? `${Math.min(index, items.length - 1) + 1} / ${items.length}` : ''}</Text>
          {current ? <Text style={styles.dimSmall}>{current.type === 'scan' ? 'Receipt' : 'Photo'}</Text> : null}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {zoomed ? <Pressable onPress={() => current && ZoomRegistry.get(current.key)?.()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fit to screen" style={styles.round}><RotateCcw color="#FFFFFF" size={20} /></Pressable> : null}
          {onDelete ? <Pressable onPress={confirmDelete} hitSlop={10} accessibilityRole="button" accessibilityLabel="Remove attachment" style={styles.round}><Trash color="#FFFFFF" size={20} /></Pressable> : null}
        </View>
      </View>
      {!zoomed ? <Text style={styles.hint} pointerEvents="none">Pinch or double-tap to zoom{items.length > 1 ? ' · swipe for more' : ''}</Text> : null}
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 44, paddingHorizontal: 14, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.45)' },
  round: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' },
  counter: { color: '#FFFFFF', fontWeight: '700', fontSize: 15, fontVariant: ['tabular-nums'] },
  dim: { color: 'rgba(255,255,255,0.7)', textAlign: 'center', paddingHorizontal: 32, marginTop: 10 },
  dimSmall: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 },
  hint: { position: 'absolute', bottom: 34, alignSelf: 'center', color: 'rgba(255,255,255,0.6)', fontSize: 12 },
});
