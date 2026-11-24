/** The split form's rules: parsing, live per-person amounts, inline errors, and what counts as the owner's spending. */
import assert from 'node:assert/strict';
import { SELF } from '../splitMath.ts';
import { draftFromSplit, emptyDraft, evaluateDraft, paiseToInput, parseMoneyToPaise, setGroup, toggleParticipant, type SplitDraft } from '../splitDraft.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`✓ ${name}`); };
const draft = (over: Partial<SplitDraft> = {}): SplitDraft => ({ ...emptyDraft(), enabled: true, participants: [SELF, 'a', 'b'], ...over });

test('money parsing: Indian grouping, 2 decimals max, no junk', () => {
  assert.equal(parseMoneyToPaise('1,25,000'), 12_500_000);
  assert.equal(parseMoneyToPaise('₹ 450.5'), 45050);
  assert.equal(parseMoneyToPaise('0.07'), 7);
  assert.equal(parseMoneyToPaise('12.345'), null); assert.equal(parseMoneyToPaise('abc'), null); assert.equal(parseMoneyToPaise('-5'), null); assert.equal(parseMoneyToPaise(''), null);
  assert.equal(paiseToInput(45050), '450.50'); assert.equal(paiseToInput(45000), '450');
});

test('equal: live amounts, my own share, and the paid-by-me flag', () => {
  const e = evaluateDraft(draft(), 100000);
  assert.ok(e.ok); assert.deepEqual(e.perPerson.map((p) => p.sharePaise), [33334, 33333, 33333]);
  assert.equal(e.ownSharePaise, 33334); assert.equal(e.paidByMe, true);
  assert.deepEqual(e.input!.payers, [{ party: SELF, paidPaise: 100000 }]);
});

test('a friend paid: I still owe my share, and no payment of mine is implied', () => {
  const e = evaluateDraft(draft({ payer: 'a' }), 90000);
  assert.ok(e.ok); assert.equal(e.paidByMe, false); assert.equal(e.ownSharePaise, 30000);
});

test('paid for others only: my own share is 0', () => {
  const e = evaluateDraft(draft({ participants: ['a', 'b'] }), 90000);
  assert.ok(e.ok); assert.equal(e.ownSharePaise, 0);
});

test('inline errors, in order: amount, people, only me', () => {
  assert.equal(evaluateDraft(draft(), null).error, 'Enter the amount first.');
  assert.equal(evaluateDraft(draft({ participants: [] }), 100).error, 'Choose at least one person to split with.');
  assert.equal(evaluateDraft(emptyDraft(), 100).error, 'Add at least one other person to split with.');
  assert.equal(evaluateDraft(draft(), 100).ok, true);
});

test('exact: shows what is left to assign; errors until it adds up', () => {
  let e = evaluateDraft(draft({ mode: 'exact', values: { me: '300', a: '300' } }), 100000);
  assert.equal(e.ok, false); assert.match(e.error!, /Enter an amount for everyone/);
  assert.deepEqual(e.remaining, { unit: 'paise', amount: 100000 - 60000 });
  e = evaluateDraft(draft({ mode: 'exact', values: { me: '300', a: '300', b: '300' } }), 100000);
  assert.match(e.error!, /less than the total/); assert.deepEqual(e.remaining, { unit: 'paise', amount: 10000 });
  e = evaluateDraft(draft({ mode: 'exact', values: { me: '400', a: '400', b: '300' } }), 100000);
  assert.match(e.error!, /more than the total/); assert.equal(e.remaining!.amount, -10000);
  e = evaluateDraft(draft({ mode: 'exact', values: { me: '400', a: '300', b: '300' } }), 100000);
  assert.ok(e.ok); assert.equal(e.ownSharePaise, 40000); assert.equal(e.remaining!.amount, 0);
  e = evaluateDraft(draft({ mode: 'exact', values: { me: '1000', a: '0', b: '0' } }), 100000);
  assert.ok(e.ok, 'zero amounts are allowed');
});

