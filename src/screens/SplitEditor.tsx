import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { palette, radius, tint } from '../../theme';
import { Button, Initial, Input, Segmented, Sheet, formatPaise, type Colors } from '../ui/common';
import { hapticLight, hapticSuccess } from '../ui/haptics';
import { getServiceDb } from '../services/transactionService';
import { SELF, SplitError, type SplitMode } from '../services/splitMath';
import { draftFromSplit, emptyDraft, evaluateDraft, setGroup, toggleParticipant, type DraftEvaluation, type SplitDraft } from '../services/splitDraft';
import { contactLabels, createContact, listContacts, listGroups, type Contact, type SplitExpense, type SplitExpenseInput, type SplitGroup } from '../services/splitService';

/** Honest, calm copy about where split data lives (it is local only for now). */
export const SPLIT_LOCAL_NOTE = 'Splits are stored on this device only for now.';

export interface SplitController {
  draft: SplitDraft;
  setDraft: (d: SplitDraft | ((d: SplitDraft) => SplitDraft)) => void;
  contacts: Contact[];
  groups: SplitGroup[];
  /** Errors stay hidden until the person tries to save once. The save button itself is never disabled. */
  attempted: boolean;
  markAttempted: () => void;
  reset: (d?: SplitDraft) => void;
  addPerson: (name: string, phone: string) => Promise<Contact>;
}

/** State for one split form. `active` is when its sheet is open (people and groups are read then). */
export function useSplitDraft(scope: string | null, active: boolean): SplitController {
  const [draft, setDraft] = useState<SplitDraft>(emptyDraft());
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<SplitGroup[]>([]);
  const [attempted, setAttempted] = useState(false);
  const reload = useCallback(async () => {
    const db = getServiceDb();
    const [c, g] = await Promise.all([listContacts(db, scope), listGroups(db, scope)]);
    setContacts(c); setGroups(g);
  }, [scope]);
  useEffect(() => { if (active) void reload().catch(() => undefined); }, [active, reload]);
  const reset = useCallback((d?: SplitDraft) => { setDraft(d ?? emptyDraft()); setAttempted(false); }, []);
  const addPerson = useCallback(async (name: string, phone: string) => {
    const c = await createContact(getServiceDb(), scope, { name, phone });
    await reload();
    setDraft((d) => toggleParticipant(d, c.id));
    return c;
  }, [scope, reload]);
  return { draft, setDraft, contacts, groups, attempted, markAttempted: () => setAttempted(true), reset, addPerson };
}

const MODES: readonly (readonly [SplitMode, string])[] = [['equal', 'Equal'], ['exact', 'Exact'], ['percent', '%'], ['shares', 'Shares']];

