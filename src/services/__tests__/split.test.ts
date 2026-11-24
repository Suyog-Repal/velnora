/**
 * Split payments on SQLite: the service layer, the v_spend rule, settlements staying out of spending, deletion rules,
 * local-only guarantee (no sync queue rows) and a large-ledger timing check.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import type { IDatabase } from '../../db/types.ts';
import { SPEND_VIEW, SQL_COUNTS_AS_EXPENSE } from '../ledgerRules.ts';
import { monthRange } from '../budgetService.ts';
import { createExpected } from '../expectedPaymentService.ts';
import { SELF, SplitError } from '../splitMath.ts';
import {
  addGroupMember, archiveGroup, contactLabels, createContact, createGroup, createSplitExpense, deleteContact, deleteGroup, deleteSettlement, deleteSplitExpense,
  deleteSplitForTransaction, expectedForContact, getBalancesWithMe, getSimplifyPreview, getSplitExpense, getSplitForTransaction, listContacts, listGroups, listSettlements,
  listSplitExpenses, recordSettlement, removeGroupMember, resplitInputs, updateContact, updateSplitExpense, type SplitExpenseInput,
} from '../splitService.ts';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed += 1; console.log(`✓ ${name}`); };
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof SplitError && re.test(e.message));

async function fresh(): Promise<IDatabase> { const db = new NodeSqliteAdapter(); await runMigrations(db); return db as unknown as IDatabase; }

let seq = 0;
async function insertTx(db: IDatabase, o: { paise: number; direction?: 'income' | 'expense'; category?: string; date?: Date; user?: string | null; deleted?: boolean; kind?: string }): Promise<string> {
  const id = `tx${++seq}`; const iso = (o.date ?? new Date()).toISOString();
  await db.runAsync(
    `INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, description, transaction_date, source, sync_status, deleted_at, created_at, updated_at, txn_kind)
     VALUES (?, ?, ?, ?, ?, 'Shop', ?, '', ?, 'manual', 'synced', ?, ?, ?, ?)`,
    id, o.user ?? null, o.paise / 100, o.paise, o.direction ?? 'expense', o.category ?? 'Food & Dining', iso, o.deleted ? iso : null, iso, iso, o.kind ?? 'payment');
  return id;
}

/** The same query shapes the app uses for spending (analyticsService / budgetService), reading from the view. */
const spentIn = async (db: IDatabase, month: string, category: string | null, scope: string | null = null, source = SPEND_VIEW) => {
  const { start, end } = monthRange(month);
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(COALESCE(amount_paise, CAST(ROUND(amount * 100) AS INTEGER))) AS total FROM ${source}
     WHERE ${SQL_COUNTS_AS_EXPENSE} AND deleted_at IS NULL AND amount > 0 AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
       AND transaction_date >= ? AND transaction_date < ? AND (? IS NULL OR category = ? COLLATE NOCASE)`,
    scope, scope, start, end, category, category);
  return row?.total ?? 0;
};
const thisMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; };

const equalInput = (over: Partial<SplitExpenseInput> & Pick<SplitExpenseInput, 'totalPaise' | 'participants' | 'payers'>): SplitExpenseInput =>
  ({ title: 'Dinner', category: 'Food & Dining', expenseDate: new Date().toISOString(), mode: 'equal', ...over });

await test('migration 11 creates the tables, indexes and the view; nothing is queued for sync', async () => {
  const db = await fresh();
  const names = (await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)).map((r) => r.name);
  for (const n of ['contacts', 'split_groups', 'group_members', 'split_expenses', 'split_shares', 'settlements', 'v_spend']) assert.ok(names.includes(n), n);
  const idx = (await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)).map((r) => r.name);
  for (const n of ['idx_split_expenses_user_date', 'idx_split_expenses_group', 'uq_split_expenses_tx', 'idx_split_shares_party', 'idx_settlements_user', 'idx_settlements_group', 'idx_group_members_contact']) assert.ok(idx.includes(n), n);
  await runMigrations(db); // repeatable
  const cols = (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(split_expenses)`)).map((r) => r.name);
  assert.ok(!cols.includes('sync_status'), 'local-only: no sync columns');
});

