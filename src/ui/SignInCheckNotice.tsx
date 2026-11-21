import { Pressable, Text, View } from 'react-native';
import { palette, radius, tint } from '../../theme';
import { typo } from '../../typography';
import { Info } from '../../icons';
import { readableOn, type Colors } from './common';

/**
 * Shown when the server refused to check the sign-in (HTTP 400 / 403 / 422) without saying the sign-in is invalid.
 * The session is kept and the app keeps working from this device; the person can try again or sign in again.
 * Different from "Your session has ended", which is only for a 401.
 */
export function SignInCheckNotice({ colors, busy, onRetry, onSignInAgain }: { colors: Colors; busy: boolean; onRetry: () => void; onSignInAgain: () => void }) {
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ marginBottom: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: tint(palette.warning, 0.5), backgroundColor: tint(palette.warning, 0.1) }}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Info size={18} color={palette.warning} />
      <Text style={{ ...typo.cardTitle, color: colors.text, marginLeft: 8, flexShrink: 1 }}>Can't verify your sign-in</Text>
    </View>
    <Text style={{ ...typo.caption, color: colors.muted, marginTop: 6 }}>Velnora couldn't confirm your sign-in with the server. Your data is safe on this device and keeps working offline; syncing is paused until this is resolved.</Text>
    <View style={{ flexDirection: 'row', marginTop: 12, gap: 10 }}>
      <Pressable onPress={onRetry} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} style={{ flex: 1, minHeight: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.emerald, opacity: busy ? 0.6 : 1 }}>
        <Text style={{ ...typo.chip, color: readableOn(palette.emerald) }}>{busy ? 'Checking…' : 'Retry'}</Text>
      </Pressable>
      <Pressable onPress={onSignInAgain} disabled={busy} accessibilityRole="button" style={{ flex: 1, minHeight: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
        <Text style={{ ...typo.chip, color: palette.accentText }}>Sign in again</Text>
      </Pressable>
    </View>
  </View>;
}
