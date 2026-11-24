import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Image, Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { palette, radius, tint } from '../../theme';
import { Check, Pencil } from '../../icons';
import { Button, Input, Labeled, Sheet, type Colors } from '../ui/common';
import { hapticSuccess } from '../ui/haptics';
import { MOTION, PopView, useReduceMotion } from '../ui/motion';
import { getServiceDb } from '../services/transactionService';
import { SplitError } from '../services/splitMath';
import { getPaymentDetails, removePaymentQr, replacePaymentQr, savePaymentDetails, type PaymentDetails } from '../services/paymentDetails';
import { expoQrFiles } from '../services/paymentExpo';

/**
 * Profile > Payment details. The owner's UPI ID, the name shown on the payment link and (optionally) a picture of their own
 * GPay / PhonePe / Paytm QR. Everything stays on this device: it is never uploaded, never synced and never logged.
 */
/** A green check that springs in (scale + fade, native driver). With reduce-motion on it simply appears. */
function SavedCheck({ colors }: { colors: Colors }) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) { v.setValue(1); return; }
    const anim = Animated.spring(v, { toValue: 1, stiffness: 260, damping: 14, mass: 1, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [v, reduce]);
  return <View style={{ alignItems: 'center', paddingVertical: 28 }} accessible accessibilityLiveRegion="polite" accessibilityLabel="Payment details saved on this device">
    <View style={{ width: 84, height: 84, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', width: 64, height: 64, borderRadius: 32, backgroundColor: tint(palette.emerald, 0.25), opacity: v.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0.9, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.5] }) }] }} />
      <Animated.View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: palette.emerald, alignItems: 'center', justifyContent: 'center', opacity: v.interpolate({ inputRange: [0, 0.4], outputRange: [0, 1], extrapolate: 'clamp' }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }}>
        <Check size={32} color="#FFFFFF" strokeWidth={3} />
      </Animated.View>
    </View>
    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16, marginTop: 10 }}>Saved on this device</Text>
  </View>;
}

function DetailRow({ label, value, colors }: { label: string; value: string; colors: Colors }) {
  return <View style={{ marginBottom: 14 }}>
    <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }}>{label}</Text>
    <Text style={{ color: colors.text, fontSize: 16, marginTop: 4 }} selectable>{value}</Text>
  </View>;
}

