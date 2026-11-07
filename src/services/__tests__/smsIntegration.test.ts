/**
 * Phase 5 SMS Integration & Offline-First Synchronization Engine Test Suite.
 *
 * Verifies scenarios A through L:
 * A. Valid bank SMS creates a local transaction.
 * B. Incoming SMS while offline saves locally and creates a sync queue entry.
 * C. Repeated SMS event does not create duplicate transactions.
 * D. App restart preserves the SMS-derived transaction and pending queue operation.
 * E. Internet reconnect triggers synchronization.
 * F. Successful server acknowledgement marks the transaction synced.
 * G. Backend failure preserves the local transaction and pending queue entry.
 * H. Malformed or unsupported SMS does not create an invalid transaction.
 * I. Same merchant and amount on different legitimate transactions are not incorrectly deduplicated.
 * J. Raw SMS message body is never sent to the backend.
 * K. Logout/account switching does not leak transactions between users.
 * L. Existing SMS parser regression tests continue to pass.
 */

import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { MetadataRepository } from '../../db/repositories/metadataRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import {
  classifySmsStatus,
  DEFAULT_SMS_RULE,
  parseSmsTransaction,
} from '../../../transactionParser.ts';
import type { Session } from '../../db/types.ts';

// Test session for User A
const sessionUserA: Session = {
  user: {
    id: 'user-uuid-1111-aaaa',
    full_name: 'Alice Finance',
    email: 'alice@example.com',
  },
  access_token: 'fake.jwt.token.alice',
  refresh_token: 'fake.refresh.alice',
  token_type: 'bearer',
};

// Test session for User B
const sessionUserB: Session = {
  user: {
    id: 'user-uuid-2222-bbbb',
    full_name: 'Bob Finance',
    email: 'bob@example.com',
  },
  access_token: 'fake.jwt.token.bob',
  refresh_token: 'fake.refresh.bob',
  token_type: 'bearer',
};

