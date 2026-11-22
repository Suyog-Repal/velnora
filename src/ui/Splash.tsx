import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Image, StyleSheet, useColorScheme } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { WELCOME_TOKENS } from '../screens/WelcomeScreen';
import { MOTION, useReduceMotion } from './motion';

// Keep the native splash up from process start. It is hidden only once the app is ready (see below).
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** Same width as app.json's expo-splash-screen imageWidth (200dp canvas); the mark fills 560/1024 of it. Tune on a device if the hand-off shows a jump. */
const MARK_WIDTH = Math.round(200 * 560 / 1024);
const MARK_HEIGHT = Math.round(MARK_WIDTH * 209 / 232);
const EXIT_MS = 350;
const SAFETY_MS = 6000;

/**
 * The one launch splash. The native splash (neutral background + the Velnora mark, set in app.json) shows from the first frame.
 * This overlay sits beneath it with the same colour and mark. When `ready` (local database + stored-session read done, never the
 * network) the native splash is hidden and this overlay slides up and fades out (350ms). With "remove animations" on it just goes.
 */
export function Splash({ ready, onFinish }: { ready: boolean; onFinish?: () => void }) {
  const dark = useColorScheme() === 'dark';
  const reduce = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const [forced, setForced] = useState(false);
  useEffect(() => { const t = setTimeout(() => setForced(true), SAFETY_MS); return () => clearTimeout(t); }, []); // never stall launch

  useEffect(() => {
    if ((!ready && !forced) || started.current) return;
    started.current = true;
    let raf = 0;
    let anim: Animated.CompositeAnimation | null = null;
    const finish = () => { setDone(true); onFinish?.(); };
    // Let the app's first frame draw under the overlay, then reveal it by hiding the native splash.
    raf = requestAnimationFrame(() => {
      void SplashScreen.hideAsync().catch(() => undefined).then(() => {
        if (reduce) { finish(); return; }
        anim = Animated.timing(progress, { toValue: 1, duration: EXIT_MS, easing: MOTION.easeOut, useNativeDriver: true });
        anim.start(({ finished }) => { if (finished) finish(); });
      });
    });
    return () => { cancelAnimationFrame(raf); anim?.stop(); };
  }, [ready, forced, reduce, progress]); // eslint-disable-line react-hooks/exhaustive-deps

  if (done) return null;
  const { height } = Dimensions.get('window');
  return <Animated.View pointerEvents={ready || forced ? 'none' : 'auto'} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={[StyleSheet.absoluteFill, {
      backgroundColor: dark ? WELCOME_TOKENS.dark.background : WELCOME_TOKENS.light.background,
      alignItems: 'center', justifyContent: 'center', zIndex: 999,
      opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
      transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -height * 0.06] }) }],
    }]}>
    <Image source={require('../../assets/velnora-mark.png')} style={{ width: MARK_WIDTH, height: MARK_HEIGHT }} resizeMode="contain" fadeDuration={0} />
  </Animated.View>;
}
