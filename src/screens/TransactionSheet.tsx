import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, ScrollView, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { palette } from '../../theme';
import { Camera, ImageIcon, MapPin, Phone, Trash } from '../../icons';
import { Button, Chip, Input, Labeled, Sheet, TypeToggle, currencySymbol, formatPaise, type Colors } from '../ui/common';
import { LocationPicker } from './LocationPicker';
import { DateField } from '../ui/CalendarDatePicker';
import { TimeField } from '../ui/TimePicker';
import { notices } from '../ui/Toast';
import { buildMerchantPhone, formatDateInput, formatTimeInput, parseLocalDateTime } from '../services/transactionDetails';
import { deleteTransaction, getServiceDb, updateTransactionDetails } from '../services/transactionService';
import { rememberAlias } from '../services/merchantAliasService';
import { attachReceipt, removeReceipt } from '../services/receiptService';
import { downloadReceipt, expoReceiptFs } from '../services/receiptFiles';
import { API_URL } from '../../auth';
import type { CategoryView } from '../services/categoryService';
import type { Direction, Session, TransactionEntity } from '../db/types';

const PAYMENT_METHODS = ['UPI', 'Card', 'Cash', 'Net banking', 'Other'];
const DIAL_CODES = ['+91', '+1', '+44', '+971', '+65', '+61'];

