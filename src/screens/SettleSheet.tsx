import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { palette } from '../../theme';
import { Button, Initial, Input, Segmented, Sheet, currencySymbol, formatPaise, type Colors } from '../ui/common';
import { hapticSuccess } from '../ui/haptics';
import { showToast } from '../ui/Toast';
import { getServiceDb } from '../services/transactionService';
import { SELF, SplitError } from '../services/splitMath';
import { paiseToInput, parseMoneyToPaise } from '../services/splitDraft';
import { recordSettlement } from '../services/splitService';
import { settleWithFriend } from '../services/splitSettle';

export interface SettleTarget {
  id: string; label: string;
  /** Signed: > 0 they owe the owner, < 0 the owner owes them, 0 settled (the owner picks the direction). */
  balancePaise: number;
  /** Set to settle inside one group only; otherwise the payment is spread over every group and outside-group debt. */
  groupId?: string | null;
}

/**
 * Records a payment between the owner and one person. The amount starts as exactly what is owed (editable: a partial payment is
 * fine, and paying more simply flips the balance). A payment is never income or expense, and nothing here is sent anywhere.
 * (Reminders, WhatsApp, UPI and QR join this sheet in the next phase.)
 */
export function SettleSheet({ visible, onClose, scope, target, colors, onDone }: {
  visible: boolean; onClose: () => void; scope: string | null; target: SettleTarget | null; colors: Colors; onDone: () => void;
}) {
  const [direction, setDirection] = useState<'they_pay' | 'i_pay'>('they_pay');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !target) return;
    setError(''); setBusy(false);
    setDirection(target.balancePaise < 0 ? 'i_pay' : 'they_pay');
    setAmount(target.balancePaise !== 0 ? paiseToInput(Math.abs(target.balancePaise)) : '');
  }, [visible, target?.id, target?.balancePaise, target?.groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;
  const owed = Math.abs(target.balancePaise);
  const paise = parseMoneyToPaise(amount);
  const settled = target.balancePaise === 0;
  const sign = direction === 'they_pay' ? 1 : -1;
  // The amount that would still be owed in the direction of the payment (0 when it is the other way round or settled).
  const outstanding = target.balancePaise * sign > 0 ? owed : 0;
  const over = paise !== null && paise > outstanding;

  const save = async () => {
    if (busy) return;
    if (paise === null || paise <= 0) { setError('Enter an amount greater than zero.'); return; }
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

  const full = paise !== null && paise === outstanding && outstanding > 0;
  return <Sheet visible={visible} onClose={onClose} title={direction === 'they_pay' ? 'Payment received' : 'Payment made'} colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    <Button title={full ? 'Mark as settled' : 'Record payment'} onPress={() => void save()} busy={busy} />
  </>}>
    <View style={{ alignItems: 'center', marginBottom: 14 }}>
      <Initial label={target.label} color={palette.emerald} size={56} />
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 8 }} numberOfLines={1}>{target.label}</Text>
      <Text style={{ color: colors.muted, marginTop: 2 }}>
        {settled ? 'You are settled up' : target.balancePaise > 0 ? `Owes you ${formatPaise(owed)}` : `You owe ${formatPaise(owed)}`}{target.groupId ? ' in this group' : ''}
      </Text>
    </View>
    {settled ? <View style={{ marginBottom: 14 }}><Segmented colors={colors} value={direction} onChange={setDirection} options={[['they_pay', `${target.label.split(' ')[0]} paid me`], ['i_pay', 'I paid them']] as const} /></View> : null}
    <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 6 }}>AMOUNT</Text>
    <Input colors={colors} value={amount} onChangeText={(t) => { setAmount(t); setError(''); }} keyboardType="decimal-pad" placeholder={`${currencySymbol()} 0`} maxLength={14} accessibilityLabel="Amount" />
    {paise !== null && paise > 0 && !over && outstanding > paise ? <Text style={{ color: colors.muted, marginTop: 6, fontSize: 12 }}>Partial payment: {formatPaise(outstanding - paise)} will still be owed.</Text> : null}
    {over && outstanding > 0 ? <Text style={{ color: palette.amber, marginTop: 6, fontSize: 12 }}>That is more than {formatPaise(outstanding)}. The balance will flip to the other direction.</Text> : null}
    {over && outstanding === 0 && !settled ? <Text style={{ color: palette.amber, marginTop: 6, fontSize: 12 }}>This goes the other way from what is owed, so it increases the balance.</Text> : null}
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 14 }}>This only records the payment in Velnora. It is not counted as income or expense, and nothing is sent to anyone.</Text>
  </Sheet>;
}
