import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { palette, radius, tint } from '../../theme';
import { typo } from '../../typography';
import { ArrowDownLeft, ArrowUpRight } from '../../icons';
import { Button, CategoryIcon, Chip, EmptyBlock, Initial, Input, Labeled, SearchField, Segmented, Sheet, currencySymbol, formatPaise, type Colors, readableOn } from '../ui/common';
import { DateField } from '../ui/CalendarDatePicker';
import { Reveal, Tap } from './ProfileView';
import { TransactionCard } from './TransactionsView';
import { useProgressiveCount } from '../ui/perf';
import { aggregatePeople, personTransactions, totalsOf, type PersonAggregate } from '../services/peopleService';
import {
  createExpected, deleteExpected, isOverdue, listExpected, markSettled, outstandingPaise, recordPayment, recordPaymentWithTransaction, summarizeExpected, updateExpected,
  type ExpectedDirection, type ExpectedPayment,
} from '../services/expectedPaymentService';
import { getServiceDb, syncPendingTransactions } from '../services/transactionService';
import { normalizeMerchantKey } from '../services/merchantAliasService';
import type { CategoryView } from '../services/categoryService';
import type { Session, TransactionEntity } from '../db/types';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDue = (d: string) => fmtDate(`${d}T12:00:00`);

function Tile({ label, value, sub, color, colors, icon }: { label: string; value: string; sub?: string; color?: string; colors: Colors; icon?: React.ReactNode }) {
  const tone = color ?? colors.text;
  return <View style={{ flex: 1, minWidth: '47%', backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 14 }} accessible accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {icon ? <View style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: tint(tone, 0.12), alignItems: 'center', justifyContent: 'center' }}>{icon}</View> : null}
      <Text style={{ color: colors.muted, ...typo.caption, flex: 1 }} numberOfLines={1}>{label}</Text>
    </View>
    <Text style={{ color: tone, ...typo.amountMd, marginTop: 10 }} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    {sub ? <Text style={{ ...typo.caption, color: colors.muted, marginTop: 2 }} numberOfLines={1}>{sub}</Text> : null}
  </View>;
}

/** One person row. Memoised with a stable onOpen, so progressive list growth never re-renders rows already shown. */
const PersonRow = memo(function PersonRow({ p, last, colors, onOpen }: { p: PersonAggregate; last: boolean; colors: Colors; onOpen: (key: string) => void }) {
  return <Tap onPress={() => onOpen(p.key)} label={`${p.name}, ${p.count} transaction${p.count === 1 ? '' : 's'}`}
            style={{ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border }}>
            <Initial label={p.name} color={palette.emerald} size={40} />
            <View style={{ flex: 1, marginHorizontal: 12, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ ...typo.cardTitle, color: colors.text }}>{p.name}</Text>
              <Text numberOfLines={1} style={{ ...typo.caption, color: colors.muted, marginTop: 2 }}>{p.count} transaction{p.count === 1 ? '' : 's'} · last {fmtDate(p.lastAt)}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', flexShrink: 0, maxWidth: '40%' }}>
              {p.incomingPaise > 0 ? <Text style={{ color: palette.accentText, ...typo.amountSm }} numberOfLines={1} adjustsFontSizeToFit>+{formatPaise(p.incomingPaise)}</Text> : null}
              {p.outgoingPaise > 0 ? <Text style={{ color: palette.expenseText, ...typo.amountSm }} numberOfLines={1} adjustsFontSizeToFit>-{formatPaise(p.outgoingPaise)}</Text> : null}
            </View>
  </Tap>;
});

