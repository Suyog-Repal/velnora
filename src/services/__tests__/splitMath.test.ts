/** Split math and balances: pure logic, no database. Money is integer paise throughout. */
import assert from 'node:assert/strict';
import { SELF, SplitError, allocateByWeight, buildPartyAmounts, computeShares, ownSharePaise, percentToBasisPoints, validatePayers, type PartyAmounts, type SplitMode } from '../splitMath.ts';
import {
  assertBalanced, balancesWithMe, expenseDebts, inScope, netBalances, netsOfPayments, pairwiseDebts, previewSimplify, simplifyDebts, totalsFromBalances,
  type LedgerExpense, type LedgerSettlement,
} from '../splitBalances.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`✓ ${name}`); };
const throwsSplit = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SplitError && re.test(e.message));
const shares = (r: { sharePaise: number }[]) => r.map((x) => x.sharePaise);
const P = (...ids: string[]) => ids.map((party) => ({ party }));
const sortedEntries = (m: Map<string, number>) => [...m].sort((a, b) => a[0].localeCompare(b[0]));

// deterministic PRNG so any failure reproduces
let seed = 12345;
const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };

test('equal: 10000 / 3 -> 3334, 3333, 3333 (remainder to the earliest participants)', () => {
  assert.deepEqual(shares(computeShares('equal', 10000, P('a', 'b', 'c'))), [3334, 3333, 3333]);
  assert.deepEqual(shares(computeShares('equal', 10001, P('a', 'b', 'c'))), [3334, 3334, 3333]);
  assert.deepEqual(shares(computeShares('equal', 100, P('a'))), [100]);
});

test('equal: very small amounts and zero shares are allowed and still sum exactly', () => {
  assert.deepEqual(shares(computeShares('equal', 1, P('a', 'b', 'c'))), [1, 0, 0]);
  assert.deepEqual(shares(computeShares('equal', 2, P('a', 'b', 'c'))), [1, 1, 0]);
});

test('exact: must add up to the total, whole paise, no negatives', () => {
  assert.deepEqual(shares(computeShares('exact', 1000, [{ party: 'a', value: 250 }, { party: 'b', value: 750 }])), [250, 750]);
  assert.deepEqual(shares(computeShares('exact', 1000, [{ party: 'a', value: 0 }, { party: 'b', value: 1000 }])), [0, 1000], 'a zero amount is allowed');
  throwsSplit(() => computeShares('exact', 1000, [{ party: 'a', value: 250 }, { party: 'b', value: 700 }]), /less than the total/);
  throwsSplit(() => computeShares('exact', 1000, [{ party: 'a', value: 300 }, { party: 'b', value: 800 }]), /more than the total/);
  throwsSplit(() => computeShares('exact', 1000, [{ party: 'a', value: 500.5 }, { party: 'b', value: 499.5 }]), /whole paise/);
  throwsSplit(() => computeShares('exact', 1000, [{ party: 'a', value: -1 }, { party: 'b', value: 1001 }]), /zero or more/);
  throwsSplit(() => computeShares('exact', 1000, [{ party: 'a', value: 1000 }, { party: 'b' }]), /every person/);
});

test('percent: must total exactly 100, max 2 decimals, remainder distributed', () => {
  assert.deepEqual(shares(computeShares('percent', 10000, [{ party: 'a', value: 50 }, { party: 'b', value: 30 }, { party: 'c', value: 20 }])), [5000, 3000, 2000]);
  const thirds = computeShares('percent', 10000, [{ party: 'a', value: 33.33 }, { party: 'b', value: 33.33 }, { party: 'c', value: 33.34 }]);
  assert.equal(shares(thirds).reduce((s, x) => s + x, 0), 10000);
  assert.deepEqual(shares(thirds), [3333, 3333, 3334]);
  assert.equal(percentToBasisPoints(33.33), 3333);
  assert.equal(percentToBasisPoints(0.07), 7, 'no float drift');
  throwsSplit(() => computeShares('percent', 10000, [{ party: 'a', value: 60 }, { party: 'b', value: 30 }]), /add up to 100/);
  throwsSplit(() => computeShares('percent', 10000, [{ party: 'a', value: 50.001 }, { party: 'b', value: 49.999 }]), /2 decimal/);
  throwsSplit(() => computeShares('percent', 10000, [{ party: 'a', value: 110 }, { party: 'b', value: -10 }]), /negative|more than 100/);
});

