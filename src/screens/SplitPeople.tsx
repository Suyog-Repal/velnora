import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { palette, radius, tint } from '../../theme';
import { Button, Chip, Initial, Input, Labeled, SearchField, Sheet, formatPaise, type Colors } from '../ui/common';
import { hapticLight, hapticSuccess } from '../ui/haptics';
import { showToast } from '../ui/Toast';
import { Reveal } from './ProfileView';
import { AddPerson, SPLIT_LOCAL_NOTE, SplitSheet } from './SplitEditor';
import { SettleSheet, type SettleTarget } from './SettleSheet';
import { getServiceDb } from '../services/transactionService';
import { SELF, SplitError } from '../services/splitMath';
import {
  addGroupMember, archiveGroup, createContact, createGroup, deleteContact, deleteGroup, deleteSplitExpense, listSplitExpenses, recordSettlement, removeGroupMember, unarchiveGroup,
  updateContact, updateSplitExpense, type Contact, type SplitExpense, type SplitGroup,
} from '../services/splitService';
import { balanceWord, buildFriendDetail, buildGroupDetail, loadOverview, type GroupRow, type Ledger, type Overview } from '../services/splitOverview';
import type { ExpectedPayment } from '../services/expectedPaymentService';
import { outstandingPaise } from '../services/expectedPaymentService';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const messageOf = (e: unknown, fallback: string) => (e instanceof SplitError || e instanceof Error ? e.message : fallback);

export interface SplitData { overview: Overview; ledger: Ledger; allGroups: SplitGroup[]; allContacts: Contact[] }

/** Reads the whole split picture for the People tab. Reloads when `refreshKey` changes (any save elsewhere in the app). */
export function useSplitData(scope: string | null, refreshKey: number) {
  const [data, setData] = useState<SplitData | null>(null);
  const reload = useCallback(async () => { setData(await loadOverview(getServiceDb(), scope)); }, [scope]);
  useEffect(() => { void reload().catch(() => undefined); }, [reload, refreshKey]);
  return { data, reload };
}

// ------------------------------------------------------------------------------------------------------- small pieces
/** "You're owed Rs X" / "You owe Rs X" / "You're all settled up", with the two parts underneath when both exist. */
export function BalanceCard({ netPaise, owedPaise, owePaise, caption, colors }: { netPaise: number; owedPaise: number; owePaise: number; caption?: string; colors: Colors }) {
  const tone = netPaise > 0 ? palette.accentText : netPaise < 0 ? palette.expenseText : colors.text;
  const headline = netPaise > 0 ? `You're owed ${formatPaise(netPaise)}` : netPaise < 0 ? `You owe ${formatPaise(-netPaise)}` : "You're all settled up";
  return <View accessible accessibilityLabel={headline} style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 16 }}>
    {caption ? <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 }}>{caption}</Text> : null}
    <Text style={{ color: tone, fontSize: 24, fontWeight: '700', marginTop: caption ? 6 : 0, fontVariant: ['tabular-nums'] }} numberOfLines={1} adjustsFontSizeToFit>{headline}</Text>
    {owedPaise > 0 && owePaise > 0 ? <Text style={{ color: colors.muted, marginTop: 4 }}>{formatPaise(owedPaise)} owed to you · {formatPaise(owePaise)} you owe</Text> : null}
  </View>;
}

function BalanceText({ balancePaise, colors }: { balancePaise: number; colors: Colors }) {
  const w = balanceWord(balancePaise);
  const color = w === 'owes_you' ? palette.accentText : w === 'you_owe' ? palette.expenseText : colors.muted;
  return <View style={{ alignItems: 'flex-end', flexShrink: 0, maxWidth: '45%' }}>
    {w !== 'settled' ? <Text style={{ color, fontWeight: '700', fontVariant: ['tabular-nums'] }} numberOfLines={1} adjustsFontSizeToFit>{formatPaise(Math.abs(balancePaise))}</Text> : null}
    <Text style={{ color: w === 'settled' ? colors.muted : color, fontSize: 12 }}>{w === 'owes_you' ? 'owes you' : w === 'you_owe' ? 'you owe' : 'settled up'}</Text>
  </View>;
}