await test('own-share rule: a split transaction keeps its full amount but counts only my share', async () => {
  const db = await fresh();
  const [a, b, c] = await Promise.all(['Asha', 'Bala', 'Chitra'].map((n) => createContact(db, null, { name: n })));
  const tx = await insertTx(db, { paise: 100000 }); // I paid Rs 1000 (bank SMS)
  assert.equal(await spentIn(db, thisMonth(), null), 100000, 'unsplit: full amount');
  await createSplitExpense(db, null, equalInput({ transactionId: tx, totalPaise: 100000, participants: [{ party: SELF }, { party: a.id }, { party: b.id }, { party: c.id }], payers: [{ party: SELF, paidPaise: 100000 }] }));
  assert.equal(await spentIn(db, thisMonth(), null), 25000, 'split four ways: Rs 250 is my spending');
  assert.equal(await spentIn(db, thisMonth(), 'Food & Dining'), 25000);
  const raw = await db.getFirstAsync<{ amount_paise: number }>(`SELECT amount_paise FROM transactions WHERE id = ?`, tx);
  assert.equal(raw!.amount_paise, 100000, 'the transaction itself still has the full amount that matches the bank');
  assert.equal(await spentIn(db, thisMonth(), null, null, 'transactions'), 100000, 'cash balance sources read transactions and are unchanged');
  const split = await getSplitForTransaction(db, null, tx);
  assert.equal(split!.rows.find((r) => r.party === SELF)!.sharePaise, 25000);
});

await test('I paid for others only (not a participant): my spending is 0, they owe me everything', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' });
  const tx = await insertTx(db, { paise: 50000 });
  await createSplitExpense(db, null, equalInput({ transactionId: tx, totalPaise: 50000, participants: [{ party: a.id }], payers: [{ party: SELF, paidPaise: 50000 }] }));
  assert.equal(await spentIn(db, thisMonth(), null), 0);
  const bal = await getBalancesWithMe(db, null);
  assert.equal(bal.perParty.get(a.id), 50000); assert.equal(bal.owedToMePaise, 50000);
});

await test('friend paid, no bank transaction: appears in spending with its category, date and month; budgets see it', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' }); const b = await createContact(db, null, { name: 'Bala' });
  const lastMonth = new Date(); lastMonth.setDate(1); lastMonth.setMonth(lastMonth.getMonth() - 1); lastMonth.setHours(12);
  const lm = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
  await createSplitExpense(db, null, equalInput({ category: 'Travel', expenseDate: lastMonth.toISOString(), totalPaise: 90000, participants: [{ party: SELF }, { party: a.id }, { party: b.id }], payers: [{ party: a.id, paidPaise: 90000 }] }));
  assert.equal(await spentIn(db, lm, 'Travel'), 30000, 'counted in the month of the expense, in its category');
  assert.equal(await spentIn(db, thisMonth(), 'Travel'), 0, 'and not in another month');
  assert.equal(await spentIn(db, lm, 'Food & Dining'), 0);
  const bal = await getBalancesWithMe(db, null);
  assert.equal(bal.perParty.get(a.id), -30000, 'I owe Asha my share'); assert.equal(bal.iOwePaise, 30000);
  assert.equal(bal.perParty.get(b.id), undefined, 'Bala and I owe each other nothing directly');
});