export function PeopleView({ transactions, categories, session, colors, refreshKey, onOpenTx, onChanged, onAddTransaction, initialTab = 'people' }: {
  transactions: TransactionEntity[]; categories: CategoryView[]; session: Session | null; colors: Colors; refreshKey: number;
  onOpenTx: (tx: TransactionEntity) => void; onChanged: () => void; onAddTransaction: () => void;
  /** Home "Expected Payment" shortcut opens the existing Expected section directly. */
  initialTab?: 'people' | 'expected';
}) {
  const scope = session?.user.id ?? null;
  const [tab, setTab] = useState<'people' | 'expected'>(initialTab);
  const [expected, setExpected] = useState<ExpectedPayment[]>([]);
  const [personKey, setPersonKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<{ edit?: ExpectedPayment; person?: string; direction?: ExpectedDirection } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => { setExpected(await listExpected(getServiceDb(), scope)); }, [scope]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const changed = async () => { await load(); onChanged(); if (session) void syncPendingTransactions(session).catch(() => undefined); };

  const people = useMemo(() => aggregatePeople(transactions), [transactions]);
  const all = useMemo(() => totalsOf(transactions), [transactions]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people), [people, q]);
  // First rows paint immediately; the rest follow in small chunks (restarts on a new search).
  const limit = useProgressiveCount(shown.length, `${q}|${people.length}`);
  const person = people.find((p) => p.key === personKey) ?? null;
  const detail = expected.find((e) => e.id === detailId) ?? null;
  const summary = useMemo(() => summarizeExpected(expected), [expected]);

  return <View>
    <View style={{ marginBottom: 14 }}><Segmented colors={colors} value={tab} onChange={setTab} options={[['people', 'People'], ['expected', `Expected${summary.receive.count + summary.pay.count ? ` (${summary.receive.count + summary.pay.count})` : ''}`]] as const} /></View>

    {tab === 'people' ? <View>
      <Reveal index={0}><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <Tile icon={<ArrowDownLeft size={16} color={palette.accentText} />} label="Received" value={formatPaise(all.incomingPaise)} sub={`${all.incomingCount} transaction${all.incomingCount === 1 ? '' : 's'}`} color={palette.accentText} colors={colors} />
        <Tile icon={<ArrowUpRight size={16} color={palette.expenseText} />} label="Paid" value={formatPaise(all.outgoingPaise)} sub={`${all.outgoingCount} transaction${all.outgoingCount === 1 ? '' : 's'}`} color={palette.expenseText} colors={colors} />
        <Tile label="Net" value={formatPaise(all.netPaise)} sub={`${people.length} ${people.length === 1 ? 'person' : 'people'}`} colors={colors} />
        <Tile label="Transactions" value={String(all.count)} sub="all time" colors={colors} />
      </View></Reveal>
      <SearchField colors={colors} value={query} onChangeText={setQuery} placeholder="Search people" accessibilityLabel="Search people" />
      {people.length === 0 ? <View><EmptyBlock title="No people yet" text="People appear here from the merchants and names on your transactions." colors={colors} /><Pressable onPress={onAddTransaction}><Text style={{ color: palette.accentText, fontWeight: '700', textAlign: 'center' }}>Add transaction</Text></Pressable></View>
        : shown.length === 0 ? <EmptyBlock title="No match" text="No one matches that search." colors={colors} />
        : <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: 14, overflow: 'hidden' }}>
          {shown.slice(0, limit).map((p, i) => <PersonRow key={p.key} p={p} last={i === shown.length - 1} colors={colors} onOpen={setPersonKey} />)}
        </View>}
    </View> : <ExpectedTab expected={expected} summary={summary} colors={colors} onAdd={() => setForm({})} onOpen={(e) => setDetailId(e.id)} />}

    <PersonSheet person={person} transactions={transactions} categories={categories} expected={expected} colors={colors} onClose={() => setPersonKey(null)} onOpenTx={onOpenTx}
      onOpenExpected={(e) => setDetailId(e.id)} onAddExpected={(name) => setForm({ person: name })} />
    <ExpectedForm state={form} people={people} scope={scope} colors={colors} onClose={() => setForm(null)} onSaved={async () => { setForm(null); await changed(); }} />
    <ExpectedDetail item={detail} scope={scope} colors={colors} onClose={() => setDetailId(null)} onChanged={changed} onEdit={(e) => { setDetailId(null); setForm({ edit: e }); }} />
  </View>;
}