function Row({ label, caption, balancePaise, colors, onPress, last, extra }: { label: string; caption: string; balancePaise: number; colors: Colors; onPress?: () => void; last?: boolean; extra?: string }) {
  return <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={`${label}, ${balanceWord(balancePaise) === 'settled' ? 'settled up' : `${balanceWord(balancePaise) === 'owes_you' ? 'owes you' : 'you owe'} ${formatPaise(Math.abs(balancePaise))}`}`}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border, opacity: pressed ? 0.7 : 1 })}>
    <Initial label={label} color={palette.emerald} size={40} />
    <View style={{ flex: 1, marginHorizontal: 12, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '700', fontSize: 15 }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{caption}</Text>
      {extra ? <Text numberOfLines={1} style={{ color: palette.info, fontSize: 12, marginTop: 1 }}>{extra}</Text> : null}
    </View>
    <BalanceText balancePaise={balancePaise} colors={colors} />
  </Pressable>;
}

const Card = ({ children, colors, style }: { children: React.ReactNode; colors: Colors; style?: object }) =>
  <View style={[{ backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: 14, overflow: 'hidden' }, style]}>{children}</View>;

const Section = ({ children, colors }: { children: string; colors: Colors }) => <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginTop: 18, marginBottom: 8 }}>{children}</Text>;

/** An invitation, not an apology: what you can do, and one button to start. */
function Invite({ title, text, action, onAction, colors }: { title: string; text: string; action: string; onAction: () => void; colors: Colors }) {
  return <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
    <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: tint(palette.emerald, 0.14), alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 26, color: palette.accentText }}>+</Text></View>
    <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 14, textAlign: 'center' }}>{title}</Text>
    <Text style={{ color: colors.muted, marginTop: 6, textAlign: 'center', marginBottom: 16 }}>{text}</Text>
    <View style={{ alignSelf: 'stretch' }}><Button title={action} onPress={onAction} /></View>
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 12, textAlign: 'center' }}>{SPLIT_LOCAL_NOTE}</Text>
  </View>;
}

// ------------------------------------------------------------------------------------------------------ friend form
function FriendForm({ visible, edit, scope, colors, onClose, onSaved }: { visible: boolean; edit: Contact | null; scope: string | null; colors: Colors; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [upi, setUpi] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setName(edit?.name ?? ''); setPhone(edit?.phone ?? ''); setUpi(edit?.upi_id ?? ''); setError(''); setBusy(false); } }, [visible, edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true); setError('');
    try {
      const db = getServiceDb();
      if (edit) await updateContact(db, scope, edit.id, { name, phone, upiId: upi }); else await createContact(db, scope, { name, phone, upiId: upi });
      hapticSuccess(); onSaved(); onClose();
    } catch (e) { setError(messageOf(e, 'Could not save.')); } finally { setBusy(false); }
  };
  return <Sheet visible={visible} onClose={onClose} title={edit ? 'Edit friend' : 'Add a friend'} colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    <Button title={edit ? 'Save changes' : 'Add friend'} onPress={() => void save()} busy={busy} />
  </>}>
    <Labeled label="NAME" colors={colors}><Input colors={colors} value={name} onChangeText={(t) => { setName(t); setError(''); }} placeholder="e.g. Rohan" autoCapitalize="words" maxLength={80} accessibilityLabel="Name" /></Labeled>
    <Labeled label="PHONE (OPTIONAL)" colors={colors} hint="Used only to open a WhatsApp chat when you remind them. Stays on this device.">
      <Input colors={colors} value={phone} onChangeText={(t) => { setPhone(t); setError(''); }} placeholder="+91 98765 43210" keyboardType="phone-pad" maxLength={20} accessibilityLabel="Phone number" />
    </Labeled>
    <Labeled label="THEIR UPI ID (OPTIONAL)" colors={colors} hint="For paying them back. Stays on this device.">
      <Input colors={colors} value={upi} onChangeText={(t) => { setUpi(t); setError(''); }} placeholder="name@bank" autoCapitalize="none" autoCorrect={false} maxLength={80} accessibilityLabel="UPI ID" />
    </Labeled>
    <Text style={{ color: colors.muted, fontSize: 12 }}>Friends are just entries in your own ledger. They do not need Velnora. {SPLIT_LOCAL_NOTE}</Text>
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------------ expense detail
function ExpenseSheet({ expense, labels, scope, colors, onClose, onChanged }: { expense: SplitExpense | null; labels: Map<string, string>; scope: string | null; colors: Colors; onClose: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [expense?.id]);
  if (!expense) return null;
  const name = (id: string) => labels.get(id) ?? 'Removed person';
  const linked = !!expense.transaction_id;
  const payers = expense.rows.filter((r) => r.paidPaise > 0);
  const remove = () => Alert.alert(linked ? 'Remove split?' : 'Delete expense?',
    linked ? 'The split is removed and the payment counts in full in your spending again. Payments you recorded stay.' : 'This removes the expense and changes everyone\'s balance. Payments you recorded stay.', [
      { text: 'Cancel', style: 'cancel' },
      { text: linked ? 'Remove' : 'Delete', style: 'destructive', onPress: () => { void deleteSplitExpense(getServiceDb(), scope, expense.id).then(() => { onChanged(); onClose(); }); } },
    ]);
  return <>
    <Sheet visible={!editing} onClose={onClose} title={expense.title} colors={colors}>
      <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatPaise(expense.total_paise)}</Text>
      <Text style={{ color: colors.muted, marginTop: 2 }}>{fmtDate(expense.expense_date)} · {expense.category} · {payers.length ? `paid by ${payers.map((p) => name(p.party)).join(' and ')}` : ''}</Text>
      <Section colors={colors}>WHO OWES WHAT</Section>
      <Card colors={colors}>
        {expense.rows.map((r, i) => <View key={r.party} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderBottomWidth: i === expense.rows.length - 1 ? 0 : 1, borderBottomColor: colors.border }}>
          <Initial label={name(r.party)} color={palette.emerald} size={32} />
          <View style={{ flex: 1, marginHorizontal: 10 }}>
            <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{name(r.party)}</Text>
            {r.paidPaise > 0 ? <Text style={{ color: colors.muted, fontSize: 12 }}>paid {formatPaise(r.paidPaise)}</Text> : null}
          </View>
          <Text style={{ color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatPaise(r.sharePaise)}</Text>
        </View>)}
      </Card>
      {expense.note ? <Text style={{ color: colors.muted, marginTop: 12 }}>{expense.note}</Text> : null}
      {linked ? <Text style={{ color: colors.muted, marginTop: 12, fontSize: 12 }}>This is linked to a payment of yours. Change its amount, date or category from Transactions; the split follows.</Text> : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        {!linked ? <View style={{ flex: 1 }}><Button title="Edit split" kind="ghost" onPress={() => setEditing(true)} /></View> : null}
        <View style={{ flex: 1 }}><Button title={linked ? 'Remove split' : 'Delete'} kind="danger" onPress={remove} /></View>
      </View>
    </Sheet>
    {!linked ? <SplitSheet visible={editing} onClose={() => setEditing(false)} scope={scope} title={expense.title} totalPaise={expense.total_paise} existing={expense} lockPayer={false} colors={colors}
      onSubmit={async (input) => {
        await updateSplitExpense(getServiceDb(), scope, expense.id, { ...input, title: expense.title, category: expense.category, expenseDate: expense.expense_date, totalPaise: expense.total_paise, note: expense.note });
        setEditing(false); onChanged(); onClose();
      }} /> : null}
  </>;
}