await test('settlements are never spending: no transaction rows, no change to v_spend, but balances drop', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' });
  const tx = await insertTx(db, { paise: 20000 });
  await createSplitExpense(db, null, equalInput({ transactionId: tx, totalPaise: 20000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: SELF, paidPaise: 20000 }] }));
  const before = await spentIn(db, thisMonth(), null);
  const txCount = (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM transactions`))!.n;
  const s = await recordSettlement(db, null, { from: a.id, to: SELF, amountPaise: 4000 });
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(a.id), 6000, 'partial settlement');
  assert.equal(await spentIn(db, thisMonth(), null), before, 'spending unchanged');
  assert.equal(await spentIn(db, thisMonth(), 'Other Income'), 0);
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM transactions`))!.n, txCount, 'no transaction was created');
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM v_spend`))!.n, txCount, 'and nothing extra shows in v_spend');
  await recordSettlement(db, null, { from: a.id, to: SELF, amountPaise: 6000 });
  assert.equal((await getBalancesWithMe(db, null)).perParty.size, 0, 'settled up');
  assert.equal(await deleteSettlement(db, null, s.id), true);
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(a.id), 4000, 'removing a settlement restores the debt');
  assert.equal((await listSettlements(db, null)).length, 1);
  await rejects(recordSettlement(db, null, { from: a.id, to: SELF, amountPaise: 0 }), /greater than zero/);
  await rejects(recordSettlement(db, null, { from: a.id, to: a.id, amountPaise: 5 }), /two different/);
  await rejects(recordSettlement(db, null, { from: 'ghost', to: SELF, amountPaise: 5 }), /not found/);
});

await test('deleting a split expense restores full spending; deleting the transaction removes its split', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' });
  const tx = await insertTx(db, { paise: 10000 });
  const e = await createSplitExpense(db, null, equalInput({ transactionId: tx, totalPaise: 10000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: SELF, paidPaise: 10000 }] }));
  assert.equal(await spentIn(db, thisMonth(), null), 5000);
  assert.equal(await deleteSplitExpense(db, null, e.id), true);
  assert.equal(await spentIn(db, thisMonth(), null), 10000, 'unsplit again: the bank amount counts');
  assert.equal((await getBalancesWithMe(db, null)).perParty.size, 0);
  const e2 = await createSplitExpense(db, null, equalInput({ transactionId: tx, totalPaise: 10000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: SELF, paidPaise: 10000 }] }));
  await deleteSplitForTransaction(db, null, tx);
  assert.equal(await getSplitExpense(db, null, e2.id), null);
  await db.runAsync(`UPDATE transactions SET deleted_at = ? WHERE id = ?`, new Date().toISOString(), tx);
  assert.equal(await spentIn(db, thisMonth(), null), 0, 'deleted transaction: nothing counts');
});

await test('link rules: one split per transaction, amounts must match, only expenses, only my own rows', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' }); const other = await createContact(db, 'user-2', { name: 'Zed' });
  const tx = await insertTx(db, { paise: 10000 }); const income = await insertTx(db, { paise: 10000, direction: 'income' }); const foreign = await insertTx(db, { paise: 10000, user: 'user-2' });
  const base = { participants: [{ party: SELF }, { party: a.id }], payers: [{ party: SELF, paidPaise: 10000 }], totalPaise: 10000 };
  await createSplitExpense(db, null, equalInput({ transactionId: tx, ...base }));
  await rejects(createSplitExpense(db, null, equalInput({ transactionId: tx, ...base })), /already split/);
  await rejects(createSplitExpense(db, null, equalInput({ transactionId: await insertTx(db, { paise: 9999 }), ...base })), /match the transaction/);
  await rejects(createSplitExpense(db, null, equalInput({ transactionId: income, ...base })), /Only an expense/);
  await rejects(createSplitExpense(db, null, equalInput({ transactionId: foreign, ...base })), /not found/);
  await rejects(createSplitExpense(db, null, equalInput({ ...base, participants: [{ party: SELF }, { party: other.id }] })), /not found/);
});

await test('contacts: same name twice stays two people (labels disambiguate); validation; legacy Expected linked by name', async () => {
  const db = await fresh();
  const r1 = await createContact(db, null, { name: 'Rohan', phone: '+919876541111' }); const r2 = await createContact(db, null, { name: ' rohan ', phone: '+919876542222' }); const r3 = await createContact(db, null, { name: 'Meera' });
  assert.notEqual(r1.id, r2.id);
  const labels = contactLabels(await listContacts(db, null));
  assert.equal(labels.get(r1.id), 'Rohan (…1111)'); assert.equal(labels.get(r2.id), 'rohan (…2222)'); assert.equal(labels.get(r3.id), 'Meera');
  await rejects(createContact(db, null, { name: '  ' }), /Enter a name/);
  await rejects(createContact(db, null, { name: 'X', phone: '12ab' }), /phone/);
  await rejects(createContact(db, null, { name: 'X', upiId: 'no-at-sign' }), /UPI/);
  const up = await updateContact(db, null, r3.id, { upiId: 'meera@okbank', phone: '98765 43210' });
  assert.equal(up.upi_id, 'meera@okbank'); assert.equal(up.phone, '9876543210');
  await createExpected(db, null, { person: 'Meera', amountPaise: 25000, note: 'tickets' });
  assert.equal((await expectedForContact(db, null, up)).length, 1, 'legacy expected row is matched by name, not migrated');
  assert.equal((await expectedForContact(db, null, r1)).length, 0);
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM expected_payments`))!.n, 1, 'legacy data untouched');
});

