import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { palette } from '../../theme';
import { Pencil, Phone } from '../../icons';
import { Button, Chip, Input, Labeled, Sheet, TypeToggle, currencySymbol, formatPaise, type Colors } from '../ui/common';
import { LocationPicker } from './LocationPicker';
import { DateField } from '../ui/CalendarDatePicker';
import { TimeField } from '../ui/TimePicker';
import { notices, showToast } from '../ui/Toast';
import { buildMerchantPhone, type LocationInput } from '../services/transactionDetails';
import { formFromTransaction, planEdit, type EditFormState } from '../services/transactionEdit';
import { deleteTransaction, getServiceDb, hasSplit, syncPendingTransactions, updateLedgerFields, updateTransactionDetailsDetailed } from '../services/transactionService';
import { SELF } from '../services/splitMath';
import { SplitReentryRequired, contactLabels, createSplitExpense, deleteSplitExpense, getSplitForTransaction, listContacts, updateSplitExpense, type SplitExpense, type SplitExpenseInput } from '../services/splitService';
import { SplitSheet } from './SplitEditor';
import { rememberAlias } from '../services/merchantAliasService';
import { removeReceipt } from '../services/receiptService';
import { downloadReceipt, expoReceiptFs } from '../services/receiptFiles';
import { commitAttachmentChanges, ensureLocalFile, getAttachments, refreshRemoteAttachments, removeAttachmentsForTransaction, toDraft, type DraftAttachment } from '../services/attachmentService';
import { expoAttachmentApi, expoAttachmentFs } from '../services/attachmentFiles';
import { AttachmentSection, EMPTY_DRAFT, draftChanges, draftIsDirty, type AttachmentDraft } from '../components/AttachmentSection';
import { TransactionRepository } from '../db/repositories/transactionRepository';
import { API_URL } from '../../auth';
import type { CategoryView } from '../services/categoryService';
import { KIND_LABELS, VERIFICATION_LABELS, sourceLabel } from '../services/ledgerRules';
import type { Direction, Session, TransactionEntity, TransactionKind } from '../db/types';

const PAYMENT_METHODS = ['UPI', 'Card', 'Cash', 'Net banking', 'Other'];
const DIAL_CODES = ['+91', '+1', '+44', '+971', '+65', '+61'];

export type TransactionSheetMode = 'view' | 'edit';

/**
 * An existing transaction. Opens as read-only Transaction Details; the pencil switches the SAME sheet to the edit form.
 * Saving updates the same transaction id and returns to Details; cancelling (Cancel, close, Android back) discards the
 * unsaved changes and returns to Details. New transactions never come here (they use the Add form).
 */
