import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { palette, space } from '../../theme';
import { Button, Input, Sheet, type Colors } from '../ui/common';
import { ReminderOptions, sendReminderOnWhatsApp } from './Reminder';
import { getServiceDb } from '../services/transactionService';
import { outstandingPaise, type ExpectedPayment } from '../services/expectedPaymentService';
import { canRemind, expectedReminderBody, reminderPhone } from '../services/expectedReminder';
import { getPaymentDetails, type PaymentDetails } from '../services/paymentDetails';
import { listContacts, type Contact } from '../services/splitService';
import { buildUpiLink, withSignature } from '../services/upiLinks';

const NO_DETAILS: PaymentDetails = { upiId: null, displayName: null, qrPath: null };

/**
 * "Remind on WhatsApp" for money someone still owes, with "More options" for editing the message, the QR and other apps.
 * Sends nothing by itself and records nothing. `actions` goes inside the detail sheet and `sheet` beside it; both are null
 * when there is nobody to remind.
 */
export function useExpectedReminder(item: ExpectedPayment | null, scope: string | null, colors: Colors): { actions: ReactNode; sheet: ReactNode } {
  const [saved, setSaved] = useState<{ details: PaymentDetails; contacts: Contact[] } | null>(null);
  const [signature, setSignature] = useState(false);
  // An edit belongs to the item as it was: once the amount, date, name or reason changes, the standard message returns.
  const [draft, setDraft] = useState<{ version: string; text: string } | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const id = item?.id ?? null;
  useEffect(() => {
    setSaved(null); setSignature(false); setDraft(null); setMore(false); setError('');
    if (!id) return;
    let live = true;
    const db = getServiceDb();
    // Either read may fail: the reminder still works without a UPI ID or a phone number.
    void Promise.all([getPaymentDetails(db, scope).catch(() => NO_DETAILS), listContacts(db, scope).catch(() => [] as Contact[])])
      .then(([details, contacts]) => { if (live) setSaved({ details, contacts }); });
    return () => { live = false; };
  }, [id, scope]);

  if (!item || !canRemind(item)) return { actions: null, sheet: null };
  const version = [item.id, item.amount_paise, item.paid_paise, item.due_date, item.person, item.note].join('|');
  const edited = draft?.version === version ? draft.text : null;
  const details = saved?.details ?? NO_DETAILS;
  const left = outstandingPaise(item);
  const body = edited ?? expectedReminderBody(item, details.upiId);
  const { phone, note } = reminderPhone(saved?.contacts ?? [], item);
  const upiLink = details.upiId ? buildUpiLink({ pa: details.upiId, pn: details.displayName, amountPaise: left, note: item.note || 'Payment' }) : null;

  const getText = (): string | null => {
    if (!body.trim()) { setError('Write a message first.'); return null; }
    setError('');
    return withSignature(body.trim(), signature);
  };
  const send = () => { const text = getText(); if (text) void sendReminderOnWhatsApp(text, phone, setError); };
  const errorText = error ? <Text style={{ color: palette.expenseText, marginBottom: space.sm }} accessibilityLiveRegion="polite">{error}</Text> : null;

  const actions = <View style={{ marginBottom: space.lg }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1 }}><Button title="Remind on WhatsApp" onPress={send} disabled={!saved} /></View>
      <Pressable onPress={() => { setError(''); setMore(true); }} disabled={!saved} accessibilityRole="button" accessibilityLabel="More reminder options" hitSlop={8} style={{ minHeight: 44, justifyContent: 'center', marginTop: space.sm }}>
        <Text style={{ color: palette.accentText, fontWeight: '700' }}>More options</Text>
      </Pressable>
    </View>
    {saved && note ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>{note}</Text> : null}
    {!more ? errorText : null}
  </View>;

  const sheet = <Sheet visible={more} onClose={() => { setError(''); setMore(false); }} title="Remind" colors={colors} footerGap={space.xxl + space.sm}
    footer={<>{errorText}<Button title="Send on WhatsApp" onPress={send} /></>}>
    <ReminderOptions colors={colors} name={item.person} getText={getText} phoneNote={note} signature={signature} onSignature={setSignature}
      details={details} amountPaise={left} upiLink={upiLink} onError={setError}
      detailsHint="Add your UPI ID or QR in Profile → Payment details to include your UPI ID and show a QR. The reminder works without them."
      preview={<View>
        <Input colors={colors} value={body} onChangeText={(text) => { setDraft({ version, text }); setError(''); }} multiline textAlignVertical="top" accessibilityLabel="Reminder message" style={{ minHeight: 112, paddingVertical: space.md }} />
        {signature ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>"Sent from Velnora" is added on a new line at the end.</Text> : null}
        {edited !== null ? <Pressable onPress={() => { setDraft(null); setError(''); }} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: space.sm }}>
          <Text style={{ color: palette.accentText, fontWeight: '700' }}>Reset message</Text>
        </Pressable> : null}
      </View>} />
  </Sheet>;

  return { actions, sheet };
}
