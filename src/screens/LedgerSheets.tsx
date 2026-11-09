import { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { palette } from '../../theme';
import { Button, Chip, Input, Labeled, Sheet, TypeToggle, formatPaise, type Colors } from '../ui/common';
import { completeTransactionReview, getReviewDetails, getReviewQueue, getServiceDb, type ReviewDetails, type ReviewItem } from '../services/transactionService';
import { REVIEW_FIELD_LABELS } from '../services/transactionCompleteness';
import { VERIFICATION_LABELS, sourceLabel } from '../services/ledgerRules';
import type { CategoryView } from '../services/categoryService';
import { confirmAccount, createAccount, listAccounts, mergeAccounts, type AccountView } from '../services/accountService';
import { MAX_STATEMENT_BYTES, applyStatement, defaultExcludedLines, displayName, flagStatementOverlaps, parseStatementCsv, previewStatement, type ImportSummary, type PreviewRow, type PreviewStatus } from '../services/statementImport';
import { categorizeRows } from '../services/statementCategorizer';
import { readPdfStatement } from '../services/pdfStatementImport';
import type { PdfStatementMeta } from '../services/pdfStatementParser';
import { expoPdfExtractPort, removeTempFile } from '../services/pdfStatementFiles';
import { rememberAlias } from '../services/merchantAliasService';
import { getBaseApiUrl } from '../services/syncApi';
import type { Direction, Session, TransactionEntity } from '../db/types';

const when = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export function ReviewSheet({ visible, session, colors, onClose, onComplete }: {
  visible: boolean; session: Session | null; colors: Colors; onClose: () => void; onComplete: (id: string) => void;
}) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    setError('');
    void getReviewQueue(session).then(setItems).catch(() => setError('Could not load transactions.'));
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  return <Sheet visible={visible} onClose={onClose} title="Review transactions" colors={colors}>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
    {items.length === 0 ? <Text style={{ color: colors.muted }}>Nothing needs your attention.</Text> : null}
    {items.map(({ transaction: row, missing }) => <View key={row.id} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 12 }}>
      <Text style={{ color: colors.text, fontWeight: '700' }}>{row.counterparty} · {formatPaise(row.amount_paise)}</Text>
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{when(row.transaction_date)} · {row.direction === 'income' ? 'Money in' : 'Money out'}</Text>
      <Text style={{ color: colors.text, marginTop: 6 }}>Needs: {missing.length ? missing.map((m) => REVIEW_FIELD_LABELS[m].toLowerCase()).join(', ') : 'a quick check'}</Text>
      <View style={{ marginTop: 8 }}><Button title="Complete" onPress={() => { onClose(); onComplete(row.id); }} /></View>
    </View>)}
  </Sheet>;
}