await test('deleting a person or group with an unsettled balance is blocked; allowed once settled', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' }); const b = await createContact(db, null, { name: 'Bala' });
  const g = await createGroup(db, null, { name: 'Goa trip', memberIds: [a.id, b.id] });
  await createSplitExpense(db, null, equalInput({ groupId: g.id, totalPaise: 30000, participants: [{ party: SELF }, { party: a.id }, { party: b.id }], payers: [{ party: SELF, paidPaise: 30000 }] }));
  await rejects(deleteContact(db, null, a.id), /unsettled/);
  await rejects(removeGroupMember(db, null, g.id, a.id), /unsettled/);
  await rejects(deleteGroup(db, null, g.id), /unsettled/);
  await rejects(archiveGroup(db, null, g.id), /unsettled/);
  await recordSettlement(db, null, { from: a.id, to: SELF, amountPaise: 10000, groupId: g.id });
  await recordSettlement(db, null, { from: b.id, to: SELF, amountPaise: 10000, groupId: g.id });
  await deleteContact(db, null, a.id);
  assert.deepEqual((await listGroups(db, null))[0].memberIds, [b.id], 'removed from the group');
  assert.equal((await listContacts(db, null)).length, 1);
  assert.equal((await listContacts(db, null, { includeDeleted: true })).length, 2, 'history can still resolve the name');
  await deleteGroup(db, null, g.id);
  assert.equal((await listGroups(db, null)).length, 0);
  assert.equal((await listSplitExpenses(db, null)).length, 0, 'its expenses go with it, so nothing keeps counting');
});

await test('group rules: members only; groups scope balances separately from friend balances', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' }); const b = await createContact(db, null, { name: 'Bala' });
  const g = await createGroup(db, null, { name: 'Flat', memberIds: [a.id] });
  await rejects(createSplitExpense(db, null, equalInput({ groupId: g.id, totalPaise: 100, participants: [{ party: SELF }, { party: b.id }], payers: [{ party: SELF, paidPaise: 100 }] })), /member of the group/);
  await addGroupMember(db, null, g.id, b.id);
  await createSplitExpense(db, null, equalInput({ groupId: g.id, totalPaise: 3000, participants: [{ party: SELF }, { party: a.id }, { party: b.id }], payers: [{ party: SELF, paidPaise: 3000 }] }));
  await createSplitExpense(db, null, equalInput({ totalPaise: 2000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: SELF, paidPaise: 2000 }] }));
  assert.equal((await getBalancesWithMe(db, null, g.id)).perParty.get(a.id), 1000);
  assert.equal((await getBalancesWithMe(db, null, null)).perParty.get(a.id), 1000);
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(a.id), 2000, 'overall friend balance adds both');
  const p = await getSimplifyPreview(db, null, g.id);
  assert.ok(p.afterCount <= p.beforeCount);
});