function ExpectedTab({ expected, summary, colors, onAdd, onOpen }: { expected: ExpectedPayment[]; summary: ReturnType<typeof summarizeExpected>; colors: Colors; onAdd: () => void; onOpen: (e: ExpectedPayment) => void }) {
  const [filter, setFilter] = useState<'pending' | 'overdue' | 'settled' | 'all'>('pending');
  const items = expected.filter((e) => filter === 'all' || (filter === 'pending' && e.status === 'pending') || (filter === 'settled' && e.status === 'settled') || (filter === 'overdue' && isOverdue(e)));
  return <View>
    <Reveal index={0}><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
      <Tile label="To receive" value={formatPaise(summary.receive.outstandingPaise)} sub={`${summary.receive.count} pending · ${summary.receive.people} ${summary.receive.people === 1 ? 'person' : 'people'}`} color={palette.accentText} colors={colors} />
      <Tile label="To pay" value={formatPaise(summary.pay.outstandingPaise)} sub={`${summary.pay.count} pending · ${summary.pay.people} ${summary.pay.people === 1 ? 'person' : 'people'}`} color={palette.expenseText} colors={colors} />
    </View></Reveal>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
      <Chip label="Pending" active={filter === 'pending'} onPress={() => setFilter('pending')} colors={colors} />
      <Chip label={`Overdue${summary.overdueCount ? ` (${summary.overdueCount})` : ''}`} active={filter === 'overdue'} onPress={() => setFilter('overdue')} colors={colors} color={palette.danger} />
      <Chip label="Settled" active={filter === 'settled'} onPress={() => setFilter('settled')} colors={colors} />
      <Chip label="All" active={filter === 'all'} onPress={() => setFilter('all')} colors={colors} />
    </ScrollView>
    <Button title="Add expected payment" onPress={onAdd} />
    {items.length === 0 ? <EmptyBlock title={filter === 'settled' ? 'Nothing settled yet' : filter === 'overdue' ? 'Nothing overdue' : 'No expected payments'} text="Track money someone will pay you (or that you will pay), with a reason. It settles automatically when the matching payment arrives." colors={colors} />
      : items.map((e, i) => {
        const over = isOverdue(e); const recv = e.direction === 'receive'; const pct = Math.min(100, Math.floor((e.paid_paise * 100) / e.amount_paise));
        return <Reveal key={e.id} index={Math.min(i, 8) + 1}><Tap onPress={() => onOpen(e)} label={e.person} style={{ backgroundColor: colors.card, borderColor: over ? `${palette.danger}88` : colors.border, borderWidth: 1, borderRadius: 16, padding: 14, marginTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Initial label={e.person} color={recv ? palette.emerald : palette.danger} size={36} />
            <View style={{ flex: 1, marginHorizontal: 10 }}>
              <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '700' }}>{e.person}</Text>
              <Text numberOfLines={1} style={{ ...typo.caption, color: colors.muted }}>{recv ? 'Will pay you' : 'You will pay'}{e.note ? ` · ${e.note}` : ''}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: e.status === 'settled' ? colors.muted : recv ? palette.accentText : palette.expenseText, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatPaise(e.status === 'settled' ? e.amount_paise : outstandingPaise(e))}</Text>
              <Text style={{ color: over ? palette.expenseText : colors.muted, ...typo.caption, fontWeight: over ? '700' : '500' }}>{e.status === 'settled' ? `Settled ${e.settled_at ? fmtDate(e.settled_at) : ''}` : over ? `Overdue · ${fmtDue(e.due_date!)}` : e.due_date ? `Due ${fmtDue(e.due_date)}` : 'No due date'}</Text>
            </View>
          </View>
          {e.status === 'pending' && e.paid_paise > 0 ? <View style={{ marginTop: 10 }}><View style={{ height: 6, borderRadius: 3, backgroundColor: tint(palette.emerald, 0.18), overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: 6, backgroundColor: palette.emerald }} /></View><Text style={{ color: colors.muted, fontSize: 12, marginTop: 4, fontVariant: ['tabular-nums'] }}>{formatPaise(e.paid_paise)} of {formatPaise(e.amount_paise)} paid</Text></View> : null}
        </Tap></Reveal>;
      })}
  </View>;
}