/** The screen a review notification opens. Shows the whole transaction, and asks only for what actually needs attention. */
export function CompleteTransactionSheet({ transactionId, session, categories, colors, onClose, onChanged, onEdit }: {
  transactionId: string | null; session: Session | null; categories: CategoryView[]; colors: Colors; onClose: () => void; onChanged: () => void; onEdit: (tx: TransactionEntity) => void;
}) {
  const [details, setDetails] = useState<ReviewDetails | null>(null);
  const [category, setCategory] = useState('');
  const [merchant, setMerchant] = useState('');
  const [direction, setDirection] = useState<Direction>('expense');
  const [bank, setBank] = useState('');
  const [last4, setLast4] = useState('');
  const [duplicate, setDuplicate] = useState<'keep' | 'merge' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDetails(null); setError(''); setDuplicate(null); setCategory('');
    if (!transactionId) return;
    let live = true;
    void getReviewDetails(transactionId, session).then((next) => {
      if (!live) return;
      if (!next) { setError('This transaction is no longer available.'); return; }
      setDetails(next); setMerchant(next.missing.includes('merchant') ? '' : next.transaction.counterparty);
      setDirection(next.transaction.direction === 'income' ? 'income' : 'expense');
      setBank(next.transaction.bank_name ?? ''); setLast4(next.transaction.account_last4 ?? '');
    }).catch(() => { if (live) setError('Could not load this transaction.'); });
    return () => { live = false; };
  }, [transactionId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!transactionId) return null;
  const tx = details?.transaction;
  const open = tx?.verification_status === 'needs_review';
  const needs = (field: ReviewDetails['missing'][number]) => !!open && !!details?.missing.includes(field);
  const account = tx?.account_last4 ? `${tx.bank_name ?? 'Unknown bank'} ··${tx.account_last4}` : tx?.bank_name ? `${tx.bank_name}, exact account unknown` : 'Unknown';

  const save = async () => {
    if (!tx || !details) return;
    if (needs('duplicate') && !duplicate) { setError('Choose whether this is one payment or two.'); return; }
    if (duplicate !== 'merge') {
      if (needs('merchant') && !merchant.trim()) { setError('Enter who it was for.'); return; }
      if (needs('category') && !category) { setError('Choose a category.'); return; }
    }
    setBusy(true); setError('');
    try {
      const chosen = categories.find((c) => c.type === direction && c.name.toLowerCase() === category.toLowerCase());
      await completeTransactionReview(tx.id, {
        ...(needs('merchant') ? { counterparty: merchant.trim() } : {}),
        ...(needs('category') ? { category, category_id: chosen && chosen.isCustom ? chosen.id : null } : {}),
        ...(needs('direction') ? { direction } : {}),
        ...(needs('account') ? { bank_name: bank.trim() || null, account_last4: last4.trim() || null } : {}),
        ...(duplicate ? { duplicate } : {}),
      }, session);
      onChanged(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };

  const facts: [string, string][] = tx ? [
    ['Amount', formatPaise(tx.amount_paise)], ['Merchant', tx.counterparty], ['Date', new Date(tx.transaction_date).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })],
    ['Type', tx.direction === 'income' ? 'Money in' : 'Money out'], ['Category', tx.category], ['Account', account], ['Source', sourceLabel(tx)], ['Status', VERIFICATION_LABELS[tx.verification_status ?? 'verified']],
  ] : [];
  const typeCats = categories.filter((c) => c.type === direction);

  return <Sheet visible onClose={onClose} title={open ? 'Complete your transaction' : 'Transaction'} colors={colors} footer={open ? <>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
    <Button title="Save" onPress={() => void save()} busy={busy} />
  </> : undefined}>
    {!tx && error ? <Text style={{ color: colors.muted }}>{error}</Text> : null}
    {facts.map(([label, value]) => <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 12 }}>
      <Text style={{ color: colors.muted }}>{label}</Text><Text style={{ color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{value}</Text>
    </View>)}
    {tx && !open ? <View style={{ marginTop: 12 }}><Text style={{ color: colors.muted, marginBottom: 10 }}>Nothing is missing here.</Text><Button title="Edit transaction" kind="ghost" onPress={() => { onClose(); onEdit(tx); }} /></View> : null}
    {open ? <Text style={{ color: colors.text, fontWeight: '700', marginTop: 14, marginBottom: 10 }}>{details?.missing.length ? `Needs: ${details.missing.map((m) => REVIEW_FIELD_LABELS[m].toLowerCase()).join(', ')}` : 'Please check the details above.'}</Text> : null}
    {needs('duplicate') && details?.duplicateOf ? <Labeled label="POSSIBLE DUPLICATE" colors={colors} hint={`May be the same payment as ${details.duplicateOf.counterparty} on ${when(details.duplicateOf.transaction_date)}. Not counted in totals until you choose.`}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        <Chip label="Same payment" active={duplicate === 'merge'} onPress={() => setDuplicate('merge')} colors={colors} />
        <Chip label="Two payments" active={duplicate === 'keep'} onPress={() => setDuplicate('keep')} colors={colors} />
      </View>
    </Labeled> : null}
    {needs('direction') ? <Labeled label="TYPE" colors={colors}><TypeToggle value={direction} onChange={setDirection} colors={colors} /></Labeled> : null}
    {needs('merchant') && duplicate !== 'merge' ? <Labeled label="WHO WAS IT FOR?" colors={colors}><Input colors={colors} value={merchant} onChangeText={setMerchant} placeholder="Merchant or person" maxLength={80} accessibilityLabel="Merchant" /></Labeled> : null}
    {needs('category') && duplicate !== 'merge' ? <Labeled label="CATEGORY" colors={colors}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{typeCats.map((c) => <Chip key={c.id} label={c.name} color={c.color} active={category.toLowerCase() === c.name.toLowerCase()} onPress={() => setCategory(c.name)} colors={colors} />)}</View>
    </Labeled> : null}
    {needs('account') && duplicate !== 'merge' ? <Labeled label="ACCOUNT (LEAVE BLANK IF UNKNOWN)" colors={colors}>
      <Input colors={colors} value={bank} onChangeText={setBank} placeholder="Bank" maxLength={60} accessibilityLabel="Bank" />
      <View style={{ height: 8 }} />
      <Input colors={colors} value={last4} onChangeText={setLast4} placeholder="Last 4 digits" keyboardType="number-pad" maxLength={4} accessibilityLabel="Account last 4 digits" />
    </Labeled> : null}
  </Sheet>;
}

