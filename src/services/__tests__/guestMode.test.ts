/** Group 1: guest mode, consent-gated import, session restore. */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import { getGuestDataSummary, importGuestData, isGuestModeChosen, setGuestModeChosen } from '../guestModeService.ts';
import { restoreSession } from '../sessionRestore.ts';
import type { IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };
const B: Session = { user: { id: 'user-B', full_name: 'B', email: 'b@x.com' }, access_token: 'tok-B', refresh_token: 'r', token_type: 'bearer' };

async function fresh() { const db = new NodeSqliteAdapter(); await runMigrations(db); return { db, repo: new TransactionRepository(db) }; }
const tx = (over: Record<string, unknown> = {}) => ({ amount: 10, direction: 'expense' as const, counterparty: 'Cafe', category: 'Food & Dining', ...over });

async function firstLaunchAndPersistence() {
  const { db, repo } = await fresh();
  assert.equal(await isGuestModeChosen(db), false, 'first launch: no choice made');
  await setGuestModeChosen(true, db);
  assert.equal(await isGuestModeChosen(db), true, 'choice persists (survives reopen: same DB)');
  const created = await repo.create(tx());
  assert.equal(created.user_id, null);
  await repo.update(created.id, { counterparty: 'Cafe 2' });
  const guest = await repo.getAll({ userId: null });
  assert.equal(guest.length, 1); assert.equal(guest[0].counterparty, 'Cafe 2');
  assert.equal((await repo.getAll({ userId: 'user-A' })).length, 0, 'guest data invisible to accounts');
  db.close();
}

