/**
 * What the People tab shows (friends, groups, group detail, simplify preview) and settling with a friend across groups.
 * Every figure is checked against hand-worked numbers.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import type { IDatabase } from '../../db/types.ts';
import { createExpected } from '../expectedPaymentService.ts';
import { SELF, SplitError } from '../splitMath.ts';
import { allocateFriendPayment, balanceWord, buildFriendDetail, buildGroupDetail, loadOverview } from '../splitOverview.ts';
import { settleWithFriend } from '../splitSettle.ts';
import {
  archiveGroup, createContact, createGroup, createSplitExpense, deleteContact, deleteGroup, expectedForContact, getBalancesWithMe, listGroups, listSettlements, recordSettlement,
  type SplitExpenseInput,
} from '../splitService.ts';

let passed = 0;
const test = async (name: string, fn: (db: IDatabase) => Promise<void>) => {
  const db = new NodeSqliteAdapter() as unknown as IDatabase; await runMigrations(db);
  await fn(db); passed += 1; console.log(`✓ ${name}`);
};
const eq = (over: Partial<SplitExpenseInput> & Pick<SplitExpenseInput, 'totalPaise' | 'participants' | 'payers'>): SplitExpenseInput =>
  ({ title: 'Dinner', category: 'Food & Dining', expenseDate: new Date().toISOString(), mode: 'equal', ...over });
const rejectsSplit = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof SplitError && re.test(e.message));
const me = (n: number) => ({ party: SELF, paidPaise: n });

/** Goa trip (Asha, Bala, Chitra) + a flat-bills side debt with Asha only. Worked out by hand in the comments. */
async function world(db: IDatabase) {
  const a = await createContact(db, null, { name: 'Asha' }); const b = await createContact(db, null, { name: 'Bala' }); const c = await createContact(db, null, { name: 'Chitra' });
  const goa = await createGroup(db, null, { name: 'Goa trip', memberIds: [a.id, b.id, c.id] });
  // I paid Rs 1200 for 4 (300 each): Asha, Bala, Chitra each owe me 300
  await createSplitExpense(db, null, eq({ groupId: goa.id, totalPaise: 120000, participants: [{ party: SELF }, { party: a.id }, { party: b.id }, { party: c.id }], payers: [me(120000)] }));
  // Bala paid Rs 800 for me, Bala and Chitra (266.67 / 266.67 / 266.66 with the extra paisa to the first): I owe Bala 26667, Chitra owes Bala 26666
  await createSplitExpense(db, null, eq({ groupId: goa.id, totalPaise: 80000, participants: [{ party: SELF }, { party: b.id }, { party: c.id }], payers: [{ party: b.id, paidPaise: 80000 }] }));
  // outside groups: Asha paid Rs 500 for her and me: I owe Asha 250
  await createSplitExpense(db, null, eq({ totalPaise: 50000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: a.id, paidPaise: 50000 }] }));
  return { a, b, c, goa };
}

await test('overview: friends and groups with hand-worked balances, and the overall total', async (db) => {
  const { a, b, c, goa } = await world(db);
  const { overview } = await loadOverview(db, null);
  const bal = (id: string) => overview.friends.find((f) => f.contact.id === id)!.balancePaise;
  assert.equal(bal(a.id), 30000 - 25000, 'Asha owes me 300 in Goa, I owe her 250 outside: net 50');
  assert.equal(bal(b.id), 30000 - 26667, 'Bala owes me 300, I owe him 266.67: net 33.33');
  assert.equal(bal(c.id), 30000, 'Chitra owes me 300');
  assert.equal(overview.owedToMePaise, 5000 + 3333 + 30000); assert.equal(overview.iOwePaise, 0);
  assert.equal(overview.netPaise, 38333);
  const g = overview.groups.find((x) => x.group.id === goa.id)!;
  assert.equal(g.memberCount, 4); assert.equal(g.netPaise, 63333, 'owed 300 x3 minus the 266.67 I owe Bala');
  assert.deepEqual(overview.friends.map((f) => f.label), ['Chitra', 'Asha', 'Bala'], 'biggest balance first');
});

await test('empty and settled states', async (db) => {
  let { overview } = await loadOverview(db, null);
  assert.deepEqual([overview.friends.length, overview.groups.length, overview.netPaise], [0, 0, 0]);
  const a = await createContact(db, null, { name: 'Asha' });
  ({ overview } = await loadOverview(db, null));
  assert.equal(overview.friends[0].balancePaise, 0); assert.equal(balanceWord(0), 'settled');
  assert.equal(balanceWord(5), 'owes_you'); assert.equal(balanceWord(-5), 'you_owe');
  assert.ok(a);
});

