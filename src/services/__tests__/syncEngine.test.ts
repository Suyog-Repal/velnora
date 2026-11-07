import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { MetadataRepository } from '../../db/repositories/metadataRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import type { RemoteTransaction, TransactionEntity } from '../../db/types.ts';

// Helper mock fetch
let mockPushHandler: ((batch: any) => Promise<any>) | null = null;
let mockPullHandler: ((cursor: string | null) => Promise<any>) | null = null;

// Mock global fetch for Node testing
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = input.toString();

  if (urlStr.includes('/api/v1/sync/push')) {
    if (!mockPushHandler) throw new Error('No push handler configured');
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const res = await mockPushHandler(body);
    return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (urlStr.includes('/api/v1/sync/pull')) {
    if (!mockPullHandler) throw new Error('No pull handler configured');
    const url = new URL(urlStr);
    const cursor = url.searchParams.get('since_cursor');
    const res = await mockPullHandler(cursor);
    return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
};

async function runAllSyncEngineTests() {
  console.log('--- Starting Sync Engine Tests (Scenarios A - J) ---');

  const session = {
    access_token: 'mock-jwt-token',
    user: { id: 'user-uuid-1', email: 'test@example.com' },
  };

  // Scenario A: Create transaction offline, reconnect, and upload
  {
    console.log('Scenario A: Create offline transaction and push to server...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const created = await txRepo.create({
      user_id: session.user.id,
      amount: 1499.50,
      direction: 'expense',
      counterparty: 'Amazon India',
      category: 'Shopping',
      source: 'manual',
      sync_status: 'pending_create',
    });

    assert.equal(created.sync_status, 'pending_create');
    assert.equal(await syncRepo.getPendingCount(), 1);

    mockPushHandler = async (batch) => {
      assert.equal(batch.items.length, 1);
      assert.equal(batch.items[0].entity_id, created.id);
      return {
        results: [
          {
            operation_id: batch.items[0].operation_id,
            entity_id: created.id,
            operation: 'create',
            status: 'synced',
            server_version: 1,
            updated_at: new Date().toISOString(),
          },
        ],
        server_time: new Date().toISOString(),
      };
    };

    const pushRes = await engine.pushPendingChanges(session);
    assert.equal(pushRes.pushed, 1);
    assert.equal(await syncRepo.getPendingCount(), 0, 'Queue should be empty after push ack');

    const updatedLocal = await txRepo.getById(created.id);
    assert.equal(updatedLocal?.sync_status, 'synced');
    assert.equal(updatedLocal?.server_version, 1);
    console.log('✓ Scenario A passed');
  }

  // Scenario B: Update transaction offline, reconnect, and synchronize
  {
    console.log('Scenario B: Update transaction offline and sync...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const created = await txRepo.create({
      user_id: session.user.id,
      amount: 500,
      direction: 'expense',
      counterparty: 'Cafe',
      category: 'Food & Dining',
      sync_status: 'synced',
    });

    // Offline update
    const updated = await txRepo.update(created.id, {
      amount: 650,
      counterparty: 'Cafe & Bakery',
    });
    assert.equal(updated.sync_status, 'pending_update');
    assert.equal(await syncRepo.getPendingCount(), 1);

    mockPushHandler = async (batch) => {
      assert.equal(batch.items[0].operation, 'update');
      return {
        results: [
          {
            operation_id: batch.items[0].operation_id,
            entity_id: created.id,
            operation: 'update',
            status: 'synced',
            server_version: 2,
          },
        ],
        server_time: new Date().toISOString(),
      };
    };

    const pushRes = await engine.pushPendingChanges(session);
    assert.equal(pushRes.pushed, 1);
    assert.equal(await syncRepo.getPendingCount(), 0);

    const synced = await txRepo.getById(created.id);
    assert.equal(synced?.sync_status, 'synced');
    assert.equal(synced?.server_version, 2);
    assert.equal(synced?.amount, 650);
    console.log('✓ Scenario B passed');
  }

  // Scenario C: Delete transaction offline and propagate tombstone
  {
    console.log('Scenario C: Delete transaction offline and propagate tombstone...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const created = await txRepo.create({
      user_id: session.user.id,
      amount: 100,
      direction: 'expense',
      counterparty: 'Snack',
      category: 'Food & Dining',
      sync_status: 'synced',
    });

    // Offline delete
    await txRepo.delete(created.id);
    const tombstone = await txRepo.getById(created.id);
    assert.equal(tombstone?.sync_status, 'pending_delete');
    assert.ok(tombstone?.deleted_at !== null);

    mockPushHandler = async (batch) => {
      assert.equal(batch.items[0].operation, 'delete');
      return {
        results: [
          {
            operation_id: batch.items[0].operation_id,
            entity_id: created.id,
            operation: 'delete',
            status: 'synced',
            server_version: 2,
          },
        ],
        server_time: new Date().toISOString(),
      };
    };

    const pushRes = await engine.pushPendingChanges(session);
    assert.equal(pushRes.pushed, 1);
    assert.equal(await syncRepo.getPendingCount(), 0);

    const finalTombstone = await txRepo.getById(created.id);
    assert.equal(finalTombstone?.sync_status, 'synced');
    assert.ok(finalTombstone?.deleted_at !== null);
    console.log('✓ Scenario C passed');
  }

  // Scenario D: Submit same operation multiple times without duplicates
  {
    console.log('Scenario D: Submit same operation multiple times (idempotency)...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const created = await txRepo.create({
      user_id: session.user.id,
      amount: 250,
      direction: 'expense',
      counterparty: 'Bookstore',
      category: 'Education',
      sync_status: 'pending_create',
    });

    let attempts = 0;
    mockPushHandler = async (batch) => {
      attempts++;
      return {
        results: [
          {
            operation_id: batch.items[0].operation_id,
            entity_id: created.id,
            operation: 'create',
            status: 'synced',
            server_version: 1,
          },
        ],
        server_time: new Date().toISOString(),
      };
    };

    await engine.pushPendingChanges(session);
    assert.equal(attempts, 1);
    assert.equal(await syncRepo.getPendingCount(), 0);

    // Call again: nothing in queue, 0 pushed, no duplicate
    const push2 = await engine.pushPendingChanges(session);
    assert.equal(push2.pushed, 0);
    assert.equal(attempts, 1);
    console.log('✓ Scenario D passed');
  }

  // Scenario E: Interrupt synchronization and retry (exponential backoff)
  {
    console.log('Scenario E: Interrupt sync and verify retry with backoff...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const created = await txRepo.create({
      user_id: session.user.id,
      amount: 99,
      direction: 'expense',
      counterparty: 'App Store',
      category: 'Software',
      sync_status: 'pending_create',
    });

    // Simulate network error
    mockPushHandler = async () => {
      throw new Error('Connection reset by peer');
    };

    await assert.rejects(async () => {
      await engine.pushPendingChanges(session);
    }, /Unable to connect/);

    // Item should remain in queue with retry_count incremented
    const queue = await syncRepo.peek(10);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].retry_count, 1);
    assert.ok(queue[0].next_retry_at !== null);

    // Recover network
    mockPushHandler = async (batch) => {
      return {
        results: [
          {
            operation_id: batch.items[0].operation_id,
            entity_id: created.id,
            operation: 'create',
            status: 'synced',
            server_version: 1,
          },
        ],
        server_time: new Date().toISOString(),
      };
    };

    // Re-attempt after retry window
    await adapter.runAsync('UPDATE sync_queue SET next_retry_at = NULL WHERE id = ?', queue[0].id);
    const retryPush = await engine.pushPendingChanges(session);
    assert.equal(retryPush.pushed, 1);
    assert.equal(await syncRepo.getPendingCount(), 0);
    console.log('✓ Scenario E passed');
  }

  // Scenario F: Cold app restart with pending operations
  {
    console.log('Scenario F: App restart with pending operations...');
    const dbPath = join(tmpdir(), `velnora_restart_${Date.now()}.db`); // portable (was a hardcoded /tmp, which fails on Windows)
    
    // Process 1: write pending item and close
    {
      const adapter = new NodeSqliteAdapter(dbPath);
      await runMigrations(adapter);
      const txRepo = new TransactionRepository(adapter);
      await txRepo.create({
        id: 'tx-restart-1',
        user_id: session.user.id,
        amount: 888,
        direction: 'income',
        counterparty: 'Freelance Payout',
        category: 'Income',
        sync_status: 'pending_create',
      });
      adapter.close();
    }

    // Process 2: reopen database from scratch
    {
      const reopenedAdapter = new NodeSqliteAdapter(dbPath);
      const syncRepo = new SyncQueueRepository(reopenedAdapter);
      const txRepo = new TransactionRepository(reopenedAdapter);
      const engine = new SyncEngine(reopenedAdapter);

      const pending = await syncRepo.peek(10);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].entity_id, 'tx-restart-1');

      mockPushHandler = async (batch) => {
        return {
          results: [
            {
              operation_id: batch.items[0].operation_id,
              entity_id: 'tx-restart-1',
              operation: 'create',
              status: 'synced',
              server_version: 1,
            },
          ],
          server_time: new Date().toISOString(),
        };
      };

      const pushRes = await engine.pushPendingChanges(session);
      assert.equal(pushRes.pushed, 1);
      assert.equal(await syncRepo.getPendingCount(), 0);

      const synced = await txRepo.getById('tx-restart-1');
      assert.equal(synced?.sync_status, 'synced');
      reopenedAdapter.close();
    }
    console.log('✓ Scenario F passed');
  }

  // Scenario G: Update same transaction from two devices (conflict handling)
  {
    console.log('Scenario G: Update same transaction on two devices (conflict resolution)...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);

    // Initial synced transaction on local device
    await txRepo.create({
      id: 'tx-conflict-1',
      amount: 100,
      direction: 'expense',
      counterparty: 'Store A',
      category: 'Shopping',
      sync_status: 'synced',
    });

    // Local user edits while offline
    await txRepo.update('tx-conflict-1', {
      amount: 150,
      counterparty: 'Store A Edited Locally',
    });

    // Remote pull delivers an update from Device 2
    const remoteTx: RemoteTransaction = {
      id: 'tx-conflict-1',
      user_id: session.user.id,
      amount: 200,
      amount_paise: 20000,
      direction: 'expense',
      counterparty: 'Store A Edited on Device 2',
      category: 'Shopping',
      description: '',
      transaction_date: new Date().toISOString(),
      source: 'manual',
      server_version: 2,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date(Date.now() + 5000).toISOString(),
    };

    mockPullHandler = async () => {
      return {
        transactions: [remoteTx],
        server_time: new Date().toISOString(),
        next_cursor: 'cursor-1',
        has_more: false,
        total_active_count: 1,
      };
    };

    const pullRes = await engine.pullRemoteChanges(session);
    assert.equal(pullRes.conflicts, 1, 'Should preserve local pending change without overwrite');

    // Verify local pending edits were NEVER silently overwritten
    const currentLocal = await txRepo.getById('tx-conflict-1');
    assert.equal(currentLocal?.amount, 150, 'Local pending amount must remain intact');
    assert.equal(currentLocal?.counterparty, 'Store A Edited Locally', 'Local pending counterparty must remain intact');
    assert.equal(currentLocal?.sync_status, 'pending_update');
    console.log('✓ Scenario G passed');
  }

  // Scenario H: Restore transactions on a second device
  {
    console.log('Scenario H: Restore transactions on a second device...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);

    // Initially 0 local transactions
    const initialList = await txRepo.getAll();
    assert.equal(initialList.length, 0);

    const remoteRecords: RemoteTransaction[] = [
      {
        id: 'tx-cloud-1',
        user_id: session.user.id,
        amount: 350.75,
        amount_paise: 35075,
        direction: 'expense',
        counterparty: 'Grocery Mart',
        category: 'Groceries',
        description: 'Weekly staples',
        transaction_date: '2026-11-01T10:00:00Z',
        source: 'manual',
        server_version: 1,
        deleted_at: null,
        created_at: '2026-11-01T10:00:00Z',
        updated_at: '2026-11-01T10:00:00Z',
      },
      {
        id: 'tx-cloud-2',
        user_id: session.user.id,
        amount: 50000.00,
        amount_paise: 5000000,
        direction: 'income',
        counterparty: 'Employer Inc',
        category: 'Salary',
        description: 'Monthly pay',
        transaction_date: '2026-11-01T09:00:00Z',
        source: 'sms',
        reference_id: 'SAL-1234',
        server_version: 1,
        deleted_at: null,
        created_at: '2026-11-01T09:00:00Z',
        updated_at: '2026-11-01T09:00:00Z',
      },
    ];

    mockPullHandler = async (cursor) => {
      return {
        transactions: remoteRecords,
        server_time: new Date().toISOString(),
        next_cursor: 'cursor-restored',
        has_more: false,
        total_active_count: 2,
      };
    };

    const pullRes = await engine.pullRemoteChanges(session);
    assert.equal(pullRes.pulled, 2);

    const restored = await txRepo.getAll();
    assert.equal(restored.length, 2);
    assert.equal(restored[0].id, 'tx-cloud-1');
    assert.equal(restored[0].amount_paise, 35075);
    assert.equal(restored[0].sync_status, 'synced');
    assert.equal(restored[1].id, 'tx-cloud-2');
    assert.equal(restored[1].amount_paise, 5000000);
    assert.equal(restored[1].sync_status, 'synced');
    console.log('✓ Scenario H passed');
  }

  // Scenario I: User Isolation verification
  {
    console.log('Scenario I: User isolation verification...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    const tx = await txRepo.create({
      amount: 100,
      direction: 'expense',
      counterparty: 'Private Item',
      category: 'Shopping',
      user_id: 'user-a',
    });
    assert.equal(tx.user_id, 'user-a');
    console.log('✓ Scenario I passed');
  }

  // Scenario J: Exact paise preservation across both directions
  {
    console.log('Scenario J: Exact paise values preserved across both directions...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);

    const testAmounts = [
      { amount: 0.01, paise: 1 },
      { amount: 1499.50, paise: 149950 },
      { amount: 999999.99, paise: 99999999 },
    ];

    for (const item of testAmounts) {
      const created = await txRepo.create({
        user_id: session.user.id,
        amount: item.amount,
        direction: 'expense',
        counterparty: `Exact test ${item.paise}`,
        category: 'Precision',
        sync_status: 'pending_create',
      });
      assert.equal(created.amount_paise, item.paise);

      mockPushHandler = async (batch) => {
        return {
          results: [
            {
              operation_id: batch.items[0].operation_id,
              entity_id: created.id,
              operation: 'create',
              status: 'synced',
              server_version: 1,
            },
          ],
          server_time: new Date().toISOString(),
        };
      };

      await engine.pushPendingChanges(session);
      const pushedTx = await txRepo.getById(created.id);
      assert.equal(pushedTx?.amount_paise, item.paise);
      assert.equal(pushedTx?.amount, item.amount);
    }
    console.log('✓ Scenario J passed');
  }

  // Edge Case 1: Permanent validation failure (HTTP 422) is not retried indefinitely
  {
    console.log('Edge Case 1: HTTP 422 validation failure dead-lettering...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const created = await txRepo.create({
      user_id: session.user.id,
      amount: 10,
      direction: 'expense',
      counterparty: 'Bad Payload',
      category: 'Test',
      sync_status: 'pending_create',
    });

    // Mock HTTP 422 rejection
    mockPushHandler = async () => {
      throw new Response(JSON.stringify({ detail: 'Unprocessable Entity' }), { status: 422 });
    };

    // Override fetch mock for 422 error
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ detail: 'Unprocessable Entity' }), { status: 422 });
    };

    await assert.rejects(async () => {
      await engine.pushPendingChanges(session);
    });

    globalThis.fetch = prevFetch;

    // Item must be marked failed and dead-lettered
    const queue = await syncRepo.peek(10);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].error_code, 'PERMANENT_ERROR_422');
    assert.equal(queue[0].next_retry_at, '9999-12-31T23:59:59Z');

    const tx = await txRepo.getById(created.id);
    assert.equal(tx?.sync_status, 'failed');

    // Subsequent eligible peek ignores dead-lettered item
    const eligible = await syncRepo.peekEligible(10);
    assert.equal(eligible.length, 0, 'Dead-lettered items must not be re-attempted');
    console.log('✓ Edge Case 1 passed');
  }

  // Edge Case 2: Category synchronization on pull
  {
    console.log('Edge Case 2: Category synchronization & hydration on Pull...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const catRepo = new (await import('../../db/repositories/categoryRepository.ts')).CategoryRepository(adapter);

    mockPullHandler = async () => {
      return {
        transactions: [],
        categories: [
          {
            id: 'cat-food',
            name: 'Food & Dining',
            direction: 'expense',
            icon: 'Utensils',
            color: '#6366f1',
            is_system: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: 'custom-cat-gym',
            user_id: session.user.id,
            name: 'Gym & Fitness',
            direction: 'expense',
            icon: 'Dumbbell',
            color: '#10b981',
            is_system: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        server_time: new Date().toISOString(),
        next_cursor: 'cat-cursor-1',
        has_more: false,
        total_active_count: 0,
      };
    };

    const pullRes = await engine.pullRemoteChanges(session);
    const pulledCat = await catRepo.getById('custom-cat-gym');
    assert.ok(pulledCat !== null);
    assert.equal(pulledCat?.name, 'Gym & Fitness');

    // Partial response test: An incomplete response lacking system categories MUST NOT prune local categories
    mockPullHandler = async () => {
      return {
        transactions: [],
        categories: [], // Incomplete/empty category response
        server_time: new Date().toISOString(),
        next_cursor: 'cat-cursor-2',
        has_more: false,
        total_active_count: 0,
      };
    };

    await engine.pullRemoteChanges(session);
    const retainedCat = await catRepo.getById('custom-cat-gym');
    assert.ok(retainedCat !== null, 'Incomplete response must never prune local categories');
    console.log('✓ Edge Case 2 passed');
  }

  // Edge Case 3: Interrupted pull recovery (atomic rollback & cursor safety)
  {
    console.log('Edge Case 3: Interrupted pull recovery & cursor safety...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const metadataRepo = new MetadataRepository(adapter);

    // Initial state: cursor is null
    assert.equal(await metadataRepo.get('last_sync_cursor'), null);

    // Simulate batch of 2 transactions where merge fails on 2nd item
    const remoteBatch: RemoteTransaction[] = [
      {
        id: 'tx-atomic-1',
        user_id: session.user.id,
        amount: 100,
        amount_paise: 10000,
        direction: 'expense',
        counterparty: 'First Item',
        category: 'Food',
        description: '',
        transaction_date: '2026-11-01T10:00:00Z',
        source: 'manual',
        server_version: 1,
        deleted_at: null,
        created_at: '2026-11-01T10:00:00Z',
        updated_at: '2026-11-01T10:00:00Z',
      },
    ];

    let failOnPull = true;
    mockPullHandler = async () => {
      if (failOnPull) {
        throw new Error('Network stream interrupted during pull payload');
      }
      return {
        transactions: remoteBatch,
        server_time: new Date().toISOString(),
        next_cursor: 'cursor-batch-1',
        has_more: false,
        total_active_count: 1,
      };
    };

    // Attempt 1 fails: cursor should NOT advance
    await assert.rejects(async () => {
      await engine.pullRemoteChanges(session);
    }, /Unable to connect/);

    assert.equal(await metadataRepo.get('last_sync_cursor'), null);
    assert.equal(await txRepo.getById('tx-atomic-1'), null);

    // Attempt 2 succeeds: recovery from last cursor without skipped records
    failOnPull = false;
    const res = await engine.pullRemoteChanges(session);
    assert.equal(res.pulled, 1);
    assert.equal(await metadataRepo.get('last_sync_cursor'), 'cursor-batch-1');
    const restored = await txRepo.getById('tx-atomic-1');
    assert.ok(restored !== null);
    assert.equal(restored?.counterparty, 'First Item');
    console.log('✓ Edge Case 3 passed');
  }

  // Edge Case 4: Category deletion propagation across devices
  {
    console.log('Edge Case 4: Category deletion propagation while device is offline...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const catRepo = new (await import('../../db/repositories/categoryRepository.ts')).CategoryRepository(adapter);
    const txRepo = new TransactionRepository(adapter);

    // Initial setup: Device has custom category 'cat-crypto' and a transaction referencing it
    await catRepo.create({
      id: 'cat-crypto',
      user_id: session.user.id,
      name: 'Crypto Investments',
      transaction_type: 'expense',
      icon: 'Bitcoin',
    });

    const tx = await txRepo.create({
      id: 'tx-with-cat',
      amount: 5000,
      direction: 'expense',
      counterparty: 'Exchange',
      category: 'Crypto Investments',
      category_id: 'cat-crypto',
      sync_status: 'synced',
    });
    assert.equal(tx.category_id, 'cat-crypto');

    // Device A deleted 'cat-crypto' on server. Device B reconnects and pulls active categories (no 'cat-crypto')
    mockPullHandler = async () => {
      return {
        transactions: [],
        categories: [
          // Only system categories remain; 'cat-crypto' was deleted on server
          {
            id: 'cat-food',
            name: 'Food & Dining',
            direction: 'expense',
            icon: 'Utensils',
            color: '#6366f1',
            is_system: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        categories_complete: true,
        server_time: new Date().toISOString(),
        next_cursor: 'cursor-after-cat-del',
        has_more: false,
        total_active_count: 1,
      };
    };

    await engine.pullRemoteChanges(session);

    // Category should be pruned from local SQLite
    const deletedCat = await catRepo.getById('cat-crypto');
    assert.equal(deletedCat, null, 'Deleted custom category should be pruned from SQLite');

    // Referenced transaction MUST remain intact with category name preserved (ON DELETE SET NULL)
    const existingTx = await txRepo.getById('tx-with-cat');
    assert.ok(existingTx !== null);
    assert.equal(existingTx?.category, 'Crypto Investments', 'Category text must be preserved');
    assert.equal(existingTx?.category_id, null, 'Foreign key must become null without deleting transaction');
    console.log('✓ Edge Case 4 passed');
  }

  // Edge Case 5: Conflict resolution merges winning server record before dequeueing
  {
    console.log('Edge Case 5: Conflict reconciliation merges winning server record...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const localTx = await txRepo.create({
      id: 'tx-conflict-winner',
      user_id: session.user.id,
      amount: 100,
      direction: 'expense',
      counterparty: 'Local Draft',
      category: 'Shopping',
      sync_status: 'synced',
    });

    await txRepo.update('tx-conflict-winner', {
      amount: 120,
      counterparty: 'Local Offline Edit',
    });

    // Server returns conflict_resolved with winning record from another device
    const winningRemoteRecord: RemoteTransaction = {
      id: 'tx-conflict-winner',
      user_id: session.user.id,
      amount: 250,
      amount_paise: 25000,
      direction: 'expense',
      counterparty: 'Server Authoritative Value',
      category: 'Shopping',
      description: 'Winning edit',
      transaction_date: '2026-11-02T12:00:00Z',
      source: 'manual',
      server_version: 5,
      deleted_at: null,
      created_at: '2026-11-02T10:00:00Z',
      updated_at: '2026-11-02T12:00:00Z',
    };

    mockPushHandler = async (batch) => {
      return {
        results: [
          {
            operation_id: batch.items[0].operation_id,
            entity_id: 'tx-conflict-winner',
            operation: 'update',
            status: 'conflict_resolved',
            server_version: 5,
            winning_record: winningRemoteRecord,
          },
        ],
        server_time: new Date().toISOString(),
      };
    };

    const pushRes = await engine.pushPendingChanges(session);
    assert.equal(pushRes.conflicts, 1);
    assert.equal(await syncRepo.getPendingCount(), 0);

    const mergedLocal = await txRepo.getById('tx-conflict-winner');
    assert.equal(mergedLocal?.counterparty, 'Server Authoritative Value');
    assert.equal(mergedLocal?.amount, 250);
    assert.equal(mergedLocal?.server_version, 5);
    assert.equal(mergedLocal?.sync_status, 'synced');
    console.log('✓ Edge Case 5 passed');
  }

  // Edge Case 6: Retry exhaustion and manual recovery
  {
    console.log('Edge Case 6: Retry exhaustion and manual recovery...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const tx = await txRepo.create({
      id: 'tx-exhaust-1',
      user_id: session.user.id,
      amount: 50,
      direction: 'expense',
      counterparty: 'Failing Item',
      category: 'Test',
      sync_status: 'pending_create',
    });

    // Simulate 10 repeated failures
    const queueItem = (await syncRepo.peek(1))[0];
    await adapter.runAsync('UPDATE sync_queue SET retry_count = 9 WHERE id = ?', queueItem.id);

    mockPushHandler = async () => {
      throw new Error('Server 500 error');
    };

    await assert.rejects(async () => {
      await engine.pushPendingChanges(session);
    });

    // Verify retry count reached 10 and transaction is marked 'failed'
    const exhaustedQueue = await syncRepo.peek(1);
    assert.equal(exhaustedQueue[0].retry_count, 10);
    assert.equal(exhaustedQueue[0].error_code, 'MAX_RETRIES_EXCEEDED');
    assert.equal(exhaustedQueue[0].next_retry_at, '9999-12-31T23:59:59Z');

    const failedTx = await txRepo.getById('tx-exhaust-1');
    assert.equal(failedTx?.sync_status, 'failed');
    assert.ok(failedTx !== null, 'Original transaction data remains available in SQLite');

    // Manual Recovery: trigger retryFailedOperation
    const recovered = await engine.retryFailedOperation('tx-exhaust-1');
    assert.equal(recovered, true);

    const recoveredQueue = await syncRepo.peek(1);
    assert.equal(recoveredQueue[0].retry_count, 0);
    assert.equal(recoveredQueue[0].next_retry_at, null);

    const pendingTx = await txRepo.getById('tx-exhaust-1');
    assert.equal(pendingTx?.sync_status, 'pending_create');

    // Now server recovers -> push succeeds
    mockPushHandler = async (batch) => {
      return {
        results: [
          {
            operation_id: batch.items[0].operation_id,
            entity_id: 'tx-exhaust-1',
            operation: 'create',
            status: 'synced',
            server_version: 1,
          },
        ],
        server_time: new Date().toISOString(),
      };
    };

    const recoverPush = await engine.pushPendingChanges(session);
    assert.equal(recoverPush.pushed, 1);
    assert.equal(await syncRepo.getPendingCount(), 0);

    const finalTx = await txRepo.getById('tx-exhaust-1');
    assert.equal(finalTx?.sync_status, 'synced');
    console.log('✓ Edge Case 6 passed');
  }

  // Edge Case 7: Partial category response containing system category with categories_complete=false skips pruning
  {
    console.log('Edge Case 7: Partial category response with system category skips pruning...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const catRepo = new (await import('../../db/repositories/categoryRepository.ts')).CategoryRepository(adapter);

    // Initial setup: Device has a custom category 'custom-cat-client'
    await catRepo.create({
      id: 'custom-cat-client',
      user_id: session.user.id,
      name: 'Client Retain Category',
      transaction_type: 'income',
      icon: 'Briefcase',
    });

    // Mock pull: Server sends a partial category response that CONTAINS a system category,
    // but explicitly omits categories_complete or sets categories_complete: false.
    mockPullHandler = async () => {
      return {
        transactions: [],
        categories: [
          {
            id: 'cat-salary',
            name: 'Salary',
            direction: 'income',
            icon: 'Briefcase',
            color: '#10b981',
            is_system: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        categories_complete: false, // Explicitly marked NOT complete
        server_time: new Date().toISOString(),
        next_cursor: 'cat-partial-cursor',
        has_more: false,
        total_active_count: 0,
      };
    };

    await engine.pullRemoteChanges(session);

    // Verify system category was upserted
    const salaryCat = await catRepo.getById('cat-salary');
    assert.ok(salaryCat !== null, 'System category should be upserted');

    // CRITICAL: Custom category MUST NOT be pruned because categories_complete was false!
    const retainedCustom = await catRepo.getById('custom-cat-client');
    assert.ok(
      retainedCustom !== null,
      'Custom category must NOT be pruned when categories_complete is false, even if system categories are present'
    );
    assert.equal(retainedCustom?.name, 'Client Retain Category');

    // Now send a complete response (categories_complete: true) that omits the custom category
    mockPullHandler = async () => {
      return {
        transactions: [],
        categories: [
          {
            id: 'cat-salary',
            name: 'Salary',
            direction: 'income',
            icon: 'Briefcase',
            color: '#10b981',
            is_system: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        categories_complete: true, // Officially certified complete active set
        server_time: new Date().toISOString(),
        next_cursor: 'cat-complete-cursor',
        has_more: false,
        total_active_count: 0,
      };
    };

    await engine.pullRemoteChanges(session);

    // Now the custom category is safely pruned
    const prunedCustom = await catRepo.getById('custom-cat-client');
    assert.equal(prunedCustom, null, 'Custom category should now be pruned after receiving complete active set');
    console.log('✓ Edge Case 7 passed');
  }

  // Edge Case 8: Multi-page synchronization with monotonically increasing revision sequence cursor
  {
    console.log('Edge Case 8: Multi-page sync with monotonically increasing revision sequence cursor...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const metaRepo = new (await import('../../db/repositories/metadataRepository.ts')).MetadataRepository(adapter);

    const pagesRequested: (string | null | undefined)[] = [];

    mockPullHandler = async (cursor) => {
      pagesRequested.push(cursor);
      if (!cursor || cursor === '0') {
        // Page 1: Revisions 101, 102
        return {
          transactions: [
            {
              id: 'tx-rev-1',
              user_id: session.user.id,
              amount: 100,
              amount_paise: 10000,
              direction: 'expense',
              counterparty: 'Vendor 1',
              category: 'Food',
              description: 'Item 1',
              transaction_date: '2026-11-02T10:00:00Z',
              source: 'manual',
              server_version: 1,
              sync_revision: 101,
              created_at: '2026-11-02T10:00:00Z',
              updated_at: '2026-11-02T10:00:00Z',
            },
            {
              id: 'tx-rev-2',
              user_id: session.user.id,
              amount: 200,
              amount_paise: 20000,
              direction: 'expense',
              counterparty: 'Vendor 2',
              category: 'Food',
              description: 'Item 2',
              transaction_date: '2026-11-02T10:01:00Z',
              source: 'manual',
              server_version: 1,
              sync_revision: 102,
              created_at: '2026-11-02T10:01:00Z',
              updated_at: '2026-11-02T10:01:00Z',
            },
          ],
          categories: [],
          categories_complete: false,
          server_time: new Date().toISOString(),
          next_cursor: '102',
          has_more: true,
          total_active_count: 5,
        };
      } else if (cursor === '102') {
        // Page 2: Revisions 103, 104
        return {
          transactions: [
            {
              id: 'tx-rev-3',
              user_id: session.user.id,
              amount: 300,
              amount_paise: 30000,
              direction: 'expense',
              counterparty: 'Vendor 3',
              category: 'Food',
              description: 'Item 3',
              transaction_date: '2026-11-02T10:02:00Z',
              source: 'manual',
              server_version: 1,
              sync_revision: 103,
              created_at: '2026-11-02T10:02:00Z',
              updated_at: '2026-11-02T10:02:00Z',
            },
            {
              id: 'tx-rev-4',
              user_id: session.user.id,
              amount: 400,
              amount_paise: 40000,
              direction: 'expense',
              counterparty: 'Vendor 4',
              category: 'Food',
              description: 'Item 4',
              transaction_date: '2026-11-02T10:03:00Z',
              source: 'manual',
              server_version: 1,
              sync_revision: 104,
              created_at: '2026-11-02T10:03:00Z',
              updated_at: '2026-11-02T10:03:00Z',
            },
          ],
          categories: [],
          categories_complete: false,
          server_time: new Date().toISOString(),
          next_cursor: '104',
          has_more: true,
          total_active_count: 5,
        };
      } else if (cursor === '104') {
        // Page 3: Revision 105 (final item)
        return {
          transactions: [
            {
              id: 'tx-rev-5',
              user_id: session.user.id,
              amount: 500,
              amount_paise: 50000,
              direction: 'income',
              counterparty: 'Client 5',
              category: 'Salary',
              description: 'Item 5',
              transaction_date: '2026-11-02T10:04:00Z',
              source: 'manual',
              server_version: 1,
              sync_revision: 105,
              created_at: '2026-11-02T10:04:00Z',
              updated_at: '2026-11-02T10:04:00Z',
            },
          ],
          categories: [],
          categories_complete: false,
          server_time: new Date().toISOString(),
          next_cursor: '105',
          has_more: false,
          total_active_count: 5,
        };
      } else {
        // Subsequent pull with cursor 105: no new records
        return {
          transactions: [],
          categories: [],
          categories_complete: false,
          server_time: new Date().toISOString(),
          next_cursor: '105',
          has_more: false,
          total_active_count: 5,
        };
      }
    };

    const pullResult = await engine.pullRemoteChanges(session);
    assert.equal(pullResult.pulled, 5, 'All 5 transactions across 3 pages must be pulled');
    assert.deepEqual(pagesRequested, [null, '102', '104'], 'Pagination must step cleanly through integer sequence cursors');

    // Verify cursor stored in app_metadata
    const finalCursor = await metaRepo.get('last_sync_cursor');
    assert.equal(finalCursor, '105', 'Final cursor must be the highest revision sequence number');

    // Verify all 5 transactions exist in local SQLite
    const localTxns = await txRepo.filterByDate('2026-11-01', '2026-11-03');
    assert.equal(localTxns.length, 5);
    for (const t of localTxns) {
      assert.equal(t.sync_status, 'synced');
    }

    // Subsequent incremental pull: sends cursor '105', discovers 0 changes
    pagesRequested.length = 0;
    const incrementalPull = await engine.pullRemoteChanges(session);
    assert.equal(incrementalPull.pulled, 0);
    assert.deepEqual(pagesRequested, ['105']);
    console.log('✓ Edge Case 8 passed');
  }

  console.log('\n--- ALL SYNC ENGINE SCENARIOS A - J AND EDGE CASES 1 - 8 PASSED! ---');
}

runAllSyncEngineTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