export function TransactionSheet({ tx, initialMode = 'view', session, categories, colors, onClose, onChanged }: {
  tx: TransactionEntity | null; initialMode?: TransactionSheetMode; session: Session | null; categories: CategoryView[]; colors: Colors; onClose: () => void; onChanged: () => void;
}) {
  const [current, setCurrent] = useState<TransactionEntity | null>(tx);
  const [mode, setMode] = useState<TransactionSheetMode>(initialMode);
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
  const [busy, setBusy] = useState(false);
  const [showMap, setShowMap] = useState(false);
  /** The stored attachments as last loaded; the draft is reset to this on cancel. */
  const [savedItems, setSavedItems] = useState<DraftAttachment[]>([]);
  const [attachDraft, setAttachDraft] = useState<AttachmentDraft>(EMPTY_DRAFT);
  const [attachLoading, setAttachLoading] = useState(false);
  const [kind, setKind] = useState<TransactionKind>('payment');
  const [bank, setBank] = useState('');
  const [last4, setLast4] = useState('');
  const [note, setNote] = useState('');
  /** Location change made in this edit, applied only by "Save changes": undefined = untouched, null = remove. */
  const [locDraft, setLocDraft] = useState<LocationInput | null | undefined>(undefined);
  const [markReviewed, setMarkReviewed] = useState(false);
  /** The split attached to this transaction (if any) and the names to show for it. */
  const [splitInfo, setSplitInfo] = useState<{ split: SplitExpense | null; names: Map<string, string> }>({ split: null, names: new Map() });
  const [splitMode, setSplitMode] = useState<null | 'create' | 'edit'>(null);
  /** Set when the amount of an Exact split changed: the person must enter the exact amounts again before anything is saved. */
  const [reentry, setReentry] = useState<SplitReentryRequired | null>(null);

  const loadSplit = async (txn: TransactionEntity) => {
    const db = getServiceDb();
    const split = await getSplitForTransaction(db, txn.user_id, txn.id).catch(() => null);
    const names = contactLabels(await listContacts(db, txn.user_id, { includeDeleted: true }).catch(() => []));
    names.set(SELF, 'You');
    setSplitInfo({ split, names });
  };

  /** Puts the saved values of `t` into the edit fields (prefill, and cancel): every unsaved change is dropped. */
  const fillForm = (t: TransactionEntity) => {
    const f = formFromTransaction(t, DIAL_CODES);
    setMerchant(f.merchant); setAmount(f.amount); setDate(f.date); setTime(f.time);
    setDirection(f.direction); setCategory(f.category); setPayment(f.payment); setError('');
    setKind(f.kind); setBank(f.bank); setLast4(f.last4); setDial(f.dial); setPhone(f.phone);
    setNote(f.note); setLocDraft(undefined); setMarkReviewed(false);
  };

  const id = tx?.id;
  useEffect(() => {
    if (!tx) return;
    setCurrent(tx); setMode(initialMode); fillForm(tx);
    void loadAttachments(tx); void loadSplit(tx);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Existing attachments: the ones on this device first (works offline), then anything added or removed on another device,
   * then cloud-only files are downloaded once into permanent storage. The old single receipt (earlier versions) is shown as
   * an attachment too, so nothing a person attached before disappears.
   */
  const loadAttachments = async (t: TransactionEntity) => {
    const db = getServiceDb();
    const api = expoAttachmentApi(API_URL);
    const legacy = (): DraftAttachment[] => (t.receipt_local_path || t.receipt_remote_id
      ? [{ key: `legacy-${t.id}`, source: 'legacy', type: 'photo', uri: t.receipt_local_path ?? null }] : []);
    const setUri = (key: string, uri: string) => {
      setSavedItems((list) => list.map((x) => (x.key === key ? { ...x, uri } : x)));
      setAttachDraft((d) => ({ ...d, items: d.items.map((x) => (x.key === key ? { ...x, uri } : x)) }));
    };
    const show = async () => {
      const saved = (await getAttachments(db, t.id)).map(toDraft);
      const items = [...legacy(), ...saved];
      setSavedItems(items);
      setAttachDraft((d) => (draftIsDirty(d) ? d : { items, removed: [] }));
      return saved;
    };
    setAttachDraft(EMPTY_DRAFT); setAttachLoading(true);
    try {
      let saved = await show();
      if (session && t.user_id === session.user.id) {
        if (await refreshRemoteAttachments(db, expoAttachmentFs, api, session, t.id).catch(() => false)) saved = await show();
        for (const item of saved.filter((x) => !x.uri && x.attachmentId)) {
          const path = await ensureLocalFile(db, expoAttachmentFs, api, session, item.attachmentId!).catch(() => null);
          if (path) setUri(item.key, path);
        }
        // Receipt added on another device by an earlier version: fetch it into private storage the first time.
        if (!t.receipt_local_path && t.receipt_remote_id) {
          void downloadReceipt(API_URL, session, t.id, t.receipt_remote_id).then((path) => {
            getServiceDb().runAsync('UPDATE transactions SET receipt_local_path = ? WHERE id = ?', path, t.id).catch(() => undefined); // device-private path, never synced
            setUri(`legacy-${t.id}`, path);
          }).catch(() => undefined);
        }
      }
    } finally {
      setAttachLoading(false);
    }
  };

  /** Re-reads the saved transaction (after a save or an immediately-applied change) so Details shows what is stored. */
  const refresh = async (): Promise<TransactionEntity | null> => {
    if (!current) return null;
    const fresh = await new TransactionRepository(getServiceDb()).getById(current.id).catch(() => null);
    if (fresh) setCurrent(fresh);
    return fresh;
  };

  const typeCats = useMemo(() => categories.filter((c) => c.type === direction).sort((a, b) => Number(b.name.toLowerCase() === category.toLowerCase()) - Number(a.name.toLowerCase() === category.toLowerCase())), [categories, direction, category]);
  const phoneCheck = buildMerchantPhone(phone, dial);
  const t = current;
  if (!tx || !t) return null;

  const startEdit = () => { fillForm(t); setAttachDraft({ items: savedItems, removed: [] }); setMode('edit'); };
  /** Cancel: nothing unsaved is kept; back to Details. */
  const cancelEdit = () => { fillForm(t); setAttachDraft({ items: savedItems, removed: [] }); setShowMap(false); setMode('view'); };
  const backToDetails = async () => {
    const fresh = await refresh();
    if (fresh) { await loadAttachments(fresh); await loadSplit(fresh); }
    setMode('view');
  };

  // Switching type moves the amount between income and expense totals; keep the category valid for the new type.
  const chooseDirection = (d: Direction) => {
    setDirection(d); setError('');
    const valid = categories.filter((c) => c.type === d);
    if (!valid.some((c) => c.name.toLowerCase() === category.toLowerCase())) setCategory(valid[0]?.name ?? (d === 'income' ? 'Other Income' : 'Other Expenses'));
  };

  /** Returns null on success, otherwise the message to show. `override` is the re-entered Exact split (see SplitReentryRequired). */
  const save = async (override?: SplitExpenseInput): Promise<string | null> => {
    setError('');
    const cat = categories.find((c) => c.type === direction && c.name.toLowerCase() === category.toLowerCase()) ?? categories.find((c) => c.name.toLowerCase() === category.toLowerCase());
    const form: EditFormState = {
      direction, merchant, amount, date, time, category, categoryId: cat && !cat.isCustom ? null : cat?.id ?? null,
      payment, phone, dial, note, kind, bank, last4, location: locDraft, markReviewed,
    };
    // Only what changed is written; the stored timestamp keeps its exact instant unless the date or time was changed.
    const planned = planEdit(t, form);
    if (!planned.ok) { setError(planned.error); return planned.error; }
    const attachmentsDirty = draftIsDirty(attachDraft);
    if (!planned.changed && !attachmentsDirty) { setShowMap(false); setMode('view'); return null; } // nothing to save
    setBusy(true);
    try {
      // Same transaction id: an update, never a new record. Synced by the existing engine.
      if (planned.plan.details) {
        const r = await updateTransactionDetailsDetailed(t.id, planned.plan.details, session, override);
        if (r.splitPlan.kind === 'resplit') showToast(r.splitPlan.zeroShare.length ? 'Split updated. The amount is too small to give everyone a paisa.' : 'Split updated to the new amount.', 'info', 'split-updated');
        if (r.splitPlan.kind === 'remove') showToast('This is no longer an expense, so its split was removed.', 'info', 'split-removed');
      }
      if (planned.plan.ledger) await updateLedgerFields(t.id, planned.plan.ledger, session);
      // Attachment changes apply to this same transaction id. Only removed items are removed.
      if (attachmentsDirty) {
        const res = await commitAttachmentChanges(getServiceDb(), expoAttachmentFs, session, t.id, draftChanges(attachDraft),
          { remove: () => removeReceipt(getServiceDb(), expoReceiptFs, session, t.id) });
        if (res.failed > 0) showToast(`${res.failed} attachment change${res.failed === 1 ? '' : 's'} could not be saved. Try again.`, 'warning', 'attach-failed');
        if (session) void syncPendingTransactions(session).catch(() => undefined);
      }
      setReentry(null);
      onChanged();
      notices.localSave('edit', !!session);
      const before = t;
      await backToDetails();
      const merchantChanged = merchant.trim() !== before.counterparty;
      const categoryChanged = category !== before.category && direction === before.direction;
      if (session && (merchantChanged || categoryChanged)) {
        Alert.alert(
          'Remember this merchant?',
          merchantChanged ? `Future transactions from "${before.counterparty}" will be named "${merchant.trim()}"${categoryChanged ? ` in ${category}` : ''}. Existing transactions are not changed.`
            : `Future transactions from "${before.counterparty}" will use ${category}. Existing transactions are not changed.`,
          [{ text: 'Not now', style: 'cancel' },
            { text: 'Remember', onPress: () => { void rememberAlias(getServiceDb(), session.user.id, before.counterparty, merchant.trim(), categoryChanged ? category : undefined).catch(() => undefined); } }],
        );
      }
      return null;
    } catch (e) {
      if (e instanceof SplitReentryRequired && !override) { setReentry(e); return null; } // nothing was changed; ask for the exact amounts first
      const message = e instanceof Error ? e.message : 'Could not save.';
      setError(message); return message;
    } finally { setBusy(false); }
  };

  const confirmDelete = async () => {
    const split = await hasSplit(t.id).catch(() => false);
    Alert.alert('Delete transaction?', `This removes it from your history and, when signed in, from your other devices.${split ? ' The split with friends is removed too; payments you recorded between you and your friends stay.' : ''}`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { void deleteTransaction(t.id, session).then(async () => {
      await removeAttachmentsForTransaction(getServiceDb(), expoAttachmentFs, session, t.id).catch(() => undefined);
      onChanged(); onClose();
    }); } },
    ]);
  };

  const hasLoc = t.location_lat != null && t.location_lng != null;
  const statusLine = `${sourceLabel(t)} · ${VERIFICATION_LABELS[t.verification_status ?? 'verified']} · ${t.user_id ? (t.sync_status === 'synced' ? 'Synced' : 'Waiting to sync') : 'Stored on this device only'}`;
  const amountHeader = (d: Direction) => <>
    <Text style={{ fontSize: 30, fontWeight: '700', color: d === 'income' ? palette.accentText : palette.expenseText, marginBottom: 4, fontVariant: ['tabular-nums'] }}>{d === 'income' ? '+' : '-'}{formatPaise(t.amount_paise)}</Text>
    <Text style={{ color: colors.muted, marginBottom: 16 }}>{statusLine}</Text>
  </>;

  // ---------------------------------------------------------------- Split (local only)
  const splitScope = t.user_id;
  const sp = splitInfo.split;
  const nameOf = (party: string) => splitInfo.names.get(party) ?? 'Removed person';
  const myShare = sp ? (sp.rows.find((r) => r.party === SELF)?.sharePaise ?? 0) : 0;
  const splitHeader = { title: t.counterparty, category: t.category, expenseDate: t.transaction_date, totalPaise: t.amount_paise };
  const removeSplit = () => Alert.alert('Remove split?', 'The split with friends is removed and this counts in full in your spending again. Payments you recorded stay.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => { if (!sp) return; void deleteSplitExpense(getServiceDb(), splitScope, sp.id).then(async () => { setSplitMode(null); await loadSplit(t); onChanged(); }); } },
  ]);
  const canSplit = t.direction === 'expense' && (t.txn_kind ?? 'payment') !== 'transfer';
  const splitCard = !canSplit && !sp ? null : <View style={{ marginTop: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 14 }}>
    {sp ? <>
      <Text style={{ color: colors.text, fontWeight: '700' }}>Split with {sp.rows.filter((r) => r.party !== SELF).map((r) => nameOf(r.party)).join(', ') || 'friends'}</Text>
      <Text style={{ color: colors.muted, marginTop: 4 }}>Your share <Text style={{ color: palette.accentText, fontWeight: '700' }}>{formatPaise(myShare)}</Text> counts in your spending. The payment above stays at the full amount.</Text>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
        <View style={{ flex: 1 }}><Button title="Edit split" kind="ghost" onPress={() => setSplitMode('edit')} /></View>
        <View style={{ flex: 1 }}><Button title="Remove split" kind="ghost" onPress={removeSplit} /></View>
      </View>
    </> : <>
      <Text style={{ color: colors.text, fontWeight: '700' }}>Shared this expense?</Text>
      <Text style={{ color: colors.muted, marginTop: 4, marginBottom: 10 }}>Split it with friends. The payment stays as it is; only your share counts in your spending.</Text>
      <Button title="Split this" onPress={() => setSplitMode('create')} />
    </>}
  </View>;
  const splitSheets = <>
    <SplitSheet visible={splitMode !== null} onClose={() => setSplitMode(null)} scope={splitScope} title={t.counterparty} totalPaise={t.amount_paise} existing={splitMode === 'edit' ? sp : null} colors={colors}
      onRemove={removeSplit}
      onSubmit={async (input) => {
        const db = getServiceDb();
        if (splitMode === 'edit' && sp) await updateSplitExpense(db, splitScope, sp.id, { ...input, ...splitHeader });
        else await createSplitExpense(db, splitScope, { ...input, ...splitHeader, transactionId: t.id });
        setSplitMode(null); await loadSplit(t); onChanged();
        showToast('Split saved. Your share counts in your spending.', 'success', 'split-saved');
      }} />
    <SplitSheet visible={!!reentry} onClose={() => setReentry(null)} scope={splitScope} title={merchant.trim() || t.counterparty} totalPaise={reentry?.newTotalPaise ?? t.amount_paise} existing={reentry?.split ?? null} startFresh colors={colors}
      reentryNote="The amount changed. Enter each person's exact amount again."
      onSubmit={async (input) => {
        if (!reentry) return;
        const failure = await save({ ...input, title: merchant.trim() || t.counterparty, category, expenseDate: reentry.split.expense_date, totalPaise: reentry.newTotalPaise });
        if (failure) throw new Error(failure);
      }} />
  </>;

  // ---------------------------------------------------------------- Transaction Details (read-only)
  if (mode === 'view') {
    const when = new Date(t.transaction_date);
    const rows: [string, string | null | undefined][] = [
      ['Type', t.direction === 'income' ? 'Income' : 'Expense'],
      ['Category', t.category],
      ['Date', when.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })],
      ['Time', when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })],
      ['Payment method', t.payment_method],
      ['Counts as', (t.txn_kind ?? 'payment') !== 'payment' ? KIND_LABELS[t.txn_kind!] : null],
      ['Bank', t.bank_name ? `${t.bank_name}${t.account_last4 ? ` ··${t.account_last4}` : ''}` : t.account_last4 ? `Account ··${t.account_last4}` : null],
      ['Seen in', t.payment_app],
      ['Merchant mobile', t.merchant_phone],
      ['Location', hasLoc ? [t.location_name || 'Pinned location', t.location_address].filter(Boolean).join('\n') : null],
      ['Note', t.description],
      ['Reference', t.reference_id],
    ];
    const edit = <Pressable onPress={startEdit} hitSlop={12} accessibilityRole="button" accessibilityLabel="Edit transaction"
      style={({ pressed }) => [{ width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center', borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 }]}>
      <Pencil color={palette.accentText} size={18} />
    </Pressable>;
    return <><Sheet visible onClose={onClose} title={t.counterparty} colors={colors} headerAction={edit}>
      {amountHeader(t.direction)}
      <View style={{ borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingHorizontal: 14 }}>
        {rows.filter(([, v]) => v && String(v).trim()).map(([label, value], i, all) => <View key={label} style={{ flexDirection: 'row', paddingVertical: 12, borderBottomWidth: i === all.length - 1 ? 0 : 1, borderBottomColor: colors.border, gap: 12 }}>
          <Text style={{ color: colors.muted, width: 118, fontSize: 13 }}>{label}</Text>
          <Text style={{ color: colors.text, flex: 1, fontSize: 14, fontWeight: '600' }} selectable>{value}</Text>
        </View>)}
      </View>
      {splitCard}
      <AttachmentSection draft={attachDraft} onChange={setAttachDraft} colors={colors} signedIn={!!session} loading={attachLoading} readOnly />
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 18 }}>Created {new Date(t.created_at).toLocaleString('en-IN')}</Text>
    </Sheet>{splitSheets}</>;
  }

  // ---------------------------------------------------------------- Edit Transaction
  /** The location the edit form shows: the unsaved change if there is one, otherwise the saved location. */
  const editLoc: LocationInput | null = locDraft !== undefined ? locDraft
    : hasLoc ? { lat: t.location_lat!, lng: t.location_lng!, name: t.location_name, address: t.location_address } : null;
  const footer = <>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Button title="Cancel" kind="ghost" onPress={cancelEdit} disabled={busy} /></View>
      <View style={{ flex: 2 }}><Button title="Save changes" onPress={() => void save()} busy={busy} /></View>
    </View>
  </>;
  return <><Sheet visible onClose={cancelEdit} title="Edit transaction" colors={colors} footer={footer}>
    {amountHeader(direction)}

    <Labeled label="TYPE" colors={colors} hint={direction !== t.direction ? `Will be saved as ${direction === 'income' ? 'income' : 'an expense'}.${sp && direction === 'income' ? ' Its split with friends will be removed.' : ''}` : undefined}><TypeToggle value={direction} onChange={chooseDirection} colors={colors} /></Labeled>
    <Labeled label="MERCHANT" colors={colors}><Input colors={colors} value={merchant} onChangeText={setMerchant} accessibilityLabel="Merchant" /></Labeled>
    <Labeled label={`AMOUNT (${currencySymbol()})`} colors={colors} hint={sp && Math.round(Number(amount) * 100) !== t.amount_paise ? (sp.mode === 'exact' ? 'This expense is split with exact amounts. You will enter them again when you save.' : 'Its split will follow the new amount.') : undefined}><Input colors={colors} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" accessibilityLabel="Amount" /></Labeled>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Labeled label="DATE" colors={colors}><DateField value={date} colors={colors} title="Transaction date" accessibilityLabel="Transaction date" onChange={(v) => { setDate(v); setError(''); }} /></Labeled></View>
      <View style={{ flex: 1 }}><Labeled label="TIME" colors={colors}><TimeField value={time} colors={colors} title="Transaction time" accessibilityLabel="Transaction time" onChange={setTime} /></Labeled></View>
    </View>

    <Labeled label="CATEGORY" colors={colors}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>{typeCats.map((c) => <Chip key={c.id} label={c.name} active={category.toLowerCase() === c.name.toLowerCase()} color={c.color} onPress={() => setCategory(c.name)} colors={colors} />)}</ScrollView>
    </Labeled>
    {(t.verification_status === 'needs_review' || t.verification_status === 'detected') && !t.possible_duplicate_of ? <View style={{ marginBottom: 14 }}>
      <Button title={markReviewed ? 'Will be marked as reviewed' : 'Mark as reviewed'} kind="ghost" onPress={() => setMarkReviewed((v) => !v)} />
      {markReviewed ? <Text style={{ color: palette.accentText, fontSize: 12, marginTop: 4 }}>Applied with "Save changes". Tap again to undo.</Text> : null}
    </View> : null}
    <Labeled label="COUNTS AS" colors={colors} hint={kind === 'transfer' ? 'Left out of income and expenses.' : kind === 'refund' || kind === 'reversal' ? 'Money back: not counted as income.' : undefined}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>{(Object.keys(KIND_LABELS) as TransactionKind[]).map((k) => <Chip key={k} label={KIND_LABELS[k]} active={kind === k} onPress={() => setKind(k)} colors={colors} />)}</ScrollView>
    </Labeled>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 2 }}><Labeled label="BANK" colors={colors}><Input colors={colors} value={bank} onChangeText={setBank} placeholder="Unknown" maxLength={60} accessibilityLabel="Bank" /></Labeled></View>
      <View style={{ flex: 1 }}><Labeled label="LAST 4" colors={colors}><Input colors={colors} value={last4} onChangeText={setLast4} placeholder="Unknown" keyboardType="number-pad" maxLength={4} accessibilityLabel="Account last 4 digits" /></Labeled></View>
    </View>
    {t.payment_app ? <Text style={{ color: colors.muted, marginBottom: 14 }}>Seen in {t.payment_app}. The app does not show which bank paid.</Text> : null}
    <Labeled label="PAYMENT METHOD (OPTIONAL)" colors={colors}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>{PAYMENT_METHODS.map((m) => <Chip key={m} label={m} active={payment === m} onPress={() => setPayment(payment === m ? null : m)} colors={colors} />)}</ScrollView>
    </Labeled>

    <Labeled label="MERCHANT MOBILE NUMBER" colors={colors} hint="Optional. Stored only with this transaction; never used to call or message anyone.">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>{DIAL_CODES.map((c) => <Chip key={c} label={c} active={dial === c} onPress={() => setDial(c)} colors={colors} />)}</ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ marginRight: 10 }}><Phone size={18} color={colors.muted} /></View>
        <View style={{ flex: 1 }}><Input colors={colors} value={phone} onChangeText={setPhone} placeholder="Enter merchant mobile number (optional)" keyboardType="phone-pad" accessibilityLabel="Merchant mobile number" /></View>
      </View>
      {phone && !phoneCheck.ok ? <Text style={{ color: palette.expenseText, marginTop: 6, fontSize: 12 }}>{phoneCheck.error}</Text> : null}
      {phone ? <Text onPress={() => setPhone('')} style={{ color: palette.accentText, fontWeight: '700', marginTop: 6 }}>Clear number</Text> : null}
    </Labeled>

    <Labeled label="LOCATION (OPTIONAL)" colors={colors} hint={locDraft !== undefined ? 'Location change is saved with "Save changes".' : undefined}>
      {editLoc ? <View style={{ marginBottom: 8 }}><Text style={{ color: colors.text, fontWeight: '700' }}>{editLoc.name || 'Pinned location'}</Text>{editLoc.address ? <Text style={{ color: colors.muted, fontSize: 12 }}>{editLoc.address}</Text> : null}</View> : <Text style={{ color: colors.muted, marginBottom: 8 }}>No location. Velnora never assumes where a payment happened.</Text>}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Button title={editLoc ? 'Edit location' : 'Add location'} kind="ghost" onPress={() => setShowMap(true)} /></View>
        {editLoc ? <View style={{ flex: 1 }}><Button title="Remove" kind="ghost" onPress={() => setLocDraft(null)} /></View> : null}
      </View>
    </Labeled>

    <Labeled label="NOTE (OPTIONAL)" colors={colors}>
      <Input colors={colors} value={note} onChangeText={setNote} placeholder="What was this for?" maxLength={500} accessibilityLabel="Note" />
    </Labeled>

    <View style={{ marginTop: -18, marginBottom: 14 }}>
      <AttachmentSection draft={attachDraft} onChange={setAttachDraft} colors={colors} signedIn={!!session} loading={attachLoading} receipt={{
        session, categories, excludeId: t.id,
        current: { direction, merchant, amount, date, time, category },
        // Reviewed and confirmed in the receipt sheet; they become the form's values (still editable, saved only with "Save changes").
        onApply: (r) => {
          chooseDirection(r.direction); setMerchant(r.merchant); setAmount(r.amount); setDate(r.date); setTime(r.time);
          if (categories.some((c) => c.type === r.direction && c.name.toLowerCase() === r.category.toLowerCase())) setCategory(r.category);
          if (r.note) setNote(r.note); // a note typed in the review; an empty one never clears the existing note
        },
      }} />
      {draftIsDirty(attachDraft) ? <Text style={{ color: palette.accentText, fontSize: 12, marginTop: 6 }}>Attachment changes are saved with "Save changes".</Text> : null}
    </View>

    <Labeled label="DETAILS" colors={colors}>
      <Text style={{ color: colors.muted, fontSize: 12 }}>Created {new Date(t.created_at).toLocaleString('en-IN')}{t.reference_id ? `\nReference ${t.reference_id}` : ''}</Text>
    </Labeled>

    <Button title="Delete transaction" kind="danger" onPress={confirmDelete} />

    <LocationPicker visible={showMap} colors={colors} initial={editLoc}
      onCancel={() => setShowMap(false)} onConfirm={(loc) => { setShowMap(false); setLocDraft(loc); }} />
  </Sheet>{splitSheets}</>;
}
