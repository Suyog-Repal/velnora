/**
 * Sync identity and failure classification (Stage 2 of the sync recovery):
 *  1. a per-item SERVER failure (internal_error, or an unclassified database error from an older server, e.g. the
 *     "UndefinedColumn txn_kind" that stranded the 183-item backlog) is retried with capped backoff and never parked,
 *  2. a per-item REJECTION (validation_error) is parked as failed with its reason, without blocking the other items,
 *  3. a create the server matched to an existing row answers with the canonical id: the local row, its attachments and
 *     its queue entry move to that id, and later edits are sent under it (no duplicate anywhere),
 *  4. when the device already holds the canonical row, the local second copy is merged into it (one row, attachments kept),
 *  5. a copy the user deleted while its create was in flight never deletes the row the user kept,
 *  6. an edit made while a push is in flight is not lost: it stays queued and is sent next,
 *  7. pull never inserts a second copy of a payment the device holds under another id (reference OR fingerprint).
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { SyncEngine, isPermanentItemError } from '../syncEngine.ts';

type Responder = (item: any) => Record<string, unknown>;
let respond: Responder = () => ({});
let duringPush: (() => Promise<void>) | null = null;
let pullRows: any[] = [];
const sentItems: any[] = [];
const PERMANENT = '9999-12-31T23:59:59Z';

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (url.includes('/sync/pull')) {
    const rows = pullRows; pullRows = [];
    return new Response(JSON.stringify({ transactions: rows, categories: [], has_more: false, next_cursor: null, total_active_count: rows.length, server_time: new Date().toISOString() }), { status: 200 });
  }
  const body = JSON.parse(String(init?.body));
  sentItems.push(...body.items);
  if (duringPush) { const f = duringPush; duringPush = null; await f(); }
  const results = body.items.map((i: any) => ({
    operation_id: i.operation_id, entity_id: i.entity_id, operation: i.operation, status: 'synced', server_version: 1, ...respond(i),
  }));
  return new Response(JSON.stringify({ results, server_time: new Date().toISOString() }), { status: 200 });
}) as typeof fetch;

const session = { access_token: 't', user: { id: 'u1', email: 'a@b.c' } };
async function setup() {
  const adapter = new NodeSqliteAdapter();
  await runMigrations(adapter);
  respond = () => ({}); duringPush = null; pullRows = []; sentItems.length = 0;
  return { adapter, engine: new SyncEngine(adapter), tx: new TransactionRepository(adapter), q: new SyncQueueRepository(adapter) };
}
const mk = (tx: TransactionRepository, label: string, extra: Record<string, unknown> = {}) =>
  tx.create({ user_id: 'u1', amount: 120, direction: 'expense', counterparty: `AutoTest ${label}`, category: 'Food', source: 'manual', sync_status: 'pending_create', ...extra } as any);
const one = <T,>(adapter: NodeSqliteAdapter, sql: string, ...p: unknown[]) => adapter.getFirstAsync<T>(sql, ...p);
const count = async (adapter: NodeSqliteAdapter, sql: string, ...p: unknown[]) => (await one<{ n: number }>(adapter, sql, ...p))!.n;
const expireBackoff = (adapter: NodeSqliteAdapter) =>
  adapter.runAsync(`UPDATE sync_queue SET next_retry_at = NULL WHERE next_retry_at IS NOT NULL AND next_retry_at <> '${PERMANENT}'`);
const attach = (adapter: NodeSqliteAdapter, id: string, txId: string) =>
  adapter.runAsync(`INSERT INTO transaction_attachments (id, transaction_id, user_id, local_path, upload_status, attachment_type, page_index, created_at, updated_at)
                    VALUES (?, ?, 'u1', 'file:///photo.jpg', 'local', 'photo', 0, '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z')`, id, txId);

// 0. Classification table
{
  assert.equal(isPermanentItemError({ error_code: 'internal_error', error: 'x' }), false);
  assert.equal(isPermanentItemError({ error_code: 'validation_error', error: 'Invalid value for: payload.txn_kind' }), true);
  assert.equal(isPermanentItemError({ error: '(psycopg.errors.UndefinedColumn) column transactions.txn_kind does not exist' }), false);
  assert.equal(isPermanentItemError({ error: 'Missing required fields for create (amount, direction, counterparty, category)' }), true);
  assert.equal(isPermanentItemError({ error: 'Forbidden: entity belongs to another user' }), true);
  console.log('ok: error classification (codes and legacy messages)');
}

// 1. The production failure shape (older server, raw database error per item) never parks anything.
{
  const { adapter, engine } = await setup();
  const tx = new TransactionRepository(adapter);
  for (let i = 0; i < 5; i++) await mk(tx, `backlog ${i}`);
  respond = () => ({ status: 'error', server_version: 0, error: '(psycopg.errors.UndefinedColumn) column transactions.txn_kind does not exist' });
  for (let cycle = 0; cycle < 15; cycle++) { await engine.triggerSync(session); await expireBackoff(adapter); }
  assert.equal(await count(adapter, `SELECT COUNT(*) AS n FROM sync_queue WHERE next_retry_at = '${PERMANENT}'`), 0, 'never parked');
  assert.equal(await count(adapter, "SELECT COUNT(*) AS n FROM transactions WHERE sync_status = 'failed'"), 0, 'never marked failed');
  const backoff = await one<{ r: string }>(adapter, 'SELECT MAX(next_retry_at) AS r FROM sync_queue');
  respond = () => ({});
  await expireBackoff(adapter);
  await engine.triggerSync(session);
  assert.equal(await count(adapter, "SELECT COUNT(*) AS n FROM transactions WHERE sync_status = 'synced'"), 5);
  assert.equal(await count(adapter, 'SELECT COUNT(*) AS n FROM sync_queue'), 0);
  void backoff;
  console.log('ok: per-item server failures retry with capped backoff and sync once the server is fixed');
}

// 1b. Backoff for per-item server failures is capped at 15 minutes (no aggressive loop, no unbounded wait).
{
  const { adapter, engine } = await setup();
  const tx = new TransactionRepository(adapter);
  await mk(tx, 'cap');
  respond = () => ({ status: 'error', server_version: 0, error_code: 'internal_error', error: 'The server could not apply this change.' });
  await adapter.runAsync('UPDATE sync_queue SET retry_count = 30');
  const before = Date.now();
  await engine.triggerSync(session);
  const next = Date.parse((await one<{ r: string }>(adapter, 'SELECT next_retry_at AS r FROM sync_queue'))!.r);
  assert.ok(next - before <= 15 * 60_000 + 2000 && next - before >= 14 * 60_000, `backoff ${next - before}ms`);
  console.log('ok: per-item retry backoff capped at 15 minutes');
}

// 2. A rejected item is parked with its reason; the others in the batch are synced.
{
  const { adapter, engine } = await setup();
  const tx = new TransactionRepository(adapter);
  const bad = await mk(tx, 'invalid');
  for (let i = 0; i < 3; i++) await mk(tx, `valid ${i}`);
  respond = (i) => (i.entity_id === bad.id ? { status: 'error', server_version: 0, error_code: 'validation_error', error: 'Invalid value for: payload.txn_kind' } : {});
  await engine.triggerSync(session);
  assert.equal((await tx.getById(bad.id))!.sync_status, 'failed');
  const q = await one<{ next_retry_at: string; error_code: string }>(adapter, 'SELECT next_retry_at, error_code FROM sync_queue WHERE entity_id = ?', bad.id);
  assert.equal(q!.next_retry_at, PERMANENT);
  assert.match(q!.error_code, /payload\.txn_kind/);
  assert.equal(await count(adapter, "SELECT COUNT(*) AS n FROM transactions WHERE sync_status = 'synced'"), 3);
  console.log('ok: rejected item parked with reason, valid items synced');
}

// 3. Canonical id adopted: row, attachment and later edits move to the server's id.
{
  const { adapter, engine, q } = await setup();
  const tx = new TransactionRepository(adapter);
  const local = await mk(tx, 'dedup', { reference_id: 'AUTOTESTREF1' });
  await attach(adapter, 'att-1', local.id);
  const canonical = '11111111-1111-4111-8111-111111111111';
  respond = (i) => (i.operation === 'create' ? { entity_id: canonical, server_version: 3 } : { server_version: 4 });
  await engine.triggerSync(session);
  assert.equal(await tx.getById(local.id), null, 'device id is gone');
  const moved = (await tx.getById(canonical))!;
  assert.equal(moved.counterparty, 'AutoTest dedup');
  assert.equal(moved.sync_status, 'synced');
  assert.equal(moved.server_version, 3);
  assert.equal((await one<{ transaction_id: string }>(adapter, "SELECT transaction_id FROM transaction_attachments WHERE id = 'att-1'"))!.transaction_id, canonical);
  assert.equal(await q.getPendingCount(), 0);
  await tx.update(canonical, { description: 'AutoTest edited' } as any);
  sentItems.length = 0;
  await engine.triggerSync(session);
  assert.equal(sentItems.length, 1);
  assert.equal(sentItems[0].entity_id, canonical, 'edit is sent under the canonical id');
  assert.equal(await count(adapter, "SELECT COUNT(*) AS n FROM transactions WHERE reference_id = 'AUTOTESTREF1'"), 1);
  console.log('ok: canonical id adopted (row, attachment, queue, later edits)');
}

// 4. Device already holds the canonical row: the local second copy is merged into it.
{
  const { adapter, engine } = await setup();
  const tx = new TransactionRepository(adapter);
  const canonical = '22222222-2222-4222-8222-222222222222';
  const kept = await mk(tx, 'kept', { reference_id: 'AUTOTESTREF2' });
  // simulate the canonical row having been pulled earlier under the server id
  await tx.adoptCanonicalId(kept.id, canonical);
  await tx.updateSyncStatus(canonical, 'synced', 1);
  await adapter.runAsync("DELETE FROM sync_queue");
  const copy = await mk(tx, 'copy', { fingerprint: 'fp-copy' });
  await attach(adapter, 'att-copy', copy.id);
  respond = (i) => (i.entity_id === copy.id ? { entity_id: canonical, server_version: 1 } : {});
  await engine.triggerSync(session);
  assert.equal(await tx.getById(copy.id), null);
  assert.ok(await tx.getById(canonical));
  assert.equal((await one<{ transaction_id: string }>(adapter, "SELECT transaction_id FROM transaction_attachments WHERE id = 'att-copy'"))!.transaction_id, canonical);
  assert.equal(await count(adapter, 'SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL'), 1);
  assert.equal(await count(adapter, 'SELECT COUNT(*) AS n FROM sync_queue'), 0);
  console.log('ok: second local copy merged into the canonical row (attachments kept)');
}

// 5. Copy deleted while in flight: the kept canonical row is never deleted on the server.
{
  const { adapter, engine } = await setup();
  const tx = new TransactionRepository(adapter);
  const canonical = '33333333-3333-4333-8333-333333333333';
  const kept = await mk(tx, 'kept', { reference_id: 'AUTOTESTREF3' });
  await tx.adoptCanonicalId(kept.id, canonical);
  await tx.updateSyncStatus(canonical, 'synced', 1);
  await adapter.runAsync('DELETE FROM sync_queue');
  const copy = await mk(tx, 'duplicate', { reference_id: 'AUTOTESTREF3' });
  respond = (i) => (i.entity_id === copy.id ? { entity_id: canonical, server_version: 1 } : {});
  duringPush = async () => { await adapter.runAsync('UPDATE transactions SET deleted_at = ? WHERE id = ?', new Date().toISOString(), copy.id); };
  await engine.triggerSync(session);
  sentItems.length = 0;
  await engine.triggerSync(session);
  assert.equal(sentItems.filter((i) => i.operation === 'delete').length, 0, 'no delete is sent for the kept row');
  assert.equal((await tx.getById(canonical))!.deleted_at, null, 'kept row stays active');
  assert.equal(await count(adapter, 'SELECT COUNT(*) AS n FROM sync_queue'), 0);
  console.log('ok: deleting a duplicate copy in flight never deletes the kept row');
}

// 6. Edit made while the push is in flight is kept and sent next.
{
  const { adapter, engine, q } = await setup();
  const tx = new TransactionRepository(adapter);
  const t = await mk(tx, 'inflight');
  duringPush = async () => { await tx.update(t.id, { description: 'AutoTest edited mid-flight' } as any); };
  await engine.triggerSync(session);
  const row = (await tx.getById(t.id))!;
  assert.notEqual(row.sync_status, 'synced', 'not synced: the edit has not reached the server yet');
  const queued = await one<{ operation: string; payload: string }>(adapter, 'SELECT operation, payload FROM sync_queue WHERE entity_id = ?', t.id);
  assert.equal(queued!.operation, 'update');
  assert.match(queued!.payload, /edited mid-flight/);
  sentItems.length = 0;
  await engine.triggerSync(session);
  assert.equal(sentItems.length, 1);
  assert.equal(sentItems[0].payload.description, 'AutoTest edited mid-flight');
  assert.equal((await tx.getById(t.id))!.sync_status, 'synced');
  assert.equal(await q.getPendingCount(), 0);
  console.log('ok: edit made during an in-flight push is not lost');
}

// 7. Pull never inserts a second copy held under another id (fingerprint-only payments too).
{
  const { adapter, engine } = await setup();
  const tx = new TransactionRepository(adapter);
  const held = await mk(tx, 'held', { fingerprint: 'fp-held' });
  await tx.updateSyncStatus(held.id, 'synced', 1);
  await adapter.runAsync('DELETE FROM sync_queue');
  pullRows = [{
    id: '44444444-4444-4444-8444-444444444444', user_id: 'u1', amount: '120.00', amount_paise: 12000, direction: 'expense',
    counterparty: 'AutoTest held', category: 'Food', description: '', transaction_date: new Date().toISOString(), source: 'manual',
    reference_id: null, fingerprint: 'fp-held', server_version: 1, sync_revision: 1, deleted_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }];
  await engine.triggerSync(session);
  assert.equal(await count(adapter, 'SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL'), 1);
  console.log('ok: pull does not duplicate a fingerprint-matched payment');
}

console.log('syncIdentity: all passed');
