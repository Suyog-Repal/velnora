import { useEffect, useState } from 'react';
import { Alert, Image, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { palette, radius } from '../../theme';
import { Button, Input, Labeled, Sheet, type Colors } from '../ui/common';
import { hapticSuccess } from '../ui/haptics';
import { showToast } from '../ui/Toast';
import { getServiceDb } from '../services/transactionService';
import { SplitError } from '../services/splitMath';
import { getPaymentDetails, removePaymentQr, replacePaymentQr, savePaymentDetails, type PaymentDetails } from '../services/paymentDetails';
import { expoQrFiles } from '../services/paymentExpo';

/**
 * Profile > Payment details. The owner's UPI ID, the name shown on the payment link and (optionally) a picture of their own
 * GPay / PhonePe / Paytm QR. Everything stays on this device: it is never uploaded, never synced and never logged.
 */
export function PaymentDetailsSheet({ visible, onClose, scope, colors }: { visible: boolean; onClose: () => void; scope: string | null; colors: Colors }) {
  const [details, setDetails] = useState<PaymentDetails>({ upiId: null, displayName: null, qrPath: null });
  const [upi, setUpi] = useState(''); const [name, setName] = useState('');
  const [error, setError] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setError(''); setNote('');
    void getPaymentDetails(getServiceDb(), scope).then((d) => { setDetails(d); setUpi(d.upiId ?? ''); setName(d.displayName ?? ''); }).catch(() => setError('Could not read your payment details.'));
  }, [visible, scope]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const d = await savePaymentDetails(getServiceDb(), scope, { upiId: upi, displayName: name });
      setDetails(d); setUpi(d.upiId ?? ''); setName(d.displayName ?? '');
      hapticSuccess(); showToast('Payment details saved on this device.', 'success', 'payment-saved');
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

  const dirty = (upi.trim() || '') !== (details.upiId ?? '') || (name.trim() || '') !== (details.displayName ?? '');
  return <Sheet visible={visible} onClose={onClose} title="Payment details" colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    <Button title={dirty ? 'Save details' : 'Saved'} onPress={() => void save()} busy={busy} />
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
