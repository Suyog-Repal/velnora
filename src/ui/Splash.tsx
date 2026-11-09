import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text } from 'react-native';
import { palette } from '../../theme';
import { type } from '../../typography';
import { VelnoraLogo } from './VelnoraLogo';

const LOGO_SIZE = 112; // on-screen width of the chevron symbol

/**
 * Launch animation: the logo pops in, holds for a beat, then flies up-and-away while the backdrop fades out to
 * reveal the app. It covers the screen only for ~1.6 s and then unmounts completely (never blocks touches afterwards).
 */
export function Splash({ onFinish }: { onFinish?: () => void }) {
  const { width, height } = Dimensions.get('window');
  const pop = useRef(new Animated.Value(0)).current;   // logo entrance
  const fly = useRef(new Animated.Value(0)).current;   // logo exit
  const backdrop = useRef(new Animated.Value(1)).current;
  const [done, setDone] = useState(false);
  // Don't start the animation until the logo is decoded, otherwise the first launch (when Android's image
  // pipeline is still starting up) flies away an empty tile. A short fallback timer guarantees the splash never stalls.
  const [started, setStarted] = useState(false);
  const loadedLayers = useRef(0);
  const layerLoaded = () => { loadedLayers.current += 1; setStarted(true); };
  useEffect(() => { const t = setTimeout(() => setStarted(true), 1500); return () => clearTimeout(t); }, []);

  useEffect(() => {
    if (!started) return;
    Animated.sequence([
      Animated.spring(pop, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }),
      Animated.delay(320),
      Animated.parallel([
        Animated.timing(fly, { toValue: 1, duration: 620, easing: Easing.in(Easing.back(0.8)), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 520, delay: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start(() => { setDone(true); onFinish?.(); });
  }, [started, pop, fly, backdrop]); // eslint-disable-line react-hooks/exhaustive-deps

  if (done) return null;
  const scale = Animated.multiply(pop.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }), fly.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }));
  return <Animated.View pointerEvents="auto" style={[StyleSheet.absoluteFill, { backgroundColor: palette.navy, opacity: backdrop, alignItems: 'center', justifyContent: 'center', zIndex: 999 }]}>
    <Animated.View style={{
      alignItems: 'center',
      opacity: Animated.multiply(pop, fly.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 0.9, 0] })),
      transform: [
        { translateY: fly.interpolate({ inputRange: [0, 1], outputRange: [0, -height * 0.62] }) },
        { translateX: fly.interpolate({ inputRange: [0, 1], outputRange: [0, width * 0.28] }) },
        { rotate: fly.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-18deg'] }) },
        { scale },
      ],
    }}>
      {/* The Velnora chevron symbol only (no tile), shared with the login screens. */}
      <VelnoraLogo size={LOGO_SIZE} onLoad={layerLoaded} />
      <Text style={{ ...type.title, color: palette.onNavy, letterSpacing: 6, marginTop: 18 }}>VELNORA</Text>
    </Animated.View>
  </Animated.View>;
}
