import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from './testAdapter.ts';
import { runMigrations, getCurrentSchemaVersion } from '../migrations.ts';
import { CategoryRepository } from '../repositories/categoryRepository.ts';
import { TransactionRepository } from '../repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../repositories/syncQueueRepository.ts';
import { migrateFromAsyncStorage, MIGRATION_METADATA_KEY } from '../asyncStorageMigration.ts';

async function runAllDatabaseTests() {
  console.log('--- Starting SQLite Database Tests ---');

  // Test 1: Migrations and Version Tracking
  {
    console.log('Test 1: Running schema migrations...');
    const adapter = new NodeSqliteAdapter();
    const appliedCount = await runMigrations(adapter);
    assert.equal(appliedCount, 2, 'Initial migration should apply 2 versions');

    const version = await getCurrentSchemaVersion(adapter);
    assert.equal(version, 2, 'Current schema version should be 2');

    // Run again, should be idempotent
    const rerunCount = await runMigrations(adapter);
    assert.equal(rerunCount, 0, 'Re-running migrations should apply 0 versions');
    console.log('✓ Migration & version tracking passed');
  }

  // Test 2: Category Repository & Seeding
  {
    console.log('Test 2: Category repository & default categories...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const catRepo = new CategoryRepository(adapter);

    const categories = await catRepo.getAll();
    assert.ok(categories.length >= 7, 'Default categories should be seeded');
    assert.ok(categories.some((c) => c.name === 'Food & Dining'), 'Food & Dining should exist');
    assert.ok(categories.some((c) => c.name === 'Other Income'), 'Other Income should exist');

    const created = await catRepo.create({
      id: 'custom-cat-1',
      name: 'Freelance',
      transaction_type: 'income',
      icon: 'Laptop',
    });
    assert.equal(created.name, 'Freelance');

    const fetched = await catRepo.getById('custom-cat-1');
    assert.equal(fetched?.id, 'custom-cat-1');
    assert.equal(fetched?.name, 'Freelance');

    const foundByName = await catRepo.findByName('freelance');
    assert.equal(foundByName?.id, 'custom-cat-1');
    console.log('✓ Category repository passed');
  }

  // Test 3: Transaction CRUD Operations
  {
    console.log('Test 3: Transaction CRUD operations...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    // Create manual transaction
    const tx = await txRepo.create({
      amount: 450.5,
      direction: 'expense',
      counterparty: 'Supermarket',
      category: 'Groceries',
      description: 'Weekly grocery run',
      transaction_date: '2026-11-01T12:00:00.000Z',
      source: 'manual',
    });

    assert.ok(tx.id, 'Transaction should have a valid UUID');
    assert.equal(tx.amount, 450.5);
    assert.equal(tx.sync_status, 'pending_create');
    assert.equal(tx.deleted_at, null);

    // Get by ID
    const fetched = await txRepo.getById(tx.id);
    assert.equal(fetched?.id, tx.id);
    assert.equal(fetched?.amount, 450.5);

    // Get all
    const all = await txRepo.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, tx.id);

    // Update transaction
    const updated = await txRepo.update(tx.id, {
      amount: 500.0,
      description: 'Updated grocery run',
    });
    assert.equal(updated.amount, 500.0);
    assert.equal(updated.description, 'Updated grocery run');

    // Soft delete transaction
    const deleted = await txRepo.delete(tx.id);
    assert.equal(deleted, true);

    // After soft delete, getAll should not return it
    const activeRemaining = await txRepo.getAll();
    assert.equal(activeRemaining.length, 0);

    // But getAll({ includeDeleted: true }) should return it
    const allWithDeleted = await txRepo.getAll({ includeDeleted: true });
    assert.equal(allWithDeleted.length, 1);
    assert.ok(allWithDeleted[0].deleted_at !== null);
    console.log('✓ Transaction CRUD operations passed');
  }

  // Test 4: Duplicate Detection (Reference ID & Fingerprint)
  {
    console.log('Test 4: Duplicate prevention (Reference ID & Fingerprint)...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    const first = await txRepo.create({
      amount: 1200,
      direction: 'expense',
      counterparty: 'Cafe Bar',
      category: 'Food & Dining',
      reference_id: 'REF-TX-999',
      fingerprint: 'fp-hash-12345',
      source: 'sms',
    });

    // Attempt insert with same reference_id
    const duplicateRef = await txRepo.create({
      amount: 1200,
      direction: 'expense',
      counterparty: 'Cafe Bar',
      category: 'Food & Dining',
      reference_id: 'REF-TX-999',
      source: 'sms',
    });
    assert.equal(duplicateRef.id, first.id, 'Duplicate reference_id must return existing transaction');

    // Attempt insert with same fingerprint
    const duplicateFp = await txRepo.create({
      amount: 1200,
      direction: 'expense',
      counterparty: 'Cafe Bar',
      category: 'Food & Dining',
      fingerprint: 'fp-hash-12345',
      source: 'sms',
    });
    assert.equal(duplicateFp.id, first.id, 'Duplicate fingerprint must return existing transaction');

    const total = await txRepo.getAll();
    assert.equal(total.length, 1, 'Only one record should exist in the database');
    console.log('✓ Duplicate prevention passed');
  }

  // Test 5: Filtering by Date and Category
  {
    console.log('Test 5: Filtering by date range and category...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    await txRepo.create({
      amount: 100,
      direction: 'expense',
      counterparty: 'Store A',
      category: 'Groceries',
      transaction_date: '2026-10-15T10:00:00.000Z',
    });
    await txRepo.create({
      amount: 200,
      direction: 'expense',
      counterparty: 'Store B',
      category: 'Transportation',
      transaction_date: '2026-11-01T10:00:00.000Z',
    });
    await txRepo.create({
      amount: 300,
      direction: 'expense',
      counterparty: 'Store C',
      category: 'Groceries',
      transaction_date: '2026-11-02T10:00:00.000Z',
    });

    const novemberTx = await txRepo.filterByDate(
      '2026-11-01T00:00:00.000Z',
      '2026-11-30T23:59:59.000Z',
    );
    assert.equal(novemberTx.length, 2, 'Should find 2 transactions in November');

    const groceries = await txRepo.filterByCategory('Groceries');
    assert.equal(groceries.length, 2, 'Should find 2 Groceries transactions');
    console.log('✓ Filtering passed');
  }

  // Test 6: Sync Queue & Status Management
  {
    console.log('Test 6: Sync queue and pending status tracking...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const tx = await txRepo.create({
      amount: 550,
      direction: 'expense',
      counterparty: 'Utility Co',
      category: 'Bills & Utilities',
    });

    // Should have 1 pending transaction
    const pending = await txRepo.getPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, tx.id);

    // Sync queue should have 1 item
    const queueItems = await syncRepo.peek(10);
    assert.equal(queueItems.length, 1);
    assert.equal(queueItems[0].entity_id, tx.id);
    assert.equal(queueItems[0].operation, 'create');

    // Test sync queue deduplication: updating pending_create entity should update payload in place
    await txRepo.update(tx.id, { amount: 600 });
    const queueAfterUpdate = await syncRepo.peek(10);
    assert.equal(queueAfterUpdate.length, 1, 'Sync queue must deduplicate and retain only 1 entry for this entity');
    assert.equal(queueAfterUpdate[0].operation, 'create', 'Operation should stay create for pending_create');
    const payload = JSON.parse(queueAfterUpdate[0].payload);
    assert.equal(payload.amount, 600, 'Payload must be updated with latest values');

    // Test repeated enqueues directly to syncQueueRepo
    await syncRepo.enqueue({
      entity_type: 'transaction',
      entity_id: tx.id,
      operation: 'update',
      payload: JSON.stringify({ amount: 650 }),
    });
    const queueAfterDirect = await syncRepo.peek(10);
    assert.equal(queueAfterDirect.length, 1, 'Direct enqueue must deduplicate via unique constraint');

    // Dequeue item
    await syncRepo.dequeue(queueItems[0].id);
    assert.equal(await syncRepo.getPendingCount(), 0);

    // Update sync status on transaction
    await txRepo.updateSyncStatus(tx.id, 'synced', 2);
    const updated = await txRepo.getById(tx.id);
    assert.equal(updated?.sync_status, 'synced');
    assert.equal(updated?.server_version, 2);

    const pendingAfter = await txRepo.getPending();
    assert.equal(pendingAfter.length, 0);
    console.log('✓ Sync queue & status passed');
  }

  // Test 7: Safe, Idempotent AsyncStorage Migration
  {
    console.log('Test 7: Safe AsyncStorage migration & verification...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);

    // Simulate AsyncStorage by pre-populating mock data in global/AsyncStorage mock
    // Create legacy transactions
    const legacyRecords = [
      {
        id: 'legacy-tx-1',
        amount: 250,
        direction: 'expense' as const,
        counterparty: 'Corner Deli',
        category: 'Food & Dining',
        description: 'Lunch',
        date: '2026-10-30T13:00:00.000Z',
        source: 'manual' as const,
      },
      {
        id: 'legacy-tx-2',
        amount: 3000,
        direction: 'income' as const,
        counterparty: 'Client Payment',
        category: 'Other Income',
        description: 'Invoice #101',
        date: '2026-10-31T09:00:00.000Z',
        source: 'manual' as const,
      },
      {
        id: 'legacy-sms-3',
        amount: 1500,
        direction: 'expense' as const,
        counterparty: 'Electronics Shop',
        category: 'Other Expenses',
        description: 'Detected from BANK-ALERT',
        date: '2026-11-01T15:30:00.000Z',
        source: 'sms' as const,
        referenceId: 'REF-SMS-9988',
        fingerprint: 'fp-9988',
      },
    ];

    // Mock AsyncStorage module in memory for test
    const mockStorage = new Map<string, string>();
    mockStorage.set('velnora.transactions.v1', JSON.stringify(legacyRecords));
    mockStorage.set('velnora.transaction-sync.v1', JSON.stringify([legacyRecords[0]])); // legacy-tx-1 was queued

    const AsyncStorageMock = {
      getItem: async (key: string) => mockStorage.get(key) ?? null,
      setItem: async (key: string, val: string) => { mockStorage.set(key, val); },
      removeItem: async (key: string) => { mockStorage.delete(key); },
    };

    // Run migration with mocked AsyncStorage
    const originalImport = await import('@react-native-async-storage/async-storage');
    // We override getItem with our test data for this test block
    (originalImport.default as any).getItem = AsyncStorageMock.getItem;

    const result = await migrateFromAsyncStorage(adapter);
    assert.equal(result.status, 'completed');
    assert.equal(result.migratedCount, 3);
    assert.equal(result.totalInAsyncStorage, 3);

    // Verify records are present in SQLite
    const txRepo = new TransactionRepository(adapter);
    const all = await txRepo.getAll();
    assert.equal(all.length, 3, 'All 3 legacy records must be in SQLite');

    // Verify legacy-tx-1 was queued as pending_create
    const tx1 = await txRepo.getById('legacy-tx-1');
    assert.equal(tx1?.sync_status, 'pending_create');

    // Verify legacy-tx-2 was not in sync queue, so synced
    const tx2 = await txRepo.getById('legacy-tx-2');
    assert.equal(tx2?.sync_status, 'synced');

    // Verify metadata was written
    const meta = await adapter.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_metadata WHERE key = ?',
      MIGRATION_METADATA_KEY,
    );
    assert.ok(meta !== null);
    const metaParsed = JSON.parse(meta!.value);
    assert.equal(metaParsed.status, 'completed');
    assert.equal(metaParsed.totalInAsyncStorage, 3);

    // Verify re-running migration is safe and returns already_migrated
    const rerun = await migrateFromAsyncStorage(adapter);
    assert.equal(rerun.status, 'already_migrated');

    // Verify AsyncStorage data was NOT deleted!
    assert.ok(mockStorage.has('velnora.transactions.v1'), 'AsyncStorage transactions must not be deleted');
    assert.ok(mockStorage.has('velnora.transaction-sync.v1'), 'AsyncStorage sync queue must not be deleted');
    console.log('✓ AsyncStorage safe migration passed');
  }

  // Test 8: Schema Upgrade from v1 to v2 with Backfill
  {
    console.log('Test 8: Schema upgrade v1 -> v2 with amount_paise backfill...');
    const adapter = new NodeSqliteAdapter();
    // Manually apply only migration 1
    const { MIGRATIONS } = await import('../schema.ts');
    await adapter.execAsync(MIGRATIONS[0].up);
    await adapter.runAsync('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)', new Date().toISOString());

    // Insert v1 transaction without amount_paise
    await adapter.runAsync(
      `INSERT INTO transactions (id, user_id, amount, direction, counterparty, category, transaction_date, source, sync_status, server_version, created_at, updated_at)
       VALUES ('v1-tx', NULL, 1250.75, 'expense', 'Merchant A', 'Groceries', '2026-11-01', 'manual', 'synced', 1, '2026-11-01', '2026-11-01')`,
    );

    // Run migration 2
    const newlyApplied = await runMigrations(adapter);
    assert.equal(newlyApplied, 1, 'Migration 2 should be applied');

    // Verify amount_paise was populated correctly by backfill
    const row = await adapter.getFirstAsync<{ amount: number; amount_paise: number }>(
      'SELECT amount, amount_paise FROM transactions WHERE id = ?',
      'v1-tx',
    );
    assert.equal(row?.amount, 1250.75);
    assert.equal(row?.amount_paise, 125075, 'amount_paise should be exactly 125075 paise');
    console.log('✓ Schema upgrade v1 -> v2 backfill passed');
  }

  // Test 9: Exact Monetary Precision Arithmetic
  {
    console.log('Test 9: Exact integer monetary precision...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    // Insert amounts with tricky decimal representations: 0.10, 0.20, 0.05
    await txRepo.create({ amount: 0.10, direction: 'income', counterparty: 'Payer A', category: 'Other Income' });
    await txRepo.create({ amount: 0.20, direction: 'income', counterparty: 'Payer B', category: 'Other Income' });
    await txRepo.create({ amount: 0.05, direction: 'expense', counterparty: 'Shop C', category: 'Other Expenses' });

    // In floating point: 0.10 + 0.20 = 0.30000000000000004
    // In integer paise: 10 + 20 - 5 = 25 paise
    const totalPaiseRow = await adapter.getFirstAsync<{ net_paise: number }>(
      `SELECT SUM(CASE WHEN direction = 'income' THEN amount_paise ELSE -amount_paise END) as net_paise
       FROM transactions WHERE deleted_at IS NULL`,
    );
    assert.equal(totalPaiseRow?.net_paise, 25, 'Net paise must be exactly 25 integer paise');
    const netRupees = (totalPaiseRow?.net_paise ?? 0) / 100;
    assert.equal(netRupees, 0.25, 'Net rupees must be exactly 0.25');
    console.log('✓ Exact monetary precision passed');
  }

  console.log('\n--- ALL DATABASE TESTS PASSED SUCCESSFULLY! ---');
}

runAllDatabaseTests().catch((err) => {
  console.error('Database tests failed:', err);
  process.exit(1);
});
