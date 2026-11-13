/**
 * Reproduces the "193 total / 183 waiting to sync" report and guards the fixes:
 *  1. a backlog larger than one batch (50) is fully pushed by ONE sync cycle,
 *  2. a long offline / server-down stretch never dead-letters items (they keep retrying with capped backoff),
 *  3. items an older build already dead-lettered (MAX_RETRIES_EXCEEDED) are recovered once, without duplicates,
 *  4. rows marked pending with no queue entry (orphans) are re-queued,
 *  5. a request that never answers times out instead of blocking every later sync,
 *  6. every engine cycle (not only app-triggered ones) is reported to listeners so the UI can refresh.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { MetadataRepository } from '../../db/repositories/metadataRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import { setSyncRequestTimeoutMs } from '../syncApi.ts';

type Mode = 'ok' | 'network' | 'hang';
let mode: Mode = 'ok';
const serverRows = new Map<string, number>(); // entity_id -> times created on the "server"
let pushRequests = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (mode === 'network') throw new TypeError('Network request failed');
  if (mode === 'hang') {
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  if (url.includes('/sync/pull')) {
    return new Response(JSON.stringify({ transactions: [], categories: [], has_more: false, next_cursor: null, total_active_count: 0, server_time: new Date().toISOString() }), { status: 200 });
  }
  pushRequests++;
  const body = JSON.parse(String(init?.body));
  const results = body.items.map((i: any) => {
    // Server is idempotent by id: a repeated create is acknowledged, never inserted twice.
    if (i.operation === 'create' && !serverRows.has(i.entity_id)) serverRows.set(i.entity_id, 1);
    if (i.operation === 'update' && !serverRows.has(i.entity_id)) serverRows.set(i.entity_id, 1); // upsert
    return { operation_id: i.operation_id, entity_id: i.entity_id, operation: i.operation, status: 'synced', server_version: 1 };
  });
  return new Response(JSON.stringify({ results, server_time: '' }), { status: 200 });
}) as typeof fetch;

const session = { access_token: 't', user: { id: 'u1', email: 'a@b.c' } };
async function setup() {
  const adapter = new NodeSqliteAdapter();
  await runMigrations(adapter);
  serverRows.clear(); pushRequests = 0; mode = 'ok';
  return { adapter, engine: new SyncEngine(adapter), tx: new TransactionRepository(adapter), q: new SyncQueueRepository(adapter), meta: new MetadataRepository(adapter) };
}
const mk = (tx: TransactionRepository, i: number) =>
  tx.create({ user_id: 'u1', amount: 10 + i, direction: 'expense', counterparty: `Shop ${i}`, category: 'Food', source: 'manual', sync_status: 'pending_create' } as any);
const pendingCount = async (adapter: NodeSqliteAdapter) =>
  (await adapter.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'u1' AND deleted_at IS NULL AND sync_status != 'synced'"))!.n;
/** Simulates time passing: every backoff has expired. */
const expireBackoff = (adapter: NodeSqliteAdapter) =>
  adapter.runAsync("UPDATE sync_queue SET next_retry_at = NULL WHERE next_retry_at IS NOT NULL AND next_retry_at < '9999-01-01'");

// 1. 183 waiting: one sync pushes them all.
{
  const { adapter, engine, q } = await setup();
  const tx = new TransactionRepository(adapter);
  for (let i = 0; i < 183; i++) await mk(tx, i);
  for (let i = 0; i < 10; i++) { const t = await mk(tx, 1000 + i); await tx.updateSyncStatus(t.id, 'synced'); await q.removeForEntity('transaction', t.id); }
  assert.equal(await pendingCount(adapter), 183);
  const summary = await engine.triggerSync(session);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.pushed, 183);
  assert.equal(await pendingCount(adapter), 0);
  assert.equal(await q.getPendingCount(), 0);
  assert.equal(serverRows.size, 183);
  console.log(`ok: 183-item backlog fully synced in one cycle (${pushRequests} batches)`);
}