test('shares: positive integer weights; largest remainder, ties to the earlier person', () => {
  assert.deepEqual(shares(computeShares('shares', 10000, [{ party: 'a', value: 1 }, { party: 'b', value: 2 }, { party: 'c', value: 3 }])), [1667, 3333, 5000]);
  assert.deepEqual(shares(computeShares('shares', 100, [{ party: 'a', value: 1 }, { party: 'b', value: 1 }, { party: 'c', value: 1 }])), [34, 33, 33]);
  throwsSplit(() => computeShares('shares', 100, [{ party: 'a', value: 0 }, { party: 'b', value: 1 }]), /at least 1/);
  throwsSplit(() => computeShares('shares', 100, [{ party: 'a', value: 1.5 }, { party: 'b', value: 1 }]), /whole number/);
});

test('totals and participants are validated', () => {
  throwsSplit(() => computeShares('equal', 0, P('a')), /greater than zero/);
  throwsSplit(() => computeShares('equal', 10.5, P('a')), /greater than zero/);
  throwsSplit(() => computeShares('equal', 100, []), /at least one/);
  throwsSplit(() => computeShares('equal', 100, P('a', 'a')), /only once/);
  throwsSplit(() => computeShares('equal', 1e12, P('a')), /too large/);
});

test('property: every mode always sums exactly to the total, deterministically', () => {
  const modes: SplitMode[] = ['equal', 'exact', 'percent', 'shares'];
  for (let i = 0; i < 2000; i++) {
    const total = 1 + rnd(5_000_000); const n = 1 + rnd(9);
    const ids = Array.from({ length: n }, (_, k) => `p${k}`);
    const mode = modes[rnd(4)];
    let inputs;
    if (mode === 'exact') { // random cut points
      const cuts = Array.from({ length: n - 1 }, () => rnd(total + 1)).sort((a, b) => a - b);
      inputs = ids.map((party, k) => ({ party, value: (k === n - 1 ? total : cuts[k]) - (k === 0 ? 0 : cuts[k - 1]) }));
    } else if (mode === 'percent') {
      let left = 10000;
      inputs = ids.map((party, k) => { const v = k === n - 1 ? left : rnd(left + 1); left -= v; return { party, value: v / 100 }; });
    } else if (mode === 'shares') inputs = ids.map((party) => ({ party, value: 1 + rnd(20) }));
    else inputs = P(...ids);
    const a = computeShares(mode, total, inputs); const b = computeShares(mode, total, inputs);
    assert.equal(a.reduce((s, x) => s + x.sharePaise, 0), total, `${mode} ${total} ${n}`);
    assert.deepEqual(a, b);
    assert.ok(a.every((x) => Number.isInteger(x.sharePaise) && x.sharePaise >= 0));
  }
});

test('allocateByWeight never gives a leftover paisa to a zero weight', () => {
  assert.deepEqual(allocateByWeight(10, [0, 1, 1, 0]), [0, 5, 5, 0]);
  assert.deepEqual(allocateByWeight(11, [0, 1, 1, 0]), [0, 6, 5, 0]);
});

test('payers: one or many, must total the amount; the payer need not be a participant', () => {
  validatePayers(1000, [{ party: SELF, paidPaise: 1000 }]);
  validatePayers(1000, [{ party: SELF, paidPaise: 400 }, { party: 'a', paidPaise: 600 }]);
  throwsSplit(() => validatePayers(1000, [{ party: SELF, paidPaise: 900 }]), /less than the total/);
  throwsSplit(() => validatePayers(1000, [{ party: SELF, paidPaise: 0 }, { party: 'a', paidPaise: 1000 }]), /more than zero/);
  throwsSplit(() => validatePayers(1000, []), /who paid/);
  const rows = buildPartyAmounts(1000, computeShares('equal', 1000, P('a', 'b')), [{ party: SELF, paidPaise: 1000 }]);
  assert.deepEqual(rows, [{ party: 'a', paidPaise: 0, sharePaise: 500 }, { party: 'b', paidPaise: 0, sharePaise: 500 }, { party: SELF, paidPaise: 1000, sharePaise: 0 }]);
  assert.equal(ownSharePaise(rows), 0, 'paid for others only: own share is 0');
  assert.equal(ownSharePaise(buildPartyAmounts(900, computeShares('equal', 900, P(SELF, 'a', 'b')), [{ party: 'a', paidPaise: 900 }])), 300);
});

