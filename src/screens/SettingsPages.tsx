import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ACCENTS, palette, type AccentId, type ThemeMode } from '../../theme';
import { Check, X } from '../../icons';
import { Sheet, type Colors } from '../ui/common';
import { CURRENCIES } from '../ui/currency';
import { AppearanceCard, Group, Reveal, Tap } from './ProfileView';

/** Full-screen Settings page (slides up). Theme and accent live here, not on the Profile page. */
export function SettingsPage({ visible, onClose, colors, mode, setMode, accent, setAccent }: {
  visible: boolean; onClose: () => void; colors: Colors; mode: ThemeMode; setMode: (m: ThemeMode) => void; accent: AccentId; setAccent: (a: AccentId) => void;
}) {
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 }}>
        <View><Text style={{ color: palette.emerald, fontSize: 11, fontWeight: '800', letterSpacing: 2 }}>VELNORA</Text><Text style={{ color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 4 }}>Settings</Text></View>
        <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close settings" style={{ width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' }}><X color={colors.muted} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 4, paddingBottom: 60 }}>
        <Reveal index={0}><AppearanceCard mode={mode} setMode={setMode} accent={accent} setAccent={setAccent} colors={colors} /></Reveal>
        <Reveal index={1}><Text style={{ color: colors.muted, marginTop: 16, marginLeft: 4, fontSize: 12 }}>Your choice is saved on this device. “System” follows your phone’s light/dark setting.</Text></Reveal>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

/** Currency picker. Changes the symbol and number format only: amounts are not converted. */
export function CurrencySheet({ visible, onClose, colors, code, setCode }: { visible: boolean; onClose: () => void; colors: Colors; code: string; setCode: (c: string) => void }) {
  return <Sheet visible={visible} onClose={onClose} title="Currency" colors={colors}>
    <Text style={{ color: colors.muted, marginBottom: 12 }}>Choose how amounts are shown. Velnora does not convert between currencies; your recorded numbers stay the same.</Text>
    <Group title="Display currency" colors={colors}>
      {CURRENCIES.map((c, i) => <Tap key={c.code} onPress={() => { setCode(c.code); onClose(); }} label={c.name} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: i === CURRENCIES.length - 1 ? 0 : 1, borderBottomColor: colors.border }}>
        <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${palette.emerald}1F`, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.emerald, fontWeight: '800' }}>{c.symbol.trim()}</Text></View>
        <View style={{ flex: 1, marginLeft: 12 }}><Text style={{ color: colors.text, fontWeight: '700' }}>{c.name}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{c.code}</Text></View>
        {code === c.code ? <Check size={18} color={palette.emerald} /> : null}
      </Tap>)}
    </Group>
  </Sheet>;
}
void ACCENTS;
