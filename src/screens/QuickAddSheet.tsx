import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { palette } from '../../theme';
import { Button, Chip, Input, Labeled, Sheet, currencySymbol, type Colors } from '../ui/common';
import { getServiceDb } from '../services/transactionService';
import { amountChipsFor, getQuickAddOptions, saveQuickEntry, type QuickAddOptions } from '../services/quickAdd';
import { formatAmount } from '../ui/currency';
import type { Session, TransactionEntity } from '../db/types';

/**
 * Fast entry for something Velnora could not capture (cash, a shop that sends no alert). Opened from the daily
 * check-in. The most-used category is already chosen and amount chips come from past manual entries, so a usual entry
 * is two taps (an amount, Save); a different category or amount is one more.
 */
export function QuickAddSheet({ visible, session, scope, colors, onClose, onSaved }: {
  visible: boolean; session: Session | null; scope: string | null; colors: Colors; onClose: () => void; onSaved: (tx: TransactionEntity) => void;
}) {
  const [options, setOptions] = useState<QuickAddOptions | null>(null);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setAmount(''); setNote(''); setError(''); setBusy(false);
    getQuickAddOptions(getServiceDb(), scope).then((next) => {
      if (!live) return;
      setOptions(next);
      setCategory(next.categories[0] ?? '');
    }).catch(() => { if (live) setError('Could not load your categories.'); });
    return () => { live = false; };
  }, [visible, scope]);

  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    const result = await saveQuickEntry({ amount, category, note }, session);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    onSaved(result.transaction);
  };

  const chips = options && category ? amountChipsFor(options, category) : [];

  return <Sheet visible={visible} onClose={onClose} title="Add expense" colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
    <Button title="Save" onPress={() => void save()} busy={busy} disabled={!amount || !category} />
  </>}>
    <Labeled label="AMOUNT" colors={colors}>
      <Input colors={colors} value={amount} onChangeText={setAmount} placeholder={`${currencySymbol()} 0`} keyboardType="decimal-pad" maxLength={12} accessibilityLabel="Amount" />
      {chips.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
        {chips.map((value) => <Chip key={value} label={formatAmount(value)} active={amount === String(value)} onPress={() => setAmount(String(value))} colors={colors} />)}
      </View> : null}
    </Labeled>
    <Labeled label="CATEGORY" colors={colors}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {(options?.categories ?? []).map((name) => <Chip key={name} label={name} active={category === name} onPress={() => setCategory(name)} colors={colors} />)}
      </View>
    </Labeled>
    <Labeled label="NOTE (OPTIONAL)" colors={colors}>
      <Input colors={colors} value={note} onChangeText={setNote} placeholder="e.g. auto fare, tea" maxLength={120} accessibilityLabel="Note" />
    </Labeled>
    <Text style={{ color: colors.muted, fontSize: 12 }}>Saved as a cash expense. It counts in your reports and charts like any other.</Text>
  </Sheet>;
}