await test('group detail: members, my balance card, simplify before/after, settled flag', async (db) => {
  const { a, b, c, goa } = await world(db);
  const { overview, ledger, allGroups, } = await loadOverview(db, null);
  const group = allGroups.find((g) => g.id === goa.id)!;
  const d = buildGroupDetail(group, overview.labels, ledger);
  assert.deepEqual(d.members.map((m) => [m.label, m.balancePaise]), [['Asha', 30000], ['Chitra', 30000], ['Bala', 3333]]);
  assert.equal(d.netPaise, 63333);
  assert.equal(d.owedToMePaise, 30000 + 30000 + 3333); assert.equal(d.iOwePaise, 0);
  assert.equal(d.settled, false);
  // 4 pairs owe each other (Asha->me, Bala->me net 33.33, Chitra->me, Chitra->Bala 266.66); the nets need only 3 payments
  assert.equal(d.simplify.beforeCount, 4); assert.equal(d.simplify.afterCount, 3);
  assert.ok(a && b && c);
});

await test('simplify preview shows the 5-to-3 style reduction with real payments that net the same', async (db) => {
  const [p, q, r, s] = await Promise.all(['P', 'Q', 'R', 'S'].map((n) => createContact(db, null, { name: n })));
  const g = await createGroup(db, null, { name: 'Flat', memberIds: [p.id, q.id, r.id, s.id] });
  const owe = (from: string, to: string, n: number) => createSplitExpense(db, null, eq({ groupId: g.id, mode: 'exact', totalPaise: n, participants: [{ party: from, value: n }], payers: [{ party: to, paidPaise: n }] }));
  await owe(p.id, q.id, 1000); await owe(q.id, r.id, 1000); await owe(r.id, s.id, 1000); await owe(p.id, s.id, 500); await owe(q.id, s.id, 500);
  const { overview, ledger, allGroups } = await loadOverview(db, null);
  const d = buildGroupDetail(allGroups[0], overview.labels, ledger);
  assert.equal(d.simplify.beforeCount, 5);
  assert.ok(d.simplify.afterCount <= 3, `after: ${d.simplify.afterCount}`);
  const total = d.simplify.after.reduce((x, y) => x + y.paise, 0);
  assert.ok(total <= d.simplify.before.reduce((x, y) => x + y.paise, 0));
});

await test('friend detail splits the balance by group and outside groups', async (db) => {
  const { a, goa } = await world(db);
  const { ledger, allGroups } = await loadOverview(db, null);
  const d = buildFriendDetail(a.id, allGroups, ledger);
  assert.equal(d.balancePaise, 5000);
  assert.deepEqual(d.scopes.map((s) => [s.groupName, s.balancePaise]), [['Goa trip', 30000], [null, -25000]]);
  assert.ok(goa);
});

await test('allocation: the payment shrinks each place it is owed, largest first; surplus flips outside groups', async () => {
  const scopes = [{ groupId: 'g1', groupName: 'Goa', balancePaise: 30000 }, { groupId: null, groupName: null, balancePaise: 10000 }, { groupId: 'g2', groupName: 'Flat', balancePaise: -4000 }];
  assert.deepEqual(allocateFriendPayment(scopes, 'they_pay', 35000), [{ groupId: 'g1', paise: 30000 }, { groupId: null, paise: 5000 }]);
  assert.deepEqual(allocateFriendPayment(scopes, 'they_pay', 5000), [{ groupId: 'g1', paise: 5000 }]);
  assert.deepEqual(allocateFriendPayment(scopes, 'they_pay', 45000), [{ groupId: 'g1', paise: 30000 }, { groupId: null, paise: 15000 }], 'surplus 5000 added outside groups');
  assert.deepEqual(allocateFriendPayment(scopes, 'i_pay', 4000), [{ groupId: 'g2', paise: 4000 }]);
  assert.deepEqual(allocateFriendPayment([], 'they_pay', 700), [{ groupId: null, paise: 700 }], 'nothing owed: it is simply recorded');
  assert.equal(allocateFriendPayment(scopes, 'they_pay', 45000).reduce((s, x) => s + x.paise, 0), 45000);
});

await test('settling with a friend: group balance and friend balance shrink together', async (db) => {
  const { a, goa } = await world(db);
  // Asha owes me 300 in Goa; I owe her 250 outside. Net 50. She pays me 50 (the netted amount).
  const made = await settleWithFriend(db, null, a.id, 'they_pay', 5000);
  assert.deepEqual(made.map((s) => [s.group_id, s.amount_paise]), [[goa.id, 5000]]);
  const { overview } = await loadOverview(db, null);
  assert.equal(overview.friends.find((f) => f.contact.id === a.id)!.balancePaise, 0, 'friend balance is settled');
  const { overview: o2, ledger, allGroups } = await loadOverview(db, null);
  const g = buildGroupDetail(allGroups.find((x) => x.id === goa.id)!, o2.labels, ledger);
  assert.equal(g.members.find((m) => m.label === 'Asha')!.balancePaise, 30000 - 5000, 'and the group view reduced by the same payment');
  // a full, multi-scope settlement: now Asha owes 250 in Goa and I owe 250 outside: friend balance 0 means nothing to pay.
  await rejectsSplit(settleWithFriend(db, null, a.id, 'they_pay', 0), /greater than zero/);
  await rejectsSplit(settleWithFriend(db, null, 'ghost', 'they_pay', 5), /not found/);
});