function ExpenseRows({ expenses, labels, colors, onOpen }: { expenses: SplitExpense[]; labels: Map<string, string>; colors: Colors; onOpen: (e: SplitExpense) => void }) {
  if (!expenses.length) return <Text style={{ color: colors.muted, paddingVertical: 14 }}>No expenses yet.</Text>;
  return <Card colors={colors}>
    {expenses.map((e, i) => {
      const mine = e.rows.find((r) => r.party === SELF)?.sharePaise ?? 0;
      const payers = e.rows.filter((r) => r.paidPaise > 0).map((r) => labels.get(r.party) ?? 'Removed person');
      return <Pressable key={e.id} onPress={() => onOpen(e)} accessibilityRole="button" accessibilityLabel={`${e.title}, ${formatPaise(e.total_paise)}`}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingVertical: 10, borderBottomWidth: i === expenses.length - 1 ? 0 : 1, borderBottomColor: colors.border, opacity: pressed ? 0.7 : 1 })}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '700' }}>{e.title}</Text>
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{fmtDate(e.expense_date)} · {payers.length ? `${payers.join(' and ')} paid` : 'no payer'}</Text>
        </View>
        <View style={{ alignItems: 'flex-end', marginLeft: 10 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatPaise(e.total_paise)}</Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>your share {formatPaise(mine)}</Text>
        </View>
      </Pressable>;
    })}
  </Card>;
}

