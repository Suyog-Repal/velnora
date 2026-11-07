import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palette } from '../../theme';
import { MessageSquare } from '../../icons';
import { SMS_PROMPT_STORAGE_KEY, shouldShowSmsPrompt } from '../services/smsPermissionPolicy';
import { readableOn } from '../ui/common';
import { showToast } from '../ui/Toast';
import { useSmsPermission } from '../ui/useSmsPermission';

/**
 * First-launch explanation for the SMS permission, shown once after the splash. Allow → Android's system permission
 * dialog; Not now → never asked again automatically (Profile → "Bank SMS detection" can turn it on later).
 * Message contents are not saved, uploaded or logged (see the native SMS pipeline).
 */
export function SmsPermissionPrompt({ enabled }: { enabled: boolean }) {
  const sms = useSmsPermission();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled || !sms.available || sms.granted) return;
    let active = true;
    AsyncStorage.getItem(SMS_PROMPT_STORAGE_KEY)
      .then((stored) => { if (active && shouldShowSmsPrompt({ available: sms.available, granted: sms.granted, answered: stored !== null })) setVisible(true); })
      .catch(() => undefined); // if storage fails, stay quiet rather than risk nagging
    return () => { active = false; };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (allow: boolean) => {
    setVisible(false);
    try { await AsyncStorage.setItem(SMS_PROMPT_STORAGE_KEY, allow ? 'allowed' : 'declined'); } catch { /* best effort */ }
    if (!allow) return;
    const result = await sms.requestWithGuidance(false);
    if (result === 'granted') showToast('SMS detection is on', 'success', 'sms-permission');
  };

  const accent = palette.emerald;
  return <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => void answer(false)}>
    <View style={s.backdrop}>
      <View style={s.card} accessibilityViewIsModal>
        <View style={[s.iconWrap, { backgroundColor: `${accent}22` }]}><MessageSquare size={30} color={accent} /></View>
        <Text style={s.title} accessibilityRole="header">Track your payments automatically</Text>
        <Text style={s.body}>Allow Velnora to receive SMS so it can spot bank and UPI payment alerts and suggest transactions for you.</Text>
        <Text style={s.fine}>Only bank-style alerts are processed. Message text is never saved, uploaded or logged, and you can change this any time in Profile or Android settings.</Text>
        <Pressable onPress={() => void answer(true)} accessibilityRole="button" style={({ pressed }) => [s.primary, { backgroundColor: accent, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={{ color: readableOn(accent), fontWeight: '800', fontSize: 15 }}>Allow SMS access</Text>
        </Pressable>
        <Pressable onPress={() => void answer(false)} accessibilityRole="button" style={s.secondary}>
          <Text style={{ color: palette.muted, fontWeight: '700' }}>Not now</Text>
        </Pressable>
      </View>
    </View>
  </Modal>;
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(8,24,39,0.6)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  card: { width: '100%', maxWidth: 380, borderRadius: 26, backgroundColor: '#FFFFFF', padding: 24, alignItems: 'center' },
  iconWrap: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '800', color: palette.ink, textAlign: 'center' },
  body: { fontSize: 14.5, lineHeight: 21, color: palette.ink, textAlign: 'center', marginTop: 10 },
  fine: { fontSize: 12, lineHeight: 18, color: palette.muted, textAlign: 'center', marginTop: 10 },
  primary: { alignSelf: 'stretch', minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  secondary: { alignSelf: 'stretch', minHeight: 46, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
});