await test('settling across scopes in one go; overpaying flips the direction; all or nothing', async (db) => {
  const a = await createContact(db, null, { name: 'Asha' });
  const g1 = await createGroup(db, null, { name: 'Goa', memberIds: [a.id] }); const g2 = await createGroup(db, null, { name: 'Flat', memberIds: [a.id] });
  await createSplitExpense(db, null, eq({ groupId: g1.id, totalPaise: 20000, participants: [{ party: SELF }, { party: a.id }], payers: [me(20000)] })); // Asha owes 100 in Goa
  await createSplitExpense(db, null, eq({ groupId: g2.id, totalPaise: 10000, participants: [{ party: SELF }, { party: a.id }], payers: [me(10000)] })); // Asha owes 50 in Flat
  await createSplitExpense(db, null, eq({ totalPaise: 6000, participants: [{ party: SELF }, { party: a.id }], payers: [me(6000)] })); // 30 outside
  const made = await settleWithFriend(db, null, a.id, 'they_pay', 15000); // pays 150: Goa 100 then Flat 50
  assert.equal(made.length, 2); assert.equal(made.reduce((s, m) => s + m.amount_paise, 0), 15000);
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(a.id), 3000, 'only the 30 outside groups is left');
  await settleWithFriend(db, null, a.id, 'they_pay', 4000);
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(a.id), -1000, 'paid 10 too much: now I owe her 10');
  assert.equal((await listSettlements(db, null)).length, 3);
  assert.equal((await listSettlements(db, null)).every((s) => s.from_party === a.id && s.to_party === SELF), true);
  await settleWithFriend(db, null, a.id, 'i_pay', 1000);
  assert.equal((await getBalancesWithMe(db, null)).perParty.size, 0);
});

await test('deleting a friend or group is blocked until settled, then allowed', async (db) => {
  const { a, goa, b, c } = await world(db);
  await rejectsSplit(deleteContact(db, null, a.id), /unsettled/);
  await rejectsSplit(deleteGroup(db, null, goa.id), /unsettled/);
  await rejectsSplit(archiveGroup(db, null, goa.id), /unsettled/);
  // settle everything in the group: Asha 300, Chitra 300, Bala nets 33.33, plus Chitra->Bala 266.66 stays between them
  await recordSettlement(db, null, { from: a.id, to: SELF, amountPaise: 30000, groupId: goa.id });
  await recordSettlement(db, null, { from: c.id, to: SELF, amountPaise: 30000, groupId: goa.id });
  await recordSettlement(db, null, { from: b.id, to: SELF, amountPaise: 3333, groupId: goa.id });
  await rejectsSplit(archiveGroup(db, null, goa.id), /unsettled/); // Chitra still owes Bala 266.66 inside the group
  await recordSettlement(db, null, { from: c.id, to: b.id, amountPaise: 26666, groupId: goa.id });
  await archiveGroup(db, null, goa.id);
  assert.equal((await listGroups(db, null)).length, 0, 'archived groups are hidden from the normal list');
  const { overview } = await loadOverview(db, null);
  assert.equal(overview.archivedGroups.length, 1); assert.equal(overview.groups.length, 0);
});

await test('legacy Expected rows stay visible next to a friend (matched by name, untouched)', async (db) => {
  const a = await createContact(db, null, { name: 'Asha' });
  await createExpected(db, null, { person: 'ASHA', amountPaise: 75000, note: 'rent share' });
  await createExpected(db, null, { person: 'Someone else', amountPaise: 100 });
  const found = await expectedForContact(db, null, a);
  assert.equal(found.length, 1); assert.equal(found[0].amount_paise, 75000);
  assert.equal((await loadOverview(db, null)).overview.friends[0].balancePaise, 0, 'Expected is separate: it does not change split balances');
});

await test('two friends with one name are two rows, labelled so they can be told apart; deleted friends keep their name in history', async (db) => {
  const r1 = await createContact(db, null, { name: 'Rohan', phone: '+919800000001' }); const r2 = await createContact(db, null, { name: 'Rohan', phone: '+919800000002' });
  await createSplitExpense(db, null, eq({ totalPaise: 1000, participants: [{ party: SELF }, { party: r1.id }], payers: [me(1000)] }));
  await recordSettlement(db, null, { from: r1.id, to: SELF, amountPaise: 500 });
  const { overview } = await loadOverview(db, null);
  assert.deepEqual(overview.friends.map((f) => f.label).sort(), ['Rohan (…0001)', 'Rohan (…0002)']);
  await deleteContact(db, null, r2.id);
  const after = await loadOverview(db, null);
  assert.equal(after.overview.friends.length, 1);
  assert.equal(after.overview.labels.get(r2.id), 'Rohan (…0002)', 'still resolvable for history');
});

console.log(`${passed} passed`);
