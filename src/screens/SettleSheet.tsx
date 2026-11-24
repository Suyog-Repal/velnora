import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, Switch, Text, View } from 'react-native';
import type Svg from 'react-native-svg';
import { palette, radius } from '../../theme';
import { Button, Initial, Input, Segmented, Sheet, currencySymbol, formatPaise, type Colors } from '../ui/common';
import { hapticSuccess } from '../ui/haptics';
import { PopView } from '../ui/motion';
import { showToast } from '../ui/Toast';
import { UpiQr, qrToPngBase64 } from './UpiQr';
import { getServiceDb } from '../services/transactionService';
import { SELF, SplitError } from '../services/splitMath';
import { paiseToInput, parseMoneyToPaise } from '../services/splitDraft';
import { recordSettlement } from '../services/splitService';
import { settleWithFriend } from '../services/splitSettle';
import { getPaymentDetails, type PaymentDetails } from '../services/paymentDetails';
import { buildReminderMessage, buildUpiLink, formatRupees, qrChoice, sendOnWhatsApp } from '../services/upiLinks';
import { copyText, openLink, shareImageFile, shareQrPng, shareText } from '../services/paymentExpo';

export interface SettleTarget {
  id: string; label: string;
  /** The plain name (no disambiguation suffix), used in messages. */
  name?: string;
  /** Signed: > 0 they owe the owner, < 0 the owner owes them, 0 settled (the owner picks the direction). */
  balancePaise: number;
  /** Set to settle inside one group only; otherwise the payment is spread over every group and outside-group debt. */
  groupId?: string | null;
  /** What the reminder says it is for: a group name, or "our shared expenses". */
  context?: string;
  /** The friend's phone (for WhatsApp) and their own UPI ID (for paying them). Both stay on this device. */
  phone?: string | null;
  upiId?: string | null;
}

const Caption = ({ children, colors }: { children: string; colors: Colors }) =>
  <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginTop: 16, marginBottom: 8 }}>{children}</Text>;

/**
 * Settle up with one person. The amount starts as exactly what is owed (editable: a partial payment is fine, and paying more simply flips
 * the balance). When they owe you it also builds the reminder: friendly text with your UPI ID and link, a QR that carries the amount, and
 * WhatsApp / share / copy. Everything is built on this device; recording a payment is never income or expense and sends nothing.
 */
