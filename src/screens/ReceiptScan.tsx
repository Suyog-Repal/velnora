import { useEffect, useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { palette } from '../../theme';
import { TypeToggle, Button, Chip, Input, Labeled, Sheet, formatPaise, currencySymbol, type Colors } from '../ui/common';
import { parseReceiptText, type ReceiptSuggestion } from '../services/receiptParser';
import { recognizeReceiptText } from '../services/receiptOcr';
import { findPossibleDuplicate } from '../services/receiptService';
import { getServiceDb } from '../services/transactionService';
import { DateField } from '../ui/CalendarDatePicker';
import { TimeField } from '../ui/TimePicker';
import { TransactionRepository } from '../db/repositories/transactionRepository';
import { formatDateInput, parseLocalDateTime } from '../services/transactionDetails';
import { initialReviewValues, reviewConflicts, type ConflictField, type ReceiptFormValues } from '../services/receiptReview';
import type { CategoryView } from '../services/categoryService';
import type { Direction, Session } from '../db/types';

/** What the transaction form already holds when "Fill in from receipt" is opened. Empty strings = not entered. */
export type { ReceiptFormValues };

/** The reviewed result handed back to the form. Only what the person confirmed in the review. */
export interface ReceiptReviewResult extends ReceiptFormValues {
  imageUri: string; imageWidth: number | null; imageHeight: number | null;
  referenceId: string | null; note: string;
}

/**
 * "Fill in from receipt": capture / choose / upload a bill or payment screenshot -> on-device OCR -> editable review ->
 * the reviewed values go back into the Add or Edit Transaction form, and the original image becomes an attachment.
 * Nothing is saved here. Values the receipt did not show are never invented: those fields keep what the form had.
 */
export function ReceiptScan({ visible, session, categories, colors, current, excludeId, onClose, onApply }: {
  visible: boolean; session: Session | null; categories: CategoryView[]; colors: Colors;
  current: ReceiptFormValues;
  /**
   * When editing an existing transaction: never report it as a duplicate of itself, and do not offer to change its
   * reference (a saved transaction's reference identifies it across devices; it is shown, not replaced).
   */
  excludeId?: string;
  onClose: () => void; onApply: (result: ReceiptReviewResult) => void;
}) {
  const referenceEditable = !excludeId;
  const [uri, setUri] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ width: number; height: number } | null>(null);
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

  const reset = () => { setUri(null); setImgSize(null); setSugg(null); setOcrFailed(false); setDirection('expense'); setMerchant(''); setAmount(''); setDate(''); setTime(''); setCategory(''); setReference(''); setNote(''); setError(''); setDupe(null); };
  useEffect(() => { if (!visible) reset(); }, [visible]);
  const close = () => { reset(); onClose(); };
  const cats = categories.filter((c) => c.type === direction);

  const readImage = async (picked: string, size: { width: number; height: number } | null) => {
    setUri(picked); setImgSize(size); setWorking(true); setError(''); setDupe(null);
    const text = await recognizeReceiptText(picked);
    const s = text ? parseReceiptText(text) : null;
    setOcrFailed(!s); setSugg(s);
    // A field starts from the receipt only where the receipt actually showed it; otherwise it keeps what the form had.
    const v = initialReviewValues(s, current, categories);
    setDirection(v.direction); setMerchant(v.merchant); setAmount(v.amount); setDate(v.date); setTime(v.time);
    setCategory(v.category); setReference(v.reference);
    setWorking(false);
  };

  const pick = async (source: 'camera' | 'gallery' | 'file') => {
    setError('');
    try {
      if (source === 'file') {
        const res = await DocumentPicker.getDocumentAsync({ type: ['image/*'], copyToCacheDirectory: true, multiple: false });
        if (res.canceled || !res.assets[0]) return;
        await readImage(res.assets[0].uri, null);
        return;
      }
      const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setError(`${source === 'camera' ? 'Camera' : 'Photo'} access was not granted. You can pick a file instead, or enter the details yourself.`); return; }
      // quality 1: the receipt is kept at full resolution so small print stays readable when zoomed.
      const res = source === 'camera' ? await ImagePicker.launchCameraAsync({ quality: 1 }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      await readImage(a.uri, a.width && a.height ? { width: a.width, height: a.height } : null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the image.'); setWorking(false); }
  };

  const apply = async (force = false) => {
    setError('');
    const value = Number(amount); const iso = parseLocalDateTime(date, time || '00:00');
    if (!merchant.trim()) { setError(direction === 'income' ? 'Enter who paid you.' : 'Enter who you paid.'); return; }
    if (!Number.isFinite(value) || value <= 0) { setError('Enter the amount.'); return; }
    if (!iso) { setError('Select a valid date and time.'); return; }
    if (!category) { setError('Choose a category.'); return; }
    if (!uri) return;
    setWorking(true);
    try {
      if (!force) {
        const db = getServiceDb(); const scope = session?.user.id ?? null;
        const ref = referenceEditable ? reference.trim() : '';
        const sameRef = ref ? await new TransactionRepository(db).findByReferenceId(ref, scope) : null;
        if (sameRef && sameRef.id !== excludeId) { setDupe(`reference ${ref}`); return; }
        const d = await findPossibleDuplicate(db, scope, { amountPaise: Math.round(value * 100), isoDate: iso, merchant });
        if (d && d.id !== excludeId) { setDupe(`"${d.counterparty}" for the same amount on this day`); return; }
      }
      const result: ReceiptReviewResult = {
        direction, merchant: merchant.trim(), amount, date, time, category,
        imageUri: uri, imageWidth: imgSize?.width ?? null, imageHeight: imgSize?.height ?? null,
        referenceId: force || !referenceEditable ? null : (reference.trim() || null), note: note.trim(),
      };
      reset();
      onApply(result);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not check this receipt.'); }
    finally { setWorking(false); }
  };

  /** "You entered X; the receipt shows Y" — a manual entry is never replaced without the person seeing both. */
  const conflicts = reviewConflicts(sugg, current, categories);
  const conflict = (f: ConflictField) => conflicts.find((c) => c.field === f);
  const differs = (f: ConflictField) => { const c = conflict(f); return c ? `You had entered "${c.entered}". The receipt shows "${c.read}".` : undefined; };
  /** Offers to go back to the entered value while the field holds something else. */
  const keep = (f: ConflictField, value: string, label: string, set: (v: string) => void) => {
    const c = conflict(f);
    return c && value !== c.entered ? <Text onPress={() => set(c.entered)} accessibilityRole="button" accessibilityLabel={`Keep ${label}`}
      style={{ color: palette.accentText, fontWeight: '700', marginTop: 6 }}>Keep {label}</Text> : null;
  };

  const ready = uri !== null;
  return <Sheet visible={visible} onClose={close} title="Fill in from receipt" colors={colors}>
    {!ready ? <View>
      <Text style={{ color: colors.muted, marginBottom: 12 }}>Take a photo, choose one from your gallery, or upload an image file (bill, UPI/bank screenshot). Text is read on this device. You review everything before it goes into the form, and the image is attached to the transaction.</Text>
      <Button title="Take photo" onPress={() => void pick('camera')} />
      <Button title="Choose from gallery" kind="ghost" onPress={() => void pick('gallery')} />
      <Button title="Upload an image file" kind="ghost" onPress={() => void pick('file')} />
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>PDF files can't be read yet; use a screenshot or photo.</Text>
      {error ? <Text style={{ color: palette.expenseText, marginTop: 8 }}>{error}</Text> : null}
    </View> : <View>
      <Image source={{ uri }} style={{ width: '100%', height: 150, borderRadius: 14, backgroundColor: colors.card, marginBottom: 12 }} resizeMode="cover" />
      {working ? <Text style={{ color: colors.muted }}>Reading…</Text> : null}
      {ocrFailed ? <Text style={{ color: palette.warning, marginBottom: 10 }}>We couldn't read this image, so nothing was filled in from it. The image will still be attached; enter or check the details below.</Text> : null}
      {sugg && !sugg.looksLikeReceipt && !sugg.isPaymentScreen ? <Text style={{ color: palette.warning, marginBottom: 10 }}>This doesn't look like a receipt or payment. Check the values carefully.</Text> : null}
      {sugg?.paymentStatus === 'failed' ? <Text style={{ color: palette.expenseText, marginBottom: 10 }}>This payment looks like it FAILED. Only use it if money really moved.</Text> : null}
      {sugg?.paymentStatus === 'pending' ? <Text style={{ color: palette.warning, marginBottom: 10 }}>This payment looks pending.</Text> : null}

      <Labeled label="TYPE" colors={colors} hint={sugg?.direction ? 'Suggested from the image. Please verify.' : undefined}>
        <TypeToggle value={direction} onChange={(d) => { if (d !== direction) { setDirection(d); setCategory(''); } }} colors={colors} expenseLabel="Expense (I paid)" incomeLabel="Income (received)" />
      </Labeled>
      <Labeled label={direction === 'income' ? 'RECEIVED FROM' : 'PAID TO'} colors={colors} hint={differs('merchant') ?? (sugg?.merchant ? 'Read from the image. Please verify.' : sugg ? 'No name found on the image; what you entered is kept.' : undefined)}>
        <Input colors={colors} value={merchant} onChangeText={setMerchant} placeholder={direction === 'income' ? 'Who paid you' : 'Who you paid'} />
        {sugg && sugg.merchantCandidates.length > 1 ? <ScrollView horizontal style={{ marginTop: 8 }}>{sugg.merchantCandidates.map((m) => <Chip key={m} label={m} active={merchant === m} onPress={() => setMerchant(m)} colors={colors} />)}</ScrollView> : null}
        {keep('merchant', merchant, `"${conflict('merchant')?.entered ?? ''}"`, setMerchant)}
      </Labeled>
      <Labeled label={`AMOUNT (${currencySymbol()})`} colors={colors} hint={differs('amount') ?? (sugg?.amountPaise == null && sugg ? 'No amount found. Pick one of the amounts seen, or type it.' : sugg?.ambiguousTotal ? 'Several totals were found; the largest is shown. Please verify.' : undefined)}>
        <Input colors={colors} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
        {sugg && (sugg.amountPaise == null || sugg.ambiguousTotal) && sugg.amountCandidates.length ? <ScrollView horizontal style={{ marginTop: 8 }}>{sugg.amountCandidates.map((p) => <Chip key={p} label={formatPaise(p)} active={Number(amount) * 100 === p} onPress={() => setAmount(String(p / 100))} colors={colors} />)}</ScrollView> : null}
        {keep('amount', amount, `${currencySymbol()}${conflict('amount')?.entered ?? ''}`, setAmount)}
        {sugg?.currency && sugg.currency !== 'INR' ? <Text style={{ color: palette.warning, marginTop: 6 }}>This looks like it is in {sugg.currency}. Velnora does not convert; enter the amount you want recorded.</Text> : null}
      </Labeled>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Labeled label="DATE" colors={colors} hint={differs('date') ?? (sugg && !sugg.date ? 'No date found on the image; the form\'s date is kept.' : sugg?.date ? 'Read from the image.' : undefined)}>
          <DateField value={date || null} colors={colors} title="Transaction date" accessibilityLabel="Transaction date" onChange={setDate} />
          {keep('date', date, conflict('date')?.entered ?? '', setDate)}
        </Labeled></View>
        <View style={{ flex: 1 }}><Labeled label="TIME" colors={colors} hint={differs('time') ?? (sugg?.date && !sugg.hasTime ? 'No time on the image; the form\'s time is kept.' : undefined)}>
          <TimeField value={time || '00:00'} colors={colors} title="Transaction time" accessibilityLabel="Transaction time" onChange={setTime} />
          {keep('time', time, conflict('time')?.entered ?? '', setTime)}
        </Labeled></View>
      </View>
      <Labeled label="CATEGORY" colors={colors} hint={differs('category')}>
        <ScrollView horizontal>{cats.map((c) => <Chip key={c.id} label={c.name} active={category === c.name} color={c.color} onPress={() => setCategory(c.name)} colors={colors} />)}</ScrollView>
        {keep('category', category, conflict('category')?.entered ?? '', setCategory)}
      </Labeled>
      {referenceEditable ? <Labeled label="TRANSACTION / REFERENCE ID (OPTIONAL)" colors={colors}><Input colors={colors} value={reference} onChangeText={setReference} placeholder="UPI ref / UTR / bill no." autoCapitalize="characters" /></Labeled>
        : sugg?.referenceId ? <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 12 }} selectable>Reference on the receipt: {sugg.referenceId}. A saved transaction keeps its own reference.</Text> : null}
      <Labeled label="NOTE (OPTIONAL)" colors={colors}><Input colors={colors} value={note} onChangeText={setNote} placeholder="What was this for?" /></Labeled>

      {dupe ? <View style={{ marginVertical: 8 }}><Text style={{ color: palette.warning, marginBottom: 6 }}>You already have a transaction with {dupe}. Is this the same one?</Text><Button title="Use anyway" onPress={() => void apply(true)} busy={working} /></View> : null}
      {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
      {!dupe ? <Button title="Use these details" onPress={() => void apply()} busy={working} /> : null}
      <Button title="Choose another image" kind="ghost" onPress={reset} />
    </View>}
  </Sheet>;
}