function PersonSheet({ person, transactions, categories, expected, colors, onClose, onOpenTx, onOpenExpected, onAddExpected }: {
  person: PersonAggregate | null; transactions: TransactionEntity[]; categories: CategoryView[]; expected: ExpectedPayment[]; colors: Colors;
  onClose: () => void; onOpenTx: (tx: TransactionEntity) => void; onOpenExpected: (e: ExpectedPayment) => void; onAddExpected: (name: string) => void;
}) {
  const [dir, setDir] = useState<'all' | 'income' | 'expense'>('all');
  const [period, setPeriod] = useState<'all' | 'month'>('all');
  useEffect(() => { setDir('all'); setPeriod('all'); }, [person?.key]);
  const all = useMemo(() => (person ? personTransactions(transactions, person.key) : []), [person, transactions]);
  const inPeriod = useMemo(() => {
    if (period === 'all') return all;
    const now = new Date();
    return all.filter((t) => { const d = new Date(t.transaction_date); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
  }, [all, period]);
  const totals = useMemo(() => totalsOf(inPeriod), [inPeriod]);
  const list = inPeriod.filter((t) => dir === 'all' || t.direction === dir);
  const colorOf = new Map(categories.map((c) => [c.name.toLowerCase(), c.color])); const iconOf = new Map(categories.map((c) => [c.name.toLowerCase(), c.icon]));
  const theirs = person ? expected.filter((e) => e.person_key === person.key) : [];
  const owesMe = theirs.filter((e) => e.status === 'pending' && e.direction === 'receive').reduce((s, e) => s + outstandingPaise(e), 0);
  const iOwe = theirs.filter((e) => e.status === 'pending' && e.direction === 'pay').reduce((s, e) => s + outstandingPaise(e), 0);
  if (!person) return null;

  return <Sheet visible onClose={onClose} title={person.name} colors={colors}>
    <View style={{ alignItems: 'center', marginBottom: 14 }}><Initial label={person.name} color={palette.emerald} size={64} />
      <Text style={{ color: colors.muted, marginTop: 8 }}>{person.count} transaction{person.count === 1 ? '' : 's'} · since {fmtDate(all[all.length - 1]?.transaction_date ?? person.lastAt)}</Text></View>
    <View style={{ flexDirection: 'row', marginBottom: 12 }}>
      <Chip label="All time" active={period === 'all'} onPress={() => setPeriod('all')} colors={colors} />
      <Chip label="This month" active={period === 'month'} onPress={() => setPeriod('month')} colors={colors} />
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
      <Tile label="Received" value={formatPaise(totals.incomingPaise)} sub={`${totals.incomingCount} transaction${totals.incomingCount === 1 ? '' : 's'}`} color={palette.accentText} colors={colors} />
      <Tile label="Paid" value={formatPaise(totals.outgoingPaise)} sub={`${totals.outgoingCount} transaction${totals.outgoingCount === 1 ? '' : 's'}`} color={palette.expenseText} colors={colors} />
      <Tile label="Net" value={formatPaise(totals.netPaise)} sub={totals.netPaise >= 0 ? 'in your favour' : 'you paid more'} color={totals.netPaise >= 0 ? palette.accentText : palette.expenseText} colors={colors} />
      <Tile label="Total" value={String(totals.count)} sub="transactions" colors={colors} />
    </View>

    <Text style={{ color: colors.muted, ...typo.label, marginTop: 6, marginBottom: 8 }}>EXPECTED PAYMENTS</Text>
    {owesMe > 0 ? <Text style={{ color: palette.accentText, fontWeight: '700', marginBottom: 6, fontVariant: ['tabular-nums'] }}>{person.name} still owes you {formatPaise(owesMe)}</Text> : null}
    {iOwe > 0 ? <Text style={{ color: palette.expenseText, fontWeight: '700', marginBottom: 6, fontVariant: ['tabular-nums'] }}>You still owe {person.name} {formatPaise(iOwe)}</Text> : null}
    {theirs.length === 0 ? <Text style={{ color: colors.muted, marginBottom: 8 }}>Nothing expected from or to {person.name}.</Text> : theirs.map((e) => <Tap key={e.id} onPress={() => onOpenExpected(e)} label={e.person}
      style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 8 }}>
      <View style={{ flex: 1 }}><Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>{e.note || (e.direction === 'receive' ? 'Will pay you' : 'You will pay')}</Text><Text style={{ color: isOverdue(e) ? palette.expenseText : colors.muted, fontSize: 12 }}>{e.status === 'settled' ? 'Settled' : e.due_date ? `${isOverdue(e) ? 'Overdue' : 'Due'} ${fmtDue(e.due_date)}` : 'No due date'}</Text></View>
      <Text style={{ color: e.status === 'settled' ? colors.muted : e.direction === 'receive' ? palette.accentText : palette.expenseText, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatPaise(e.status === 'settled' ? e.amount_paise : outstandingPaise(e))}</Text></Tap>)}
    <Button title="Add expected payment" kind="ghost" onPress={() => onAddExpected(person.name)} />

    <Text style={{ color: colors.muted, ...typo.label, marginTop: 14, marginBottom: 8 }}>HISTORY</Text>
    <View style={{ flexDirection: 'row', marginBottom: 8 }}>
      <Chip label="All" active={dir === 'all'} onPress={() => setDir('all')} colors={colors} />
      <Chip label="Incoming" active={dir === 'income'} onPress={() => setDir('income')} colors={colors} color={palette.emerald} />
      <Chip label="Outgoing" active={dir === 'expense'} onPress={() => setDir('expense')} colors={colors} color={palette.danger} />
    </View>
    {list.length === 0 ? <EmptyBlock title="No transactions" text="Nothing matches this filter." colors={colors} /> : list.map((t) =>
      <TransactionCard key={t.id} tx={t} colors={colors} color={colorOf.get(t.category.toLowerCase()) ?? palette.navy} icon={iconOf.get(t.category.toLowerCase())} onOpen={onOpenTx} />)}
  </Sheet>;
}

function ExpectedForm({ state, people, scope, colors, onClose, onSaved }: {
  state: { edit?: ExpectedPayment; person?: string; direction?: ExpectedDirection } | null; people: PersonAggregate[]; scope: string | null; colors: Colors; onClose: () => void; onSaved: () => void;
}) {
  const [direction, setDirection] = useState<ExpectedDirection>('receive');
  const [person, setPerson] = useState(''); const [amount, setAmount] = useState(''); const [note, setNote] = useState(''); const [due, setDue] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const open = state !== null; const edit = state?.edit;
  useEffect(() => {
    if (!state) return;
    setError('');
    setDirection(edit?.direction ?? state.direction ?? 'receive'); setPerson(edit?.person ?? state.person ?? ''); setAmount(edit ? String(edit.amount_paise / 100) : '');
    setNote(edit?.note ?? ''); setDue(edit?.due_date ?? '');
  }, [state, edit]);
  const save = async () => {
    setError(''); setBusy(true);
    try {
      const rupees = Number(amount);
      if (!Number.isFinite(rupees) || rupees <= 0) throw new Error('Enter an amount greater than zero.');
      const db = getServiceDb(); const amountPaise = Math.round(rupees * 100);
      if (edit) await updateExpected(db, scope, edit.id, { person, amountPaise, note, dueDate: due.trim() || null });
      else await createExpected(db, scope, { person, amountPaise, note, dueDate: due.trim() || null, direction });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  return <Sheet visible={open} onClose={onClose} title={edit ? 'Edit expected payment' : 'New expected payment'} colors={colors}>
    {!edit ? <Labeled label="WHO PAYS WHOM" colors={colors}><View style={{ flexDirection: 'row' }}>
      <Chip label="They will pay me" active={direction === 'receive'} onPress={() => setDirection('receive')} colors={colors} color={palette.emerald} />
      <Chip label="I will pay them" active={direction === 'pay'} onPress={() => setDirection('pay')} colors={colors} color={palette.danger} /></View></Labeled> : null}
    <Labeled label="PERSON" colors={colors}>
      <Input colors={colors} value={person} onChangeText={setPerson} placeholder="Name" maxLength={80} />
      {!edit && people.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>{people.slice(0, 8).map((p) => <Chip key={p.key} label={p.name} active={normalizeMerchantKey(person) === p.key} onPress={() => setPerson(p.name)} colors={colors} />)}</ScrollView> : null}
    </Labeled>
    <Labeled label={`AMOUNT (${currencySymbol()})`} colors={colors}><Input colors={colors} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" /></Labeled>
    <Labeled label="REASON / NOTE (OPTIONAL)" colors={colors}><Input colors={colors} value={note} onChangeText={setNote} placeholder="e.g. Dinner split, loan, rent share" maxLength={200} /></Labeled>
    <Labeled label="EXPECTED BY (OPTIONAL)" colors={colors} hint="Tap to pick a date. Leave empty if there's no date.">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}><DateField value={due || null} onChange={(ymd) => setDue(ymd)} colors={colors} title="Expected by" placeholder="Select date (optional)" /></View>
        {due ? <Pressable onPress={() => setDue('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear date" style={{ padding: 6 }}><Text style={{ color: colors.muted, fontSize: 20, lineHeight: 20 }}>×</Text></Pressable> : null}
      </View>
    </Labeled>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
    <Button title={edit ? 'Save changes' : 'Add'} onPress={() => void save()} busy={busy} />
  </Sheet>;
}

function ExpectedDetail({ item, scope, colors, onClose, onChanged, onEdit }: { item: ExpectedPayment | null; scope: string | null; colors: Colors; onClose: () => void; onChanged: () => Promise<void>; onEdit: (e: ExpectedPayment) => void }) {
  const [amount, setAmount] = useState(''); const [asTx, setAsTx] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (item) { setAmount(String(outstandingPaise(item) / 100)); setError(''); setAsTx(true); } }, [item?.id, item?.paid_paise]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!item) return null;
  const recv = item.direction === 'receive'; const left = outstandingPaise(item); const over = isOverdue(item);
  const run = async (fn: () => Promise<unknown>) => { setError(''); setBusy(true); try { await fn(); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); } finally { setBusy(false); } };
  const pay = () => run(async () => {
    const rupees = Number(amount); if (!Number.isFinite(rupees) || rupees <= 0) throw new Error('Enter an amount greater than zero.');
    const paise = Math.round(rupees * 100); const db = getServiceDb();
    if (asTx) await recordPaymentWithTransaction(db, scope, item.id, { amountPaise: paise }); else await recordPayment(db, scope, item.id, { amountPaise: paise });
  });
  return <Sheet visible onClose={onClose} title={item.person} colors={colors}>
    <Text style={{ ...typo.amountLg, fontSize: 30, color: item.status === 'settled' ? colors.muted : recv ? palette.accentText : palette.expenseText, fontVariant: ['tabular-nums'] }}>{formatPaise(item.status === 'settled' ? item.amount_paise : left)}</Text>
    <Text style={{ color: colors.muted, marginBottom: 12 }}>{item.status === 'settled' ? `Settled${item.settled_at ? ` on ${fmtDate(item.settled_at)}` : ''}` : recv ? `still to receive from ${item.person}` : `still to pay to ${item.person}`}</Text>
    {item.note ? <View style={{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 12 }}><Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600' }}>REASON</Text><Text style={{ color: colors.text, marginTop: 4 }}>{item.note}</Text></View> : null}
    <Text style={{ color: colors.muted, marginBottom: 4, fontVariant: ['tabular-nums'] }}>Total {formatPaise(item.amount_paise)} · paid {formatPaise(item.paid_paise)}</Text>
    <Text style={{ color: over ? palette.expenseText : colors.muted, fontWeight: over ? '700' : '500', marginBottom: 12 }}>{item.due_date ? `${over ? 'Overdue since' : 'Expected by'} ${fmtDue(item.due_date)}` : 'No due date'}</Text>

    {item.status === 'pending' ? <View style={{ marginBottom: 8 }}>
      <Labeled label={recv ? 'RECORD A PAYMENT RECEIVED' : 'RECORD A PAYMENT MADE'} colors={colors}><Input colors={colors} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" /></Labeled>
      <Pressable onPress={() => setAsTx(!asTx)} accessibilityRole="checkbox" accessibilityState={{ checked: asTx }} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: palette.emerald, backgroundColor: asTx ? palette.emerald : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>{asTx ? <Text style={{ color: readableOn(palette.emerald), fontWeight: '700' }}>✓</Text> : null}</View>
        <Text style={{ color: colors.text, flex: 1 }}>Also add it as a {recv ? 'income' : 'expense'} transaction</Text></Pressable>
      <Button title="Record payment" onPress={() => void pay()} busy={busy} />
      <Button title="Mark as fully paid" kind="ghost" onPress={() => void run(() => markSettled(getServiceDb(), scope, item.id))} disabled={busy} />
    </View> : null}
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}

    {item.payments.length ? <View style={{ marginTop: 8 }}><Text style={{ color: colors.muted, ...typo.label, marginBottom: 6 }}>PAYMENTS</Text>
      {item.payments.map((p, i) => <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {recv ? <ArrowDownLeft size={16} color={palette.emerald} /> : <ArrowUpRight size={16} color={palette.danger} />}
        <Text style={{ flex: 1, color: colors.text, marginLeft: 8 }}>{fmtDate(p.at)}{p.transaction_id ? ' · linked to a transaction' : ' · recorded by hand'}</Text>
        <Text style={{ color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatPaise(p.amount_paise)}</Text></View>)}</View> : null}

    <Button title="Edit" kind="ghost" onPress={() => onEdit(item)} />
    <Button title="Delete" kind="danger" onPress={() => Alert.alert('Delete this?', 'Linked transactions are not deleted.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { void run(async () => { await deleteExpected(getServiceDb(), scope, item.id); onClose(); }); } }])} />
  </Sheet>;
}
void CategoryIcon;
