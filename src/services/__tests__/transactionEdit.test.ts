/**
 * Edit Transaction: the form updates ONE existing transaction.
 *  - an untouched form writes nothing (no queue entry, same updated_at),
 *  - changed fields update the same id (never a second record) with exactly one queued change,
 *  - the timestamp keeps its exact instant unless the date or time was changed,
 *  - location, note and "mark as reviewed" are part of the plan (applied only on save, so cancel discards them),
 *  - invalid input is refused before anything is written,
 *  - attachments stay with the edited transaction.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { formFromTransaction, isEditDirty, planEdit, type EditFormState } from '../transactionEdit.ts';
import { toUpdateInput } from '../transactionDetails.ts';
import type { TransactionEntity } from '../../db/types.ts';

async function setup() {
  const db = new NodeSqliteAdapter();
  await runMigrations(db);
  const repo = new TransactionRepository(db);
  const created = await repo.create({
    user_id: 'u1', amount: 120.5, direction: 'expense', counterparty: 'AutoTest Cafe', category: 'Food & Dining', source: 'manual',
    description: 'AutoTest lunch', transaction_date: '2026-11-10T07:15:42.123Z',
  } as any);
  // Start from a clean, synced row: any queue entry afterwards comes from the edit under test.
  await repo.updateSyncStatus(created.id, 'synced', 1);
  await db.runAsync('DELETE FROM sync_queue');
  const t = (await repo.getById(created.id))!;
  const count = async (sql: string) => (await db.getFirstAsync<{ n: number }>(sql))!.n;
  /** What the screen does on Save. */
  const apply = async (tx: TransactionEntity, f: EditFormState) => {
    const r = planEdit(tx, f);
    if (!r.ok) return r;
    if (r.plan.details) await repo.update(tx.id, toUpdateInput(r.plan.details));
    if (r.plan.ledger) await repo.update(tx.id, r.plan.ledger);
    return r;
  };
  return { db, repo, t, count, apply };
}
const edit = (t: TransactionEntity, over: Partial<EditFormState>): EditFormState => ({ ...formFromTransaction(t), ...over });

// 1. Untouched form: nothing is written.
{
  const { repo, t, count, apply } = await setup();
  const r = await apply(t, formFromTransaction(t));
  assert.ok(r.ok && !r.changed && r.plan.details === null && r.plan.ledger === null);
  assert.equal(isEditDirty(t, formFromTransaction(t)), false);
  const after = (await repo.getById(t.id))!;
  assert.equal(after.updated_at, t.updated_at);
  assert.equal(after.sync_status, 'synced');
  assert.equal(await count('SELECT COUNT(*) AS n FROM sync_queue'), 0);
  console.log('ok: saving an untouched form writes nothing');
}

// 2. Changing fields updates the SAME id: no duplicate, one queued update, other fields untouched.
{
  const { repo, t, count, apply } = await setup();
  const r = await apply(t, edit(t, { merchant: ' AutoTest Bistro ', amount: '250', category: 'Groceries', note: 'AutoTest dinner', payment: 'UPI' }));
  assert.ok(r.ok && r.changed);
  assert.deepEqual(Object.keys(r.plan.details!).sort(), ['amount', 'category', 'category_id', 'counterparty', 'description', 'payment_method']);
  assert.equal(await count('SELECT COUNT(*) AS n FROM transactions'), 1, 'still exactly one transaction');
  const after = (await repo.getById(t.id))!;
  assert.deepEqual([after.id, after.counterparty, after.amount_paise, after.category, after.description, after.payment_method],
    [t.id, 'AutoTest Bistro', 25000, 'Groceries', 'AutoTest dinner', 'UPI']);
  assert.equal(after.transaction_date, t.transaction_date, 'timestamp untouched (seconds and milliseconds kept)');
  assert.equal(after.direction, 'expense');
  assert.equal(after.created_at, t.created_at);
  const q = await repo['db'].getAllAsync<{ entity_id: string; operation: string }>('SELECT entity_id, operation FROM sync_queue');
  assert.deepEqual(q.map((r) => [r.entity_id, r.operation]), [[t.id, 'update']], 'one queued update for the same id');
  console.log('ok: edit updates the same id, no duplicate, one queued update');
}

// 3. Date/time: rewritten only when changed.
{
  const { repo, t, apply } = await setup();
  const r1 = planEdit(t, edit(t, { note: 'x' }));
  assert.ok(r1.ok && r1.plan.details && !('transaction_date' in r1.plan.details));
  const r2 = await apply(t, edit(t, { date: '2026-11-11' }));
  assert.ok(r2.ok && r2.plan.details?.transaction_date);
  const after = (await repo.getById(t.id))!;
  assert.notEqual(after.transaction_date, t.transaction_date);
  assert.equal(new Date(after.transaction_date).getDate(), 11);
  console.log('ok: timestamp rewritten only when date or time changed');
}

// 4. Direction change carries the category; ledger fields and review flag go in the ledger patch.
{
  const { repo, t, apply } = await setup();
  await repo.update(t.id, { verification_status: 'needs_review' });
  await repo.updateSyncStatus(t.id, 'synced', 1);
  const tx = (await repo.getById(t.id))!;
  const r = await apply(tx, edit(tx, { direction: 'income', category: 'Salary', kind: 'refund', bank: ' AutoTest Bank ', last4: '1234', markReviewed: true }));
  assert.ok(r.ok);
  assert.deepEqual([r.plan.details!.direction, r.plan.details!.category], ['income', 'Salary']);
  assert.deepEqual(r.plan.ledger, { txn_kind: 'refund', bank_name: 'AutoTest Bank', account_last4: '1234', verification_status: 'verified' });
  const after = (await repo.getById(t.id))!;
  assert.deepEqual([after.direction, after.category, after.txn_kind, after.bank_name, after.account_last4, after.verification_status],
    ['income', 'Salary', 'refund', 'AutoTest Bank', '1234', 'verified']);
  console.log('ok: type, ledger fields and "mark as reviewed" saved together');
}

