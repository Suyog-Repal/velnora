/**
 * Phase 6 review: a local write that starts while pullRemoteChanges holds its page transaction must neither fail
 * ("cannot start a transaction within a transaction") nor be swept into / rolled back with the pull transaction.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import type { IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };

async function scenario(forceRollback: boolean) {
  const inner = new NodeSqliteAdapter();
  await runMigrations(inner);
  const repo = new TransactionRepository(inner);
  let pending: Promise<unknown> | null = null;
  let pullBegan = false;
  // Wrapper used ONLY by the engine: when the engine opens its pull transaction, start a manual write concurrently.
  const engineDb: IDatabase = {
    getFirstAsync: (s, ...p) => inner.getFirstAsync(s, ...p),
    getAllAsync: (s, ...p) => inner.getAllAsync(s, ...p),
    runAsync: (s, ...p) => {
      if (forceRollback && /INSERT INTO transactions/.test(s)) return Promise.reject(new Error('forced pull failure'));
      return inner.runAsync(s, ...p);
    },
    execAsync: async (s) => {
      if (s.includes('BEGIN') && !pullBegan) {
        pullBegan = true;
        pending = repo.create({ id: 'tx-manual', amount: 11, direction: 'expense', counterparty: 'Manual', category: 'c', user_id: A.user.id, reference_id: 'MANUAL1' });
        void pending.catch(() => undefined);
      }
      return inner.execAsync(s);
    },
  };
  const now = new Date().toISOString();
  const remote = Array.from({ length: 5 }, (_, i) => ({
    id: `remote-${i}`, user_id: A.user.id, amount: i + 1, amount_paise: (i + 1) * 100, direction: 'expense', counterparty: `R${i}`,
    category: 'c', category_id: null, description: '', transaction_date: now, source: 'manual', reference_id: `RR${i}0000`, fingerprint: null,
    server_version: 1, deleted_at: null, created_at: now, updated_at: now,
  }));
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ transactions: remote, categories: [], server_time: now, next_cursor: null, has_more: false, total_active_count: 5 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const engine = new SyncEngine(engineDb);
    let pullError: unknown = null;
    try { await engine.pullRemoteChanges(A); } catch (e) { pullError = e; }
    assert.ok(pending, 'manual write was started');
    await (pending as Promise<unknown>);             // must resolve: not rejected by the pull's open transaction
    const manual = await inner.getFirstAsync<{ id: string }>("SELECT id FROM transactions WHERE id = 'tx-manual'");
    assert.ok(manual, 'manual write persisted (not rolled back with the pull)');
    const queued = await inner.getFirstAsync<{ c: number }>("SELECT COUNT(*) c FROM sync_queue WHERE entity_id = 'tx-manual'");
    assert.equal(queued!.c, 1, 'its sync-queue item persisted with it');
    const remoteCount = (await inner.getFirstAsync<{ c: number }>("SELECT COUNT(*) c FROM transactions WHERE id LIKE 'remote-%'"))!.c;
    if (forceRollback) { assert.ok(pullError); assert.equal(remoteCount, 0, 'failed pull page rolled back fully'); }
    else { assert.equal(pullError, null); assert.equal(remoteCount, 5); }
  } finally { globalThis.fetch = prevFetch; inner.close(); }
}

async function main() {
  await scenario(false);
  console.log('✓ manual write during pull: both persist');
  await scenario(true);
  console.log('✓ pull rollback does not take a concurrent manual write with it');
  console.log('--- PHASE 6 PULL CONCURRENCY TEST PASSED ---');
}
main().catch((e) => { console.error(e); process.exit(1); });