// ---- balances ----------------------------------------------------------------------------------------------------------
const exp = (id: string, groupId: string | null, total: number, mode: SplitMode, parts: { party: string; value?: number }[], payers: { party: string; paidPaise: number }[]): LedgerExpense =>
  ({ id, groupId, rows: buildPartyAmounts(total, computeShares(mode, total, parts), payers) });

test('net balance = paid - share, and balances always sum to zero', () => {
  const e = exp('e1', null, 10000, 'equal', P(SELF, 'a', 'b'), [{ party: SELF, paidPaise: 10000 }]);
  const nets = netBalances([e], []);
  assert.equal(nets.get(SELF), 10000 - 3334); assert.equal(nets.get('a'), -3333); assert.equal(nets.get('b'), -3333);
  assertBalanced(nets);
  assert.throws(() => assertBalanced(new Map([['a', 5]])), /inconsistent/);
});

test('property: random expenses and settlements keep the ledger balanced', () => {
  for (let round = 0; round < 300; round++) {
    const ids = ['me', 'a', 'b', 'c', 'd', 'e'];
    const expenses: LedgerExpense[] = []; const settlements: LedgerSettlement[] = [];
    const nExp = 1 + rnd(8);
    for (let i = 0; i < nExp; i++) {
      const total = 1 + rnd(100000); const k = 1 + rnd(5); const parts = ids.slice(0, k + 1);
      const payer = ids[rnd(ids.length)];
      expenses.push(exp(`e${i}`, null, total, 'equal', P(...parts), [{ party: payer, paidPaise: total }]));
    }
    const nSet = rnd(4);
    for (let i = 0; i < nSet; i++) { const f = ids[rnd(6)]; const t = ids[(ids.indexOf(f) + 1 + rnd(5)) % 6]; settlements.push({ id: `s${i}`, groupId: null, from: f, to: t, amountPaise: 1 + rnd(5000) }); }
    const nets = netBalances(expenses, settlements); assertBalanced(nets);
    // the pairwise debts must reproduce exactly the same nets
    assert.deepEqual(sortedEntries(netsOfPayments(pairwiseDebts(expenses, settlements))), sortedEntries(nets));
  }
});

test('settlement reduces what is owed (partial, full) and overpaying flips the direction', () => {
  const e = exp('e1', null, 9000, 'equal', P(SELF, 'a', 'b'), [{ party: SELF, paidPaise: 9000 }]);
  const owed = (s: LedgerSettlement[]) => balancesWithMe(pairwiseDebts([e], s));
  assert.equal(owed([]).get('a'), 3000);
  assert.equal(owed([{ id: 's', groupId: null, from: 'a', to: SELF, amountPaise: 1000 }]).get('a'), 2000, 'partial');
  assert.equal(owed([{ id: 's', groupId: null, from: 'a', to: SELF, amountPaise: 3000 }]).get('a'), undefined, 'settled up');
  assert.equal(owed([{ id: 's', groupId: null, from: 'a', to: SELF, amountPaise: 4000 }]).get('a'), -1000, 'overpaying flips the direction');
});

test('multiple payers: debts follow what each payer is owed and reproduce the nets', () => {
  const rows: PartyAmounts[] = buildPartyAmounts(1000, computeShares('equal', 1000, P('a', 'b', 'c', 'd')), [{ party: 'a', paidPaise: 600 }, { party: 'b', paidPaise: 400 }]);
  const debts = expenseDebts(rows);
  assert.deepEqual(sortedEntries(netsOfPayments(debts)), sortedEntries(netBalances([{ id: 'x', groupId: null, rows }], [])));
  assert.ok(debts.every((d) => d.paise > 0 && d.from !== d.to));
});