test('percent: must reach 100; remaining shown in hundredths of a percent', () => {
  let e = evaluateDraft(draft({ mode: 'percent', values: { me: '50', a: '30', b: '' } }), 100000);
  assert.equal(e.ok, false); assert.deepEqual(e.remaining, { unit: 'percent', amount: 2000 });
  e = evaluateDraft(draft({ mode: 'percent', values: { me: '50', a: '30', b: '30' } }), 100000);
  assert.match(e.error!, /add up to 100/); assert.equal(e.remaining!.amount, -1000);
  e = evaluateDraft(draft({ mode: 'percent', values: { me: '33.33', a: '33.33', b: '33.34' } }), 100000);
  assert.ok(e.ok); assert.equal(e.perPerson.reduce((s, p) => s + (p.sharePaise ?? 0), 0), 100000);
  e = evaluateDraft(draft({ mode: 'percent', values: { me: '33.333', a: '33.333', b: '33.334' } }), 100000);
  assert.match(e.error!, /2 decimal/);
});

test('shares: whole numbers of at least 1', () => {
  assert.deepEqual(evaluateDraft(draft({ mode: 'shares', values: { me: '1', a: '2', b: '3' } }), 60000).perPerson.map((p) => p.sharePaise), [10000, 20000, 30000]);
  assert.match(evaluateDraft(draft({ mode: 'shares', values: { me: '0', a: '2', b: '3' } }), 60000).error!, /at least 1/);
  assert.match(evaluateDraft(draft({ mode: 'shares', values: { me: '1.5', a: '2', b: '3' } }), 60000).error!, /whole number/);
  assert.match(evaluateDraft(draft({ mode: 'shares', values: { me: '1', a: '2' } }), 60000).error!, /share count for everyone/);
});

test('tiny amounts: the people who get Rs 0 are reported for an inline notice (equal only)', () => {
  const e = evaluateDraft(draft(), 2);
  assert.ok(e.ok); assert.deepEqual(e.zeroShare, ['b']);
  assert.deepEqual(evaluateDraft(draft({ mode: 'exact', values: { me: '0.02', a: '0', b: '0' } }), 2).zeroShare, []);
});

test('toggling people keeps the payer valid and clears their typed value; groups preselect members', () => {
  let d = draft({ payer: 'a', values: { a: '10', b: '5' } });
  d = toggleParticipant(d, 'a');
  assert.deepEqual(d.participants, [SELF, 'b']); assert.equal(d.payer, SELF); assert.equal(d.values.a, undefined); assert.equal(d.values.b, '5');
  d = toggleParticipant(d, 'c'); assert.deepEqual(d.participants, [SELF, 'b', 'c']);
  const g = setGroup(d, 'grp', ['x', 'y']);
  assert.deepEqual(g.participants, [SELF, 'x', 'y']); assert.equal(g.groupId, 'grp'); assert.deepEqual(g.values, {});
  assert.equal(setGroup(g, null, []).groupId, null);
});

test('reopening a stored split: equal stays equal; others reopen as exact amounts', () => {
  const rows = [{ party: SELF, paidPaise: 90000, sharePaise: 30000 }, { party: 'a', paidPaise: 0, sharePaise: 30000 }, { party: 'b', paidPaise: 0, sharePaise: 30000 }];
  const eq = draftFromSplit({ mode: 'equal', rows, group_id: null });
  assert.equal(eq.mode, 'equal'); assert.deepEqual(eq.participants, [SELF, 'a', 'b']); assert.equal(eq.payer, SELF);
  const sh = draftFromSplit({ mode: 'shares', rows, group_id: 'g' });
  assert.equal(sh.mode, 'exact'); assert.equal(sh.values.a, '300'); assert.equal(sh.groupId, 'g');
  assert.ok(evaluateDraft(sh, 90000).ok, 'the reopened draft is valid as is');
  const friendPaid = draftFromSplit({ mode: 'equal', group_id: null, rows: [{ party: 'a', paidPaise: 90000, sharePaise: 45000 }, { party: SELF, paidPaise: 0, sharePaise: 45000 }] });
  assert.equal(friendPaid.payer, 'a');
});

console.log(`${passed} passed`);