export function PaymentDetailsSheet({ visible, onClose, scope, colors }: { visible: boolean; onClose: () => void; scope: string | null; colors: Colors }) {
  const [details, setDetails] = useState<PaymentDetails>({ upiId: null, displayName: null, qrPath: null });
  const [upi, setUpi] = useState(''); const [name, setName] = useState('');
  const [error, setError] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [pop, setPop] = useState(0);
  // What is on screen: the read-only summary once something is saved, the form to add or change it, or the brief "saved" confirmation.
  const [mode, setMode] = useState<'view' | 'edit'>('edit'); const [celebrate, setCelebrate] = useState(false);
  const reduce = useReduceMotion();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!visible) return;
    setError(''); setNote(''); setCelebrate(false);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    void getPaymentDetails(getServiceDb(), scope).then((d) => { setDetails(d); setUpi(d.upiId ?? ''); setName(d.displayName ?? ''); setMode(d.upiId || d.qrPath ? 'view' : 'edit'); }).catch(() => setError('Could not read your payment details.'));
  }, [visible, scope]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const d = await savePaymentDetails(getServiceDb(), scope, { upiId: upi, displayName: name });
      setDetails(d); setUpi(d.upiId ?? ''); setName(d.displayName ?? '');
      setPop((n) => n + 1); hapticSuccess();
      // A green check, then the read-only summary (no toast: the check is the confirmation).
      setCelebrate(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = null; setCelebrate(false); setMode('view'); }, reduce ? 700 : MOTION.base * 5);
    } catch (e) { setError(e instanceof SplitError || e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  const pickQr = async () => {
    setNote(''); setError('');
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setNote('Photo access was not granted. You can allow it in Settings.'); return; }
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 1, exif: false });
      if (res.canceled || !res.assets.length) return;
      const path = await replacePaymentQr(getServiceDb(), scope, expoQrFiles, res.assets[0].uri);
      setDetails((d) => ({ ...d, qrPath: path }));
      hapticSuccess();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save that picture.'); }
  };

  const removeQr = () => Alert.alert('Remove your QR?', 'The picture is deleted from this device. Your UPI ID stays.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => { void removePaymentQr(getServiceDb(), scope, expoQrFiles).then(() => setDetails((d) => ({ ...d, qrPath: null }))).catch(() => setError('Could not remove the picture.')); } },
  ]);

  const startEdit = () => { setUpi(details.upiId ?? ''); setName(details.displayName ?? ''); setError(''); setNote(''); setMode('edit'); };
  if (celebrate) return <Sheet visible={visible} onClose={onClose} title="Payment details" colors={colors}><SavedCheck colors={colors} /></Sheet>;
  if (mode === 'view') return <Sheet visible={visible} onClose={onClose} title="Payment details" colors={colors}>
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
      <Text style={{ color: colors.muted, flex: 1 }}>Saved on this device. Nothing here is uploaded or synced.</Text>
      <Pressable onPress={startEdit} accessibilityRole="button" accessibilityLabel="Edit payment details" hitSlop={8}
        style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? tint(palette.emerald, 0.2) : tint(palette.emerald, 0.12) })}>
        <Pencil size={18} color={palette.accentText} />
      </Pressable>
    </View>
    {details.upiId ? <DetailRow label="YOUR UPI ID" value={details.upiId} colors={colors} /> : null}
    {details.displayName ? <DetailRow label="NAME ON THE PAYMENT LINK" value={details.displayName} colors={colors} /> : null}
    {details.qrPath ? <>
      <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 }}>YOUR PAYMENT QR</Text>
      <View style={{ alignSelf: 'flex-start', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 8 }}>
        <Image source={{ uri: details.qrPath }} style={{ width: 96, height: 96, backgroundColor: '#FFFFFF' }} resizeMode="contain" accessibilityLabel="Your saved payment QR" />
      </View>
    </> : null}
  </Sheet>;
  return <Sheet visible={visible} onClose={onClose} title="Payment details" colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    <PopView popKey={pop}><Button title="Save" onPress={() => void save()} busy={busy} /></PopView>
  </>}>
    <Text style={{ color: colors.muted, marginBottom: 14 }}>Used only to build the payment requests you send to friends. They stay on this device: nothing here is uploaded or synced.</Text>
    <Labeled label="YOUR UPI ID" colors={colors} hint="Like name@bank. With it, Velnora can add the exact amount to a QR and a payment link.">
      <Input colors={colors} value={upi} onChangeText={(t) => { setUpi(t); setError(''); }} placeholder="name@bank" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={80} accessibilityLabel="Your UPI ID" />
    </Labeled>
    <Labeled label="NAME ON THE PAYMENT LINK (OPTIONAL)" colors={colors} hint="What your friend sees in their UPI app. Leave empty to show your UPI ID.">
      <Input colors={colors} value={name} onChangeText={(t) => { setName(t); setError(''); }} placeholder="e.g. Suyog" autoCapitalize="words" maxLength={60} accessibilityLabel="Name on the payment link" />
    </Labeled>

    <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginTop: 6, marginBottom: 8 }}>YOUR PAYMENT QR (OPTIONAL)</Text>
    {details.qrPath ? <View style={{ alignItems: 'center', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 14 }}>
      <Image source={{ uri: details.qrPath }} style={{ width: 200, height: 200, backgroundColor: '#FFFFFF' }} resizeMode="contain" accessibilityLabel="Your saved payment QR" />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12, alignSelf: 'stretch' }}>
        <View style={{ flex: 1 }}><Button title="Replace" kind="ghost" onPress={() => void pickQr()} /></View>
        <View style={{ flex: 1 }}><Button title="Remove" kind="danger" onPress={removeQr} /></View>
      </View>
    </View> : <Button title="Add payment QR" kind="ghost" onPress={() => void pickQr()} />}
    {note ? <Text style={{ color: palette.amber, marginTop: 8 }}>{note}</Text> : null}
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 10 }}>
      Choose a screenshot or photo of your own GPay, PhonePe or Paytm QR. A picture like this does not include an amount, so your friend types it themselves; with your UPI ID saved, Velnora draws a QR that already has the amount. The picture is copied into the app's private storage and deleted if you remove it.
    </Text>
  </Sheet>;
}
