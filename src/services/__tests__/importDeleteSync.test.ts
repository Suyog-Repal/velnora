/**
 * Import -> delete -> re-import, deletion reaching the server, an in-flight create racing a delete, and shared refresh.
 * Real services and SQLite (node:sqlite); the server is a small fake that follows the real one's rules
 * (create dedupes by reference and answers with the existing row's id; delete by id, else by reference).
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { setTransactionServiceAdapter, deleteTransaction, getTransactions } from '../transactionService.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import { getCashFlowSummary } from '../cashFlowService.ts';
import { parsePdfStatement } from '../pdfStatementParser.ts';
import { categorizeRows } from '../statementCategorizer.ts';
import { applyStatement, flagStatementOverlaps, previewStatement, defaultExcludedLines } from '../statementImport.ts';
import { createSharedRefresh } from '../sessionRefresh.ts';
import type { IDatabase } from '../../db/types.ts';

let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); passed += 1; console.log(`✓ ${name}`); }

const USER = 'user-1';
const session = { access_token: 't', user: { id: USER, email: 'a@b.c' } };

// ── fake server ──
interface ServerRow { id: string; reference_id: string | null; fingerprint: string | null; deleted_at: string | null; amount: number; direction: string; transaction_date?: string; counterparty?: string; category?: string }
const server = new Map<string, ServerRow>();
let pushCalls = 0;
let failNext: 'network' | null = null;
let beforeReply: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/sync/pull')) {
    return json({ transactions: [...server.values()].map((r) => ({ ...r, user_id: USER, counterparty: r.counterparty ?? 'x', category: r.category ?? 'c', description: '', transaction_date: r.transaction_date ?? new Date(2026, 9, 1).toISOString(), source: 'sms', server_version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })), categories: [], has_more: false, next_cursor: null, total_active_count: 0, server_time: new Date().toISOString() });
  }
  pushCalls += 1;
  if (failNext) { failNext = null; throw new TypeError('network down'); }
  const body = JSON.parse(String(init?.body));
  const results = body.items.map((i: any) => {
    const p = i.payload ?? {};
    const live = [...server.values()].filter((r) => !r.deleted_at);
    if (i.operation === 'create') {
      const hit = server.get(i.entity_id) ?? live.find((r) => p.reference_id && r.reference_id === p.reference_id);
      if (!hit) server.set(i.entity_id, { id: i.entity_id, reference_id: p.reference_id ?? null, fingerprint: p.fingerprint ?? null, deleted_at: null, amount: p.amount, direction: p.direction, transaction_date: p.transaction_date, counterparty: p.counterparty, category: p.category });
      return { operation_id: i.operation_id, entity_id: hit?.id ?? i.entity_id, operation: i.operation, status: 'synced', server_version: 1 };
    }
    if (i.operation === 'delete') {
      const row = server.get(i.entity_id) ?? live.find((r) => p.reference_id && r.reference_id === p.reference_id);
      if (row) row.deleted_at = new Date().toISOString();
      return { operation_id: i.operation_id, entity_id: row?.id ?? i.entity_id, operation: i.operation, status: 'synced', server_version: 2 };
    }
    return { operation_id: i.operation_id, entity_id: i.entity_id, operation: i.operation, status: 'synced', server_version: 2 };
  });
  if (beforeReply) { const f = beforeReply; beforeReply = null; await f(); }
  return json({ results, server_time: new Date().toISOString() });
}) as typeof fetch;

// ── a small statement in the real Google Pay layout ──
const row = (left: string, mid: string, amount = '') => `${left.padEnd(16)}${mid}`.padEnd(90 - amount.length) + amount;
const block = (date: string, time: string, who: string, id: string, account: string, amount: string) => [row(date, who, amount), row(time, `UPI Transaction ID: ${id}`), `${' '.repeat(16)}${account}`];
const STATEMENT = [[
  'Transaction statement', row('Transaction statement period', '', 'Sent') + '   Received', row('01 October 2026 - 31 October 2026', '', '₹143') + '   ₹200', row('Date & time', 'Transaction details', 'Amount'),
  ...block('01 Oct, 2026', '01:28 PM', 'Received from Asha Rao', '627404356150', 'Paid to State Bank of India 4823', '₹200'),
  ...block('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', '627425966121', 'Paid by State Bank of India 4823', '₹43'),
  ...block('01 Oct, 2026', '07:02 PM', 'Paid to Night canteen', '664027330542', 'Paid by State Bank of India 4823', '₹43'),
  ...block('02 Oct, 2026', '10:44 AM', 'Paid to Cafe Krishna', '627549880758', 'Paid by State Bank of India 4823', '₹57'),
]];

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  server.clear(); pushCalls = 0;
  const idb = db as unknown as IDatabase;
  return { db: idb, engine: new SyncEngine(db), repo: new TransactionRepository(db), q: new SyncQueueRepository(db) };
}

async function importStatement(db: IDatabase) {
  const parsed = parsePdfStatement(STATEMENT);
  assert.deepEqual(parsed.errors, []);
  const rows = await categorizeRows(db, USER, parsed.rows);
  const preview = await flagStatementOverlaps(db, USER, await previewStatement(db, USER, rows));
  const skipped = defaultExcludedLines(preview);
  const summary = await applyStatement(db, USER, preview, (p) => !skipped.has(p.row.line));
  return { preview, summary };
}
const live = (db: IDatabase) => db.getAllAsync<{ id: string; direction: string; amount_paise: number; reference_id: string; sync_status: string }>('SELECT id, direction, amount_paise, reference_id, sync_status FROM transactions WHERE deleted_at IS NULL AND user_id = ? ORDER BY transaction_date, created_at', USER);

async function main() {
  await test('import: income and expenses land in the ledger as read, and the month totals count them correctly', async () => {
    const { db } = await fresh();
    const { summary } = await importStatement(db);
    assert.equal(summary.added, 4);
    const rows = await live(db);
    assert.deepEqual(rows.map((r) => [r.direction, r.amount_paise, r.reference_id]), [['income', 20000, '627404356150'], ['expense', 4300, '627425966121'], ['expense', 4300, '664027330542'], ['expense', 5700, '627549880758']]);
    const flow = await getCashFlowSummary(db, USER, new Date(2026, 9, 15));
    assert.equal(flow.monthIncomePaise, 20000, 'received money is income');
    assert.equal(flow.monthExpensePaise, 14300, 'paid money is expense');
  });

  await test('delete then re-import: a deleted statement line is not an active duplicate and comes back once; the others are not doubled', async () => {
    const { db, repo } = await fresh();
    await importStatement(db);
    const [first, second] = await live(db);
    assert.ok(await repo.delete(second.id));
    const flowAfter = await getCashFlowSummary(db, USER, new Date(2026, 9, 15));
    assert.equal(flowAfter.monthExpensePaise, 10000, 'the deleted amount leaves the totals at once');
    const again = await importStatement(db);
    assert.deepEqual(again.preview.map((p) => p.status), ['already_imported', 'new', 'already_imported', 'already_imported'], 'only the deleted line is new');
    assert.equal(again.summary.added, 1);
    assert.equal(again.summary.alreadyImported, 3);
    const rows = await live(db);
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map((r) => r.reference_id)).size, 4);
    assert.equal(rows.filter((r) => r.id === first.id).length, 1);
    assert.equal((await getCashFlowSummary(db, USER, new Date(2026, 9, 15))).monthExpensePaise, 14300);
  });

  await test('re-importing everything after deleting everything brings back every line exactly once', async () => {
    const { db, repo } = await fresh();
    await importStatement(db);
    for (const r of await live(db)) await repo.delete(r.id);
    assert.equal((await live(db)).length, 0);
    const again = await importStatement(db);
    assert.deepEqual(again.preview.map((p) => p.status), ['new', 'new', 'new', 'new']);
    assert.equal((await live(db)).length, 4);
    assert.equal((await importStatement(db)).summary.added, 0, 'and a third import adds nothing');
  });

  await test('a deleted transaction stays deleted after a restart (new repository over the same database)', async () => {
    const { db, repo } = await fresh();
    await importStatement(db);
    const [gone] = await live(db);
    await repo.delete(gone.id);
    const restarted = new TransactionRepository(db as never);
    assert.equal((await restarted.getById(gone.id))!.deleted_at !== null, true);
    assert.equal((await getTransactions(USER)).some((t) => t.id === gone.id), false);
  });

  await test('sync: imported transactions reach the server, are marked synced only after the acknowledgement, and the queue empties', async () => {
    const { db, engine, q } = await fresh();
    await importStatement(db);
    assert.equal((await live(db)).every((r) => r.sync_status === 'pending_create'), true);
    assert.equal(await q.getPendingCount(), 4);
    failNext = 'network';
    await assert.rejects(engine.pushPendingChanges(session as never));
    assert.equal((await live(db)).every((r) => r.sync_status === 'pending_create'), true, 'a failed request marks nothing synced');
    assert.equal(server.size, 0);
    // the failed attempt backed the items off; make them eligible again, as time passing would
    await db.runAsync('UPDATE sync_queue SET next_retry_at = NULL');
    const r = await engine.pushPendingChanges(session as never);
    assert.equal(r.pushed, 4);
    assert.equal(server.size, 4);
    assert.equal((await live(db)).every((x) => x.sync_status === 'synced'), true);
    assert.equal(await q.getPendingCount(), 0);
  });

  await test('sync is idempotent: pushing again (a retry after a lost reply) creates no second server row', async () => {
    const { db, engine } = await fresh();
    await importStatement(db);
    await engine.pushPendingChanges(session as never);
    const before = server.size;
    await db.runAsync("UPDATE transactions SET sync_status = 'pending_create'");
    for (const t of await live(db)) await new SyncQueueRepository(db as never).enqueue({ entity_type: 'transaction', entity_id: t.id, operation: 'create', payload: JSON.stringify((await new TransactionRepository(db as never).getById(t.id))) });
    await engine.pushPendingChanges(session as never);
    assert.equal(server.size, before);
  });

  await test('deleting a synced transaction deletes it on the server; a pull afterwards does not bring it back', async () => {
    const { db, engine, repo } = await fresh();
    await importStatement(db);
    await engine.pushPendingChanges(session as never);
    const [victim] = await live(db);
    await repo.delete(victim.id);
    await engine.pushPendingChanges(session as never);
    assert.equal(server.get(victim.id)!.deleted_at !== null, true, 'the server row is deleted');
    await engine.pullRemoteChanges(session as never);
    assert.equal((await live(db)).some((r) => r.id === victim.id), false, 'a stale pull does not restore it');
    assert.equal((await live(db)).length, 3);
  });

  await test('a deletion made offline survives, is sent when the network returns, and a retry does not recreate anything', async () => {
    const { db, engine, repo, q } = await fresh();
    await importStatement(db);
    await engine.pushPendingChanges(session as never);
    const [victim] = await live(db);
    await repo.delete(victim.id);
    failNext = 'network';
    await assert.rejects(engine.pushPendingChanges(session as never));
    assert.equal(await q.getPendingCount(), 1, 'the deletion is still queued');
    assert.equal(server.get(victim.id)!.deleted_at, null);
    await db.runAsync('UPDATE sync_queue SET next_retry_at = NULL');
    await engine.pushPendingChanges(session as never);
    await db.runAsync('UPDATE sync_queue SET next_retry_at = NULL');
    await engine.pushPendingChanges(session as never);
    assert.equal(server.get(victim.id)!.deleted_at !== null, true);
    assert.equal(server.size, 4, 'no new row was created by the retries');
    assert.equal(await q.getPendingCount(), 0);
  });

  await test('delete after the server answered a create with another row\'s id: the server row is deleted by its reference', async () => {
    const { db, engine, repo } = await fresh();
    // the server already holds this payment (another device synced it first) under its own id
    server.set('server-row-1', { id: 'server-row-1', reference_id: '627425966121', fingerprint: null, deleted_at: null, amount: 43, direction: 'expense' });
    await importStatement(db);
    await engine.pushPendingChanges(session as never);
    const local = (await live(db)).find((r) => r.reference_id === '627425966121')!;
    assert.equal(local.sync_status, 'synced');
    await repo.delete(local.id);
    await engine.pushPendingChanges(session as never);
    assert.notEqual(server.get('server-row-1')!.deleted_at, null, 'the server copy is deleted, not left active');
  });

  await test('a transaction deleted while its create is in flight is not marked synced; the deletion is sent next', async () => {
    const { db, engine, repo, q } = await fresh();
    await importStatement(db);
    const [victim] = await live(db);
    beforeReply = async () => { await repo.delete(victim.id); }; // the person deletes it while the request is on the wire
    await engine.pushPendingChanges(session as never);
    const after = await repo.getById(victim.id);
    assert.notEqual(after!.deleted_at, null);
    assert.equal(after!.sync_status, 'pending_delete', 'not synced: the server holds an active copy');
    assert.equal(await q.getPendingCount(), 1, 'a delete is queued for it');
    await engine.pushPendingChanges(session as never);
    assert.notEqual(server.get(victim.id)!.deleted_at, null);
    await engine.pullRemoteChanges(session as never);
    assert.equal((await live(db)).some((r) => r.id === victim.id), false);
  });

  await test('a pulled server copy of a payment the device already holds does not become a second local row', async () => {
    const { db, engine } = await fresh();
    server.set('server-row-1', { id: 'server-row-1', reference_id: '627425966121', fingerprint: null, deleted_at: null, amount: 43, direction: 'expense' });
    await importStatement(db);
    await engine.pushPendingChanges(session as never);
    await engine.pullRemoteChanges(session as never);
    assert.equal((await live(db)).filter((r) => r.reference_id === '627425966121').length, 1);
    assert.equal((await getCashFlowSummary(db, USER, new Date(2026, 9, 15))).monthExpensePaise, 14300);
  });

  await test('shared refresh: concurrent callers spend the rotating refresh token once', async () => {
    let stored = { access_token: 'a1', refresh_token: 'r1', user: { id: USER } };
    let calls = 0;
    const refresh = createSharedRefresh({
      loadStored: async () => stored,
      refresh: async (s) => { calls += 1; await new Promise((r) => setTimeout(r, 20)); if (s.refresh_token !== stored.refresh_token) throw Object.assign(new Error('revoked'), { status: 401 }); stored = { access_token: `a${calls + 1}`, refresh_token: `r${calls + 1}`, user: { id: USER } }; return stored; },
    });
    const old = { access_token: 'a1', refresh_token: 'r1', user: { id: USER } };
    const [x, y, z] = await Promise.all([refresh(old), refresh(old), refresh(old)]);
    assert.equal(calls, 1);
    assert.deepEqual([x, y, z].map((s) => s.refresh_token), ['r2', 'r2', 'r2']);
    // a late caller that still holds the old token gets the newer stored session, without a second network call
    const late = await refresh(old);
    assert.equal(calls, 1);
    assert.equal(late.refresh_token, 'r2');
  });

  await test('shared refresh: a network failure keeps its error (not a rejection) and never touches the stored session', async () => {
    const stored = { access_token: 'a1', refresh_token: 'r1', user: { id: USER } };
    const refresh = createSharedRefresh({ loadStored: async () => stored, refresh: async () => { throw Object.assign(new Error('offline'), { kind: 'connection' }); } });
    await assert.rejects(refresh(stored), (e: any) => e.kind === 'connection' && e.status === undefined);
    assert.equal(stored.refresh_token, 'r1');
  });

  await test('a sync requested while another runs is not dropped: one follow-up cycle is scheduled', async () => {
    const { db, engine } = await fresh();
    await importStatement(db);
    (engine as any).sessionProvider = async () => session; // as when the app started the engine
    const first = engine.triggerSync(session as never);
    const second = await engine.triggerSync(session as never);
    assert.match(second.errors[0], /already in progress/);
    assert.equal((engine as any).rerunRequested, true);
    await first;
    assert.equal((engine as any).rerunRequested, false, 'consumed: a follow-up timer was scheduled');
    engine.stop();
  });

  console.log(`\n${passed} import/delete/sync tests passed`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
