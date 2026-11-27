import { useRef, useState, type ReactNode } from 'react';
import { Image, Switch, Text, View } from 'react-native';
import type Svg from 'react-native-svg';
import { palette, radius } from '../../theme';
import { Button, type Colors } from '../ui/common';
import { hapticSuccess } from '../ui/haptics';
import { showToast } from '../ui/Toast';
import { UpiQr, qrToPngBase64 } from './UpiQr';
import type { PaymentDetails } from '../services/paymentDetails';
import { formatRupees, greetingName, qrChoice, sendOnWhatsApp } from '../services/upiLinks';
import { copyText, openLink, shareImageFile, shareQrPng, shareText } from '../services/paymentExpo';

/**
 * Sending a reminder: the same actions and options for Settle up and for an expected payment. Nothing here records anything;
 * it only hands the text or the QR picture to the app the person chooses.
 */

export const Caption = ({ children, colors }: { children: string; colors: Colors }) =>
  <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginTop: 16, marginBottom: 8 }}>{children}</Text>;

/** WhatsApp with the text ready: the app, then wa.me, then the share sheet. */
export async function sendReminderOnWhatsApp(text: string, phone: string | null | undefined, onError: (message: string) => void): Promise<void> {
  const outcome = await sendOnWhatsApp(text, phone, { open: openLink, share: shareText });
  if (outcome === 'share') showToast("WhatsApp isn't available here, so the share sheet opened instead.", 'info', 'wa-share');
  if (outcome === 'failed') onError('Could not open WhatsApp or the share sheet.');
}

async function copyReminder(text: string): Promise<void> {
  if (await copyText(text)) { hapticSuccess(); showToast('Message copied.', 'success', 'copied'); }
  else { showToast("Copy isn't available in this version of the app, so the share sheet opened.", 'info', 'copy-share'); await shareText(text).catch(() => undefined); }
}

/** The message, its sign-off switch, copy / share, and the payment QR. */
export function ReminderOptions({ colors, preview, getText, phoneNote, detailsHint, signature, onSignature, details, amountPaise, upiLink, name, onError }: {
  colors: Colors;
  /** The message as it will be sent (a read-only box, or an editor). */
  preview: ReactNode;
  /** The text to send, or null after telling the person why there is none. */
  getText: () => string | null;
  phoneNote: string | null;
  /** Shown while neither a UPI ID nor a QR is saved. */
  detailsHint: string;
  signature: boolean; onSignature: (on: boolean) => void;
  details: PaymentDetails; amountPaise: number | null;
  /** The owner's link for this amount, which the generated QR carries. */
  upiLink: string | null;
  name: string; onError: (message: string) => void;
}) {
  const [showQr, setShowQr] = useState(false);
  const [useSaved, setUseSaved] = useState(false);
  const svgRef = useRef<Svg>(null);
  const choice = qrChoice({ hasUpiId: !!details.upiId, hasSavedQr: !!details.qrPath, useSaved });

  const shareOther = async () => { const text = getText(); if (text) await shareText(text).catch(() => undefined); };
  const copy = async () => { const text = getText(); if (text) await copyReminder(text); };
  const shareQr = async () => {
    try {
      if (choice === 'saved' && details.qrPath) await shareImageFile(details.qrPath, /\.png$/i.test(details.qrPath) ? 'image/png' : 'image/jpeg');
      else if (choice === 'generated' && svgRef.current) await shareQrPng(await qrToPngBase64(svgRef.current));
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not share the QR.'); }
  };

  return <>
    <Caption colors={colors}>REMINDER</Caption>
    {preview}
    {!details.upiId && !details.qrPath ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>{detailsHint}</Text> : null}
    {phoneNote ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>{phoneNote}</Text> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
      <Text style={{ color: colors.text }}>Add "Sent from Velnora"</Text>
      <Switch value={signature} onValueChange={onSignature} trackColor={{ true: palette.emerald, false: colors.border }} thumbColor="#FFFFFF" accessibilityLabel="Add Sent from Velnora" />
    </View>

    <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
      <View style={{ flex: 1 }}><Button title={showQr ? 'Hide UPI QR' : 'Show UPI QR'} kind="ghost" onPress={() => setShowQr((v) => !v)} /></View>
      <View style={{ flex: 1 }}><Button title="Copy message" kind="ghost" onPress={() => void copy()} /></View>
    </View>
    <View style={{ marginTop: 8 }}><Button title="Share via other apps" kind="ghost" onPress={() => void shareOther()} /></View>

    {showQr ? <View style={{ marginTop: 14, alignItems: 'center', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 14 }}>
      {choice === 'generated' && upiLink ? <>
        <UpiQr ref={svgRef} text={upiLink} size={220} />
        <Text style={{ color: colors.text, fontWeight: '700', marginTop: 8 }}>{formatRupees(amountPaise ?? 0)} to {details.upiId}</Text>
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2, textAlign: 'center' }}>Scanning fills in the amount.</Text>
      </> : null}
      {choice === 'generated' && !upiLink ? <Text style={{ color: colors.muted, textAlign: 'center' }}>Enter an amount to draw a QR that includes it.</Text> : null}
      {choice === 'saved' && details.qrPath ? <>
        <Image source={{ uri: details.qrPath }} style={{ width: 220, height: 220, backgroundColor: '#FFFFFF' }} resizeMode="contain" accessibilityLabel="Your saved payment QR" />
        <Text style={{ color: palette.amber, fontSize: 12, marginTop: 8, textAlign: 'center' }}>This is your own saved QR. It has no amount, so {greetingName(name)} has to enter {formatRupees(amountPaise ?? 0)} themselves.</Text>
      </> : null}
      {choice === 'none' ? <Text style={{ color: colors.muted, textAlign: 'center' }}>No payment details yet. Add your UPI ID or your QR in Profile → Payment details to show one here.</Text> : null}
      {details.upiId && details.qrPath ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', marginTop: 12 }}>
        <Text style={{ color: colors.text }}>Use my saved QR</Text>
        <Switch value={useSaved} onValueChange={setUseSaved} trackColor={{ true: palette.emerald, false: colors.border }} thumbColor="#FFFFFF" accessibilityLabel="Use my saved QR" />
      </View> : null}
      {choice !== 'none' && (choice === 'saved' || upiLink) ? <View style={{ alignSelf: 'stretch', marginTop: 12 }}><Button title="Share QR image" kind="ghost" onPress={() => void shareQr()} /></View> : null}
    </View> : null}
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 10 }}>WhatsApp opens with the text ready. It cannot attach the QR picture, so use "Share QR image" to send that as well.</Text>
  </>;
}
