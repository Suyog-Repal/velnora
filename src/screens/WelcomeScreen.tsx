/**
 * Welcome / sign-in landing screen. Presentation only: the three actions are handed in by App.tsx and do exactly what
 * they did before. The preview cards are decorative sample data (never real user data) and are hidden from
 * accessibility. Motion uses React Native's Animated via the shared motion module and respects reduce-motion.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { MOTION, useReduceMotion } from '../ui/motion';

/** Palette, spacing and radii for this screen only. Change the look here. */
export const WELCOME_TOKENS = {
  light: {
    background: '#F6F7F9',
    text: '#0F1115',
    muted: '#5B6472',      // 5.6:1 on background
    brand: '#2563EB',      // 4.9:1 on background
    primaryBg: '#0F1115',
    primaryText: '#FFFFFF',
    outlineBg: '#FFFFFF',
    outlineBorder: '#D9DDE4',
    outlineText: '#0F1115',
    previewDark: '#0F1115',
    previewDarkBorder: '#0F1115',
    previewDarkLabel: '#A8B0BD',
    previewDarkText: '#FFFFFF',
    previewTrack: '#2A2F3A',
    previewCard: '#FFFFFF',
    previewCardText: '#0F1115',
    expense: '#C62828',    // 5.6:1 on white
    income: '#0F766E',     // 5.5:1 on white
    shadow: '#0F1115',
  },
  dark: {
    background: '#0E1014',
    text: '#F5F7FA',
    muted: '#9AA3B2',      // 7:1 on background
    brand: '#6FA0FF',      // lighter blue keeps >= 4.5:1 on charcoal
    primaryBg: '#FFFFFF',
    primaryText: '#0F1115',
    outlineBg: 'transparent',
    outlineBorder: '#3A404C',
    outlineText: '#F5F7FA',
    previewDark: '#181C24',
    previewDarkBorder: '#2A303B',
    previewDarkLabel: '#A8B0BD',
    previewDarkText: '#FFFFFF',
    previewTrack: '#2A2F3A',
    previewCard: '#222833',
    previewCardText: '#F5F7FA',
    expense: '#F87171',
    income: '#34D399',
    shadow: '#000000',
  },
  accent: '#2563EB',       // progress fill and logo accent (the logo blue)
  space: { gutter: 24, gapS: 8, gapM: 12, gapL: 24 },
  radius: { button: 16, card: 24 },
  button: { height: 56 },
} as const;

type Props = { dark: boolean; onGetStarted: () => void; onSignIn: () => void; onGuest: () => void };

/** The real Velnora mark (shadowless, opaque copy of the app icon's chevron), shown at ~38px wide. */
export function LogoMark({ width = 38 }: { width?: number }) {
  return <Image source={require('../../assets/velnora-mark.png')} accessible accessibilityRole="image" accessibilityLabel="Velnora logo"
    style={{ width, height: Math.round(width * 209 / 232) }} resizeMode="contain" fadeDuration={0} />;
}

