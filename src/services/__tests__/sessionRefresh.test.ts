import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import { createSessionRefresher } from '../sessionRefresh.ts';

// Fake backend: only the CURRENT token is accepted, anything else is the real 401 shape.
let validToken = 'fresh-token';
const pushTokens: string[] = [];
let serverRows = 0;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input.toString();
  const auth = (init?.headers as Record<string, string>)?.Authorization;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (auth !== `Bearer ${validToken}`) return json(401, { detail: 'Invalid or expired session' });
  if (url.includes('/api/v1/sync/push')) {
    const body = JSON.parse(init!.body as string);
    pushTokens.push(auth);
    serverRows += body.items.length;
    return json(200, {
      server_time: new Date().toISOString(),
      results: body.items.map((i: any) => ({ operation_id: i.operation_id, entity_id: i.entity_id, operation: i.operation, status: 'synced', server_version: 1 })),
    });
  }
  return json(200, { transactions: [], categories: [], server_time: new Date().toISOString(), next_cursor: null, has_more: false, total_active_count: 0 });
};

const user = { id: 'user-1', email: 'u@x.com' };
const expired = { access_token: 'expired-token', refresh_token: 'refresh-1', user, token_type: 'bearer' };
const fresh = { ...expired, access_token: 'fresh-token', refresh_token: 'refresh-2' };

async function setup(count: number) {
  const adapter = new NodeSqliteAdapter();
  await runMigrations(adapter);
  const tx = new TransactionRepository(adapter);
  const queue = new SyncQueueRepository(adapter);
  for (let i = 0; i < count; i++) {
    await tx.create({ user_id: user.id, amount: 10 + i, direction: 'expense', counterparty: `Shop ${i}`, category: 'Shopping', source: 'manual', sync_status: 'pending_create' });
  }
  return { engine: new SyncEngine(adapter), queue };
}

async function main() {
  // 1. The reported bug: expired token + no refresher => 401, queue untouched (nothing lost, nothing falsely acked).
  {
    const { engine, queue } = await setup(3);
    const summary = await engine.triggerSync(expired);
    assert.equal(summary.pushed, 0);
    assert.equal(await queue.getPendingCount(), 3, 'queue preserved on 401');
    assert.ok(summary.errors.length > 0);
  }

  // 2. Fix: 401 -> refresh once -> retry with the NEW token -> queue acknowledged and drained.
  {
    const { engine, queue } = await setup(3);
    pushTokens.length = 0; serverRows = 0;
    let refreshCalls = 0;
    engine.setSessionRefresher(createSessionRefresher({
      loadStored: async () => expired,
      refresh: async () => { refreshCalls++; return fresh; },
    }));
    const summary = await engine.triggerSync(expired);
    assert.equal(refreshCalls, 1);
    assert.equal(summary.pushed, 3);
    assert.deepEqual(pushTokens, ['Bearer fresh-token'], 'retry uses the refreshed token, never the stale one');
    assert.equal(serverRows, 3, 'each item sent exactly once');
    assert.equal(await queue.getPendingCount(), 0);
    assert.deepEqual(summary.errors, []);
  }

  // 3. Refresh rejected (revoked refresh token): no loop, queue preserved, onRejected fired once.
  {
    const { engine, queue } = await setup(3);
    let refreshCalls = 0; let rejected = 0;
    engine.setSessionRefresher(createSessionRefresher({
      loadStored: async () => expired,
      refresh: async () => { refreshCalls++; throw Object.assign(new Error('Invalid or revoked session'), { status: 401 }); },
      onRejected: () => { rejected++; },
    }));
    const summary = await engine.triggerSync(expired);
    assert.equal(refreshCalls, 1);
    assert.equal(rejected, 1);
    assert.equal(summary.pushed, 0);
    assert.equal(await queue.getPendingCount(), 3);
  }

  // 4. Refreshed token is itself rejected: exactly one retry, then stop (no infinite loop).
  {
    const { engine, queue } = await setup(3);
    let refreshCalls = 0;
    engine.setSessionRefresher(createSessionRefresher({
      loadStored: async () => expired,
      refresh: async () => { refreshCalls++; return { ...fresh, access_token: 'also-bad' }; },
    }));
    const summary = await engine.triggerSync(expired);
    assert.equal(refreshCalls, 1);
    assert.equal(await queue.getPendingCount(), 3);
    assert.ok(summary.errors.length > 0);
  }

  // 5. Single-flight: concurrent refreshes spend the rotating refresh token once.
  {
    let calls = 0;
    const refresher = createSessionRefresher({
      loadStored: async () => expired,
      refresh: async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return fresh; },
    });
    const [a, b] = await Promise.all([refresher(expired), refresher(expired)]);
    assert.equal(calls, 1);
    assert.equal(a, b);
  }

  // 6. A caller holding a stale session reuses the already-refreshed stored session; other accounts are never adopted.
  {
    let calls = 0;
    const reuse = createSessionRefresher({ loadStored: async () => fresh, refresh: async () => { calls++; return fresh; } });
    assert.equal((await reuse(expired))?.access_token, 'fresh-token');
    assert.equal(calls, 0);
    const other = createSessionRefresher({ loadStored: async () => ({ ...fresh, user: { id: 'someone-else' } }), refresh: async () => { calls++; return fresh; } });
    assert.equal(await other(expired), null);
    assert.equal(calls, 0);
  }

  console.log('sessionRefresh tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
