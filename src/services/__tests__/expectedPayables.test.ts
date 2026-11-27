/** Home's "You'll pay" card: what is on it, in what order, how much, and when it is hidden. All people are invented. */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import type { IDatabase } from '../../db/types.ts';
import { PAYABLE_ROWS, payableCard, payableStatus, payables } from '../expectedPayables.ts';
import { createExpected, deleteExpected, isOverdue, listExpected, markSettled, recordPayment, type ExpectedPayment } from '../expectedPaymentService.ts';
import { createContact, createSplitExpense } from '../splitService.ts';
import { SELF } from '../splitMath.ts';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed += 1; console.log(`✓ ${name}`); };
const fresh = async () => { const db = new NodeSqliteAdapter() as unknown as IDatabase; await runMigrations(db); return db; };
const NOW = new Date(2026, 10, 28, 12, 0, 0);
const item = (id: string, over: Partial<ExpectedPayment> = {}): ExpectedPayment => ({
  id, user_id: null, person: id, person_key: id, direction: 'pay', amount_paise: 10000, paid_paise: 0, note: null, due_date: null, status: 'pending',
  settled_at: null, payments: [], created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...over,
});
const ids = (items: ExpectedPayment[]) => payables(items, NOW).map((e) => e.id);

await test('only pending money I will pay: nothing owed to me, nothing settled, nothing already covered', () => {
  assert.deepEqual(ids([
    item('mine'),
    item('owed-to-me', { direction: 'receive' }),
    item('settled', { status: 'settled', paid_paise: 10000 }),
    item('covered', { paid_paise: 10000 }),
    item('part', { paid_paise: 1 }),
  ]), ['mine', 'part']);
});

await test('overdue first, then by due date, then no date; ties are stable', () => {
  const list = [
    item('no-date'), item('due-later', { due_date: '2026-12-20' }), item('overdue-recent', { due_date: '2026-11-27' }),
    item('due-today', { due_date: '2026-11-28' }), item('overdue-old', { due_date: '2026-10-01' }), item('due-soon', { due_date: '2026-12-03' }),
    item('no-date-older', { created_at: '2026-10-01T00:00:00.000Z' }),
  ];
  const expected = ['overdue-old', 'overdue-recent', 'due-today', 'due-soon', 'due-later', 'no-date-older', 'no-date'];
  assert.deepEqual(ids(list), expected);
  assert.deepEqual(ids([...list].reverse()), expected);
  assert.equal(list[0].id, 'no-date', 'the input is not reordered');
});

await test('status wording follows the Expected tab\'s overdue rule', () => {
  const status = (due_date: string | null) => payableStatus(item('x', { due_date }), NOW);
  assert.equal(status('2026-11-26'), 'Overdue since 26 Nov');
  assert.equal(status('2026-12-03'), 'Due 3 Dec');
  assert.equal(status('2026-11-28'), 'Due 28 Nov', 'due today is not overdue');
  assert.equal(status(null), 'No due date');
  assert.equal(status('2025-12-31'), 'Overdue since 31 Dec 2025', 'another year is named');
  assert.equal(status('2027-01-03'), 'Due 3 Jan 2027');
  for (const due_date of ['2026-11-27', '2026-11-28']) {
    const e = item('x', { due_date });
    assert.equal(payableStatus(e, NOW).startsWith('Overdue'), isOverdue(e, NOW), due_date);
  }
});

await test('the remaining amount is the total minus what has been paid', () => {
  const card = payableCard([item('a', { amount_paise: 100000, paid_paise: 35050 }), item('b', { amount_paise: 500, paid_paise: 499 })], NOW)!;
  assert.deepEqual(card.rows.map((r) => [r.id, r.amountPaise]), [['a', 64950], ['b', 1]]);
});

await test('three rows at most, with "See all N" counting every item to pay and nothing else', () => {
  const make = (n: number) => [...Array.from({ length: n }, (_, i) => item(`p${i}`, { due_date: `2026-12-${String(i + 1).padStart(2, '0')}` })), item('r', { direction: 'receive' }), item('s', { status: 'settled' })];
  assert.equal(PAYABLE_ROWS, 3);
  for (const n of [1, 3]) { const card = payableCard(make(n), NOW)!; assert.deepEqual([card.rows.length, card.total, card.action], [n, n, 'Open']); }
  const card = payableCard(make(7), NOW)!;
  assert.deepEqual([card.rows.length, card.total, card.action], [3, 7, 'See all 7']);
  assert.deepEqual(card.rows.map((r) => r.id), ['p0', 'p1', 'p2']);
});

await test('hidden when there is nothing to pay', () => {
  assert.equal(payableCard([], NOW), null);
  assert.equal(payableCard([item('r', { direction: 'receive' }), item('s', { status: 'settled' })], NOW), null);
});

await test('from the database: one account or the guest only; paying, settling and deleting update it', async () => {
  const db = await fresh();
  const mine = await createExpected(db, 'u1', { person: 'Asha', amountPaise: 50000, direction: 'pay' });
  await createExpected(db, 'u1', { person: 'Bala', amountPaise: 900 });
  await createExpected(db, 'u2', { person: 'Chitra', amountPaise: 700, direction: 'pay' });
  await createExpected(db, null, { person: 'Devi', amountPaise: 300, direction: 'pay' });
  const card = async (scope: string | null) => payableCard(await listExpected(db, scope), NOW);
  const people = async (scope: string | null) => (await card(scope))?.rows.map((r) => r.person) ?? [];
  assert.deepEqual([await people('u1'), await people('u2'), await people(null)], [['Asha'], ['Chitra'], ['Devi']]);
  await recordPayment(db, 'u1', mine.id, { amountPaise: 20000 });
  assert.equal((await card('u1'))!.rows[0].amountPaise, 30000);
  await markSettled(db, 'u1', mine.id);
  assert.equal(await card('u1'), null);
  await deleteExpected(db, null, (await card(null))!.rows[0].id);
  assert.equal(await card(null), null);
});

await test('a split balance I owe is not duplicated here', async () => {
  const db = await fresh();
  const friend = await createContact(db, null, { name: 'Asha' });
  await createSplitExpense(db, null, { title: 'Dinner', category: 'Food & Dining', expenseDate: NOW.toISOString(), mode: 'equal', totalPaise: 1000, participants: [{ party: SELF }, { party: friend.id }], payers: [{ party: friend.id, paidPaise: 1000 }] });
  assert.equal(payableCard(await listExpected(db, null), NOW), null);
});

console.log(`${passed} passed`);