export function SettleSheet({ visible, onClose, scope, target, colors, onDone }: {
  visible: boolean; onClose: () => void; scope: string | null; target: SettleTarget | null; colors: Colors; onDone: () => void;
}) {
  const [direction, setDirection] = useState<'they_pay' | 'i_pay'>('they_pay');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<PaymentDetails>({ upiId: null, displayName: null, qrPath: null });
  const [showQr, setShowQr] = useState(false);
  const [useSaved, setUseSaved] = useState(false);
  const [signature, setSignature] = useState(false);
  const [pop, setPop] = useState(0);
  const svgRef = useRef<Svg>(null);

  useEffect(() => {
    if (!visible || !target) return;
    setError(''); setBusy(false); setShowQr(false); setUseSaved(false); setSignature(false);
    setDirection(target.balancePaise < 0 ? 'i_pay' : 'they_pay');
    setAmount(target.balancePaise !== 0 ? paiseToInput(Math.abs(target.balancePaise)) : '');
    void getPaymentDetails(getServiceDb(), scope).then(setDetails).catch(() => undefined);
  }, [visible, target?.id, target?.balancePaise, target?.groupId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const paise = parseMoneyToPaise(amount);
  const owed = target ? Math.abs(target.balancePaise) : 0;
  const sign = direction === 'they_pay' ? 1 : -1;
  const outstanding = target && target.balancePaise * sign > 0 ? owed : 0;
  const over = paise !== null && paise > outstanding;
  const settled = !!target && target.balancePaise === 0;
  const remind = direction === 'they_pay';
  const forWhat = target?.context ?? 'our shared expenses';
  const firstName = target?.name ?? target?.label ?? '';

  const choice = qrChoice({ hasUpiId: !!details.upiId, hasSavedQr: !!details.qrPath, useSaved });
  const myLink = useMemo(() => (details.upiId && paise ? buildUpiLink({ pa: details.upiId, pn: details.displayName, amountPaise: paise, note: forWhat }) : null), [details.upiId, details.displayName, paise, forWhat]);
  const message = useMemo(() => (remind && paise ? buildReminderMessage({ name: firstName, forWhat, amountPaise: paise, upiId: details.upiId, upiLink: myLink, signature }) : ''), [remind, paise, firstName, forWhat, details.upiId, myLink, signature]);
  const payLink = target?.upiId && paise ? buildUpiLink({ pa: target.upiId, pn: target.name ?? target.label, amountPaise: paise, note: forWhat }) : null;

  if (!target) return null;

  const needAmount = () => { setError('Enter an amount greater than zero.'); return false; };
  const record = async () => {
    if (busy) return;
    if (paise === null || paise <= 0) { needAmount(); return; }
    setPop((n) => n + 1);
    setBusy(true); setError('');
    try {
      const db = getServiceDb();
      if (target.groupId !== undefined) {
        await recordSettlement(db, scope, { from: direction === 'they_pay' ? target.id : SELF, to: direction === 'they_pay' ? SELF : target.id, amountPaise: paise, groupId: target.groupId });
      } else await settleWithFriend(db, scope, target.id, direction, paise);
      hapticSuccess();
      showToast(direction === 'they_pay' ? `Recorded ${formatPaise(paise)} from ${target.label}.` : `Recorded ${formatPaise(paise)} paid to ${target.label}.`, 'success', 'settled');
      onDone(); onClose();
    } catch (e) { setError(e instanceof SplitError || e instanceof Error ? e.message : 'Could not record the payment.'); }
    finally { setBusy(false); }
  };

  const guard = (): string | null => { if (!paise || !message) { needAmount(); return null; } setError(''); return message; };
  const sendWhatsApp = async () => {
    const text = guard(); if (!text) return;
    setPop((n) => n + 1);
    const outcome = await sendOnWhatsApp(text, target.phone, { open: openLink, share: shareText });
    if (outcome === 'share') showToast("WhatsApp isn't available here, so the share sheet opened instead.", 'info', 'wa-share');
    if (outcome === 'failed') setError('Could not open WhatsApp or the share sheet.');
  };
  const shareOther = async () => { const text = guard(); if (text) await shareText(text).catch(() => undefined); };
  const copy = async () => {
    const text = guard(); if (!text) return;
    if (await copyText(text)) { hapticSuccess(); showToast('Message copied.', 'success', 'copied'); }
    else { showToast("Copy isn't available in this version of the app, so the share sheet opened.", 'info', 'copy-share'); await shareText(text).catch(() => undefined); }
  };
  const shareQr = async () => {
    try {
      if (choice === 'saved' && details.qrPath) await shareImageFile(details.qrPath, /\.png$/i.test(details.qrPath) ? 'image/png' : 'image/jpeg');
      else if (choice === 'generated' && svgRef.current) await shareQrPng(await qrToPngBase64(svgRef.current));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not share the QR.'); }
  };
  const openUpiApp = async () => {
    if (!payLink) return;
    try { await openLink(payLink); } catch { setError('No UPI app was found on this device.'); }
  };

  const full = paise !== null && paise === outstanding && outstanding > 0;
  const recordLabel = full ? 'Mark as settled' : 'Record this payment';
  const title = direction === 'they_pay' ? (settled || target.balancePaise > 0 ? 'Settle up' : 'Payment received') : 'Pay back';

  return <Sheet visible={visible} onClose={onClose} title={title} colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    {remind && target.balancePaise > 0 ? <>
      <PopView popKey={pop}><Button title="Send on WhatsApp" onPress={() => void sendWhatsApp()} /></PopView>
      <Pressable onPress={() => void record()} disabled={busy} accessibilityRole="button" hitSlop={8} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}>
        <Text style={{ color: palette.accentText, fontWeight: '700' }}>{busy ? 'Saving…' : recordLabel}</Text>
      </Pressable>
    </> : <PopView popKey={pop}><Button title={recordLabel} onPress={() => void record()} busy={busy} /></PopView>}
  </>}>
    <View style={{ alignItems: 'center', marginBottom: 14 }}>
      <Initial label={target.label} color={palette.emerald} size={56} />
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 8 }} numberOfLines={1}>{target.label}</Text>
      <Text style={{ color: colors.muted, marginTop: 2 }}>
        {settled ? 'You are settled up' : target.balancePaise > 0 ? `Owes you ${formatPaise(owed)}` : `You owe ${formatPaise(owed)}`}{target.groupId ? ' in this group' : ''}
      </Text>
    </View>
    {settled ? <View style={{ marginBottom: 14 }}><Segmented colors={colors} value={direction} onChange={setDirection} options={[['they_pay', `${firstName.split(' ')[0]} paid me`], ['i_pay', 'I paid them']] as const} /></View> : null}

    <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 6 }}>AMOUNT</Text>
    <Input colors={colors} value={amount} onChangeText={(t) => { setAmount(t); setError(''); }} keyboardType="decimal-pad" placeholder={`${currencySymbol()} 0`} maxLength={14} accessibilityLabel="Amount" />
    {paise !== null && paise > 0 && !over && outstanding > paise ? <Text style={{ color: colors.muted, marginTop: 6, fontSize: 12 }}>Partial payment: {formatPaise(outstanding - paise)} will still be owed.</Text> : null}
    {over && outstanding > 0 ? <Text style={{ color: palette.amber, marginTop: 6, fontSize: 12 }}>That is more than {formatPaise(outstanding)}. The balance will flip to the other direction.</Text> : null}
    {over && outstanding === 0 && !settled ? <Text style={{ color: palette.amber, marginTop: 6, fontSize: 12 }}>This goes the other way from what is owed, so it increases the balance.</Text> : null}

    {remind ? <>
      <Caption colors={colors}>REMINDER</Caption>
      <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 12 }}>
        {message ? <Text selectable style={{ color: colors.text, lineHeight: 20 }}>{message}</Text> : <Text style={{ color: colors.muted }}>Enter an amount to see the message.</Text>}
      </View>
      {!details.upiId && !details.qrPath ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>
        Add your UPI ID or QR in Profile → Payment details to include a payment link and QR. The reminder works without them.
      </Text> : null}
      {!target.phone ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>No phone saved for {firstName.split(' ')[0]}: WhatsApp will ask you to choose the chat.</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
        <Text style={{ color: colors.text }}>Add "Sent from Velnora"</Text>
        <Switch value={signature} onValueChange={setSignature} trackColor={{ true: palette.emerald, false: colors.border }} thumbColor="#FFFFFF" accessibilityLabel="Add Sent from Velnora" />
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <View style={{ flex: 1 }}><Button title={showQr ? 'Hide UPI QR' : 'Show UPI QR'} kind="ghost" onPress={() => setShowQr((v) => !v)} /></View>
        <View style={{ flex: 1 }}><Button title="Copy message" kind="ghost" onPress={() => void copy()} /></View>
      </View>
      <View style={{ marginTop: 8 }}><Button title="Share via other apps" kind="ghost" onPress={() => void shareOther()} /></View>

      {showQr ? <View style={{ marginTop: 14, alignItems: 'center', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 14 }}>
        {choice === 'generated' && myLink ? <>
          <UpiQr ref={svgRef} text={myLink} size={220} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 8 }}>{formatRupees(paise ?? 0)} to {details.upiId}</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2, textAlign: 'center' }}>Scanning fills in the amount.</Text>
        </> : null}
        {choice === 'generated' && !myLink ? <Text style={{ color: colors.muted, textAlign: 'center' }}>Enter an amount to draw a QR that includes it.</Text> : null}
        {choice === 'saved' && details.qrPath ? <>
          <Image source={{ uri: details.qrPath }} style={{ width: 220, height: 220, backgroundColor: '#FFFFFF' }} resizeMode="contain" accessibilityLabel="Your saved payment QR" />
          <Text style={{ color: palette.amber, fontSize: 12, marginTop: 8, textAlign: 'center' }}>This is your own saved QR. It has no amount, so {firstName.split(' ')[0]} has to enter {formatRupees(paise ?? 0)} themselves.</Text>
        </> : null}
        {choice === 'none' ? <Text style={{ color: colors.muted, textAlign: 'center' }}>No payment details yet. Add your UPI ID or your QR in Profile → Payment details to show one here.</Text> : null}
        {details.upiId && details.qrPath ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', marginTop: 12 }}>
          <Text style={{ color: colors.text }}>Use my saved QR</Text>
          <Switch value={useSaved} onValueChange={setUseSaved} trackColor={{ true: palette.emerald, false: colors.border }} thumbColor="#FFFFFF" accessibilityLabel="Use my saved QR" />
        </View> : null}
        {choice !== 'none' && (choice === 'saved' || myLink) ? <View style={{ alignSelf: 'stretch', marginTop: 12 }}><Button title="Share QR image" kind="ghost" onPress={() => void shareQr()} /></View> : null}
      </View> : null}
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 10 }}>WhatsApp opens with the text ready. It cannot attach the QR picture, so use "Share QR image" to send that as well.</Text>
    </> : <>
      {target.upiId ? <>
        <Caption colors={colors}>{`PAY ${firstName.split(' ')[0].toUpperCase()}`}</Caption>
        <Button title="Open in UPI app" kind="ghost" onPress={() => void openUpiApp()} />
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>Opens your UPI app with {target.upiId} and the amount filled in. Come back and record it here once you have paid.</Text>
      </> : <Text style={{ color: colors.muted, fontSize: 12, marginTop: 12 }}>Add {firstName.split(' ')[0]}'s UPI ID on their friend page to pay them from here.</Text>}
    </>}
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 14 }}>Recording a payment only updates your balances in Velnora. It is not counted as income or expense, and nothing is sent to anyone unless you choose to.</Text>
  </Sheet>;
}