export function TransactionSheet({ tx, session, categories, colors, onClose, onChanged }: {
  tx: TransactionEntity | null; session: Session | null; categories: CategoryView[]; colors: Colors; onClose: () => void; onChanged: () => void;
}) {
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [category, setCategory] = useState('');
  const [direction, setDirection] = useState<Direction>('expense');
  const [payment, setPayment] = useState<string | null>(null);
  const [dial, setDial] = useState('+91');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [receiptUri, setReceiptUri] = useState<string | null>(null);

  const id = tx?.id;
  useEffect(() => {
    if (!tx) return;
    setMerchant(tx.counterparty); setAmount(String(tx.amount_paise / 100)); setDate(formatDateInput(tx.transaction_date)); setTime(formatTimeInput(tx.transaction_date));
    setDirection(tx.direction); setCategory(tx.category); setPayment(tx.payment_method ?? null); setError(''); setNote('');
    const p = tx.merchant_phone ?? '';
    const known = [...DIAL_CODES].sort((x, y) => y.length - x.length).find((c) => p.startsWith(c));
    if (!p) { setDial('+91'); setPhone(''); } else if (known) { setDial(known); setPhone(p.slice(known.length)); } else { setDial('+91'); setPhone(p); }
    setReceiptUri(tx.receipt_local_path ?? null);
    // Receipt added on another device: fetch it into private storage the first time it is opened (needs internet).
    if (!tx.receipt_local_path && tx.receipt_remote_id && session) {
      void downloadReceipt(API_URL, session, tx.id, tx.receipt_remote_id).then(async (path) => {
        // device-private path: written directly, never queued for sync
        getServiceDb().runAsync('UPDATE transactions SET receipt_local_path = ? WHERE id = ?', path, tx.id).catch(() => undefined);
        setReceiptUri(path);
      }).catch(() => undefined);
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeCats = useMemo(() => categories.filter((c) => c.type === direction).sort((a, b) => Number(b.name.toLowerCase() === category.toLowerCase()) - Number(a.name.toLowerCase() === category.toLowerCase())), [categories, direction, category]);
  const phoneCheck = buildMerchantPhone(phone, dial);
  if (!tx) return null;

  // Switching type moves the amount between income and expense totals; keep the category valid for the new type.
  const chooseDirection = (d: Direction) => {
    setDirection(d); setError('');
    const valid = categories.filter((c) => c.type === d);
    if (!valid.some((c) => c.name.toLowerCase() === category.toLowerCase())) setCategory(valid[0]?.name ?? (d === 'income' ? 'Other Income' : 'Other Expenses'));
  };

  const save = async () => {
    setError('');
    const value = Number(amount);
    // Only rewrite the stored timestamp when the person actually changed the date or time; otherwise the original
    // instant (including seconds) is left exactly as it was.
    const whenChanged = date !== formatDateInput(tx.transaction_date) || time !== formatTimeInput(tx.transaction_date);
    const iso = whenChanged ? parseLocalDateTime(date, time) : null;
    if (!Number.isFinite(value) || value <= 0) { setError('Enter an amount greater than zero.'); return; }
    if (whenChanged && !iso) { setError('Select a valid date and time.'); return; }
    if (!phoneCheck.ok) { setError(phoneCheck.error); return; }
    setBusy(true);
    try {
      const cat = categories.find((c) => c.type === direction && c.name.toLowerCase() === category.toLowerCase()) ?? categories.find((c) => c.name.toLowerCase() === category.toLowerCase());
      await updateTransactionDetails(tx.id, {
        direction,
        counterparty: merchant, amount: value, ...(iso ? { transaction_date: iso } : {}), category, category_id: cat && !cat.isCustom ? null : cat?.id ?? null,
        payment_method: payment, merchantPhone: { number: phone, dialCode: dial },
      }, session);
      onChanged();
      notices.localSave('edit', !!session);
      const merchantChanged = merchant.trim() !== tx.counterparty;
      const categoryChanged = category !== tx.category && direction === tx.direction;
      if (session && (merchantChanged || categoryChanged)) {
        Alert.alert(
          'Remember this merchant?',
          merchantChanged ? `Future transactions from "${tx.counterparty}" will be named "${merchant.trim()}"${categoryChanged ? ` in ${category}` : ''}. Existing transactions are not changed.`
            : `Future transactions from "${tx.counterparty}" will use ${category}. Existing transactions are not changed.`,
          [{ text: 'Not now', style: 'cancel', onPress: onClose },
            { text: 'Remember', onPress: () => { void rememberAlias(getServiceDb(), session.user.id, tx.counterparty, merchant.trim(), categoryChanged ? category : undefined).catch(() => undefined).finally(onClose); } }],
        );
      } else onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  const pickReceipt = async (source: 'camera' | 'gallery') => {
    setNote('');
    try {
      const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setNote(`${source === 'camera' ? 'Camera' : 'Photo'} permission was not granted. You can continue without a photo.`); return; }
      const res = source === 'camera' ? await ImagePicker.launchCameraAsync({ quality: 0.7 }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (res.canceled || !res.assets[0]) return;
      setReceiptUri(await attachReceipt(getServiceDb(), expoReceiptFs, session, tx.id, res.assets[0].uri));
      onChanged();
    } catch (e) { setNote(e instanceof Error ? e.message : 'Could not attach the photo.'); }
  };

  const clearReceipt = async () => {
    try { await removeReceipt(getServiceDb(), expoReceiptFs, session, tx.id); setReceiptUri(null); onChanged(); } catch (e) { setNote(e instanceof Error ? e.message : 'Could not remove.'); }
  };

  const confirmDelete = () => Alert.alert('Delete transaction?', 'This removes it from your history and, when signed in, from your other devices.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { void deleteTransaction(tx.id, session).then(() => { onChanged(); onClose(); }); } },
  ]);

  const hasLoc = tx.location_lat != null && tx.location_lng != null;
  const footer = <>
    {error ? <Text style={{ color: palette.danger, marginBottom: 8 }}>{error}</Text> : null}
    <Button title="Save changes" onPress={() => void save()} busy={busy} />
  </>;
  return <Sheet visible onClose={onClose} title={tx.counterparty} colors={colors} footer={footer}>
    <Text style={{ fontSize: 30, fontWeight: '800', color: direction === 'income' ? palette.emerald : palette.danger, marginBottom: 4 }}>{direction === 'income' ? '+' : '-'}{formatPaise(tx.amount_paise)}</Text>
    <Text style={{ color: colors.muted, marginBottom: 16 }}>{tx.source === 'sms' ? 'Detected from SMS' : 'Added manually'} · {tx.user_id ? (tx.sync_status === 'synced' ? 'Synced' : 'Waiting to sync') : 'Stored on this device only'}</Text>

    <Labeled label="TYPE" colors={colors} hint={direction !== tx.direction ? `Will be saved as ${direction === 'income' ? 'income' : 'an expense'}.` : undefined}><TypeToggle value={direction} onChange={chooseDirection} colors={colors} /></Labeled>
    <Labeled label="MERCHANT" colors={colors}><Input colors={colors} value={merchant} onChangeText={setMerchant} accessibilityLabel="Merchant" /></Labeled>
    <Labeled label={`AMOUNT (${currencySymbol()})`} colors={colors}><Input colors={colors} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" accessibilityLabel="Amount" /></Labeled>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Labeled label="DATE" colors={colors}><DateField value={date} colors={colors} title="Transaction date" accessibilityLabel="Transaction date" onChange={(v) => { setDate(v); setError(''); }} /></Labeled></View>
      <View style={{ flex: 1 }}><Labeled label="TIME" colors={colors}><TimeField value={time} colors={colors} title="Transaction time" accessibilityLabel="Transaction time" onChange={setTime} /></Labeled></View>
    </View>

    <Labeled label="CATEGORY" colors={colors}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>{typeCats.map((c) => <Chip key={c.id} label={c.name} active={category.toLowerCase() === c.name.toLowerCase()} color={c.color} onPress={() => setCategory(c.name)} colors={colors} />)}</ScrollView>
    </Labeled>
    <Labeled label="PAYMENT METHOD (OPTIONAL)" colors={colors}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>{PAYMENT_METHODS.map((m) => <Chip key={m} label={m} active={payment === m} onPress={() => setPayment(payment === m ? null : m)} colors={colors} />)}</ScrollView>
    </Labeled>

    <Labeled label="MERCHANT MOBILE NUMBER" colors={colors} hint="Optional. Stored only with this transaction; never used to call or message anyone.">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>{DIAL_CODES.map((c) => <Chip key={c} label={c} active={dial === c} onPress={() => setDial(c)} colors={colors} />)}</ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ marginRight: 10 }}><Phone size={18} color={colors.muted} /></View>
        <View style={{ flex: 1 }}><Input colors={colors} value={phone} onChangeText={setPhone} placeholder="Enter merchant mobile number (optional)" keyboardType="phone-pad" accessibilityLabel="Merchant mobile number" /></View>
      </View>
      {phone && !phoneCheck.ok ? <Text style={{ color: palette.danger, marginTop: 6, fontSize: 12 }}>{phoneCheck.error}</Text> : null}
      {phone ? <Text onPress={() => setPhone('')} style={{ color: palette.emerald, fontWeight: '700', marginTop: 6 }}>Clear number</Text> : null}
    </Labeled>

    <Labeled label="LOCATION (OPTIONAL)" colors={colors}>
      {hasLoc ? <View style={{ marginBottom: 8 }}><Text style={{ color: colors.text, fontWeight: '700' }}>{tx.location_name || 'Pinned location'}</Text>{tx.location_address ? <Text style={{ color: colors.muted, fontSize: 12 }}>{tx.location_address}</Text> : null}</View> : <Text style={{ color: colors.muted, marginBottom: 8 }}>No location. Velnora never assumes where a payment happened.</Text>}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Button title={hasLoc ? 'Edit location' : 'Add location'} kind="ghost" onPress={() => setShowMap(true)} /></View>
        {hasLoc ? <View style={{ flex: 1 }}><Button title="Remove" kind="ghost" onPress={() => { void updateTransactionDetails(tx.id, { location: null }, session).then(onChanged); }} /></View> : null}
      </View>
    </Labeled>

    <Labeled label="RECEIPT / PHOTO (OPTIONAL)" colors={colors}>
      {receiptUri ? <Image source={{ uri: receiptUri }} style={{ width: '100%', height: 200, borderRadius: 14, marginBottom: 8, backgroundColor: colors.card }} resizeMode="cover" accessibilityLabel="Receipt photo" /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Button title={receiptUri ? 'Retake' : 'Take photo'} kind="ghost" onPress={() => void pickReceipt('camera')} /></View>
        <View style={{ flex: 1 }}><Button title={receiptUri ? 'Replace' : 'Gallery'} kind="ghost" onPress={() => void pickReceipt('gallery')} /></View>
      </View>
      {receiptUri ? <Text onPress={() => void clearReceipt()} style={{ color: palette.danger, fontWeight: '700', marginTop: 6 }}>Remove photo</Text> : null}
      {note ? <Text style={{ color: colors.muted, marginTop: 6 }}>{note}</Text> : null}
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>{session ? 'Kept on this device and uploaded to your account when online.' : 'Guest photos stay on this device.'}</Text>
    </Labeled>

    <Labeled label="DETAILS" colors={colors}>
      <Text style={{ color: colors.muted, fontSize: 12 }}>Created {new Date(tx.created_at).toLocaleString('en-IN')}{tx.reference_id ? `\nReference ${tx.reference_id}` : ''}{tx.description ? `\n${tx.description}` : ''}</Text>
    </Labeled>

    <Button title="Delete transaction" kind="danger" onPress={confirmDelete} />

    <LocationPicker visible={showMap} colors={colors} initial={hasLoc ? { lat: tx.location_lat!, lng: tx.location_lng!, name: tx.location_name, address: tx.location_address } : null}
      onCancel={() => setShowMap(false)} onConfirm={(loc) => { setShowMap(false); void updateTransactionDetails(tx.id, { location: loc }, session).then(onChanged).catch((e) => setError(e instanceof Error ? e.message : 'Could not save location.')); }} />
  </Sheet>;
}