export function WelcomeScreen({ dark, onGetStarted, onSignIn, onGuest }: Props) {
  const c = dark ? WELCOME_TOKENS.dark : WELCOME_TOKENS.light;
  const t = WELCOME_TOKENS;
  const { height } = useWindowDimensions();
  const previewHeight = Math.round(Math.min(240, Math.max(170, height * 0.28)));
  const reduce = useReduceMotion();

  // Four groups (balance card, transactions card, text, actions) fade/slide up in a stagger, ~300ms in total.
  const values = useRef([0, 1, 2, 3].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (reduce) { values.forEach((v) => { v.stopAnimation(); v.setValue(1); }); return; }
    const anim = Animated.stagger(40, values.map((v) => Animated.timing(v, { toValue: 1, duration: 180, easing: MOTION.easeOut, useNativeDriver: true })));
    anim.start();
    return () => anim.stop();
  }, [reduce, values]);
  const enter = (i: number) => ({
    opacity: values[i],
    transform: [{ translateY: values[i].interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  });

  const s = useMemo(() => StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { flexGrow: 1, paddingHorizontal: t.space.gutter, paddingTop: 16, paddingBottom: 20 },
    brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
    wordmark: { color: c.text, fontSize: 15, fontWeight: '800', letterSpacing: 4 },
    previewWrap: { flex: 1, minHeight: previewHeight, justifyContent: 'center' },
    preview: { height: previewHeight },
    balanceCard: { position: 'absolute', top: 6, left: 32, right: 0, height: Math.round(previewHeight * 0.66), borderRadius: t.radius.card, backgroundColor: c.previewDark, borderWidth: 1, borderColor: c.previewDarkBorder, padding: 20, transform: [{ rotate: '-3deg' }] },
    balanceLabel: { color: c.previewDarkLabel, fontSize: 13 },
    balanceAmount: { color: c.previewDarkText, fontSize: 32, fontWeight: '800', marginTop: 4 },
    track: { height: 5, borderRadius: 3, backgroundColor: c.previewTrack, marginTop: 14, overflow: 'hidden' },
    fill: { width: '62%', height: 5, borderRadius: 3, backgroundColor: t.accent },
    txCard: { position: 'absolute', left: 0, right: 40, bottom: 4, borderRadius: t.radius.card, backgroundColor: c.previewCard, paddingHorizontal: 16, paddingVertical: 12, gap: 8, shadowColor: c.shadow, shadowOpacity: dark ? 0.5 : 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
    txRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    txName: { color: c.previewCardText, fontSize: 14, fontWeight: '600' },
    txAmount: { fontSize: 14, fontWeight: '700' },
    headline: { color: c.text, fontSize: 36, lineHeight: 40, fontWeight: '800', letterSpacing: -0.8, marginTop: t.space.gapL },
    support: { color: c.muted, fontSize: 16, lineHeight: 24, marginTop: t.space.gapM },
    actions: { marginTop: t.space.gapL, gap: t.space.gapM },
    button: { minHeight: t.button.height, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 12 },
    primary: { backgroundColor: c.primaryBg },
    primaryText: { color: c.primaryText, fontSize: 16, fontWeight: '700' },
    outline: { backgroundColor: c.outlineBg, borderWidth: 1, borderColor: c.outlineBorder },
    outlineText: { color: c.outlineText, fontSize: 16, fontWeight: '600' },
    linkBtn: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    linkText: { color: c.brand, fontSize: 15, fontWeight: '600' },
    helper: { color: c.muted, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  }), [c, t, dark, previewHeight]);

  return <SafeAreaView style={s.safe}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false} bounces={false}>
      <View style={s.brandRow}>
        <LogoMark />
        <Text style={s.wordmark} maxFontSizeMultiplier={1.2}>VELNORA</Text>
      </View>

      <View style={s.previewWrap}>
        {/* Decorative sample data only: hidden from screen readers. */}
        <View style={s.preview} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
          <Animated.View style={[s.balanceCard, enter(0)]}>
            <Text style={s.balanceLabel} allowFontScaling={false}>Recorded balance</Text>
            <Text style={s.balanceAmount} allowFontScaling={false}>₹24,580</Text>
            <View style={s.track}><View style={s.fill} /></View>
          </Animated.View>
          <Animated.View style={[s.txCard, enter(1)]}>
            <View style={s.txRow}><Text style={s.txName} allowFontScaling={false}>Swiggy</Text><Text style={[s.txAmount, { color: c.expense }]} allowFontScaling={false}>−₹420</Text></View>
            <View style={s.txRow}><Text style={s.txName} allowFontScaling={false}>Salary</Text><Text style={[s.txAmount, { color: c.income }]} allowFontScaling={false}>+₹42,000</Text></View>
          </Animated.View>
        </View>
      </View>

      <Animated.View style={enter(2)}>
        <Text style={s.headline} accessibilityRole="header" maxFontSizeMultiplier={1.3}>Your money, clearly.</Text>
        <Text style={s.support}>Track spending, set budgets and see who owes whom. Private by default.</Text>
      </Animated.View>

      <Animated.View style={[s.actions, enter(3)]}>
        <Pressable accessibilityRole="button" onPress={onGetStarted} style={({ pressed }) => [s.button, s.primary, pressed && { opacity: 0.85 }]}>
          <Text style={s.primaryText}>Get started</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onSignIn} style={({ pressed }) => [s.button, s.outline, pressed && { opacity: 0.7 }]}>
          <Text style={s.outlineText}>I already have an account</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onGuest} style={({ pressed }) => [s.linkBtn, pressed && { opacity: 0.6 }]}>
          <Text style={s.linkText}>Continue without an account</Text>
        </Pressable>
        <Text style={s.helper}>Without an account, data stays on this device.</Text>
      </Animated.View>
    </ScrollView>
  </SafeAreaView>;
}