await test('editing an expense recomputes; amount edits re-split proportionally except exact (re-entry)', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'Asha' }); const b = await createContact(db, null, { name: 'Bala' });
  const e = await createSplitExpense(db, null, { title: 'Cab', category: 'Transportation', expenseDate: new Date().toISOString(), totalPaise: 10000, mode: 'shares',
    participants: [{ party: SELF, value: 1 }, { party: a.id, value: 1 }, { party: b.id, value: 2 }], payers: [{ party: SELF, paidPaise: 10000 }] });
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(b.id), 5000);
  await recordSettlement(db, null, { from: b.id, to: SELF, amountPaise: 1000 }); // a partial settlement already exists
  const re = resplitInputs(e, 20000);
  assert.equal(re.mode, 'exact');
  await updateSplitExpense(db, null, e.id, { title: 'Cab', category: 'Transportation', expenseDate: e.expense_date, totalPaise: 20000, mode: re.mode, participants: re.participants, payers: [{ party: SELF, paidPaise: 20000 }] });
  const after = await getSplitExpense(db, null, e.id);
  assert.deepEqual(after!.rows.filter((r) => r.party !== SELF).map((r) => r.sharePaise).sort((x, y) => x - y), [5000, 10000]);
  assert.equal((await getBalancesWithMe(db, null)).perParty.get(b.id), 9000, 'settlement kept (1000), balance follows the new split (10000)');
  const exact = await createSplitExpense(db, null, equalInput({ totalPaise: 1000, mode: 'exact', participants: [{ party: SELF, value: 400 }, { party: a.id, value: 600 }], payers: [{ party: SELF, paidPaise: 1000 }] }));
  assert.throws(() => resplitInputs(exact, 2000), /exact amounts again/);
  const eq = await createSplitExpense(db, null, equalInput({ totalPaise: 1000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: SELF, paidPaise: 1000 }] }));
  assert.deepEqual(resplitInputs(eq, 3001), { mode: 'equal', participants: [{ party: SELF }, { party: a.id }] });
});

