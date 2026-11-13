import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { SyncEngine } from '../syncEngine.ts';

type Reply = { status: number; json: unknown } | 'network';
let handler: (body: any) => Reply = () => ({ status: 200, json: {} });
let pushCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (url.includes('/sync/pull')) {
    return new Response(JSON.stringify({ transactions: [], categories: [], has_more: false, next_cursor: null, total_active_count: 0, server_time: new Date().toISOString() }), { status: 200 });
  }
  pushCalls++;
  const r = handler(JSON.parse(String(init?.body)));
  if (r === 'network') throw new TypeError('network down');
  return new Response(JSON.stringify(r.json), { status: r.status });
}) as typeof fetch;

const session = { access_token: 't', user: { id: 'u1', email: 'a@b.c' } };
const ack = (item: any, extra: object = {}) => ({ operation_id: item.operation_id, entity_id: item.entity_id, operation: item.operation, status: 'synced', server_version: 1, ...extra });
const okAll = (b: any): Reply => ({ status: 200, json: { results: b.items.map((i: any) => ack(i)), server_time: '' } });

async function setup() {
  const adapter = new NodeSqliteAdapter();
  await runMigrations(adapter);
  return { adapter, engine: new SyncEngine(adapter), tx: new TransactionRepository(adapter), q: new SyncQueueRepository(adapter) };
}
const mk = (tx: TransactionRepository, name: string, extra: object = {}) =>
  tx.create({ user_id: 'u1', amount: 10, direction: 'expense', counterparty: name, category: 'Food', source: 'manual', sync_status: 'pending_create', ...extra } as any);
// Same predicate the Profile screen uses (profileStats): not synced, not deleted, owned.
const profilePending = async (tx: TransactionRepository) =>
  (await tx.filterByDate('2000-01-01', '2100-01-01')).filter((t) => !t.deleted_at && t.sync_status !== 'synced' && t.user_id).length;

// 1. Server dedupes by fingerprint and answers with the EXISTING row's id: the local row moves to that canonical id and
//    becomes synced there (it must not stay synced under an id the server does not know: later edits would duplicate it).
{
  const { engine, tx, q } = await setup();
  const t = await mk(tx, 'Dup', { fingerprint: 'fp-1' });
  const canonical = '11111111-1111-4111-8111-111111111111';
  handler = (b) => ({ status: 200, json: { results: b.items.map((i: any) => ack(i, { entity_id: canonical })), server_time: '' } });
  const r = await engine.pushPendingChanges(session);
  assert.equal(r.pushed, 1);
  assert.equal(await tx.getById(t.id), null);
  assert.equal((await tx.getById(canonical))!.sync_status, 'synced');
  assert.equal((await tx.getById(canonical))!.counterparty, 'Dup');
  assert.equal(await q.getPendingCount(), 0);
  assert.equal(await profilePending(tx), 0);
  console.log('ok: duplicate-ack with different entity_id moves the row to the canonical id and clears pending');
}

// 2. Multiple transactions, partial success: only acknowledged ones leave the queue.
{
  const { engine, tx, q } = await setup();
  const a = await mk(tx, 'A'); const b = await mk(tx, 'B'); const c = await mk(tx, 'C');
  handler = (body) => ({ status: 200, json: { results: body.items.filter((i: any) => i.entity_id !== b.id).map((i: any) => ack(i)), server_time: '' } });
  await engine.pushPendingChanges(session);
  assert.equal((await tx.getById(a.id))!.sync_status, 'synced');
  assert.equal((await tx.getById(c.id))!.sync_status, 'synced');
  assert.equal((await tx.getById(b.id))!.sync_status, 'pending_create');
  assert.equal(await q.getPendingCount(), 1);
  assert.equal(await profilePending(tx), 1);
  console.log('ok: partial ack keeps only the unacknowledged item');
}

// 3. Network failure and HTTP 500 keep everything queued.
for (const mode of ['network', 500] as const) {
  const { engine, tx, q } = await setup();
  await mk(tx, 'X'); await mk(tx, 'Y');
  handler = () => (mode === 'network' ? 'network' : { status: 500, json: { detail: 'boom' } });
  await assert.rejects(engine.pushPendingChanges(session));
  assert.equal(await q.getPendingCount(), 2);
  assert.equal(await profilePending(tx), 2);
  console.log(`ok: ${mode} keeps queue intact`);
}

// 4. 401 does not touch the queue; a malformed 200 acknowledges nothing.
{
  const { engine, tx, q } = await setup();
  await mk(tx, 'X');
  handler = () => ({ status: 401, json: { detail: 'expired' } });
  await assert.rejects(engine.pushPendingChanges(session));
  assert.equal(await q.getPendingCount(), 1);
  assert.equal(await profilePending(tx), 1);
  handler = () => ({ status: 200, json: { nope: true } });
  await assert.rejects(engine.pushPendingChanges(session));
  assert.equal(await q.getPendingCount(), 1);
  assert.equal(await profilePending(tx), 1);
  console.log('ok: 401 and malformed response keep queue');
}

// 5. One bad item in a 422 batch fails only itself; the others sync, and it is not retried forever.
{
  const { engine, tx } = await setup();
  const good1 = await mk(tx, 'G1'); const bad = await mk(tx, 'BAD'); const good2 = await mk(tx, 'G2');
  handler = (b) => b.items.some((i: any) => i.entity_id === bad.id) ? { status: 422, json: { detail: 'invalid' } } : okAll(b);
  await engine.pushPendingChanges(session).catch(() => undefined);
  assert.equal((await tx.getById(good1.id))!.sync_status, 'synced');
  assert.equal((await tx.getById(good2.id))!.sync_status, 'synced');
  assert.equal((await tx.getById(bad.id))!.sync_status, 'failed');
  pushCalls = 0;
  await engine.pushPendingChanges(session);
  assert.equal(pushCalls, 0);
  console.log('ok: 422 isolates the bad item');
}

// 6. Items stranded by an older build's whole-batch failure are retried and recover.
{
  const { engine, tx, q } = await setup();
  const t = await mk(tx, 'Stranded');
  const item = (await q.peek(10))[0];
  await q.markFailed(item.id, 'PERMANENT_ERROR_422', '9999-12-31T23:59:59Z');
  await tx.updateSyncStatus(t.id, 'failed');
  handler = okAll;
  await engine.pushPendingChanges(session);
  assert.equal((await tx.getById(t.id))!.sync_status, 'synced');
  assert.equal(await q.getPendingCount(), 0);
  console.log('ok: stranded failures recover');
}

// 7. Restart: a fresh engine over the same database still finds the pending items; concurrent triggers are single-flight.
{
  const { adapter, tx } = await setup();
  await mk(tx, 'Persist');
  const restarted = new SyncEngine(adapter);
  handler = okAll;
  const [r1, r2] = await Promise.all([restarted.triggerSync(session), restarted.triggerSync(session)]);
  assert.ok([r1, r2].some((r) => r.errors.includes('Sync already in progress')));
  assert.equal(await profilePending(tx), 0);
  console.log('ok: restart + concurrent triggers');
}

// 8. Waiting-for-review is independent of waiting-to-sync.
{
  const { tx } = await setup();
  await mk(tx, 'Review', { sync_status: 'synced', verification_status: 'needs_review' });
  assert.equal(await profilePending(tx), 0);
  console.log('ok: needs_review does not count as waiting to sync');
}
console.log('syncReliability: all passed');
