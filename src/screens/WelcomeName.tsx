/**
 * "What should we call you?" shown after "Continue without an account". One field, same tokens as the welcome screen.
 * The caller saves the name (locally) before entering Home; nothing here touches the server.
 */
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { WELCOME_TOKENS } from './WelcomeScreen';
import { NAME_MAX_LENGTH, normalizeDisplayName } from '../services/profileService';

type Props = { dark: boolean; onContinue: (name: string) => Promise<void> | void; onBack: () => void };

export function WelcomeName({ dark, onContinue, onBack }: Props) {
  const c = dark ? WELCOME_TOKENS.dark : WELCOME_TOKENS.light;
  const t = WELCOME_TOKENS;
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = normalizeDisplayName(value);
  const valid = name !== null && !busy;

  const submit = async () => {
    if (!name || busy) return;
    setBusy(true); setFailed(false);
    try { await onContinue(name); } catch { setFailed(true); setBusy(false); }
  };

  const s = useMemo(() => StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { flexGrow: 1, paddingHorizontal: t.space.gutter, paddingTop: 16, paddingBottom: 20 },
    back: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    backText: { color: c.brand, fontSize: 15, fontWeight: '600' },
    headline: { color: c.text, fontSize: 32, lineHeight: 37, fontWeight: '800', letterSpacing: -0.6, marginTop: 16 },
    support: { color: c.muted, fontSize: 16, lineHeight: 24, marginTop: 10 },
    label: { color: c.muted, fontSize: 13, fontWeight: '600', marginTop: 28, marginBottom: 8 },
    input: { minHeight: 58, borderRadius: t.radius.button, borderWidth: focused ? 1.5 : 1, borderColor: focused ? t.accent : c.outlineBorder, backgroundColor: dark ? c.previewCard : '#FFFFFF', color: c.text, fontSize: 18, paddingHorizontal: 16 },
    error: { color: c.expense, fontSize: 13, marginTop: 8 },
    spacer: { flex: 1, minHeight: 24 },
    button: { minHeight: t.button.height, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primaryBg, paddingHorizontal: 16, paddingVertical: 12 },
    buttonText: { color: c.primaryText, fontSize: 16, fontWeight: '700' },
  }), [c, t, dark, focused]);

  return <SafeAreaView style={s.safe}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" style={s.back} hitSlop={8}><Text style={s.backText}>‹ Back</Text></Pressable>
        <Text style={s.headline} accessibilityRole="header" maxFontSizeMultiplier={1.3}>What should we call you?</Text>
        <Text style={s.support}>We use it to greet you. It is saved only on this phone.</Text>
        <Text style={s.label}>Your name</Text>
        <TextInput
          style={s.input} value={value} onChangeText={(v) => { setValue(v); setFailed(false); }}
          autoFocus autoCapitalize="words" autoCorrect={false} autoComplete="name" textContentType="givenName"
          returnKeyType="done" onSubmitEditing={() => void submit()} maxLength={NAME_MAX_LENGTH + 20}
          placeholder="Your name" placeholderTextColor={c.muted} accessibilityLabel="Your name"
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
        {value.trim().length > NAME_MAX_LENGTH ? <Text style={s.error}>Use {NAME_MAX_LENGTH} characters or fewer.</Text> : null}
        {failed ? <Text style={s.error}>Couldn't save your name. Please try again.</Text> : null}
        <View style={s.spacer} />
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !valid }} disabled={!valid} onPress={() => void submit()}
          style={({ pressed }) => [s.button, !valid && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}>
          <Text style={s.buttonText}>Continue</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
