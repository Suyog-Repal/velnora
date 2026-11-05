import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from 'react-native';
import { palette } from '../../theme';
import { WalletCards } from '../../icons';

/**
 * Launch animation: the logo pops in, holds for a beat, then flies up-and-away while the backdrop fades out to
 * reveal the app. It covers the screen only for ~1.6 s and then unmounts completely (never blocks touches afterwards).
 */
export function Splash() {
  const { width, height } = Dimensions.get('window');
  const pop = useRef(new Animated.Value(0)).current;   // logo entrance
  const fly = useRef(new Animated.Value(0)).current;   // logo exit
  const backdrop = useRef(new Animated.Value(1)).current;
  const [done, setDone] = useState(false);

  useEffect(() => {
    Animated.sequence([
      Animated.spring(pop, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }),
      Animated.delay(320),
      Animated.parallel([
        Animated.timing(fly, { toValue: 1, duration: 620, easing: Easing.in(Easing.back(0.8)), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 520, delay: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start(() => setDone(true));
  }, [pop, fly, backdrop]);

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
      <View style={{ width: 92, height: 92, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
        <WalletCards color={palette.emerald} size={44} />
      </View>
      <Text style={{ color: '#FFFFFF', fontSize: 22, fontWeight: '800', letterSpacing: 6, marginTop: 18 }}>VELNORA</Text>
    </Animated.View>
  </Animated.View>;
}
