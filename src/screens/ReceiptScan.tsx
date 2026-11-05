import { useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { palette } from '../../theme';
import { Button, Chip, Input, Labeled, Sheet, formatPaise, type Colors } from '../ui/common';
import { parseReceiptText, type ReceiptSuggestion } from '../services/receiptParser';
import { recognizeReceiptText } from '../services/receiptOcr';
import { attachReceipt, findPossibleDuplicate } from '../services/receiptService';
import { expoReceiptFs } from '../services/receiptFiles';
import { addTransaction, getServiceDb } from '../services/transactionService';
import { formatDateInput, formatTimeInput, parseLocalDateTime } from '../services/transactionDetails';
import type { CategoryView } from '../services/categoryService';
import type { Session } from '../db/types';

/** Capture/select a bill -> on-device OCR -> editable review -> create transaction + keep the photo. Nothing is saved without confirmation. */
export function ReceiptScan({ visible, session, categories, colors, onClose, onSaved }: {
  visible: boolean; session: Session | null; categories: CategoryView[]; colors: Colors; onClose: () => void; onSaved: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [sugg, setSugg] = useState<ReceiptSuggestion | null>(null);
  const [ocrFailed, setOcrFailed] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState('');
  const [dupe, setDupe] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const reset = () => { setUri(null); setSugg(null); setOcrFailed(false); setMerchant(''); setAmount(''); setDate(''); setCategory(''); setError(''); setDupe(null); };
  const close = () => { reset(); onClose(); };
  const expenseCats = categories.filter((c) => c.type === 'expense');

  const pick = async (source: 'camera' | 'gallery') => {
    setError('');
    try {
      const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setError(`${source === 'camera' ? 'Camera' : 'Photo'} access was not granted. You can still add the transaction manually.`); return; }
      const res = source === 'camera' ? await ImagePicker.launchCameraAsync({ quality: 0.8 }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (res.canceled || !res.assets[0]) return;
      const picked = res.assets[0].uri;
      setUri(picked); setWorking(true);
      const text = await recognizeReceiptText(picked);
      const s = text ? parseReceiptText(text) : null;
      setOcrFailed(!s); setSugg(s);
      const when = s?.date ?? new Date().toISOString();
      setMerchant(s?.merchant ?? ''); setAmount(s?.amountPaise ? String(s.amountPaise / 100) : ''); setDate(formatDateInput(when));
      setCategory(expenseCats.find((c) => c.name.toLowerCase() === s?.categoryHint?.toLowerCase())?.name ?? '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the photo.'); }
    finally { setWorking(false); }
  };

  const save = async (force = false) => {
    setError('');
    const value = Number(amount); const iso = parseLocalDateTime(date, uri && sugg?.date ? formatTimeInput(sugg.date) : formatTimeInput(new Date().toISOString()));
    if (!merchant.trim()) { setError('Enter the merchant name.'); return; }
    if (!Number.isFinite(value) || value <= 0) { setError('Enter the total amount.'); return; }
    if (!iso) { setError('Enter a valid date (YYYY-MM-DD).'); return; }
    if (!category) { setError('Choose a category.'); return; }
    setWorking(true);
    try {
      const db = getServiceDb();
      if (!force) {
        const d = await findPossibleDuplicate(db, session?.user.id ?? null, { amountPaise: Math.round(value * 100), isoDate: iso, merchant });
        if (d) { setDupe(d.counterparty); return; }
      }
      const tx = await addTransaction({ amount: value, direction: 'expense', counterparty: merchant.trim(), category, description: 'Added from receipt', source: 'manual', transaction_date: iso }, session);
      if (uri) await attachReceipt(db, expoReceiptFs, session, tx.id, uri);
      onSaved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setWorking(false); }
  };

  return <Sheet visible={visible} onClose={close} title="Scan a receipt" colors={colors}>
    {!uri ? <View>
      <Text style={{ color: colors.muted, marginBottom: 12 }}>Take a photo of a bill or pick one from your gallery. Text is read on this device; you review everything before it is saved.</Text>
      <Button title="Take photo" onPress={() => void pick('camera')} />
      <Button title="Choose from gallery" kind="ghost" onPress={() => void pick('gallery')} />
      {error ? <Text style={{ color: palette.danger, marginTop: 8 }}>{error}</Text> : null}
    </View> : <View>
      <Image source={{ uri }} style={{ width: '100%', height: 160, borderRadius: 14, backgroundColor: colors.card, marginBottom: 12 }} resizeMode="cover" />
      {working ? <Text style={{ color: colors.muted }}>Reading receipt…</Text> : null}
      {ocrFailed ? <Text style={{ color: palette.warning, marginBottom: 10 }}>We couldn't read this photo, so nothing was filled in. The photo is kept; enter the details below.</Text> : null}
      {sugg && !sugg.looksLikeReceipt ? <Text style={{ color: palette.warning, marginBottom: 10 }}>This doesn't look like a receipt. Check the values carefully.</Text> : null}
      <Labeled label="MERCHANT" colors={colors} hint={sugg?.merchant ? 'Best guess from the top of the receipt. Please verify.' : undefined}>
        <Input colors={colors} value={merchant} onChangeText={setMerchant} placeholder="Merchant name" />
        {sugg && sugg.merchantCandidates.length > 1 ? <ScrollView horizontal style={{ marginTop: 8 }}>{sugg.merchantCandidates.map((m) => <Chip key={m} label={m} active={merchant === m} onPress={() => setMerchant(m)} colors={colors} />)}</ScrollView> : null}
      </Labeled>
      <Labeled label="TOTAL (₹)" colors={colors} hint={sugg?.amountPaise == null && sugg ? 'No total found. Pick one of the amounts seen, or type it.' : sugg?.ambiguousTotal ? 'Several totals were found; the largest is shown. Please verify.' : undefined}>
        <Input colors={colors} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
        {sugg && (sugg.amountPaise == null || sugg.ambiguousTotal) && sugg.amountCandidates.length ? <ScrollView horizontal style={{ marginTop: 8 }}>{sugg.amountCandidates.map((p) => <Chip key={p} label={formatPaise(p)} active={Number(amount) * 100 === p} onPress={() => setAmount(String(p / 100))} colors={colors} />)}</ScrollView> : null}
        {sugg?.currency && sugg.currency !== 'INR' ? <Text style={{ color: palette.warning, marginTop: 6 }}>This receipt looks like it is in {sugg.currency}; Velnora records rupees, so convert before saving.</Text> : null}
      </Labeled>
      <Labeled label="DATE" colors={colors} hint={sugg && !sugg.date ? 'No date found; today is used. Change it if needed.' : undefined}><Input colors={colors} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" /></Labeled>
      <Labeled label="CATEGORY" colors={colors} hint={sugg?.categoryHint && category ? 'Suggested from the merchant name.' : undefined}>
        <ScrollView horizontal>{expenseCats.map((c) => <Chip key={c.id} label={c.name} active={category === c.name} color={c.color} onPress={() => setCategory(c.name)} colors={colors} />)}</ScrollView>
      </Labeled>
      {dupe ? <View style={{ marginVertical: 8 }}><Text style={{ color: palette.warning, marginBottom: 6 }}>You already have "{dupe}" for the same amount on this day. Is this the same bill?</Text><Button title="Save anyway" onPress={() => void save(true)} busy={working} /></View> : null}
      {error ? <Text style={{ color: palette.danger, marginBottom: 8 }}>{error}</Text> : null}
      {!dupe ? <Button title="Save transaction" onPress={() => void save()} busy={working} /> : null}
      <Button title="Choose another photo" kind="ghost" onPress={reset} />
    </View>}
  </Sheet>;
}