test('editing or deleting an expense just recomputes: balances follow the records', () => {
  const e1 = exp('e1', null, 3000, 'equal', P(SELF, 'a', 'b'), [{ party: SELF, paidPaise: 3000 }]);
  const e2 = exp('e2', null, 6000, 'equal', P(SELF, 'a', 'b'), [{ party: 'a', paidPaise: 6000 }]);
  assert.equal(balancesWithMe(pairwiseDebts([e1, e2], [])).get('a'), -1000); // a owes me 1000, I owe a 2000
  assert.equal(balancesWithMe(pairwiseDebts([e1], [])).get('a'), 1000, 'e2 deleted');
  const edited = exp('e2', null, 9000, 'equal', P(SELF, 'a', 'b'), [{ party: 'a', paidPaise: 9000 }]);
  assert.equal(balancesWithMe(pairwiseDebts([e1, edited], [])).get('a'), -2000, 'e2 edited');
});

test('scope: group, outside any group, everything', () => {
  const g = exp('g', 'grp', 3000, 'equal', P(SELF, 'a', 'b'), [{ party: SELF, paidPaise: 3000 }]);
  const f = exp('f', null, 2000, 'equal', P(SELF, 'a'), [{ party: SELF, paidPaise: 2000 }]);
  assert.equal(balancesWithMe(pairwiseDebts(inScope([g, f], 'grp'), [])).get('a'), 1000);
  assert.equal(balancesWithMe(pairwiseDebts(inScope([g, f], null), [])).get('a'), 1000);
  assert.equal(balancesWithMe(pairwiseDebts(inScope([g, f], undefined), [])).get('a'), 2000);
  assert.deepEqual(totalsFromBalances(balancesWithMe(pairwiseDebts([g, f], []))), { owedToMePaise: 2000 + 1000, iOwePaise: 0 });
});

test('simplify: a chain collapses (A->B->C becomes A->C)', () => {
  const e1 = exp('1', 'g', 1000, 'exact', [{ party: 'a', value: 1000 }], [{ party: 'b', paidPaise: 1000 }]);
  const e2 = exp('2', 'g', 1000, 'exact', [{ party: 'b', value: 1000 }], [{ party: 'c', paidPaise: 1000 }]);
  const p = previewSimplify([e1, e2], []);
  assert.equal(p.beforeCount, 2); assert.equal(p.afterCount, 1);
  assert.deepEqual(p.after, [{ from: 'a', to: 'c', paise: 1000 }]);
});

test('property: simplify keeps every net identical and never needs more payments', () => {
  for (let round = 0; round < 500; round++) {
    const ids = ['me', 'a', 'b', 'c', 'd', 'e', 'f'];
    const expenses: LedgerExpense[] = []; const settlements: LedgerSettlement[] = [];
    const nExp = 1 + rnd(10);
    for (let i = 0; i < nExp; i++) {
      const total = 1 + rnd(200000); const parts = ids.slice(0, 2 + rnd(5)); const payer = ids[rnd(ids.length)];
      expenses.push(exp(`e${i}`, 'g', total, 'equal', P(...parts), [{ party: payer, paidPaise: total }]));
    }
    const nSet = rnd(3);
    for (let i = 0; i < nSet; i++) { const f = ids[rnd(7)]; settlements.push({ id: `s${i}`, groupId: 'g', from: f, to: ids[(ids.indexOf(f) + 1 + rnd(6)) % 7], amountPaise: 1 + rnd(3000) }); }
    const nets = netBalances(expenses, settlements);
    const p = previewSimplify(expenses, settlements);
    assert.deepEqual(sortedEntries(netsOfPayments(p.after)), sortedEntries(nets), 'nets unchanged by the simplified plan');
    assert.ok(p.afterCount <= p.beforeCount, `${p.afterCount} <= ${p.beforeCount}`);
    assert.ok(p.after.every((d) => d.paise > 0));
    const g = simplifyDebts(nets);
    assert.ok(g.length <= Math.max(0, nets.size - 1), 'greedy plan needs at most (people with a balance - 1) payments');
    assert.deepEqual(g, simplifyDebts(nets), 'deterministic');
  }
});

test('simplify: an already-settled group needs no payments', () => {
  const e = exp('1', 'g', 1000, 'exact', [{ party: 'a', value: 1000 }], [{ party: 'b', paidPaise: 1000 }]);
  const p = previewSimplify([e], [{ id: 's', groupId: 'g', from: 'a', to: 'b', amountPaise: 1000 }]);
  assert.equal(p.beforeCount, 0); assert.equal(p.afterCount, 0);
});

console.log(`${passed} passed`);