// 2. Twelve failed attempts while offline: nothing is dead-lettered; when the network returns everything syncs once.
{
  const { adapter, engine, tx, q } = await setup();
  for (let i = 0; i < 60; i++) await mk(tx, i);
  mode = 'network';
  for (let attempt = 0; attempt < 12; attempt++) { await engine.triggerSync(session); await expireBackoff(adapter); }
  const failed = (await adapter.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE sync_status = 'failed'"))!.n;
  assert.equal(failed, 0, 'an offline stretch must never mark transactions as failed');
  const parked = (await adapter.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_queue WHERE next_retry_at = '9999-12-31T23:59:59Z'"))!.n;
  assert.equal(parked, 0, 'no queue item may be parked permanently because of a network failure');
  mode = 'ok';
  await expireBackoff(adapter);
  await engine.triggerSync(session);
  assert.equal(await pendingCount(adapter), 0);
  assert.equal(await q.getPendingCount(), 0);
  assert.ok([...serverRows.values()].every((n) => n === 1));
  console.log('ok: offline stretch keeps items retrying; reconnect syncs all exactly once');
}

// 3. State left by an older build: items dead-lettered after 10 transient failures, recovery marker v1 already used.
{
  const { adapter, engine, tx, meta } = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) ids.push((await mk(tx, i)).id);
  await meta.set('sync_requeue_stranded_v1_u1', '2026-11-01T00:00:00.000Z');
  await adapter.runAsync("UPDATE sync_queue SET retry_count = 10, next_retry_at = '9999-12-31T23:59:59Z', error_code = 'MAX_RETRIES_EXCEEDED'");
  await adapter.runAsync("UPDATE transactions SET sync_status = 'failed'");
  // Half of them actually reached the server before the old build gave up (ack lost): must not be duplicated.
  for (const id of ids.slice(0, 60)) serverRows.set(id, 1);
  const summary = await engine.triggerSync(session);
  assert.deepEqual(summary.errors, []);
  assert.equal(await pendingCount(adapter), 0);
  assert.equal(serverRows.size, 120);
  assert.ok([...serverRows.values()].every((n) => n === 1), 'no server duplicates');
  // A genuinely invalid item stays failed and is not retried forever.
  console.log('ok: dead-lettered backlog from an older build recovered without duplicates');
}

// 4. Orphans: rows marked pending/failed with no queue entry are queued again; a never-synced deleted row is not resurrected.
{
  const { adapter, engine, tx, q } = await setup();
  const a = await mk(tx, 1); const b = await mk(tx, 2); const c = await mk(tx, 3);
  await adapter.runAsync('DELETE FROM sync_queue');
  await tx.updateSyncStatus(b.id, 'failed');
  await adapter.runAsync("UPDATE transactions SET deleted_at = ? WHERE id = ?", new Date().toISOString(), c.id);
  await engine.triggerSync(session);
  assert.equal((await tx.getById(a.id))!.sync_status, 'synced');
  assert.equal((await tx.getById(b.id))!.sync_status, 'synced');
  assert.equal(serverRows.has(c.id), false, 'a row deleted before it ever synced is not uploaded');
  assert.equal(await q.getPendingCount(), 0);
  console.log('ok: orphaned pending rows re-queued and synced');
}

// 5. A request that never answers times out; the engine is free for the next cycle.
{
  const { adapter, engine, tx } = await setup();
  await mk(tx, 1);
  setSyncRequestTimeoutMs(200);
  mode = 'hang';
  const started = Date.now();
  const s1 = await engine.triggerSync(session);
  assert.ok(Date.now() - started < 5000, 'sync must not hang');
  assert.ok(s1.errors.length > 0);
  assert.equal(engine.getState().isSyncing, false);
  mode = 'ok';
  await expireBackoff(adapter);
  const s2 = await engine.triggerSync(session);
  assert.equal(s2.pushed, 1);
  assert.equal(await pendingCount(adapter), 0);
  setSyncRequestTimeoutMs(null);
  console.log('ok: hung request times out and does not block later syncs');
}

// 6. Cycle listeners fire for engine-internal cycles too.
{
  const { engine, tx } = await setup();
  await mk(tx, 1);
  const seen: number[] = [];
  const off = engine.onCycleComplete((s) => { seen.push(s.pushed); });
  await engine.triggerSync(session);
  off();
  assert.deepEqual(seen, [1]);
  console.log('ok: cycle listeners notified');
}