// ------------------------------------------------------------------------------------------------------- friend sheet
function FriendSheet({ friendId, data, expected, scope, colors, onClose, onChanged, onEdit, onSettle, onOpenExpense, onOpenExpected }: {
  friendId: string | null; data: SplitData; expected: ExpectedPayment[]; scope: string | null; colors: Colors; onClose: () => void; onChanged: () => void;
  onEdit: (c: Contact) => void; onSettle: (t: SettleTarget) => void; onOpenExpense: (e: SplitExpense) => void; onOpenExpected: (e: ExpectedPayment) => void;
}) {
  const [expenses, setExpenses] = useState<SplitExpense[]>([]);
  const friend = data.overview.friends.find((f) => f.contact.id === friendId) ?? null;
  useEffect(() => {
    if (!friendId) return;
    let live = true;
    void listSplitExpenses(getServiceDb(), scope, { limit: 500 }).then((all) => { if (live) setExpenses(all.filter((e) => e.rows.some((r) => r.party === friendId)).slice(0, 12)); }).catch(() => undefined);
    return () => { live = false; };
  }, [friendId, scope, data]);
  if (!friend) return null;
  const detail = buildFriendDetail(friend.contact.id, data.allGroups, data.ledger);
  const pending = expected.filter((e) => e.status === 'pending' && e.person_key === friend.contact.name_key);
  const confirmDelete = () => Alert.alert('Delete friend?', `${friend.label} is removed from your friends. Past expenses keep their name.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { void deleteContact(getServiceDb(), scope, friend.contact.id).then(() => { onChanged(); onClose(); }).catch((e) => Alert.alert('Cannot delete yet', messageOf(e, 'Could not delete.'))); } },
  ]);
  return <Sheet visible onClose={onClose} title={friend.label} colors={colors}>
    <BalanceCard netPaise={friend.balancePaise} owedPaise={Math.max(0, friend.balancePaise)} owePaise={Math.max(0, -friend.balancePaise)} colors={colors} />
    {friend.contact.phone || friend.contact.upi_id ? <Text style={{ color: colors.muted, marginTop: 8, fontSize: 12 }}>{[friend.contact.phone, friend.contact.upi_id].filter(Boolean).join(' · ')}  (stays on this device)</Text> : null}
    <View style={{ marginTop: 12 }}><Button title={friend.balancePaise === 0 ? 'Record a payment' : friend.balancePaise > 0 ? 'Settle up' : 'Pay back'} kind={friend.balancePaise === 0 ? 'ghost' : 'primary'}
      onPress={() => onSettle({ id: friend.contact.id, label: friend.label, balancePaise: friend.balancePaise })} /></View>

    {detail.scopes.length > 1 || (detail.scopes[0] && detail.scopes[0].groupId) ? <>
      <Section colors={colors}>WHERE IT ADDS UP</Section>
      <Card colors={colors}>{detail.scopes.map((s, i) => <View key={s.groupId ?? 'none'} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, borderBottomWidth: i === detail.scopes.length - 1 ? 0 : 1, borderBottomColor: colors.border }}>
        <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>{s.groupName ?? 'Outside groups'}</Text>
        <BalanceText balancePaise={s.balancePaise} colors={colors} />
      </View>)}</Card>
    </> : null}

    {pending.length ? <>
      <Section colors={colors}>EXPECTED PAYMENTS</Section>
      <Card colors={colors}>{pending.map((e, i) => <Pressable key={e.id} onPress={() => { onClose(); onOpenExpected(e); }} accessibilityRole="button" accessibilityLabel={`Expected payment ${formatPaise(outstandingPaise(e))}`}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderBottomWidth: i === pending.length - 1 ? 0 : 1, borderBottomColor: colors.border, opacity: pressed ? 0.7 : 1 })}>
        <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>{e.direction === 'receive' ? 'Will pay you' : 'You will pay'}{e.note ? ` · ${e.note}` : ''}</Text>
        <Text style={{ color: e.direction === 'receive' ? palette.accentText : palette.expenseText, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatPaise(outstandingPaise(e))}</Text>
      </Pressable>)}</Card>
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>Expected payments are tracked separately and do not change the split balance above.</Text>
    </> : null}

    <Section colors={colors}>SHARED EXPENSES</Section>
    <ExpenseRows expenses={expenses} labels={data.overview.labels} colors={colors} onOpen={onOpenExpense} />

    <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
      <View style={{ flex: 1 }}><Button title="Edit" kind="ghost" onPress={() => onEdit(friend.contact)} /></View>
      <View style={{ flex: 1 }}><Button title="Delete" kind="danger" onPress={confirmDelete} /></View>
    </View>
  </Sheet>;
}

// ------------------------------------------------------------------------------------------------------- group create
function CreateGroupSheet({ visible, friends, scope, colors, onClose, onCreated }: { visible: boolean; friends: Contact[]; scope: string | null; colors: Colors; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState(''); const [picked, setPicked] = useState<string[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState<Contact[]>([]);
  useEffect(() => { if (visible) { setName(''); setPicked([]); setError(''); setBusy(false); setExtra([]); } }, [visible]);
  const all = [...friends, ...extra.filter((c) => !friends.some((f) => f.id === c.id))];
  const toggle = (id: string) => { hapticLight(); setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); setError(''); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (picked.length === 0) throw new SplitError('Add at least one friend to the group.');
      await createGroup(getServiceDb(), scope, { name, memberIds: picked });
      hapticSuccess(); onCreated(); onClose();
    } catch (e) { setError(messageOf(e, 'Could not create the group.')); } finally { setBusy(false); }
  };
  return <Sheet visible={visible} onClose={onClose} title="New group" colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    <Button title="Create group" onPress={() => void save()} busy={busy} />
  </>}>
    <Labeled label="GROUP NAME" colors={colors}><Input colors={colors} value={name} onChangeText={(t) => { setName(t); setError(''); }} placeholder="e.g. Goa trip" autoCapitalize="words" maxLength={80} accessibilityLabel="Group name" /></Labeled>
    <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 }}>MEMBERS</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {all.map((c) => <Chip key={c.id} label={c.name} active={picked.includes(c.id)} onPress={() => toggle(c.id)} colors={colors} />)}
    </View>
    <AddPerson colors={colors} onAdd={async (n, p) => { const c = await createContact(getServiceDb(), scope, { name: n, phone: p }); setExtra((x) => [...x, c]); setPicked((x) => [...x, c.id]); onCreated(); }} />
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>You are always in the group. {SPLIT_LOCAL_NOTE}</Text>
  </Sheet>;
}

// -------------------------------------------------------------------------------------------------------- group sheet
function GroupSheet({ groupId, data, scope, colors, onClose, onChanged, onSettle, onAddExpense, onOpenExpense }: {
  groupId: string | null; data: SplitData; scope: string | null; colors: Colors; onClose: () => void; onChanged: () => void;
  onSettle: (t: SettleTarget) => void; onAddExpense: (g: SplitGroup) => void; onOpenExpense: (e: SplitExpense) => void;
}) {
  const [expenses, setExpenses] = useState<SplitExpense[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [manage, setManage] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const group = data.allGroups.find((g) => g.id === groupId) ?? null;
  useEffect(() => { setShowAll(false); setManage(false); setShowPlan(false); }, [groupId]);
  useEffect(() => {
    if (!groupId) return;
    let live = true;
    void listSplitExpenses(getServiceDb(), scope, { groupId, limit: showAll ? 200 : 6 }).then((l) => { if (live) setExpenses(l); }).catch(() => undefined);
    return () => { live = false; };
  }, [groupId, scope, data, showAll]);
  const detail = useMemo(() => (group ? buildGroupDetail(group, data.overview.labels, data.ledger) : null), [group, data]);
  if (!group || !detail) return null;
  const archived = !!group.archived_at;
  const labels = data.overview.labels;
  const fail = (title: string) => (e: unknown) => Alert.alert(title, messageOf(e, 'Something went wrong.'));
  const nonMembers = data.overview.friends.filter((f) => !group.memberIds.includes(f.contact.id));

  const recordPlan = async (from: string, to: string, paise: number) => {
    try { await recordSettlement(getServiceDb(), scope, { from, to, amountPaise: paise, groupId: group.id }); hapticSuccess(); onChanged(); }
    catch (e) { fail('Could not record')(e); }
  };
  const confirmDelete = () => Alert.alert('Delete group?', `"${group.name}" and its expenses are removed. This only works once everyone is settled up.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { void deleteGroup(getServiceDb(), scope, group.id).then(() => { onChanged(); onClose(); }).catch(fail('Cannot delete yet')); } },
  ]);
  const toggleArchive = () => {
    const run = archived ? unarchiveGroup(getServiceDb(), scope, group.id) : archiveGroup(getServiceDb(), scope, group.id);
    void run.then(() => { onChanged(); if (!archived) onClose(); }).catch(fail('Cannot archive yet'));
  };

  return <Sheet visible onClose={onClose} title={group.name} colors={colors} footer={archived ? undefined : <Button title="Add expense" onPress={() => onAddExpense(group)} />}>
    <Text style={{ color: colors.muted, marginBottom: 10 }}>{group.memberIds.length + 1} members{archived ? ' · archived' : ''}</Text>
    <BalanceCard netPaise={detail.netPaise} owedPaise={detail.owedToMePaise} owePaise={detail.iOwePaise} colors={colors} />

    <Section colors={colors}>MEMBERS</Section>
    <Card colors={colors}>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderBottomWidth: detail.members.length ? 1 : 0, borderBottomColor: colors.border }}>
        <Initial label="You" color={palette.info} size={32} /><Text style={{ color: colors.text, marginLeft: 10, fontWeight: '600' }}>You</Text>
      </View>
      {detail.members.map((m, i) => <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}><Row label={m.label} caption={manage ? 'tap Remove to take out of the group' : balanceWord(m.balancePaise) === 'settled' ? 'settled up' : 'tap to settle up'} balancePaise={m.balancePaise} colors={colors} last={i === detail.members.length - 1}
          onPress={manage || archived ? undefined : () => onSettle({ id: m.id, label: m.label, balancePaise: m.balancePaise, groupId: group.id })} /></View>
        {manage ? <Pressable onPress={() => { void removeGroupMember(getServiceDb(), scope, group.id, m.id).then(onChanged).catch(fail('Cannot remove yet')); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${m.label}`}><Text style={{ color: palette.expenseText, fontWeight: '700', paddingLeft: 8 }}>Remove</Text></Pressable> : null}
      </View>)}
    </Card>
    {!archived ? <View style={{ marginTop: 10 }}><Button title={manage ? 'Done' : 'Manage members'} kind="ghost" onPress={() => setManage((v) => !v)} /></View> : null}
    {manage && !archived ? <View style={{ marginTop: 10 }}>
      {nonMembers.length ? <><Text style={{ color: colors.muted, fontSize: 12, marginBottom: 6 }}>Add a friend to this group</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{nonMembers.map((f) => <Chip key={f.contact.id} label={`+ ${f.label}`} active={false} colors={colors} onPress={() => { void addGroupMember(getServiceDb(), scope, group.id, f.contact.id).then(onChanged).catch(fail('Could not add')); }} />)}</View></> : null}
      <AddPerson colors={colors} onAdd={async (n, p) => { const c = await createContact(getServiceDb(), scope, { name: n, phone: p }); await addGroupMember(getServiceDb(), scope, group.id, c.id); onChanged(); }} />
    </View> : null}

    {detail.simplify.beforeCount > 0 ? <>
      <Section colors={colors}>SIMPLIFY DEBTS</Section>
      <Card colors={colors} style={{ paddingVertical: 14 }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }} accessibilityLabel={`${detail.simplify.beforeCount} payments can become ${detail.simplify.afterCount}`}>
          {detail.simplify.beforeCount} {detail.simplify.beforeCount === 1 ? 'payment' : 'payments'}  →  {detail.simplify.afterCount}
        </Text>
        <Text style={{ color: colors.muted, marginTop: 4 }}>{detail.simplify.afterCount < detail.simplify.beforeCount ? `Everyone can settle with ${detail.simplify.afterCount} instead of ${detail.simplify.beforeCount}.` : 'Already as simple as it gets.'}</Text>
        {!archived ? <View style={{ marginTop: 10 }}><Button title={showPlan ? 'Hide payments' : 'Show the payments'} kind="ghost" onPress={() => setShowPlan((v) => !v)} /></View> : null}
        {showPlan ? detail.simplify.after.map((p, i) => <View key={`${p.from}-${p.to}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, borderTopWidth: 1, borderTopColor: colors.border, marginTop: i === 0 ? 10 : 0 }}>
          <Text style={{ color: colors.text, flex: 1 }} numberOfLines={2}>{labels.get(p.from) ?? 'Removed person'} pays {labels.get(p.to) ?? 'Removed person'} <Text style={{ fontWeight: '700' }}>{formatPaise(p.paise)}</Text></Text>
          <Pressable onPress={() => void recordPlan(p.from, p.to, p.paise)} accessibilityRole="button" accessibilityLabel={`Record ${labels.get(p.from)} pays ${labels.get(p.to)} ${formatPaise(p.paise)}`} hitSlop={8}>
            <Text style={{ color: palette.accentText, fontWeight: '700', paddingLeft: 10 }}>Record</Text>
          </Pressable>
        </View>) : null}
      </Card>
    </> : null}

    <Section colors={colors}>RECENT EXPENSES</Section>
    {expenses.length === 0 && !archived ? <Invite title="Split your first expense" text="Add an expense to this group and Velnora keeps track of who owes what." action="Add expense" onAction={() => onAddExpense(group)} colors={colors} />
      : <ExpenseRows expenses={expenses} labels={labels} colors={colors} onOpen={onOpenExpense} />}
    {!showAll && expenses.length >= 6 ? <Pressable onPress={() => setShowAll(true)} accessibilityRole="button"><Text style={{ color: palette.accentText, fontWeight: '700', textAlign: 'center', paddingVertical: 12 }}>Show all expenses</Text></Pressable> : null}

    <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
      <View style={{ flex: 1 }}><Button title={archived ? 'Unarchive' : 'Archive'} kind="ghost" onPress={toggleArchive} /></View>
      <View style={{ flex: 1 }}><Button title="Delete group" kind="danger" onPress={confirmDelete} /></View>
    </View>
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 10 }}>A group can be archived or deleted once everyone is settled up. {SPLIT_LOCAL_NOTE}</Text>
  </Sheet>;
}