async function guestDataIsNeverUploaded() {
  const { db, repo } = await fresh();
  await repo.create(tx());
  const calls: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { calls.push(String(u)); return new Response(JSON.stringify({ results: [], transactions: [], categories: [], server_time: new Date().toISOString(), next_cursor: null, has_more: false, total_active_count: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
  try {
    const r = await new SyncEngine(db).pushPendingChanges(A);
    assert.equal(r.pushed, 0);
    assert.equal(calls.filter((c) => /push/.test(c)).length, 0, 'no push request carries guest rows');
    const row = await db.getFirstAsync<{ sync_status: string }>('SELECT sync_status FROM transactions');
    assert.equal(row!.sync_status, 'pending_create', 'not marked synced');
    assert.equal((await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) c FROM sync_queue'))!.c, 1, 'queue item preserved');
  } finally { globalThis.fetch = prev; db.close(); }
}

async function importRequiresCallAndWorks() {
  const { db, repo } = await fresh();
  const g1 = await repo.create(tx({ reference_id: 'REF0001' }));
  const g2 = await repo.create(tx({ amount: 20 }));
  const deleted = await repo.create(tx({ amount: 30 })); await repo.delete(deleted.id);
  assert.deepEqual(await getGuestDataSummary(db), { transactionCount: 2, budgetCount: 0, categoryCount: 0 }, 'summary only counts live guest rows');
  // Without an explicit import call, signing in leaves guest rows untouched (consent gate lives in the caller).
  assert.equal((await repo.getAll({ userId: 'user-A' })).length, 0);
  const res = await importGuestData('user-A', db);
  assert.deepEqual(res, { imported: 2, skippedDuplicates: 0 });
  const mine = await repo.getAll({ userId: 'user-A' });
  assert.deepEqual(mine.map((t) => t.id).sort(), [g1.id, g2.id].sort(), 'ids preserved');
  assert.equal((await getGuestDataSummary(db)).transactionCount, 0);
  const q = await db.getAllAsync<{ entity_id: string; payload: string }>("SELECT entity_id, payload FROM sync_queue WHERE operation = 'create' AND entity_id IN (?, ?)", g1.id, g2.id);
  assert.equal(q.length, 2); for (const row of q) assert.equal(JSON.parse(row.payload).user_id, 'user-A');
  // Imported rows now push under A only, never under B.
  const pushed: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => { const body = JSON.parse(init!.body!); pushed.push(...body.operations.map((o: { entity_id: string }) => o.entity_id)); return new Response(JSON.stringify({ results: body.operations.map((o: { operation_id: string; entity_id: string }) => ({ operation_id: o.operation_id, entity_id: o.entity_id, status: 'applied', server_version: 1 })), server_time: new Date().toISOString() }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
  try {
    const asB = await new SyncEngine(db).pushPendingChanges(B);
    assert.equal(asB.pushed, 0); assert.equal(pushed.length, 0, 'account B cannot upload A\'s imported rows');
  } finally { globalThis.fetch = prev; }
  db.close();
}

async function importDedupesAndIsAtomic() {
  const { db, repo } = await fresh();
  await repo.create(tx({ user_id: 'user-A', reference_id: 'REFDUP1' }));
  await repo.create(tx({ user_id: null, reference_id: 'REFDUP1' }));       // duplicate of A's record
  const keep = await repo.create(tx({ amount: 55, reference_id: 'REFNEW1' }));
  const res = await importGuestData('user-A', db);
  assert.deepEqual(res, { imported: 1, skippedDuplicates: 1 });
  assert.equal((await repo.getAll({ userId: 'user-A' })).filter((t) => t.id === keep.id).length, 1);
  assert.equal((await getGuestDataSummary(db)).transactionCount, 1, 'duplicate stays local, not lost');
  // Atomic rollback: force a failure mid-import.
  const { db: db2, repo: repo2 } = await fresh();
  await repo2.create(tx()); await repo2.create(tx({ amount: 2 }));
  let queueUpdates = 0;
  const failing: IDatabase = {
    getFirstAsync: (q, ...p) => db2.getFirstAsync(q, ...p),
    getAllAsync: (q, ...p) => db2.getAllAsync(q, ...p),
    execAsync: (q) => db2.execAsync(q),
    runAsync: (q, ...p) => (/UPDATE sync_queue/.test(q) && ++queueUpdates >= 2 ? Promise.reject(new Error('boom')) : db2.runAsync(q, ...p)),
  };
  await assert.rejects(importGuestData('user-A', failing));
  assert.equal((await getGuestDataSummary(db2)).transactionCount, 2, 'rolled back: all still guest');
  assert.equal((await repo2.getAll({ userId: 'user-A' })).length, 0);
  db.close(); db2.close();
}

async function accountSwitchKeepsDataSeparate() {
  const { db, repo } = await fresh();
  await repo.create(tx({ user_id: 'user-A' }));
  await repo.create(tx({ user_id: 'user-B', amount: 99 }));
  await repo.create(tx({ amount: 5 }));
  assert.equal((await repo.getAll({ userId: 'user-A' })).length, 1);
  assert.equal((await repo.getAll({ userId: 'user-B' })).length, 1);
  assert.equal((await repo.getAll({ userId: null })).length, 1);
  db.close();
}

async function sessionRestore() {
  const stored = A;
  const refreshed = { ...A, access_token: 'new' };
  assert.deepEqual(await restoreSession(stored, async () => refreshed), { session: refreshed, status: 'refreshed' });
  const net = Object.assign(new Error('net'), { kind: 'connection' });
  assert.deepEqual(await restoreSession(stored, async () => { throw net; }), { session: stored, status: 'offline' }, 'offline keeps session');
  const s500 = Object.assign(new Error('x'), { kind: 'server', status: 503 });
  assert.equal((await restoreSession(stored, async () => { throw s500; })).status, 'offline');
  const s401 = Object.assign(new Error('x'), { kind: 'client', status: 401 });
  assert.deepEqual(await restoreSession(stored, async () => { throw s401; }), { session: null, status: 'expired' });
  const s429 = Object.assign(new Error('x'), { kind: 'client', status: 429 });
  assert.equal((await restoreSession(stored, async () => { throw s429; })).status, 'offline', 'rate limiting is not a rejection');
}

await firstLaunchAndPersistence();
await guestDataIsNeverUploaded();
await importRequiresCallAndWorks();
await importDedupesAndIsAtomic();
await accountSwitchKeepsDataSeparate();
await sessionRestore();
console.log('guestMode tests passed');
