import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { palette, radius, space } from '../../theme';
import { Button, Initial, Input, Segmented, Sheet, currencySymbol, formatPaise, type Colors } from '../ui/common';
import { hapticSuccess } from '../ui/haptics';
import { PopView } from '../ui/motion';
import { showToast } from '../ui/Toast';
import { WhatsAppIcon } from '../ui/WhatsAppIcon';
import { Caption, ReminderOptions, sendReminderOnWhatsApp } from './Reminder';
import { getServiceDb } from '../services/transactionService';
import { SELF, SplitError } from '../services/splitMath';
import { paiseToInput, parseMoneyToPaise } from '../services/splitDraft';
import { recordSettlement } from '../services/splitService';
import { settleWithFriend } from '../services/splitSettle';
import { getPaymentDetails, type PaymentDetails } from '../services/paymentDetails';
import { buildReminderMessage, buildUpiLink, noPhoneNote } from '../services/upiLinks';
import { openLink } from '../services/paymentExpo';

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
  const [signature, setSignature] = useState(false);
  const [pop, setPop] = useState(0);

  useEffect(() => {
    if (!visible || !target) return;
    setError(''); setBusy(false); setSignature(false);
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
    await sendReminderOnWhatsApp(text, target.phone, setError);
  };
  const openUpiApp = async () => {
    if (!payLink) return;
    try { await openLink(payLink); } catch { setError('No UPI app was found on this device.'); }
  };

  const full = paise !== null && paise === outstanding && outstanding > 0;
  const recordLabel = full ? 'Mark as settled' : 'Record this payment';
  const title = direction === 'they_pay' ? (settled || target.balancePaise > 0 ? 'Settle up' : 'Payment received') : 'Pay back';

  return <Sheet visible={visible} onClose={onClose} title={title} colors={colors} footerGap={space.xxl + space.sm} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    {remind && target.balancePaise > 0 ? <>
      <PopView popKey={pop}><Button title="Send on WhatsApp" icon={WhatsAppIcon} onPress={() => void sendWhatsApp()} /></PopView>
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

    {remind ? <ReminderOptions key={`${target.id}:${target.groupId ?? ''}:${target.balancePaise}`} colors={colors} name={firstName} getText={guard}
      phoneNote={!target.phone ? noPhoneNote(firstName) : null} signature={signature} onSignature={setSignature} details={details} amountPaise={paise} upiLink={myLink} onError={setError}
      detailsHint="Add your UPI ID or QR in Profile → Payment details to include a payment link and QR. The reminder works without them."
      preview={<View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 12 }}>
        {message ? <Text selectable style={{ color: colors.text, lineHeight: 20 }}>{message}</Text> : <Text style={{ color: colors.muted }}>Enter an amount to see the message.</Text>}
      </View>} />
    : <>
      {target.upiId ? <>
        <Caption colors={colors}>{`PAY ${firstName.split(' ')[0].toUpperCase()}`}</Caption>
        <Button title="Open in UPI app" kind="ghost" onPress={() => void openUpiApp()} />
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>Opens your UPI app with {target.upiId} and the amount filled in. Come back and record it here once you have paid.</Text>
      </> : <Text style={{ color: colors.muted, fontSize: 12, marginTop: 12 }}>Add {firstName.split(' ')[0]}'s UPI ID on their friend page to pay them from here.</Text>}
    </>}
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 14 }}>Recording a payment only updates your balances in Velnora. It is not counted as income or expense, and nothing is sent to anyone unless you choose to.</Text>
  </Sheet>;
}