// ----------------------------------------------------------------------------------------------------------- the tabs
export function SplitPeople({ tab, scope, colors, refreshKey, onChanged, expected, onGoExpected, onOpenExpected, onAddSplit }: {
  tab: 'friends' | 'groups'; scope: string | null; colors: Colors; refreshKey: number; onChanged: () => void;
  expected: ExpectedPayment[]; onGoExpected: () => void; onOpenExpected: (e: ExpectedPayment) => void;
  /** Opens the Add sheet with the split switched on (and a group chosen, when given). */
  onAddSplit: (group: SplitGroup | null) => void;
}) {
  const { data, reload } = useSplitData(scope, refreshKey);
  const [query, setQuery] = useState('');
  const [friendId, setFriendId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [friendForm, setFriendForm] = useState<{ edit: Contact | null } | null>(null);
  const [newGroup, setNewGroup] = useState(false);
  const [settle, setSettle] = useState<SettleTarget | null>(null);
  const [expense, setExpense] = useState<SplitExpense | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const changed = useCallback(async () => { await reload(); onChanged(); }, [reload, onChanged]);

  const pendingExpected = useMemo(() => {
    let receive = 0; let pay = 0;
    for (const e of expected) if (e.status === 'pending') { if (e.direction === 'receive') receive += outstandingPaise(e); else pay += outstandingPaise(e); }
    return { receive, pay };
  }, [expected]);

  if (!data) return <View style={{ paddingVertical: 40 }}><Text style={{ color: colors.muted, textAlign: 'center' }}>Loading…</Text></View>;
  const o = data.overview;
  const q = query.trim().toLowerCase();
  const friends = q ? o.friends.filter((f) => f.label.toLowerCase().includes(q)) : o.friends;
  const expectedFor = (c: Contact) => expected.filter((e) => e.status === 'pending' && e.person_key === c.name_key).reduce((s, e) => s + (e.direction === 'receive' ? outstandingPaise(e) : -outstandingPaise(e)), 0);

  const summary = <Reveal index={0}><View style={{ marginBottom: 14 }}>
    <BalanceCard netPaise={o.netPaise} owedPaise={o.owedToMePaise} owePaise={o.iOwePaise} caption="SPLIT BALANCE" colors={colors} />
    {pendingExpected.receive + pendingExpected.pay > 0 ? <Pressable onPress={onGoExpected} accessibilityRole="button" style={({ pressed }) => ({ marginTop: 8, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ color: colors.text }}>Expected payments · <Text style={{ color: palette.accentText, fontWeight: '700' }}>{formatPaise(pendingExpected.receive)}</Text> to receive · <Text style={{ color: palette.expenseText, fontWeight: '700' }}>{formatPaise(pendingExpected.pay)}</Text> to pay</Text>
      <Text style={{ color: palette.accentText, fontSize: 12, marginTop: 2 }}>Tracked separately from splits. Tap to open.</Text>
    </Pressable> : null}
  </View></Reveal>;

  return <View>
    {summary}
    {tab === 'friends' ? <>
      {o.friends.length === 0
        ? <Invite title="Split your first expense" text="Add a friend, then split any expense with them. They do not need Velnora." action="Add a friend" onAction={() => setFriendForm({ edit: null })} colors={colors} />
        : <>
          {o.friends.length > 6 ? <SearchField colors={colors} value={query} onChangeText={setQuery} placeholder="Search friends" accessibilityLabel="Search friends" /> : null}
          <Card colors={colors} style={{ marginTop: o.friends.length > 6 ? 10 : 0 }}>
            {friends.length === 0 ? <Text style={{ color: colors.muted, paddingVertical: 16 }}>No friend matches that search.</Text> : friends.map((f, i) => {
              const exp = expectedFor(f.contact);
              return <Reveal key={f.contact.id} index={Math.min(i, 8) + 1}><Row label={f.label} caption={f.contact.phone ? 'phone saved' : 'tap to open'} balancePaise={f.balancePaise} colors={colors} last={i === friends.length - 1}
                extra={exp !== 0 ? `${formatPaise(Math.abs(exp))} expected ${exp > 0 ? 'from' : 'to'} them` : undefined} onPress={() => setFriendId(f.contact.id)} /></Reveal>;
            })}
          </Card>
          <View style={{ marginTop: 14, gap: 10 }}>
            <Button title="Split an expense" onPress={() => onAddSplit(null)} />
            <Button title="Add a friend" kind="ghost" onPress={() => setFriendForm({ edit: null })} />
          </View>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 12, textAlign: 'center' }}>{SPLIT_LOCAL_NOTE}</Text>
        </>}
    </> : <>
      {o.groups.length === 0 && o.archivedGroups.length === 0
        ? <Invite title="Make a group for a trip or a flat" text="Keep every shared expense in one place and see who owes whom." action="Create a group" onAction={() => setNewGroup(true)} colors={colors} />
        : <>
          <Card colors={colors}>
            {(o.groups.length === 0 ? <Text style={{ color: colors.muted, paddingVertical: 16 }}>No active groups.</Text> : null)}
            {o.groups.map((g, i) => <Reveal key={g.group.id} index={Math.min(i, 8) + 1}><GroupListRow g={g} colors={colors} last={i === o.groups.length - 1} onOpen={() => setGroupId(g.group.id)} /></Reveal>)}
          </Card>
          <View style={{ marginTop: 14 }}><Button title="New group" onPress={() => setNewGroup(true)} /></View>
          {o.archivedGroups.length ? <>
            <Pressable onPress={() => setShowArchived((v) => !v)} accessibilityRole="button" style={{ paddingVertical: 14 }}><Text style={{ color: palette.accentText, fontWeight: '700', textAlign: 'center' }}>{showArchived ? 'Hide' : 'Show'} archived ({o.archivedGroups.length})</Text></Pressable>
            {showArchived ? <Card colors={colors}>{o.archivedGroups.map((g, i) => <GroupListRow key={g.group.id} g={g} colors={colors} last={i === o.archivedGroups.length - 1} onOpen={() => setGroupId(g.group.id)} />)}</Card> : null}
          </> : null}
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 12, textAlign: 'center' }}>{SPLIT_LOCAL_NOTE}</Text>
        </>}
    </>}

    <FriendForm visible={!!friendForm} edit={friendForm?.edit ?? null} scope={scope} colors={colors} onClose={() => setFriendForm(null)} onSaved={() => void changed()} />
    <CreateGroupSheet visible={newGroup} friends={o.friends.map((f) => f.contact)} scope={scope} colors={colors} onClose={() => setNewGroup(false)} onCreated={() => void changed()} />
    {friendId ? <FriendSheet friendId={friendId} data={data} expected={expected} scope={scope} colors={colors} onClose={() => setFriendId(null)} onChanged={() => void changed()}
      onEdit={(c) => { setFriendId(null); setFriendForm({ edit: c }); }} onSettle={setSettle} onOpenExpense={setExpense} onOpenExpected={onOpenExpected} /> : null}
    {groupId ? <GroupSheet groupId={groupId} data={data} scope={scope} colors={colors} onClose={() => setGroupId(null)} onChanged={() => void changed()} onSettle={setSettle}
      onAddExpense={(g) => { setGroupId(null); onAddSplit(g); }} onOpenExpense={setExpense} /> : null}
    <SettleSheet visible={!!settle} onClose={() => setSettle(null)} scope={scope} target={settle} colors={colors} onDone={() => void changed()} />
    <ExpenseSheet expense={expense} labels={o.labels} scope={scope} colors={colors} onClose={() => setExpense(null)} onChanged={() => void changed()} />
  </View>;
}

function GroupListRow({ g, colors, last, onOpen }: { g: GroupRow; colors: Colors; last: boolean; onOpen: () => void }) {
  return <Row label={g.group.name} caption={`${g.memberCount} members${g.group.archived_at ? ' · archived' : ''}`} balancePaise={g.netPaise} colors={colors} last={last} onPress={onOpen} />;
}