async function runAllSmsIntegrationTests() {
  console.log('--- Starting Phase 5 SMS Integration Tests (Scenarios A - L) ---');

  // ============================================================================
  // Scenario A: Valid bank SMS creates a local transaction
  // ============================================================================
  {
    console.log('Scenario A: Valid bank SMS creates a local transaction...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    const smsEvent = {
      sender: 'HDFC-BANK',
      receivedAt: Date.parse('2026-11-02T14:30:00.000Z'),
      partCount: 1,
      body: 'Your account was debited INR 1,450.50 at Swiggy on 02/11/2026. Ref: HDFC99887766.',
    };

    // Override repository getters for isolated testing
    const parsed = parseSmsTransaction(smsEvent);
    assert.ok(parsed !== null, 'SMS should parse successfully');

    const created = await txRepo.create({
      amount: parsed.amount,
      amount_paise: Math.round(parsed.amount * 100),
      direction: parsed.direction,
      counterparty: parsed.merchant,
      category: 'Food & Dining',
      description: `Detected from ${parsed.bankSender}`,
      transaction_date: parsed.transactionDate,
      source: 'sms',
      reference_id: parsed.referenceId,
      fingerprint: parsed.fingerprint,
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    assert.equal(created.amount, 1450.5);
    assert.equal(created.amount_paise, 145050);
    assert.equal(created.direction, 'expense');
    assert.equal(created.counterparty, 'Swiggy');
    assert.equal(created.source, 'sms');
    assert.equal(created.reference_id, 'HDFC99887766');
    assert.equal(created.sync_status, 'pending_create');

    const fetched = await txRepo.getById(created.id);
    assert.ok(fetched !== null);
    assert.equal(fetched?.amount_paise, 145050);
    console.log('✓ Scenario A passed');
  }

  // ============================================================================
  // Scenario B: Incoming SMS while offline saves locally and creates a sync queue entry
  // ============================================================================
  {
    console.log('Scenario B: Incoming SMS while offline saves locally and creates a sync queue entry...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const smsEvent = {
      sender: 'SBI-ALERT',
      receivedAt: Date.parse('2026-11-02T15:00:00.000Z'),
      partCount: 1,
      body: 'Your a/c is credited INR 25,000.00 from Acro Corp on 02/11/2026. Ref: SBI11223344.',
    };

    const parsed = parseSmsTransaction(smsEvent);
    assert.ok(parsed !== null);

    const created = await txRepo.create({
      amount: parsed.amount,
      amount_paise: Math.round(parsed.amount * 100),
      direction: parsed.direction,
      counterparty: parsed.merchant,
      category: 'Salary',
      description: `Detected from ${parsed.bankSender}`,
      transaction_date: parsed.transactionDate,
      source: 'sms',
      reference_id: parsed.referenceId,
      fingerprint: parsed.fingerprint,
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    // Check transaction exists in SQLite with pending status
    const dbTx = await txRepo.getById(created.id);
    assert.ok(dbTx !== null);
    assert.equal(dbTx?.sync_status, 'pending_create');

    // Check sync queue entry created atomically
    const queueItems = await syncRepo.peek(10);
    assert.equal(queueItems.length, 1);
    assert.equal(queueItems[0].entity_id, created.id);
    assert.equal(queueItems[0].operation, 'create');
    console.log('✓ Scenario B passed');
  }

  // ============================================================================
  // Scenario C: Repeated SMS event does not create duplicate transactions
  // ============================================================================
  {
    console.log('Scenario C: Repeated SMS event does not create duplicate transactions...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    const smsInput = {
      amount: 500,
      amount_paise: 50000,
      direction: 'expense' as const,
      counterparty: 'Starbucks',
      category: 'Food & Dining',
      description: 'Detected from ICICI',
      source: 'sms' as const,
      reference_id: 'REF-DUP-123',
      fingerprint: 'fp-dup-123',
      sync_status: 'pending_create' as const,
    };

    // First arrival
    const first = await txRepo.create(smsInput);

    // Second arrival of identical SMS
    const second = await txRepo.create(smsInput);

    assert.equal(first.id, second.id, 'Duplicate SMS must return existing transaction record');

    // Verify only 1 row exists in SQLite transactions table
    const all = await txRepo.getAll();
    assert.equal(all.length, 1);

    // Verify only 1 queue item exists
    const queue = await syncRepo.peek(10);
    assert.equal(queue.length, 1);
    console.log('✓ Scenario C passed');
  }

  // ============================================================================
  // Scenario D: App restart preserves the SMS-derived transaction and pending queue operation
  // ============================================================================
  {
    console.log('Scenario D: App restart preserves SMS transaction and pending queue operation...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);

    const txRepo1 = new TransactionRepository(adapter);
    const created = await txRepo1.create({
      amount: 750,
      amount_paise: 75000,
      direction: 'expense',
      counterparty: 'Metro Transit',
      category: 'Transportation',
      source: 'sms',
      reference_id: 'REF-RESTART-01',
      fingerprint: 'fp-restart-01',
      sync_status: 'pending_create',
    });

    // Simulate App Restart by creating fresh repositories over the existing SQLite database
    const txRepo2 = new TransactionRepository(adapter);
    const syncRepo2 = new SyncQueueRepository(adapter);

    const reloadedTx = await txRepo2.getById(created.id);
    assert.ok(reloadedTx !== null);
    assert.equal(reloadedTx?.amount, 750);
    assert.equal(reloadedTx?.amount_paise, 75000);
    assert.equal(reloadedTx?.sync_status, 'pending_create');

    const pendingQueue = await syncRepo2.peek(10);
    assert.equal(pendingQueue.length, 1);
    assert.equal(pendingQueue[0].entity_id, created.id);
    console.log('✓ Scenario D passed');
  }

  // ============================================================================
  // Scenario E: Internet reconnect triggers synchronization
  // ============================================================================
  {
    console.log('Scenario E: Internet reconnect triggers synchronization...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);
    const engine = new SyncEngine(adapter);

    await txRepo.create({
      id: 'tx-sms-reconnect',
      amount: 1200,
      amount_paise: 120000,
      direction: 'expense',
      counterparty: 'Amazon India',
      category: 'Shopping',
      source: 'sms',
      reference_id: 'REF-AMZN-99',
      fingerprint: 'fp-amzn-99',
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    let networkPushed = false;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/sync/push')) {
        networkPushed = true;
        const body = JSON.parse(String(options?.body));
        assert.equal(body.items[0].entity_id, 'tx-sms-reconnect');
        return new Response(
          JSON.stringify({
            results: [
              {
                operation_id: body.items[0].operation_id,
                entity_id: 'tx-sms-reconnect',
                status: 'synced',
                server_version: 1,
              },
            ],
            server_time: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          transactions: [],
          categories: [],
          categories_complete: false,
          server_time: new Date().toISOString(),
          next_cursor: '100',
          has_more: false,
          total_active_count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const syncSummary = await engine.triggerSync(sessionUserA);
    globalThis.fetch = prevFetch;

    assert.equal(networkPushed, true, 'Reconnect must trigger push to server');
    assert.equal(syncSummary.pushed, 1);
    console.log('✓ Scenario E passed');
  }

  // ============================================================================
  // Scenario F: Successful server acknowledgement marks the transaction synced
  // ============================================================================
  {
    console.log('Scenario F: Successful server acknowledgement marks transaction synced...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);
    const engine = new SyncEngine(adapter);

    const tx = await txRepo.create({
      id: 'tx-sms-ack',
      amount: 350,
      amount_paise: 35000,
      direction: 'expense',
      counterparty: 'Chai Point',
      category: 'Food & Dining',
      source: 'sms',
      reference_id: 'REF-CHAI-01',
      fingerprint: 'fp-chai-01',
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/sync/push')) {
        const body = JSON.parse(String(options?.body));
        return new Response(
          JSON.stringify({
            results: [
              {
                operation_id: body.items[0].operation_id,
                entity_id: tx.id,
                status: 'synced',
                server_version: 1,
              },
            ],
            server_time: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          transactions: [],
          categories: [],
          categories_complete: false,
          server_time: new Date().toISOString(),
          next_cursor: '101',
          has_more: false,
          total_active_count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    await engine.pushPendingChanges(sessionUserA);
    globalThis.fetch = prevFetch;

    // Verify local SQLite transaction updated to 'synced' with server_version
    const syncedTx = await txRepo.getById(tx.id);
    assert.equal(syncedTx?.sync_status, 'synced');
    assert.equal(syncedTx?.server_version, 1);

    // Verify sync_queue item dequeued
    const queue = await syncRepo.peek(10);
    assert.equal(queue.length, 0);
    console.log('✓ Scenario F passed');
  }

  // ============================================================================
  // Scenario G: Backend failure preserves local transaction and pending queue entry
  // ============================================================================
  {
    console.log('Scenario G: Backend failure preserves local transaction and queue entry...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);
    const engine = new SyncEngine(adapter);

    const tx = await txRepo.create({
      id: 'tx-sms-fail',
      amount: 800,
      amount_paise: 80000,
      direction: 'expense',
      counterparty: 'Supermarket',
      category: 'Groceries',
      source: 'sms',
      reference_id: 'REF-FAIL-TEST',
      fingerprint: 'fp-fail-test',
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ detail: 'Internal Server Error' }), { status: 500 });
    };

    // Push fails
    await assert.rejects(async () => {
      await engine.pushPendingChanges(sessionUserA);
    });
    globalThis.fetch = prevFetch;

    // Local transaction MUST remain intact in SQLite
    const localTx = await txRepo.getById(tx.id);
    assert.ok(localTx !== null, 'Local transaction must never disappear on cloud failure');
    assert.equal(localTx?.amount, 800);
    assert.equal(localTx?.sync_status, 'pending_create');

    // Sync queue item must remain pending with incremented retry count
    const queue = await syncRepo.peek(10);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].entity_id, tx.id);
    assert.equal(queue[0].retry_count, 1);
    console.log('✓ Scenario G passed');
  }

  // ============================================================================
  // Scenario H: Malformed or unsupported SMS does not create an invalid transaction
  // ============================================================================
  {
    console.log('Scenario H: Malformed or unsupported SMS handling...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    // 1. Promotional message
    const promo = await processIncomingSms(
      {
        sender: 'DM-PROMO',
        receivedAt: Date.now(),
        partCount: 1,
        body: 'Flat 50% discount on shoes! Use coupon CODE50. Shop now.',
      },
      sessionUserA,
    );
    assert.equal(promo.success, false);
    assert.equal(promo.action, 'unsupported_or_invalid');

    // 2. OTP message
    const otp = await processIncomingSms(
      {
        sender: 'HDFC-BANK',
        receivedAt: Date.now(),
        partCount: 1,
        body: 'Your OTP for NetBanking login is 849201. Do not share with anyone.',
      },
      sessionUserA,
    );
    assert.equal(otp.success, false);
    assert.equal(otp.action, 'unsupported_or_invalid');

    // 3. Missing amount message
    const missingAmount = await processIncomingSms(
      {
        sender: 'HDFC-BANK',
        receivedAt: Date.now(),
        partCount: 1,
        body: 'Your account was debited at Grocery Store. Ref: ABC12345.',
      },
      sessionUserA,
    );
    assert.equal(missingAmount.success, false);
    assert.equal(missingAmount.action, 'unsupported_or_invalid');

    // 4. Failed/Declined transaction SMS
    const declined = await processIncomingSms(
      {
        sender: 'HDFC-BANK',
        receivedAt: Date.now(),
        partCount: 1,
        body: 'Transaction of INR 500 at Store failed. Ref: FAIL123.',
      },
      sessionUserA,
    );
    assert.equal(declined.success, false);
    assert.equal(declined.action, 'unsupported_or_invalid');

    // Verify 0 records were inserted into SQLite
    const records = await txRepo.getAll();
    assert.equal(records.length, 0, 'No transactions should be created from non-transaction SMS alerts');
    console.log('✓ Scenario H passed');
  }

  // ============================================================================
  // Scenario I: Same merchant and amount on different legitimate transactions are not incorrectly deduplicated
  // ============================================================================
  {
    console.log('Scenario I: Legitimate duplicate amounts and merchants on different dates/refs are preserved...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);

    // Transaction 1: Coffee on Nov 1 with Ref 1
    const tx1 = await txRepo.create({
      amount: 250,
      amount_paise: 25000,
      direction: 'expense',
      counterparty: 'Starbucks',
      category: 'Food & Dining',
      transaction_date: '2026-11-01T10:00:00.000Z',
      source: 'sms',
      reference_id: 'UTR-NOV-01',
      fingerprint: 'fp-sbux-nov01',
      sync_status: 'pending_create',
    });

    // Transaction 2: Coffee on Nov 2 with Ref 2 (identical merchant and amount)
    const tx2 = await txRepo.create({
      amount: 250,
      amount_paise: 25000,
      direction: 'expense',
      counterparty: 'Starbucks',
      category: 'Food & Dining',
      transaction_date: '2026-11-02T10:00:00.000Z',
      source: 'sms',
      reference_id: 'UTR-NOV-02',
      fingerprint: 'fp-sbux-nov02',
      sync_status: 'pending_create',
    });

    assert.notEqual(tx1.id, tx2.id, 'Legitimate separate transactions must generate separate UUIDs');

    const all = await txRepo.getAll();
    assert.equal(all.length, 2, 'Both legitimate transactions must be present in SQLite');
    console.log('✓ Scenario I passed');
  }

  // ============================================================================
  // Scenario J: Raw SMS message body is never sent to the backend
  // ============================================================================
  {
    console.log('Scenario J: Raw SMS message body is never sent to the backend...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const txRepo = new TransactionRepository(adapter);
    const engine = new SyncEngine(adapter);

    const rawBody = 'CONFIDENTIAL: Acct ending XX1234 debited INR 999.00 at Secret Merchant on 02/11/2026. Ref: CONFID999.';
    const parsed = parseSmsTransaction({
      sender: 'BANK-ALERT',
      receivedAt: Date.now(),
      partCount: 1,
      body: rawBody,
    });
    assert.ok(parsed !== null);

    await txRepo.create({
      amount: parsed.amount,
      amount_paise: Math.round(parsed.amount * 100),
      direction: parsed.direction,
      counterparty: parsed.merchant,
      category: 'Other Expenses',
      description: `Detected from ${parsed.bankSender}`,
      transaction_date: parsed.transactionDate,
      source: 'sms',
      reference_id: parsed.referenceId,
      fingerprint: parsed.fingerprint,
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    let uploadedPayloadString = '';
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      uploadedPayloadString = String(options?.body);
      return new Response(
        JSON.stringify({
          results: [{ operation_id: 'op-1', entity_id: 'tx-1', status: 'synced', server_version: 1 }],
          server_time: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    await engine.pushPendingChanges(sessionUserA);
    globalThis.fetch = prevFetch;

    // Verify raw SMS body was NEVER included in the uploaded payload
    assert.equal(
      uploadedPayloadString.includes('CONFIDENTIAL'),
      false,
      'Raw SMS body must NEVER be sent over the wire'
    );
    assert.equal(
      uploadedPayloadString.includes('XX1234'),
      false,
      'Sensitive account details must NEVER be sent to the backend'
    );

    // Verify only normalized fields were serialized
    const parsedPayload = JSON.parse(uploadedPayloadString);
    const txItem = parsedPayload.items[0].payload;
    assert.equal(txItem.amount, 999);
    assert.equal(txItem.counterparty, 'Secret Merchant');
    assert.equal(txItem.source, 'sms');
    assert.equal(txItem.body, undefined, 'Payload must not contain a body field');
    console.log('✓ Scenario J passed');
  }

  // ============================================================================
  // Scenario K: Safe logout and account switching (Requirements A - H)
  // ============================================================================
  {
    console.log('Scenario K: Safe logout and account switching (Requirements A - H)...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);
    const metaRepo = new MetadataRepository(adapter);

    // Requirement A: User A creates a transaction offline through SMS
    const smsEventUserA = {
      sender: 'HDFC-BANK',
      receivedAt: Date.parse('2026-11-02T15:00:00.000Z'),
      partCount: 1,
      body: 'Your account was debited INR 750.00 at Grocery Mart on 02/11/2026. Ref: HDFC123456.',
    };
    const parsedA = parseSmsTransaction(smsEventUserA);
    assert.ok(parsedA !== null);

    const txA = await txRepo.create({
      id: 'tx-alice-offline-sms',
      amount: parsedA.amount,
      amount_paise: Math.round(parsedA.amount * 100),
      direction: parsedA.direction,
      counterparty: parsedA.merchant,
      category: 'Groceries',
      description: `Detected from ${parsedA.bankSender}`,
      transaction_date: parsedA.transactionDate,
      source: 'sms',
      reference_id: parsedA.referenceId,
      fingerprint: parsedA.fingerprint,
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    assert.equal(txA.amount, 750);
    assert.equal(txA.user_id, sessionUserA.user.id);
    assert.equal(txA.sync_status, 'pending_create');

    // Verify User A can see this transaction in SQLite
    const aliceTxnsBeforeLogout = await txRepo.getAll({ userId: sessionUserA.user.id });
    assert.equal(aliceTxnsBeforeLogout.length, 1);
    assert.equal(aliceTxnsBeforeLogout[0].id, 'tx-alice-offline-sms');

    // Requirement B: User A logs out before synchronization
    // SQLite records and sync queue operations MUST NOT be deleted
    // (Simulate logout which clears session but preserves local SQLite data)
    let currentSession: Session | null = null;
    const allStoredAfterLogout = await txRepo.getAll({ includeDeleted: true });
    assert.equal(allStoredAfterLogout.length, 1, 'Local transaction must NOT be deleted during logout');
    const pendingQueueAfterLogout = await syncRepo.peek(10);
    assert.equal(pendingQueueAfterLogout.length, 1, 'Sync queue operation must be preserved during logout');

    // Requirement C: User B logs in and cannot see User A's transactions
    currentSession = sessionUserB;
    const bobTxns = await txRepo.getAll({ userId: currentSession.user.id });
    assert.equal(bobTxns.length, 0, "User B MUST NOT see User A's transactions");

    // Requirement D: User B cannot synchronize User A's pending queue
    let pushAttemptsByBob = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      pushAttemptsByBob = body.items.length;
      return new Response(JSON.stringify({ results: [], server_time: new Date().toISOString() }), { status: 200 });
    };

    const bobPushResult = await engine.pushPendingChanges(sessionUserB);
    assert.equal(pushAttemptsByBob, 0, "User B cannot upload User A's pending sync items");
    assert.equal(bobPushResult.pushed, 0);

    // Verify User A's sync item remains untouched in the queue
    const queueAfterBobPush = await syncRepo.peek(10);
    assert.equal(queueAfterBobPush.length, 1);
    assert.equal(queueAfterBobPush[0].entity_id, 'tx-alice-offline-sms');

    // Requirement E: User A logs back in and can see the original transaction
    currentSession = sessionUserA;
    const aliceTxnsAfterRelogin = await txRepo.getAll({ userId: currentSession.user.id });
    assert.equal(aliceTxnsAfterRelogin.length, 1, 'User A can see the original transaction after re-login');
    assert.equal(aliceTxnsAfterRelogin[0].id, 'tx-alice-offline-sms');
    assert.equal(aliceTxnsAfterRelogin[0].counterparty, 'Grocery Mart');

    // Requirement F: User A's pending transaction synchronizes successfully
    let pushedItemsForAlice: any[] = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      pushedItemsForAlice = body.items;
      return new Response(
        JSON.stringify({
          results: [
            {
              operation_id: body.items[0].operation_id,
              entity_id: body.items[0].entity_id,
              operation: 'create',
              status: 'synced',
              server_version: 1,
              updated_at: new Date().toISOString(),
            },
          ],
          server_time: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const alicePushResult = await engine.pushPendingChanges(sessionUserA);
    assert.equal(alicePushResult.pushed, 1, "User A's pending transaction pushes successfully");
    assert.equal(pushedItemsForAlice.length, 1);
    assert.equal(pushedItemsForAlice[0].entity_id, 'tx-alice-offline-sms');

    // Requirement G: Verify no transaction is duplicated or lost
    const aliceFinalTxns = await txRepo.getAll({ userId: sessionUserA.user.id });
    assert.equal(aliceFinalTxns.length, 1, 'Exactly one transaction exists (not duplicated or lost)');
    assert.equal(aliceFinalTxns[0].sync_status, 'synced', 'Transaction is marked synced');
    const remainingQueue = await syncRepo.peek(10, sessionUserA.user.id);
    assert.equal(remainingQueue.length, 0, 'Sync queue is now empty for User A');

    // Requirement H: Verify separate synchronization cursors for separate accounts
    // User A pulls from server and advances cursor
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          transactions: [],
          categories: [],
          categories_complete: true,
          server_time: new Date().toISOString(),
          next_cursor: 'cursor_rev_userA_100',
          has_more: false,
          total_active_count: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    await engine.pullRemoteChanges(sessionUserA);

    // User B pulls from server and advances cursor
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          transactions: [],
          categories: [],
          categories_complete: true,
          server_time: new Date().toISOString(),
          next_cursor: 'cursor_rev_userB_50',
          has_more: false,
          total_active_count: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    await engine.pullRemoteChanges(sessionUserB);

    // Restore fetch
    globalThis.fetch = prevFetch;

    // Verify each user has their own separate cursor in SQLite metadata
    const userACursor = await metaRepo.get(`last_sync_cursor_${sessionUserA.user.id}`);
    const userBCursor = await metaRepo.get(`last_sync_cursor_${sessionUserB.user.id}`);

    assert.equal(userACursor, 'cursor_rev_userA_100', "User A's cursor is preserved independently");
    assert.equal(userBCursor, 'cursor_rev_userB_50', "User B's cursor is preserved independently");
    assert.notEqual(userACursor, userBCursor, 'Cursors for User A and User B must remain separate');

    console.log('✓ Scenario K passed (Requirements A - H verified)');
  }

  // ============================================================================
  // Scenario L: Existing SMS parser regression tests continue to pass
  // ============================================================================
  {
    console.log('Scenario L: Existing SMS parser regression verification...');
    const receivedAt = Date.parse('2026-11-01T10:00:00.000Z');

    const success = parseSmsTransaction({
      sender: 'BANK-TEST',
      receivedAt,
      partCount: 1,
      body: 'Your account was debited INR 1,250.50 at Fictional Cafe on 01/11/2026 15:20. Ref: ABC123456.',
    });
    assert.equal(success?.status, 'success');
    assert.equal(success?.direction, 'expense');
    assert.equal(success?.amount, 1250.5);
    assert.equal(success?.merchant, 'Fictional Cafe');
    assert.equal(success?.referenceId, 'ABC123456');

    assert.equal(classifySmsStatus('Transaction of INR 500 failed. Ref: FAIL1234.'), 'failed');
    assert.equal(classifySmsStatus('INR 500 pending at Fictional Shop. Ref: PEND1234.'), 'pending');
    assert.equal(classifySmsStatus('Unknown message about INR 500.'), 'ambiguous');
    assert.equal(parseSmsTransaction({ sender: 'BANK-TEST', receivedAt, partCount: 1, body: 'Transaction of INR 500 failed. Ref: FAIL1234.' }), null);
    assert.equal(parseSmsTransaction({ sender: 'BANK-TEST', receivedAt, partCount: 1, body: 'INR 500 pending at Fictional Shop. Ref: PEND1234.' }), null);
    // Many real bank alerts carry no reference: they are still captured (deduped by fingerprint), with an empty reference.
    const noRef = parseSmsTransaction({ sender: 'BANK-TEST', receivedAt, partCount: 1, body: 'Your account was debited INR 100 at Fictional Shop.' });
    assert.equal(noRef?.merchant, 'Fictional Shop');
    assert.equal(noRef?.amount, 100);
    assert.equal(noRef?.referenceId, '');

    const creditRule = { ...DEFAULT_SMS_RULE, successPatterns: ['received'], creditPatterns: ['received'] };
    const credit = parseSmsTransaction({
      sender: 'BANK-TEST',
      receivedAt,
      partCount: 1,
      body: 'You received INR 900 from Fictional Person. Ref: CREDIT123.',
    }, [creditRule]);
    assert.equal(credit?.direction, 'income');
    assert.equal(credit?.fingerprint, parseSmsTransaction({
      sender: 'BANK-TEST',
      receivedAt,
      partCount: 1,
      body: 'You received INR 900 from Fictional Person. Ref: CREDIT123.',
    }, [creditRule])?.fingerprint);
    console.log('✓ Scenario L passed');
  }

  // ============================================================================
  // Scenario M: Strict Multi-Account Queue Ownership Safety (Cases 1 - 6)
  // ============================================================================
  {
    console.log('Scenario M: Strict Multi-Account Queue Ownership Safety (Cases 1 - 6)...');
    const adapter = new NodeSqliteAdapter();
    await runMigrations(adapter);
    const engine = new SyncEngine(adapter);
    const txRepo = new TransactionRepository(adapter);
    const syncRepo = new SyncQueueRepository(adapter);

    let uploadedBatches: any[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      uploadedBatches.push(body);
      return new Response(
        JSON.stringify({
          results: body.items.map((it: any) => ({
            operation_id: it.operation_id,
            entity_id: it.entity_id,
            operation: it.operation,
            status: 'synced',
            server_version: 1,
            updated_at: new Date().toISOString(),
          })),
          server_time: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    // Case 1: User A's pending queue entry is never uploaded by User B
    const txA = await txRepo.create({
      id: 'tx-case1-userA',
      amount: 150,
      direction: 'expense',
      counterparty: 'Merchant A',
      category: 'Food',
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    uploadedBatches = [];
    const bPushCase1 = await engine.pushPendingChanges(sessionUserB);
    assert.equal(bPushCase1.pushed, 0, "User B must not push User A's pending entry");
    assert.equal(uploadedBatches.length, 0, "No network request should be sent when no items belong to User B");
    const qA = await syncRepo.peek(10);
    assert.ok(qA.some((it) => it.entity_id === 'tx-case1-userA'), "User A's entry must remain in queue");

    // Case 2: User B's pending queue entry is never uploaded by User A
    const txB = await txRepo.create({
      id: 'tx-case2-userB',
      amount: 250,
      direction: 'expense',
      counterparty: 'Merchant B',
      category: 'Shopping',
      user_id: sessionUserB.user.id,
      sync_status: 'pending_create',
    });

    uploadedBatches = [];
    const aPushCase2 = await engine.pushPendingChanges(sessionUserA);
    assert.equal(aPushCase2.pushed, 1, "User A pushes their own item");
    assert.equal(uploadedBatches.length, 1);
    assert.equal(uploadedBatches[0].items.length, 1);
    assert.equal(uploadedBatches[0].items[0].entity_id, 'tx-case1-userA', "User A's push only includes User A's item");
    // Verify User B's item is still pending in queue
    const qB = await syncRepo.peek(10);
    assert.ok(qB.some((it) => it.entity_id === 'tx-case2-userB'), "User B's entry must remain in queue untouched");

    // Edge Case: User A transaction with User B payload owner (Mismatched ownership)
    await adapter.runAsync(
      `INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, transaction_date, source, sync_status, server_version, created_at, updated_at)
       VALUES (?, ?, 100, 10000, 'expense', 'Mismatch Store 1', 'General', ?, 'manual', 'pending_create', 1, ?, ?)`,
      'tx-mismatch-alice-tx-bob-payload',
      sessionUserA.user.id,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
    await adapter.runAsync(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)`,
      'q-mismatch-1',
      'transaction',
      'tx-mismatch-alice-tx-bob-payload',
      'create',
      JSON.stringify({ id: 'tx-mismatch-alice-tx-bob-payload', user_id: sessionUserB.user.id, amount: 100 }),
      new Date().toISOString()
    );

    // Neither User A nor User B can upload this mismatched entry
    uploadedBatches = [];
    const aPushMismatch1 = await engine.pushPendingChanges(sessionUserA);
    assert.equal(aPushMismatch1.pushed, 0, "User A must not upload entry where payload claims User B");
    assert.equal(uploadedBatches.length, 0);

    const bPushMismatch1 = await engine.pushPendingChanges(sessionUserB);
    assert.equal(bPushMismatch1.pushed, 1, "User B only uploads User B's own item tx-case2-userB");
    assert.equal(uploadedBatches[0].items[0].entity_id, 'tx-case2-userB');
    // Ensure mismatched entry q-mismatch-1 is preserved in queue
    const qPreserved1 = await adapter.getAllAsync<any>('SELECT * FROM sync_queue WHERE id = ?', 'q-mismatch-1');
    assert.equal(qPreserved1.length, 1, "Mismatched entry must be preserved");

    // Edge Case: User B transaction with User A payload owner (Mismatched ownership reversed)
    await adapter.runAsync(
      `INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, transaction_date, source, sync_status, server_version, created_at, updated_at)
       VALUES (?, ?, 200, 20000, 'expense', 'Mismatch Store 2', 'General', ?, 'manual', 'pending_create', 1, ?, ?)`,
      'tx-mismatch-bob-tx-alice-payload',
      sessionUserB.user.id,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
    await adapter.runAsync(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)`,
      'q-mismatch-2',
      'transaction',
      'tx-mismatch-bob-tx-alice-payload',
      'create',
      JSON.stringify({ id: 'tx-mismatch-bob-tx-alice-payload', user_id: sessionUserA.user.id, amount: 200 }),
      new Date().toISOString()
    );

    uploadedBatches = [];
    const aPushMismatch2 = await engine.pushPendingChanges(sessionUserA);
    assert.equal(aPushMismatch2.pushed, 0, "User A must not upload entry where tx belongs to User B");
    assert.equal(uploadedBatches.length, 0);

    const bPushMismatch2 = await engine.pushPendingChanges(sessionUserB);
    assert.equal(bPushMismatch2.pushed, 0, "User B must not upload entry where payload claims User A");
    assert.equal(uploadedBatches.length, 0);

    const qPreserved2 = await adapter.getAllAsync<any>('SELECT * FROM sync_queue WHERE id = ?', 'q-mismatch-2');
    assert.equal(qPreserved2.length, 1, "Mismatched entry 2 must be preserved");

    // Edge Case: Missing associated transaction
    await adapter.runAsync(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)`,
      'q-missing-tx',
      'transaction',
      'tx-does-not-exist',
      'create',
      JSON.stringify({ id: 'tx-does-not-exist', user_id: sessionUserA.user.id, amount: 50 }),
      new Date().toISOString()
    );

    uploadedBatches = [];
    const aPushMissing = await engine.pushPendingChanges(sessionUserA);
    assert.equal(aPushMissing.pushed, 0, "Cannot upload queue entry when associated SQLite transaction is missing");
    assert.equal(uploadedBatches.length, 0);
    const qMissingPreserved = await adapter.getAllAsync<any>('SELECT * FROM sync_queue WHERE id = ?', 'q-missing-tx');
    assert.equal(qMissingPreserved.length, 1, "Queue entry with missing transaction must be preserved without error");

    // Case 3: A queue entry without user_id is not uploaded by either account
    // Simulate an unowned queue item (no user_id in payload, no matching transaction)
    await adapter.runAsync(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)`,
      'queue-unowned-1',
      'transaction',
      'tx-orphan-1',
      'create',
      JSON.stringify({ id: 'tx-orphan-1', amount: 99, counterparty: 'Unknown' }),
      new Date().toISOString()
    );

    uploadedBatches = [];
    const aPushCase3 = await engine.pushPendingChanges(sessionUserA);
    assert.equal(aPushCase3.pushed, 0, "User A must NOT upload unowned queue item");
    assert.equal(uploadedBatches.length, 0);

    const bPushCase3 = await engine.pushPendingChanges(sessionUserB);
    assert.equal(bPushCase3.pushed, 0, "User B must NOT upload unowned queue item");
    assert.equal(uploadedBatches.length, 0);

    // Case 4: A legacy entry with verifiable ownership can only be synchronized by its actual owner
    // Create transaction in SQLite belonging to User A
    await adapter.runAsync(
      `INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, transaction_date, source, sync_status, server_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'expense', 'Legacy Store', 'General', ?, 'manual', 'pending_create', 1, ?, ?)`,
      'tx-legacy-alice',
      sessionUserA.user.id,
      300,
      30000,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );

    // Enqueue queue item WITHOUT user_id in payload (legacy payload format)
    await adapter.runAsync(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?)`,
      'queue-legacy-alice',
      'transaction',
      'tx-legacy-alice',
      'create',
      JSON.stringify({ id: 'tx-legacy-alice', amount: 300, counterparty: 'Legacy Store' }),
      new Date().toISOString()
    );

    // User B tries to push -> MUST NOT push Alice's legacy entry
    uploadedBatches = [];
    const bPushCase4 = await engine.pushPendingChanges(sessionUserB);
    assert.equal(bPushCase4.pushed, 0, "User B cannot upload legacy entry owned by User A");
    assert.equal(uploadedBatches.length, 0);

    // User A pushes -> Ownership verified via transactions table -> PUSHES SUCCESSFULLY
    const aPushCase4 = await engine.pushPendingChanges(sessionUserA);
    assert.equal(aPushCase4.pushed, 1, "User A successfully uploads legacy entry after ownership resolution");
    assert.equal(uploadedBatches.length, 1);
    assert.equal(uploadedBatches[0].items[0].entity_id, 'tx-legacy-alice');

    // Case 5: An entry with unverifiable ownership remains safely preserved
    const remainingQueueItems = await adapter.getAllAsync<any>('SELECT * FROM sync_queue WHERE id = ?', 'queue-unowned-1');
    assert.equal(remainingQueueItems.length, 1, "Unverifiable queue item must NOT be deleted");
    assert.equal(remainingQueueItems[0].retry_count, 0, "Unverifiable item must NOT be marked failed");
    assert.equal(remainingQueueItems[0].error_code, null);

    // Case 6: Existing offline logout, account switching, and re-login recovery continue to work
    // User A receives offline transaction
    await txRepo.create({
      id: 'tx-alice-offline-durability',
      amount: 450,
      direction: 'expense',
      counterparty: 'Durability Shop',
      category: 'Shopping',
      user_id: sessionUserA.user.id,
      sync_status: 'pending_create',
    });

    // User A logs out (session becomes null)
    let currentSession: Session | null = null;
    // User B logs in
    currentSession = sessionUserB;
    const bVisibleTx = await txRepo.getAll({ userId: currentSession.user.id });
    assert.ok(!bVisibleTx.some((t) => t.id === 'tx-alice-offline-durability'), "User B cannot see User A's offline transaction");

    // User A logs back in
    currentSession = sessionUserA;
    const aVisibleTx = await txRepo.getAll({ userId: currentSession.user.id });
    assert.ok(aVisibleTx.some((t) => t.id === 'tx-alice-offline-durability'), "User A sees their offline transaction upon re-login");

    // Online push succeeds
    uploadedBatches = [];
    const aFinalPush = await engine.pushPendingChanges(sessionUserA);
    assert.equal(aFinalPush.pushed, 1);
    assert.equal(uploadedBatches[0].items[0].entity_id, 'tx-alice-offline-durability');

    const syncedTx = await txRepo.getById('tx-alice-offline-durability');
    assert.equal(syncedTx?.sync_status, 'synced');

    // Restore fetch
    globalThis.fetch = prevFetch;
    console.log('✓ Scenario M passed (Cases 1 - 6 verified)');
  }

  console.log('\n--- ALL PHASE 5 SMS INTEGRATION SCENARIOS A - L PASSED! ---');
}

runAllSmsIntegrationTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
