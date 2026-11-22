/** Bottom sheet that asks for the display name: the one-time prompt for existing guests, and the editor in Profile. */
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Input, Sheet, type Colors } from '../ui/common';
import { NAME_MAX_LENGTH, normalizeDisplayName } from '../services/profileService';
import { palette } from '../../theme';

type Props = {
  visible: boolean; colors: Colors; initial?: string | null; title?: string; skipLabel?: string;
  onSave: (name: string) => Promise<void> | void; onClose: () => void;
};

export function NameSheet({ visible, colors, initial, title = 'What should we call you?', skipLabel = 'Not now', onSave, onClose }: Props) {
  const [value, setValue] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (visible) { setValue(initial ?? ''); setFailed(false); setBusy(false); } }, [visible, initial]);
  const name = normalizeDisplayName(value);
  const save = async () => {
    if (!name || busy) return;
    setBusy(true); setFailed(false);
    try { await onSave(name); } catch { setFailed(true); setBusy(false); }
  };
  const footer = <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" disabled={!name || busy} onPress={() => void save()}
      style={{ minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.emerald, opacity: !name || busy ? 0.4 : 1 }}>
      <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 16 }}>Save</Text>
    </Pressable>
    <Pressable accessibilityRole="button" onPress={onClose} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.muted, fontWeight: '600', fontSize: 15 }}>{skipLabel}</Text>
    </Pressable>
  </View>;
  return <Sheet visible={visible} onClose={onClose} title={title} colors={colors} footer={footer}>
    <Text style={{ color: colors.muted, fontSize: 14, marginBottom: 12 }}>We use it to greet you. It is saved only on this phone.</Text>
    <Input colors={colors} value={value} onChangeText={(v) => { setValue(v); setFailed(false); }} placeholder="Your name" autoFocus autoCapitalize="words"
      autoCorrect={false} maxLength={NAME_MAX_LENGTH + 20} returnKeyType="done" onSubmitEditing={() => void save()} accessibilityLabel="Your name" />
    {value.trim().length > NAME_MAX_LENGTH ? <Text style={{ color: palette.dangerDeep, fontSize: 13, marginTop: 8 }}>Use {NAME_MAX_LENGTH} characters or fewer.</Text> : null}
    {failed ? <Text style={{ color: palette.dangerDeep, fontSize: 13, marginTop: 8 }}>Couldn't save your name. Please try again.</Text> : null}
  </Sheet>;
}