// 5. Location is part of the plan: set, unchanged, removed. Nothing is stored until the plan is applied (cancel = no apply).
{
  const { repo, t, apply, count } = await setup();
  const loc = { lat: 18.52, lng: 73.85, name: 'AutoTest Place', address: 'AutoTest Road' };
  const planned = planEdit(t, edit(t, { location: loc }));
  assert.ok(planned.ok && planned.plan.details?.location);
  assert.equal((await repo.getById(t.id))!.location_lat ?? null, null, 'planning (or cancelling) stores nothing');
  assert.equal(await count('SELECT COUNT(*) AS n FROM sync_queue'), 0);
  await apply(t, edit(t, { location: loc }));
  const withLoc = (await repo.getById(t.id))!;
  assert.deepEqual([withLoc.location_lat, withLoc.location_lng, withLoc.location_name], [18.52, 73.85, 'AutoTest Place']);
  const same = planEdit(withLoc, edit(withLoc, { location: loc }));
  assert.ok(same.ok && !same.changed, 'the same location is not a change');
  await apply(withLoc, edit(withLoc, { location: null }));
  assert.equal((await repo.getById(t.id))!.location_lat ?? null, null);
  const none = planEdit(t, edit(t, { location: null }));
  assert.ok(none.ok && !none.changed, 'removing a location that does not exist is not a change');
  console.log('ok: location saved only with the plan; cancel leaves it untouched');
}

// 6. Invalid input is refused and nothing is written.
{
  const { repo, t, count } = await setup();
  const bad: Array<[Partial<EditFormState>, RegExp]> = [
    [{ amount: '0' }, /greater than zero/], [{ amount: '' }, /greater than zero/], [{ amount: 'abc' }, /greater than zero/],
    [{ amount: '-5' }, /greater than zero/], [{ amount: '10.123' }, /two decimal/], [{ merchant: '   ' }, /Merchant/],
    [{ date: '2026-13-45' }, /valid date/], [{ last4: '12' }, /last 3 or 4/], [{ last4: '12ab' }, /last 3 or 4/],
    [{ phone: '12345' }, /./], [{ category: '' }, /category/i], [{ location: { lat: 200, lng: 0 } }, /out of range/],
  ];
  for (const [over, message] of bad) {
    const r = planEdit(t, edit(t, over));
    assert.ok(!r.ok, `must be refused: ${JSON.stringify(over)}`);
    if (!r.ok) assert.match(r.error, message);
    assert.equal(isEditDirty(t, edit(t, over)), true);
  }
  assert.equal(await count('SELECT COUNT(*) AS n FROM sync_queue'), 0);
  assert.equal((await repo.getById(t.id))!.updated_at, t.updated_at);
  console.log(`ok: ${bad.length} invalid inputs refused, nothing written`);
}

// 7. Amounts: exact paise, no float drift, equal value in another spelling is not a change.
{
  const { repo, t, apply } = await setup();
  assert.ok((() => { const r = planEdit(t, edit(t, { amount: '120.50' })); return r.ok && !r.changed; })(), '120.50 == 120.5');
  await apply(t, edit(t, { amount: '0.07' }));
  assert.equal((await repo.getById(t.id))!.amount_paise, 7);
  await apply((await repo.getById(t.id))!, edit((await repo.getById(t.id))!, { amount: '1234567.89' }));
  assert.equal((await repo.getById(t.id))!.amount_paise, 123456789);
  console.log('ok: amounts stored as exact paise');
}

// 8. Attachments stay with the edited transaction (the id never changes).
{
  const { db, repo, t, apply } = await setup();
  await db.runAsync(`INSERT INTO transaction_attachments (id, transaction_id, user_id, local_path, upload_status, attachment_type, page_index, created_at, updated_at)
                     VALUES ('att-edit', ?, 'u1', 'file:///p.jpg', 'local', 'photo', 0, '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z')`, t.id);
  await apply(t, edit(t, { merchant: 'AutoTest Renamed', amount: '999' }));
  const a = await db.getFirstAsync<{ transaction_id: string }>("SELECT transaction_id FROM transaction_attachments WHERE id = 'att-edit'");
  assert.equal(a!.transaction_id, t.id);
  assert.equal((await repo.getById(t.id))!.counterparty, 'AutoTest Renamed');
  console.log('ok: attachments remain on the edited transaction');
}

// 9. Prefill round-trip: phone with a known dial code, and a note that only differs by surrounding spaces is not a change.
{
  const { repo, t } = await setup();
  await repo.update(t.id, { merchant_phone: '+919876543210' });
  const tx = (await repo.getById(t.id))!;
  const f = formFromTransaction(tx, ['+91', '+1', '+971']);
  assert.deepEqual([f.dial, f.phone], ['+91', '9876543210']);
  const r = planEdit(tx, { ...f, note: `  ${tx.description}  ` });
  assert.ok(r.ok && !r.changed);
  console.log('ok: prefill round-trips without spurious changes');
}

console.log('transactionEdit: all passed');