export function AccountsSheet({ visible, scope, colors, onClose, onChanged }: { visible: boolean; scope: string | null; colors: Colors; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<AccountView[]>([]);
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [bank, setBank] = useState('');
  const [last4, setLast4] = useState('');
  const [error, setError] = useState('');

  const load = async () => setRows(await listAccounts(getServiceDb(), scope));
  useEffect(() => { if (visible) { setError(''); setMergeFrom(null); void load().catch(() => setError('Could not load accounts.')); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (task: () => Promise<unknown>) => {
    setError('');
    try { await task(); await load(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
  };
  const label = (a: AccountView) => a.label || `${a.bank_name ?? 'Unknown bank'}${a.last4 ? ` ··${a.last4}` : ''}`;
  const pressMerge = (a: AccountView) => {
    if (!mergeFrom) { setMergeFrom(a.id); return; }
    if (mergeFrom === a.id) { setMergeFrom(null); return; }
    const from = rows.find((r) => r.id === mergeFrom);
    Alert.alert('Merge accounts?', `Transactions on ${from ? label(from) : 'that account'} will move to ${label(a)}.`, [
      { text: 'Cancel', style: 'cancel', onPress: () => setMergeFrom(null) },
      { text: 'Merge', onPress: () => void act(async () => { await mergeAccounts(getServiceDb(), scope, mergeFrom, a.id); setMergeFrom(null); }) },
    ]);
  };

  return <Sheet visible={visible} onClose={onClose} title="Accounts" colors={colors}>
    <Text style={{ color: colors.muted, marginBottom: 10 }}>Found only from what your bank messages say. Velnora never connects to your bank. A payment app such as Google Pay is not treated as a bank account.</Text>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
    {rows.length === 0 ? <Text style={{ color: colors.muted }}>No accounts identified yet.</Text> : null}
    {rows.map((a) => <View key={a.id} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 12 }}>
      <Text style={{ color: colors.text, fontWeight: '700' }}>{label(a)}</Text>
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{a.status === 'confirmed' ? 'Confirmed' : 'Suggested'} · {a.transactionCount} transaction{a.transactionCount === 1 ? '' : 's'} · {formatPaise(a.monthSpentPaise)} spent this month</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
        {a.status === 'suggested' ? <Chip label="Confirm" active={false} colors={colors} onPress={() => void act(() => confirmAccount(getServiceDb(), scope, a.id))} /> : null}
        <Chip label={mergeFrom === a.id ? 'Cancel merge' : mergeFrom ? 'Merge into this' : 'Merge'} active={mergeFrom === a.id} colors={colors} onPress={() => pressMerge(a)} />
      </View>
    </View>)}
    <Labeled label="ADD AN ACCOUNT" colors={colors}><Input colors={colors} value={bank} onChangeText={setBank} placeholder="Bank name" maxLength={60} accessibilityLabel="Bank name" /></Labeled>
    <Input colors={colors} value={last4} onChangeText={setLast4} placeholder="Last 4 digits (optional)" keyboardType="number-pad" maxLength={4} accessibilityLabel="Last 4 digits" />
    <View style={{ marginTop: 10 }}><Button title="Add account" onPress={() => void act(async () => { await createAccount(getServiceDb(), scope, { bankName: bank, last4 }); setBank(''); setLast4(''); })} /></View>
  </Sheet>;
}

const STATUS_TEXT: Record<PreviewStatus, string> = { new: 'New', matched: 'Already recorded', possible: 'Possible duplicate', already_imported: 'Imported before' };

const dayLabel = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/**
 * Statement import, one sheet for both file types. CSV is read on the phone. A PDF is sent to the person's own Velnora
 * server to read its text (they are told first; nothing is stored there) and is then parsed here. Either way the person
 * reviews every line, can leave lines out and change categories, and nothing touches the ledger until they confirm.
 */
export function StatementImportSheet({ visible, mode, scope, session, categories, refreshSession, colors, onClose, onImported }: {
  visible: boolean; mode: 'csv' | 'pdf'; scope: string | null; session: Session | null; categories: CategoryView[]; refreshSession?: (stale: Session) => Promise<Session | null>;
  colors: Colors; onClose: () => void; onImported: () => void;
}) {
  const pdf = mode === 'pdf';
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [edited, setEdited] = useState<Map<number, string>>(new Map());
  const [editing, setEditing] = useState<number | null>(null);
  const [remember, setRemember] = useState(true);
  const [parseErrors, setParseErrors] = useState(0);
  const [fileName, setFileName] = useState('');
  const [meta, setMeta] = useState<PdfStatementMeta | null>(null);
  const [summary, setSummary] = useState<(ImportSummary & { needsCategory: number }) | null>(null);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (visible) { setPreview(null); setSummary(null); setError(''); setSkipped(new Set()); setEdited(new Map()); setEditing(null); setMeta(null); setStage(''); } }, [visible]);

  const pickCsv = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'application/csv', 'application/vnd.ms-excel', 'text/plain'], copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    if ((asset.size ?? 0) > MAX_STATEMENT_BYTES) { setError('This file is too large. Export a shorter date range.'); return; }
    const text = await FileSystem.readAsStringAsync(asset.uri);
    await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => undefined); // the cached copy is not kept
    const parsed = parseStatementCsv(text);
    if (!parsed.headerFound) { setError('Could not find date, description and amount columns. Please export the statement as CSV, or use Import PDF Statement.'); return; }
    if (parsed.rows.length === 0) { setError('No transactions were found in this file.'); return; }
    setParseErrors(parsed.errors.length);
    setFileName(asset.name ?? '');
    setPreview(await previewStatement(getServiceDb(), scope, parsed.rows));
  };

  const pickPdf = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets[0]) return; // cancelling is not an error
    const asset = res.assets[0];
    try {
      setStage('Reading your statement…');
      const read = await readPdfStatement({ uri: asset.uri, name: asset.name ?? '', mimeType: asset.mimeType, size: asset.size }, session, expoPdfExtractPort(getBaseApiUrl()), refreshSession);
      if (!read.ok) { setError(read.message); return; }
      setStage('Checking for duplicates…');
      const db = getServiceDb();
      const rows = await categorizeRows(db, scope, read.rows);
      const checked = await flagStatementOverlaps(db, scope, await previewStatement(db, scope, rows));
      setParseErrors(read.errors.length);
      setFileName(asset.name ?? '');
      setMeta(read.meta);
      setSkipped(defaultExcludedLines(checked)); // a possible duplicate is added only if the person says so
      setPreview(checked);
    } finally { await removeTempFile(asset.uri); }
  };

  const pick = async () => {
    if (busy) return;
    setError(''); setBusy(true);
    try { await (pdf ? pickPdf() : pickCsv()); } catch { setError(pdf ? 'Could not read that file. Nothing was imported.' : 'Could not read that file.'); } finally { setBusy(false); setStage(''); }
  };

  const withEdits = (rows: PreviewRow[]): PreviewRow[] => rows.map((p) => {
    const category = edited.get(p.row.line);
    return category ? { ...p, row: { ...p.row, category, categoryConfidence: 'user' as const, needsReview: false } } : p;
  });

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const final = withEdits(preview);
      const included = (p: PreviewRow) => !skipped.has(p.row.line);
      const done = await applyStatement(getServiceDb(), scope, final, included, parseErrors);
      const needsCategory = final.filter((p) => p.status === 'new' && included(p) && p.row.needsReview).length;
      if (remember && session && edited.size) {
        // Only what the person chose, and only because they left the box ticked.
        for (const p of final) {
          const category = edited.get(p.row.line);
          if (category && included(p)) await rememberAlias(getServiceDb(), session.user.id, displayName(p.row.narration), displayName(p.row.narration), category).catch(() => undefined);
        }
      }
      setSummary({ ...done, needsCategory });
      setPreview(null);
      onImported();
    } catch { setError('The import stopped. Lines already added are kept, and importing again will not repeat them.'); } finally { setBusy(false); }
  };

  const toggle = (line: number) => setSkipped((prev) => { const next = new Set(prev); if (!next.delete(line)) next.add(line); return next; });
  const count = (status: PreviewStatus) => preview?.filter((p) => p.status === status).length ?? 0;
  const importable = preview?.filter((p) => (p.status === 'new' || p.status === 'possible') && !skipped.has(p.row.line)) ?? [];
  const totalIn = preview?.filter((p) => p.row.direction === 'income').reduce((s, p) => s + p.row.amount, 0) ?? 0;
  const totalOut = preview?.filter((p) => p.row.direction === 'expense').reduce((s, p) => s + p.row.amount, 0) ?? 0;
  const toCheck = preview?.filter((p) => p.status === 'new' && p.row.needsReview && !edited.has(p.row.line)).length ?? 0;
  const title = pdf ? 'Import PDF Statement' : 'Import CSV';

  const footer = preview ? <View>
    <Button title={importable.length ? `Import ${importable.length} transaction${importable.length === 1 ? '' : 's'}` : 'Confirm import'} onPress={() => void confirm()} busy={busy} />
    <Text onPress={busy ? undefined : onClose} accessibilityRole="button" style={{ color: colors.muted, textAlign: 'center', paddingTop: 12 }}>Cancel and import nothing</Text>
  </View> : undefined;

  return <Sheet visible={visible} onClose={busy ? () => undefined : onClose} title={title} colors={colors} footer={footer}>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
    {summary ? <View>
      <Text style={{ color: colors.text, fontWeight: '700', marginBottom: 6 }}>Import finished</Text>
      {[['Transactions found', summary.found], ['Added', summary.added], ['Matched to existing', summary.matched], ['Possible duplicates', summary.possibleDuplicates], ['Need a category check', summary.needsCategory], ['Imported before', summary.alreadyImported], ['Lines not understood', summary.errors]].map(([k, v]) =>
        <Text key={String(k)} style={{ color: colors.muted, marginBottom: 2 }}>{k}: {v}</Text>)}
      <Text style={{ color: colors.muted, marginTop: 8 }}>Saved on this phone. They are sent to your account in the background, and show as synced only once the server confirms.</Text>
      {summary.needsCategory > 0 ? <Text style={{ color: colors.muted, marginTop: 6 }}>Transactions that need a category are in Review transactions on your Profile.</Text> : null}
    </View> : preview ? <View>
      {pdf ? <View style={{ marginBottom: 10 }}>
        <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>{fileName}</Text>
        <Text style={{ color: colors.muted, marginTop: 2 }}>{[meta?.bankName, meta?.periodStart ? `${dayLabel(meta.periodStart)} to ${dayLabel(meta.periodEnd)}` : null].filter(Boolean).join(' · ') || 'Statement period not found'}</Text>
        <Text style={{ color: colors.muted, marginTop: 2 }}>Income {formatPaise(Math.round(totalIn * 100))} · Expenses {formatPaise(Math.round(totalOut * 100))}</Text>
      </View> : null}
      <Text style={{ color: colors.muted, marginBottom: 8 }}>{preview.length} found · {count('new')} new · {count('matched')} already recorded · {count('possible')} possible duplicates · {count('already_imported')} imported before{toCheck ? ` · ${toCheck} to check` : ''}{parseErrors ? ` · ${parseErrors} lines not understood` : ''}. Tap a line to leave it out{pdf ? ', or its category to change it' : ''}.</Text>
      {pdf && session ? <View style={{ marginBottom: 8 }}><Chip label={remember ? 'Remember my category choices' : 'Do not remember my choices'} active={remember} onPress={() => setRemember((v) => !v)} colors={colors} /></View> : null}
      {preview.slice(0, 200).map((p) => {
        const toggleable = p.status === 'new' || p.status === 'possible';
        const off = toggleable && skipped.has(p.row.line);
        const category = edited.get(p.row.line) ?? p.row.category;
        const flagged = p.status === 'new' && p.row.needsReview && !edited.has(p.row.line);
        return <View key={p.row.line} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 8, opacity: off ? 0.45 : 1 }}>
          <Text onPress={toggleable ? () => toggle(p.row.line) : undefined} style={{ color: colors.text }} numberOfLines={1}>{when(p.row.date)} · {p.row.direction === 'income' ? '+' : '-'}{formatPaise(Math.round(p.row.amount * 100))} · {p.row.narration}</Text>
          <Text style={{ color: flagged ? palette.expenseText : colors.muted, fontSize: 12 }}>
            {off ? 'Left out' : STATUS_TEXT[p.status]}{p.matchLabel ? ` · ${p.matchLabel}` : ''}{p.status === 'new' && category ? ` · ${p.row.direction === 'income' ? 'Income' : 'Expense'} · ${category}` : ''}{flagged ? ' · Check category' : ''}
          </Text>
          {pdf && p.status === 'new' && !off ? <Text onPress={() => setEditing(editing === p.row.line ? null : p.row.line)} accessibilityRole="button" style={{ color: palette.accentText, fontSize: 12, paddingVertical: 4 }}>{editing === p.row.line ? 'Close' : 'Change category'}</Text> : null}
          {editing === p.row.line ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 4 }}>
            {categories.filter((c) => c.type === p.row.direction).map((c) => <Chip key={c.id} label={c.name} active={category === c.name} colors={colors} onPress={() => { setEdited((prev) => new Map(prev).set(p.row.line, c.name)); setEditing(null); }} />)}
          </View> : null}
        </View>;
      })}
      {preview.length > 200 ? <Text style={{ color: colors.muted, marginTop: 8 }}>Showing the first 200 of {preview.length} lines. All will be imported.</Text> : null}
    </View> : <View>
      {busy && stage ? <Text style={{ color: colors.text, marginBottom: 12 }}>{stage}</Text> : null}
      <Text style={{ color: colors.muted, marginBottom: 12 }}>
        {pdf
          ? 'Choose a bank statement PDF with selectable text. To read it, the PDF is sent securely to your Velnora server, which returns the text and does not keep the file or the text. You see every line before anything is added. Scanned (picture) statements and password-protected PDFs are not supported.'
          : 'Choose a CSV statement downloaded from your bank. It is read on this phone, and you see every line before anything is added.'}
      </Text>
      <Button title={pdf ? 'Agree and choose PDF' : 'Choose CSV file'} onPress={() => void pick()} busy={busy} />
    </View>}
  </Sheet>;
}