function PersonChip({ label, active, onPress, colors, trailing }: { label: string; active: boolean; onPress: () => void; colors: Colors; trailing?: string }) {
  return <Pressable onPress={() => { hapticLight(); onPress(); }} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${label}${active ? ', selected' : ''}`}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingLeft: 6, paddingRight: 12, marginRight: 8, marginBottom: 8, borderRadius: 22, borderWidth: 1.5,
      borderColor: active ? palette.emerald : colors.border, backgroundColor: active ? tint(palette.emerald, 0.14) : colors.card, opacity: pressed ? 0.8 : 1, minHeight: 40 })}>
    <Initial label={label} color={active ? palette.accentText : colors.muted} size={26} />
    <Text numberOfLines={1} style={{ color: colors.text, fontWeight: active ? '700' : '500', maxWidth: 150 }}>{label}</Text>
    {trailing ? <Text style={{ color: colors.muted, fontSize: 12 }}>{trailing}</Text> : null}
  </Pressable>;
}

export function AddPerson({ onAdd, colors }: { onAdd: (name: string, phone: string) => Promise<unknown>; colors: Colors }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  if (!open) return <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Add a new person"
    style={({ pressed }) => ({ paddingVertical: 8, paddingHorizontal: 14, marginBottom: 8, borderRadius: 22, borderWidth: 1.5, borderStyle: 'dashed', borderColor: palette.emerald, minHeight: 40, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
    <Text style={{ color: palette.accentText, fontWeight: '700' }}>+ New person</Text>
  </Pressable>;
  const submit = async () => {
    setBusy(true); setError('');
    try { await onAdd(name, phone); setName(''); setPhone(''); setOpen(false); }
    catch (e) { setError(e instanceof SplitError ? e.message : 'Could not add this person.'); }
    finally { setBusy(false); }
  };
  return <View style={{ width: '100%', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 12, marginBottom: 8 }}>
    <Input colors={colors} value={name} onChangeText={(t) => { setName(t); setError(''); }} placeholder="Name" autoCapitalize="words" maxLength={80} accessibilityLabel="Person name" />
    <View style={{ height: 8 }} />
    <Input colors={colors} value={phone} onChangeText={(t) => { setPhone(t); setError(''); }} placeholder="Phone (optional, stays on this device)" keyboardType="phone-pad" maxLength={20} accessibilityLabel="Phone number" />
    {error ? <Text style={{ color: palette.expenseText, marginTop: 6, fontSize: 12 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
      <View style={{ flex: 1 }}><Button title="Cancel" kind="ghost" onPress={() => { setOpen(false); setError(''); }} disabled={busy} /></View>
      <View style={{ flex: 1 }}><Button title="Add" onPress={() => void submit()} busy={busy} /></View>
    </View>
  </View>;
}

const Caption = ({ children, colors }: { children: string; colors: Colors }) => <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8, marginTop: 14 }}>{children}</Text>;

/**
 * The split form: who shares the cost, who paid, how to divide it, live amounts per person and what it counts as in the owner's
 * spending. Controlled by `useSplitDraft`; evaluation (and every rule) lives in services/splitDraft.ts.
 */
export function SplitFields({ split, totalPaise, colors, payerLocked }: { split: SplitController; totalPaise: number | null; colors: Colors; /** A linked bank payment was paid by the owner, so the payer cannot be changed. */ payerLocked?: boolean }) {
  const { draft, setDraft, contacts, groups, attempted } = split;
  const labels = useMemo(() => { const m = contactLabels(contacts); m.set(SELF, 'You'); return m; }, [contacts]);
  const evaluation: DraftEvaluation = useMemo(() => evaluateDraft(draft, totalPaise), [draft, totalPaise]);
  const nameOf = (id: string) => labels.get(id) ?? 'Removed person';
  const shareOf = (id: string) => evaluation.perPerson.find((p) => p.party === id)?.sharePaise ?? null;
  const chosenGroup = groups.find((g) => g.id === draft.groupId) ?? null;
  const people: string[] = [SELF, ...(chosenGroup ? chosenGroup.memberIds : contacts.map((c) => c.id))];
  const unit = draft.mode === 'exact' ? '₹' : draft.mode === 'percent' ? '%' : '×';
  const rem = evaluation.remaining;

  return <View>
    {groups.length ? <>
      <Caption colors={colors}>GROUP</Caption>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <PersonChip label="No group" active={!draft.groupId} onPress={() => setDraft((d) => setGroup(d, null, []))} colors={colors} />
        {groups.map((g) => <PersonChip key={g.id} label={g.name} active={draft.groupId === g.id} onPress={() => setDraft((d) => setGroup(d, g.id, g.memberIds))} colors={colors} trailing={`${g.memberIds.length + 1}`} />)}
      </ScrollView>
    </> : null}

    <Caption colors={colors}>SPLIT WITH</Caption>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {people.map((id) => <PersonChip key={id} label={nameOf(id)} active={draft.participants.includes(id)} onPress={() => setDraft((d) => toggleParticipant(d, id))} colors={colors} />)}
      {!chosenGroup ? <AddPerson onAdd={split.addPerson} colors={colors} /> : null}
    </View>

    {payerLocked ? <Text style={{ color: colors.muted, marginTop: 14 }}>Paid by <Text style={{ color: colors.text, fontWeight: '700' }}>You</Text>, from this payment.</Text> : <>
    <Caption colors={colors}>PAID BY</Caption>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {[SELF, ...draft.participants.filter((p) => p !== SELF)].map((id) => <PersonChip key={id} label={nameOf(id)} active={draft.payer === id} onPress={() => setDraft((d) => ({ ...d, payer: id }))} colors={colors} />)}
    </ScrollView></>}
    {draft.payer !== SELF ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{nameOf(draft.payer)} paid, so no payment of yours is recorded. Your share still counts as your spending.</Text> : null}

    <Caption colors={colors}>HOW TO SPLIT</Caption>
    <Segmented colors={colors} value={draft.mode} onChange={(mode) => { hapticLight(); setDraft((d) => ({ ...d, mode, values: {} })); }} options={MODES} />

    <View style={{ marginTop: 12, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingHorizontal: 12 }}>
      {draft.participants.length === 0 ? <Text style={{ color: colors.muted, paddingVertical: 14 }}>Choose who to split with.</Text> : draft.participants.map((id, i) => {
        const share = shareOf(id);
        return <View key={id} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, borderBottomWidth: i === draft.participants.length - 1 ? 0 : 1, borderBottomColor: colors.border }}>
          <Initial label={nameOf(id)} color={palette.emerald} size={32} />
          <Text numberOfLines={1} style={{ color: colors.text, flex: 1, marginHorizontal: 10, fontWeight: '600' }}>{nameOf(id)}</Text>
          {draft.mode !== 'equal' ? <View style={{ width: 86, marginRight: 10 }}>
            <Input colors={colors} value={draft.values[id] ?? ''} onChangeText={(t) => setDraft((d) => ({ ...d, values: { ...d.values, [id]: t } }))}
              keyboardType={draft.mode === 'shares' ? 'number-pad' : 'decimal-pad'} placeholder={unit} maxLength={12} accessibilityLabel={`${nameOf(id)} ${draft.mode === 'exact' ? 'amount' : draft.mode === 'percent' ? 'percent' : 'shares'}`}
              style={{ minHeight: 40, textAlign: 'right', paddingHorizontal: 8 }} />
          </View> : null}
          <Text style={{ color: share === null ? colors.muted : colors.text, fontWeight: '700', minWidth: 74, textAlign: 'right', fontVariant: ['tabular-nums'] }} numberOfLines={1} adjustsFontSizeToFit>
            {share === null ? '—' : formatPaise(share)}
          </Text>
        </View>;
      })}
    </View>

    {rem ? <Text style={{ marginTop: 8, fontWeight: '600', color: rem.amount === 0 ? palette.accentText : palette.expenseText }} accessibilityLiveRegion="polite">
      {rem.unit === 'paise'
        ? rem.amount === 0 ? 'Adds up to the total' : rem.amount > 0 ? `${formatPaise(rem.amount)} left to assign` : `${formatPaise(-rem.amount)} over the total`
        : rem.amount === 0 ? 'Adds up to 100%' : rem.amount > 0 ? `${(rem.amount / 100).toFixed(2).replace(/\.?0+$/, '')}% left to assign` : `${(-rem.amount / 100).toFixed(2).replace(/\.?0+$/, '')}% over 100`}
    </Text> : null}
    {attempted && evaluation.error ? <Text style={{ marginTop: 8, color: palette.expenseText }} accessibilityLiveRegion="polite">{evaluation.error}</Text> : null}
    {evaluation.zeroShare.length ? <Text style={{ marginTop: 8, color: colors.muted, fontSize: 12 }}>
      This amount is too small to give everyone a paisa: {evaluation.zeroShare.map(nameOf).join(', ')} {evaluation.zeroShare.length === 1 ? 'gets' : 'get'} {formatPaise(0)}.
    </Text> : null}

    {evaluation.ok ? <View style={{ marginTop: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: tint(palette.emerald, 0.12) }}>
      <Text style={{ color: colors.text }}>Counts as <Text style={{ fontWeight: '700', color: palette.accentText }}>{formatPaise(evaluation.ownSharePaise ?? 0)}</Text> in your spending</Text>
    </View> : null}
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 10 }}>{SPLIT_LOCAL_NOTE}</Text>
  </View>;
}

/** The "Split with others" switch plus the fields below it, for the Add sheet. */
export function SplitSection({ split, totalPaise, colors }: { split: SplitController; totalPaise: number | null; colors: Colors }) {
  const { draft, setDraft } = split;
  return <View style={{ marginTop: 18, marginBottom: 6 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15 }}>Split with others</Text>
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>Share this expense with friends. Only your share counts in your spending.</Text>
      </View>
      <Switch value={draft.enabled} onValueChange={(enabled) => { hapticLight(); setDraft((d) => ({ ...d, enabled })); }} accessibilityLabel="Split with others"
        trackColor={{ true: palette.emerald, false: colors.border }} thumbColor="#FFFFFF" />
    </View>
    {draft.enabled ? <SplitFields split={split} totalPaise={totalPaise} colors={colors} /> : null}
  </View>;
}

/**
 * A sheet for splitting an EXISTING transaction ("Split this"), editing its split, or re-entering the exact amounts after the
 * transaction's amount changed. It only builds the validated input; `onSubmit` decides what to save.
 */
export function SplitSheet({ visible, onClose, scope, title, totalPaise, existing, startFresh, reentryNote, lockPayer = true, colors, onSubmit, onRemove }: {
  visible: boolean; onClose: () => void; scope: string | null; title: string; totalPaise: number; existing: SplitExpense | null;
  /** Open with Exact mode and empty amounts (used when the amount changed and the exact split must be entered again). */
  startFresh?: boolean; reentryNote?: string; colors: Colors;
  /** True for a split on one of the owner's own payments (they paid). False for an expense a friend paid, where the payer can change. */
  lockPayer?: boolean;
  onSubmit: (input: Pick<SplitExpenseInput, 'mode' | 'participants' | 'payers' | 'groupId'>) => Promise<void>; onRemove?: () => void;
}) {
  const split = useSplitDraft(scope, visible);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    setError(''); setBusy(false);
    if (existing) { const d = lockPayer ? { ...draftFromSplit(existing), payer: SELF } : draftFromSplit(existing); split.reset(startFresh ? { ...d, mode: 'exact', values: {} } : d); }
    else split.reset({ ...emptyDraft(), enabled: true });
  }, [visible, existing?.id, startFresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const evaluation = evaluateDraft(split.draft, totalPaise);

  const save = async () => {
    if (busy) return;
    if (!evaluation.ok || !evaluation.input) { split.markAttempted(); setError(evaluation.error ?? 'Check the split.'); return; }
    setBusy(true); setError('');
    try { await onSubmit({ ...evaluation.input, groupId: split.draft.groupId }); hapticSuccess(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the split.'); }
    finally { setBusy(false); }
  };

  return <Sheet visible={visible} onClose={onClose} title={existing && !startFresh ? 'Edit split' : 'Split this'} colors={colors} footer={<>
    {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }} accessibilityLiveRegion="polite">{error}</Text> : null}
    <Button title="Save split" onPress={() => void save()} busy={busy} />
    {existing && onRemove && !startFresh ? <View style={{ marginTop: 8 }}><Button title="Remove split" kind="ghost" onPress={onRemove} disabled={busy} /></View> : null}
  </>}>
    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>{title}</Text>
    <Text style={{ color: colors.muted, marginTop: 2 }}>Total <Text style={{ color: colors.text, fontWeight: '700' }}>{formatPaise(totalPaise)}</Text></Text>
    {reentryNote ? <Text style={{ color: palette.amber, marginTop: 8 }}>{reentryNote}</Text> : null}
    <SplitFields split={split} totalPaise={totalPaise} colors={colors} payerLocked={lockPayer} />
  </Sheet>;
}
