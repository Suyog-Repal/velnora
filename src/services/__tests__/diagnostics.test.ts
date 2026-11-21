/**
 * Diagnostics ring buffer: capacity, privacy filtering (tokens, e-mails, ids, amounts can never get in), persistence across
 * runs, and the per-sync-cycle summary computed from a real SQLite queue and the real sync HTTP layer.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { SyncQueueRepository } from '../../db/repositories/syncQueueRepository.ts';
import { DIAG_CAPACITY, createDiagnostics, diagnostics, sanitizeData, type DiagnosticsPort } from '../diagnostics.ts';
import { classifyCycleError, installSyncHttpTally, recordSyncCycle, summarizeQueue, takeHttpTally } from '../syncDiagnostics.ts';
import { pushSync } from '../syncApi.ts';
import type { IDatabase } from '../../db/types.ts';

// Things that must never appear in a report.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const EMAIL = 'someone@example.com';
const USER_ID = '4f2c9a10-aaaa-4bbb-8ccc-123456789abc';
const PASSWORD = 'SecurePass1!';
const SECRETS = [JWT, EMAIL, USER_ID, PASSWORD, 'SecurePass1', 'Authorization: Bearer abc', 'user@bank.in debited Rs 1,234.56'];

class MemoryPort implements DiagnosticsPort {
  value: string | null = null;
  writes = 0;
  async read() { return this.value; }
  async write(v: string) { this.writes += 1; this.value = v; }
}
function fakeClock() {
  const tasks: { fn: () => void; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void) => { const t = { fn, cancelled: false }; tasks.push(t); return () => { t.cancelled = true; }; },
    run: () => { for (const t of tasks) if (!t.cancelled) { t.cancelled = true; t.fn(); } },
    live: () => tasks.filter((t) => !t.cancelled).length,
  };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed += 1; console.log(`✓ ${name}`); }

async function main() {
  await test('ring buffer keeps the last 200 events, oldest dropped, in order', () => {
    const log = createDiagnostics();
    assert.equal(DIAG_CAPACITY, 200);
    for (let i = 1; i <= 250; i += 1) log.record('refresh_http', { status: i });
    const entries = log.entries();
    assert.equal(entries.length, 200);
    assert.equal(entries[0].d?.status, 51);
    assert.equal(entries[199].d?.status, 250);
  });

  await test('every event type from the approved list is accepted', () => {
    const log = createDiagnostics();
    log.record('load_session', { result: 'missing' });
    log.record('refresh_start', { source: 'launch' });
    log.record('refresh_http', { status: 403, kind: 'client' });
    log.record('save_session_ok');
    log.record('save_session_fail', { retry: 2 });
    log.record('session_cleared', { site: 'launch_expired' });
    log.record('notice_shown', { notice: 'cant_verify' });
    log.record('headless_task', { task: 'capture_drain', session_present: false });
    log.record('sync_cycle', { pending: 210, eligible: 0, waiting: 210, failed: 0, error_codes: { internal_error: 210 }, http: { '200': 4, '500': 1 } });
    log.record('app_state', { state: 'background' });
    log.record('network', { type: 'wifi', connected: true });
    assert.equal(log.entries().length, 11);
  });

  await test('privacy: secrets in any allowed field are redacted, in unknown fields dropped, and never reach the report', () => {
    const log = createDiagnostics();
    for (const secret of SECRETS) {
      log.record('refresh_http', { kind: secret, status: secret as unknown as number });
      log.record('notice_shown', { notice: secret });
      log.record('session_cleared', { site: secret });
      log.record('sync_cycle', { error_codes: { [secret]: 3 }, last_error: secret });
      log.record('load_session', { result: 'ok', access_token: secret, refresh_token: secret, email: secret, user_id: secret, amount: secret, token: secret } as never);
    }
    log.setContext({ app: JWT, net: EMAIL });
    log.record('network', { type: USER_ID });
    log.setContext({ app: 'SecurePass1' });
    log.record('app_state', { state: 'SecurePass1' });
    const report = log.format({ app: PASSWORD });
    for (const secret of SECRETS) assert.ok(!report.includes(secret), `report must not contain ${secret.slice(0, 12)}...`);
    const text = JSON.stringify(log.entries());
    for (const secret of SECRETS) assert.ok(!text.includes(secret), 'entries must not contain it either');
    assert.ok(!/access_token|refresh_token|user_id|amount|"email"/.test(text), 'unknown keys are dropped, not stored');
    assert.ok(report.includes('[redacted]'));
  });

  await test('privacy: numbers only under count-like keys, strings only from a fixed vocabulary, histograms fold unknown keys into "other"', () => {
    assert.deepEqual(sanitizeData({ result: 12345 as never }), { result: '[redacted]' });
    assert.deepEqual(sanitizeData({ status: 'two hundred' as never }), undefined, 'a string under a number key is dropped');
    assert.deepEqual(sanitizeData({ status: 403.9 }), { status: 403 });
    assert.deepEqual(sanitizeData({ status: Number.NaN }), undefined);
    assert.deepEqual(sanitizeData({ status: 1e12 }), undefined);
    assert.deepEqual(sanitizeData({ result: 'x'.repeat(25) }), { result: '[redacted]' });
    // Even a short, plain, password-like word is refused: strings must come from the fixed vocabulary of their key.
    for (const word of ['SecurePass1', 'hunter2', 'abc123', 'user42']) {
      assert.deepEqual(sanitizeData({ result: word, notice: word, site: word, kind: word, source: word, task: word, state: word, type: word, last_error: word }),
        { result: '[redacted]', notice: '[redacted]', site: '[redacted]', kind: '[redacted]', source: '[redacted]', task: '[redacted]', state: '[redacted]', type: '[redacted]', last_error: '[redacted]' });
    }
    assert.deepEqual(sanitizeData({ notice: 'sign_in_again' }), { notice: 'sign_in_again' });
    assert.deepEqual(sanitizeData({ site: 'parse_error' }), { site: '[redacted]' }, 'a word from another key is not accepted');
    assert.deepEqual(sanitizeData({ result: 'parse_error' }), { result: 'parse_error' });
    assert.deepEqual(sanitizeData({ error_codes: { internal_error: 2, 'Server rejected item for a@b.com': 1, 'another free text message': 4 } }), { error_codes: { internal_error: 2, other: 5 } });
    assert.deepEqual(sanitizeData({ http: { '200': 1, secret: 'x' as never } }), { http: { '200': 1 } });
    assert.deepEqual(sanitizeData({ error_codes: { SecurePass1: 1, hunter2: 2, internal_error: 3, PERMANENT_ERROR_422: 1, '403': 1 } }), { error_codes: { other: 3, internal_error: 3, PERMANENT_ERROR_422: 1, '403': 1 } }, 'a short word that is not a known code is folded into other');
    assert.deepEqual(sanitizeData({ error_codes: 'not a histogram' as never }), undefined);
    assert.deepEqual(sanitizeData({ session_present: 'yes' as never }), undefined);
    assert.equal(sanitizeData(undefined), undefined);
  });

  await test('an unknown event name is ignored and record never throws', () => {
    const log = createDiagnostics();
    log.record('login_with_password' as never, { result: 'ok' });
    assert.equal(log.entries().length, 0);
    assert.doesNotThrow(() => log.record('refresh_http', { get status(): number { throw new Error('boom'); } } as never));
  });

  await test('context: app state and network type are stamped on later events', () => {
    const log = createDiagnostics();
    log.setContext({ app: 'background', net: 'cellular' });
    log.record('refresh_http', { status: 401 });
    assert.deepEqual([log.entries()[0].app, log.entries()[0].net], ['background', 'cellular']);
    assert.match(log.format(), /app=background net=cellular refresh_http status=401/);
  });

  await test('persistence: writes are debounced, and a new run sees the previous run first, capped at 200', async () => {
    const port = new MemoryPort();
    const clock = fakeClock();
    const first = createDiagnostics({ schedule: clock.schedule });
    await first.attach(port);
    clock.run();
    port.writes = 0;
    for (let i = 0; i < 5; i += 1) first.record('refresh_http', { status: 200 + i });
    assert.equal(clock.live(), 1, 'one pending write for five events');
    clock.run();
    assert.equal(port.writes, 1);

    const second = createDiagnostics({ schedule: clock.schedule });
    second.record('app_state', { state: 'active' }); // recorded before storage is attached
    await second.attach(port);
    assert.deepEqual(second.entries().map((e) => e.ev), ['refresh_http', 'refresh_http', 'refresh_http', 'refresh_http', 'refresh_http', 'app_state']);

    const big = createDiagnostics({ schedule: clock.schedule });
    for (let i = 0; i < 150; i += 1) big.record('refresh_http', { status: 200 });
    await big.attach({ read: async () => JSON.stringify(Array.from({ length: 150 }, () => ({ t: new Date().toISOString(), ev: 'refresh_http', d: { status: 500 } }))), write: async () => undefined });
    assert.equal(big.entries().length, 200);
  });

  await test('persistence: a tampered or old stored file cannot smuggle secrets or junk into a report', async () => {
    const stored = JSON.stringify([
      { t: new Date().toISOString(), ev: 'load_session', d: { result: JWT, access_token: JWT, email: EMAIL } },
      { t: 'not a date', ev: 'load_session' },
      { t: new Date().toISOString(), ev: 'steal_password' },
      'junk', null, 7,
      { t: new Date().toISOString(), ev: 'network', app: USER_ID, net: EMAIL, d: { type: 'wifi', connected: true } },
    ]);
    const log = createDiagnostics();
    await log.attach({ read: async () => stored, write: async () => undefined });
    const report = log.format();
    for (const secret of SECRETS) assert.ok(!report.includes(secret));
    assert.equal(log.entries().length, 2);
    await createDiagnostics().attach({ read: async () => '{not json', write: async () => undefined }); // unreadable history does not throw
  });

  await test('clear empties the log and the stored copy', async () => {
    const port = new MemoryPort();
    const log = createDiagnostics();
    await log.attach(port);
    log.record('app_state', { state: 'active' });
    await log.clear();
    assert.equal(log.entries().length, 0);
    assert.equal(port.value, '[]');
  });

  await test('report format: header, one plain line per event, histograms readable', () => {
    const log = createDiagnostics({ now: () => new Date('2026-11-21T10:00:00.000Z') });
    log.record('sync_cycle', { pending: 210, eligible: 0, waiting: 210, failed: 0, error_codes: { internal_error: 210 }, http: { '200': 2, '401': 1 }, last_error: 'none' });
    const lines = log.format({ app: '1.0.0' }).split('\n');
    assert.equal(lines[0], 'Velnora diagnostics');
    assert.ok(lines.includes('app: 1.0.0'));
    assert.ok(lines.includes('---'));
    assert.equal(lines.at(-1), '2026-11-21T10:00:00.000Z sync_cycle pending=210 eligible=0 waiting=210 failed=0 error_codes={internal_error:210} http={200:2,401:1} last_error=none');
  });

  // --- sync cycle summary ---------------------------------------------------------------------------------------------
  await test('summarizeQueue: pending = eligible + waiting + failed, with an error-code histogram', () => {
    const now = '2026-11-21T10:00:00.000Z';
    const counts = summarizeQueue([
      { next_retry_at: null, error_code: null },
      { next_retry_at: '2026-11-21T09:00:00.000Z', error_code: 'NO_ACK' }, // retry time passed: eligible
      { next_retry_at: '2026-11-21T10:05:00.000Z', error_code: 'internal_error' }, // waiting
      { next_retry_at: '2026-11-21T10:05:00.000Z', error_code: 'internal_error' },
      { next_retry_at: '9999-12-31T23:59:59Z', error_code: 'PERMANENT_ERROR_422' }, // parked
    ], now);
    assert.deepEqual(counts, { pending: 5, eligible: 2, waiting: 2, failed: 1, error_codes: { NO_ACK: 1, internal_error: 2, PERMANENT_ERROR_422: 1 } });
    assert.equal(counts.eligible + counts.waiting + counts.failed, counts.pending);
    assert.deepEqual(summarizeQueue([], now), { pending: 0, eligible: 0, waiting: 0, failed: 0, error_codes: {} });
  });

  await test('classifyCycleError gives a class, never the message', () => {
    assert.equal(classifyCycleError([]), 'none');
    assert.equal(classifyCycleError(['UNAUTHORIZED']), 'unauthorized');
    assert.equal(classifyCycleError(['No active session']), 'no_session');
    assert.equal(classifyCycleError(['Sync already in progress']), 'in_progress');
    assert.equal(classifyCycleError([`${USER_ID}: rejected by server (422)`]), 'rejected');
    assert.equal(classifyCycleError(['Synchronization server did not respond in time.']), 'network');
    assert.equal(classifyCycleError([`a message with ${EMAIL}`]), 'other');
  });

  await test('recordSyncCycle: reads the real queue and the real HTTP statuses, and leaks nothing', async () => {
    const db = new NodeSqliteAdapter() as unknown as IDatabase;
    await runMigrations(db);
    const queue = new SyncQueueRepository(db);
    const add = (id: string) => queue.enqueue({ entity_type: 'budget', entity_id: id, operation: 'create', payload: JSON.stringify({ user_id: 'u1', category: 'Food', amount_paise: 123456 }) });
    await add('b1');
    const b = await add('b2');
    const c = await add('b3');
    const d = await add('b4');
    await queue.markFailed(b!.id, 'internal_error', new Date(Date.now() + 600_000).toISOString());
    await queue.markFailed(c!.id, `Server rejected item for ${EMAIL} amount 1234.56`, new Date(Date.now() + 600_000).toISOString());
    await queue.markFailed(d!.id, 'PERMANENT_ERROR_422', '9999-12-31T23:59:59Z');

    installSyncHttpTally();
    takeHttpTally();
    (globalThis as { fetch: unknown }).fetch = async (_url: string, init: { headers: Record<string, string> }) => {
      assert.ok(init.headers.Authorization.startsWith('Bearer '));
      return new Response(JSON.stringify({ detail: 'Invalid or expired session' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(pushSync(JWT, { items: [] }, 'http://localhost:1'));
    (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    await pushSync(JWT, { items: [] }, 'http://localhost:1');
    (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
    await assert.rejects(pushSync(JWT, { items: [] }, 'http://localhost:1'));

    await recordSyncCycle(db, { pushed: 0, pulled: 0, errors: ['UNAUTHORIZED'] }, 'u1');
    const entry = diagnostics.entries().filter((e) => e.ev === 'sync_cycle').at(-1)!;
    assert.deepEqual(entry.d, {
      pending: 4, eligible: 1, waiting: 2, failed: 1,
      error_codes: { internal_error: 1, other: 1, PERMANENT_ERROR_422: 1 },
      http: { '401': 1, '200': 1, network: 1 },
      pushed: 0, pulled: 0, errors: 1, last_error: 'unauthorized',
    });
    const report = diagnostics.format();
    for (const secret of [...SECRETS, '123456', '1234.56']) assert.ok(!report.includes(secret), `report leaked ${secret}`);
    assert.deepEqual(takeHttpTally(), {}, 'the tally was consumed by the cycle report');
  });

  console.log(`${passed} tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