await test('guest and account data stay separate; nothing ever reaches the sync queue', async () => {
  const db = await fresh();
  const g = await createContact(db, null, { name: 'Guest friend' }); const u = await createContact(db, 'user-1', { name: 'User friend' });
  await createSplitExpense(db, null, equalInput({ totalPaise: 1000, participants: [{ party: SELF }, { party: g.id }], payers: [{ party: SELF, paidPaise: 1000 }] }));
  await createSplitExpense(db, 'user-1', equalInput({ totalPaise: 3000, participants: [{ party: SELF }, { party: u.id }], payers: [{ party: SELF, paidPaise: 3000 }] }));
  assert.equal((await getBalancesWithMe(db, null)).owedToMePaise, 500);
  assert.equal((await getBalancesWithMe(db, 'user-1')).owedToMePaise, 1500);
  assert.equal(await spentIn(db, thisMonth(), null, null), 500); assert.equal(await spentIn(db, thisMonth(), null, 'user-1'), 1500);
  await recordSettlement(db, null, { from: g.id, to: SELF, amountPaise: 100 });
  await createGroup(db, null, { name: 'G', memberIds: [g.id] });
  assert.equal((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM sync_queue`))!.n, 0, 'sync queue untouched');
});

await test('split expenses accept very small amounts, zero shares, large Indian-scale amounts', async () => {
  const db = await fresh();
  const a = await createContact(db, null, { name: 'A' }); const b = await createContact(db, null, { name: 'B' });
  const tiny = await createSplitExpense(db, null, equalInput({ totalPaise: 1, participants: [{ party: SELF }, { party: a.id }, { party: b.id }], payers: [{ party: SELF, paidPaise: 1 }] }));
  assert.deepEqual(tiny.rows.map((r) => r.sharePaise), [1, 0, 0, 0].slice(0, tiny.rows.length));
  const big = await createSplitExpense(db, null, equalInput({ totalPaise: 12_500_000_00, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: a.id, paidPaise: 12_500_000_00 }] }));
  assert.equal(big.rows.find((r) => r.party === SELF)!.sharePaise, 6_250_000_00);
  await rejects(createSplitExpense(db, null, equalInput({ totalPaise: 1000, participants: [{ party: SELF }], payers: [{ party: SELF, paidPaise: 999 }] })), /less than the total/);
  await rejects(createSplitExpense(db, null, equalInput({ title: ' ', totalPaise: 1000, participants: [{ party: SELF }], payers: [{ party: SELF, paidPaise: 1000 }] })), /title/);
});

await test('large ledger: spending through v_spend is not noticeably slower than reading transactions directly', async () => {
  const db = await fresh();
  const friends = await Promise.all(Array.from({ length: 8 }, (_, i) => createContact(db, null, { name: `Friend ${i}` })));
  const cats = ['Food & Dining', 'Groceries', 'Transportation', 'Travel', 'Shopping'];
  const now = new Date();
  await db.execAsync('BEGIN TRANSACTION');
  for (let i = 0; i < 6000; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), 1 + (i % 27), 10, i % 60);
    await insertTx(db, { paise: 10000 + (i % 500) * 100, category: cats[i % 5], date: d, direction: i % 9 === 0 ? 'income' : 'expense' });
  }
  await db.execAsync('COMMIT');
  const txIds = (await db.getAllAsync<{ id: string }>(`SELECT id FROM transactions WHERE direction = 'expense' ORDER BY id LIMIT 600`)).map((r) => r.id);
  for (let i = 0; i < txIds.length; i++) {
    const t = await db.getFirstAsync<{ amount_paise: number }>(`SELECT amount_paise FROM transactions WHERE id = ?`, txIds[i]);
    await createSplitExpense(db, null, equalInput({ transactionId: txIds[i], totalPaise: t!.amount_paise, participants: [{ party: SELF }, { party: friends[i % 8].id }], payers: [{ party: SELF, paidPaise: t!.amount_paise }] }));
  }
  for (let i = 0; i < 300; i++) await createSplitExpense(db, null, equalInput({ category: cats[i % 5], totalPaise: 9000 + i, participants: [{ party: SELF }, { party: friends[i % 8].id }], payers: [{ party: friends[i % 8].id, paidPaise: 9000 + i }] }));
  const time = async (source: string) => { const t0 = performance.now(); for (let k = 0; k < 20; k++) await spentIn(db, thisMonth(), k % 2 ? 'Travel' : null, null, source); return (performance.now() - t0) / 20; };
  await time('transactions'); await time(SPEND_VIEW); // warm up
  const direct = await time('transactions'); const viaView = await time(SPEND_VIEW);
  console.log(`  6000 transactions, 600 linked splits, 300 friend-paid splits: transactions ${direct.toFixed(2)} ms, v_spend ${viaView.toFixed(2)} ms per query`);
  assert.ok(viaView < Math.max(direct * 6, 60), `v_spend ${viaView.toFixed(1)}ms vs direct ${direct.toFixed(1)}ms`);
  const t0 = performance.now(); await getBalancesWithMe(db, null); const balMs = performance.now() - t0;
  console.log(`  balances over 900 expenses: ${balMs.toFixed(1)} ms`);
  assert.ok(balMs < 1000);
  const plan = (await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT * FROM split_expenses WHERE transaction_id = 'x' AND deleted_at IS NULL`)).map((r) => r.detail).join(' ');
  assert.match(plan, /uq_split_expenses_tx/, 'the view join uses the transaction_id index');
});

console.log(`${passed} passed`);
