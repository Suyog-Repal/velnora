import { useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { palette } from '../../theme';
import { Button, Chip, Input, Labeled, Sheet, formatPaise, currencySymbol, type Colors } from '../ui/common';
import { parseReceiptText, type ReceiptSuggestion } from '../services/receiptParser';
import { recognizeReceiptText } from '../services/receiptOcr';
import { attachReceipt, findPossibleDuplicate } from '../services/receiptService';
import { expoReceiptFs } from '../services/receiptFiles';
import { addTransaction, getServiceDb } from '../services/transactionService';
import { TransactionRepository } from '../db/repositories/transactionRepository';
import { formatDateInput, formatTimeInput, parseLocalDateTime } from '../services/transactionDetails';
import type { CategoryView } from '../services/categoryService';
import type { Direction, Session } from '../db/types';

/**
 * Capture / choose / upload a bill or payment screenshot -> on-device OCR -> editable review -> transaction + the photo.
 * The review always shows what was read (date, who paid whom, amount, reference). Nothing is saved without confirmation.
 */
export function ReceiptScan({ visible, session, categories, colors, onClose, onSaved }: {
  visible: boolean; session: Session | null; categories: CategoryView[]; colors: Colors; onClose: () => void; onSaved: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [sugg, setSugg] = useState<ReceiptSuggestion | null>(null);
  const [ocrFailed, setOcrFailed] = useState(false);
  const [direction, setDirection] = useState<Direction>('expense');
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [category, setCategory] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [dupe, setDupe] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const reset = () => { setUri(null); setSugg(null); setOcrFailed(false); setDirection('expense'); setMerchant(''); setAmount(''); setDate(''); setTime(''); setCategory(''); setReference(''); setNote(''); setError(''); setDupe(null); };
  const close = () => { reset(); onClose(); };
  const cats = categories.filter((c) => c.type === direction);

  const readImage = async (picked: string) => {
    setUri(picked); setWorking(true); setError('');
    const text = await recognizeReceiptText(picked);
    const s = text ? parseReceiptText(text) : null;
    setOcrFailed(!s); setSugg(s);
    const dir: Direction = s?.direction ?? 'expense';
    setDirection(dir);
    const when = s?.date ?? new Date().toISOString();
    setMerchant(s?.merchant ?? ''); setAmount(s?.amountPaise ? String(s.amountPaise / 100) : '');
    setDate(formatDateInput(when)); setTime(formatTimeInput(when));
    setReference(s?.referenceId ?? '');
    const hint = categories.find((c) => c.type === dir && c.name.toLowerCase() === s?.categoryHint?.toLowerCase())?.name;
    setCategory(hint ?? '');
    setWorking(false);
  };

  const pick = async (source: 'camera' | 'gallery' | 'file') => {
    setError('');
    try {
      if (source === 'file') {
        const res = await DocumentPicker.getDocumentAsync({ type: ['image/*'], copyToCacheDirectory: true, multiple: false });
        if (res.canceled || !res.assets[0]) return;
        await readImage(res.assets[0].uri);
        return;
      }
      const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setError(`${source === 'camera' ? 'Camera' : 'Photo'} access was not granted. You can pick a file instead, or add the transaction manually.`); return; }
      const res = source === 'camera' ? await ImagePicker.launchCameraAsync({ quality: 0.9 }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
      if (res.canceled || !res.assets[0]) return;
      await readImage(res.assets[0].uri);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the image.'); setWorking(false); }
  };

  const save = async (force = false) => {
    setError('');
    const value = Number(amount); const iso = parseLocalDateTime(date, time || '00:00');
    if (!merchant.trim()) { setError(direction === 'income' ? 'Enter who paid you.' : 'Enter who you paid.'); return; }
    if (!Number.isFinite(value) || value <= 0) { setError('Enter the amount.'); return; }
    if (!iso) { setError('Enter a valid date (YYYY-MM-DD) and time (HH:MM).'); return; }
    if (!category) { setError('Choose a category.'); return; }
    setWorking(true);
    try {
      const db = getServiceDb(); const scope = session?.user.id ?? null;
      if (!force) {
        const ref = reference.trim();
        const sameRef = ref ? await new TransactionRepository(db).findByReferenceId(ref, scope) : null;
        if (sameRef) { setDupe(`reference ${ref}`); return; }
        const d = await findPossibleDuplicate(db, scope, { amountPaise: Math.round(value * 100), isoDate: iso, merchant });
        if (d) { setDupe(`"${d.counterparty}" for the same amount on this day`); return; }
      }
      const tx = await addTransaction({
        amount: value, direction, counterparty: merchant.trim(), category,
        description: note.trim() || (sugg?.isPaymentScreen ? 'Added from payment screenshot' : 'Added from receipt'),
        source: 'manual', transaction_date: iso, reference_id: force ? null : (reference.trim() || null),
      }, session);
      if (uri) await attachReceipt(db, expoReceiptFs, session, tx.id, uri);
      onSaved(); close();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setWorking(false); }
  };

  const ready = uri !== null;
  return <Sheet visible={visible} onClose={close} title="Scan a receipt or payment" colors={colors}>
    {!ready ? <View>
      <Text style={{ color: colors.muted, marginBottom: 12 }}>Take a photo, choose one from your gallery, or upload an image file (bill, UPI/bank screenshot). Text is read on this device; you review everything before it is saved.</Text>
      <Button title="Take photo" onPress={() => void pick('camera')} />
      <Button title="Choose from gallery" kind="ghost" onPress={() => void pick('gallery')} />
      <Button title="Upload an image file" kind="ghost" onPress={() => void pick('file')} />
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>PDF files can't be read yet; use a screenshot or photo.</Text>
      {error ? <Text style={{ color: palette.danger, marginTop: 8 }}>{error}</Text> : null}
    </View> : <View>
      <Image source={{ uri }} style={{ width: '100%', height: 150, borderRadius: 14, backgroundColor: colors.card, marginBottom: 12 }} resizeMode="cover" />
      {working ? <Text style={{ color: colors.muted }}>Reading…</Text> : null}
      {ocrFailed ? <Text style={{ color: palette.warning, marginBottom: 10 }}>We couldn't read this image, so nothing was filled in. The image is kept; enter the details below.</Text> : null}
      {sugg && !sugg.looksLikeReceipt && !sugg.isPaymentScreen ? <Text style={{ color: palette.warning, marginBottom: 10 }}>This doesn't look like a receipt or payment. Check the values carefully.</Text> : null}
      {sugg?.paymentStatus === 'failed' ? <Text style={{ color: palette.danger, marginBottom: 10 }}>This payment looks like it FAILED. Only save it if money really moved.</Text> : null}
      {sugg?.paymentStatus === 'pending' ? <Text style={{ color: palette.warning, marginBottom: 10 }}>This payment looks pending.</Text> : null}

      <Labeled label="TYPE" colors={colors}><View style={{ flexDirection: 'row' }}>
        <Chip label="Expense (I paid)" active={direction === 'expense'} onPress={() => { setDirection('expense'); setCategory(''); }} colors={colors} />
        <Chip label="Income (I received)" active={direction === 'income'} onPress={() => { setDirection('income'); setCategory(''); }} colors={colors} />
      </View></Labeled>
      <Labeled label={direction === 'income' ? 'RECEIVED FROM' : 'PAID TO'} colors={colors} hint={sugg?.merchant ? 'Read from the image. Please verify.' : undefined}>
        <Input colors={colors} value={merchant} onChangeText={setMerchant} placeholder={direction === 'income' ? 'Who paid you' : 'Who you paid'} />
        {sugg && sugg.merchantCandidates.length > 1 ? <ScrollView horizontal style={{ marginTop: 8 }}>{sugg.merchantCandidates.map((m) => <Chip key={m} label={m} active={merchant === m} onPress={() => setMerchant(m)} colors={colors} />)}</ScrollView> : null}
      </Labeled>
      <Labeled label={`AMOUNT (${currencySymbol()})`} colors={colors} hint={sugg?.amountPaise == null && sugg ? 'No amount found. Pick one of the amounts seen, or type it.' : sugg?.ambiguousTotal ? 'Several totals were found; the largest is shown. Please verify.' : undefined}>
        <Input colors={colors} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
        {sugg && (sugg.amountPaise == null || sugg.ambiguousTotal) && sugg.amountCandidates.length ? <ScrollView horizontal style={{ marginTop: 8 }}>{sugg.amountCandidates.map((p) => <Chip key={p} label={formatPaise(p)} active={Number(amount) * 100 === p} onPress={() => setAmount(String(p / 100))} colors={colors} />)}</ScrollView> : null}
        {sugg?.currency && sugg.currency !== 'INR' ? <Text style={{ color: palette.warning, marginTop: 6 }}>This looks like it is in {sugg.currency}. Velnora does not convert; enter the amount you want recorded.</Text> : null}
      </Labeled>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 3 }}><Labeled label="DATE" colors={colors} hint={sugg && !sugg.date ? 'No date found on the image; today is used.' : sugg?.date ? 'Read from the image.' : undefined}><Input colors={colors} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" /></Labeled></View>
        <View style={{ flex: 2 }}><Labeled label="TIME" colors={colors}><Input colors={colors} value={time} onChangeText={setTime} placeholder="HH:MM" /></Labeled></View>
      </View>
      <Labeled label="CATEGORY" colors={colors}><ScrollView horizontal>{cats.map((c) => <Chip key={c.id} label={c.name} active={category === c.name} color={c.color} onPress={() => setCategory(c.name)} colors={colors} />)}</ScrollView></Labeled>
      <Labeled label="TRANSACTION / REFERENCE ID (OPTIONAL)" colors={colors}><Input colors={colors} value={reference} onChangeText={setReference} placeholder="UPI ref / UTR / bill no." autoCapitalize="characters" /></Labeled>
      <Labeled label="NOTE (OPTIONAL)" colors={colors}><Input colors={colors} value={note} onChangeText={setNote} placeholder="What was this for?" /></Labeled>

      {dupe ? <View style={{ marginVertical: 8 }}><Text style={{ color: palette.warning, marginBottom: 6 }}>You already have a transaction with {dupe}. Is this the same one?</Text><Button title="Save anyway" onPress={() => void save(true)} busy={working} /></View> : null}
      {error ? <Text style={{ color: palette.danger, marginBottom: 8 }}>{error}</Text> : null}
      {!dupe ? <Button title="Save transaction" onPress={() => void save()} busy={working} /> : null}
      <Button title="Choose another image" kind="ghost" onPress={reset} />
    </View>}
  </Sheet>;
}
