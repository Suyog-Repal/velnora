/**
 * The capture log: retention and privacy of the real SQL the app runs (read from the Kotlin file), the export, the reason
 * codes, and the entries the drain writes. All messages are invented.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseSmsTransaction } from '../../../transactionParser.ts';
import { LOG_RESULTS, LOG_SOURCES, LOG_STAGES, REASON_LABELS, captureNote, explainRejection, formatCaptureLog, sanitizeLogRows } from '../captureLog.ts';
import { MAX_ATTEMPTS, drainStagedSms, purgeCaptureData } from '../smsStagingService.ts';
import type { SmsProcessResult } from '../smsIntegrationService.ts';
import type { SmsStagingStore, StagedSms } from '../smsStagingTypes.ts';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed += 1; console.log(`✓ ${name}`); }

const kotlin = (file: string) => readFileSync(new URL(`../../../modules/velnora-sms/android/src/main/java/com/velnora/sms/${file}`, import.meta.url), 'utf8');
const SQL = Object.fromEntries([...kotlin('VelnoraCaptureLogSql.kt').matchAll(/const val (\w+) = """([\s\S]*?)"""/g)].map((m) => [m[1], m[2]]));
const RULES = kotlin('VelnoraCaptureRules.kt');
const constant = (name: string) => Function(`return (${new RegExp(`const val ${name} = ([0-9L *]+)`).exec(RULES)![1].replace(/L/g, '')})`)() as number;
const MAX_ROWS = constant('LOG_MAX_ROWS'); const MAX_AGE = constant('LOG_MAX_AGE_MS'); const COALESCE_MS = constant('LOG_COALESCE_MS');
const ALLOWED_COLUMNS = ['at', 'count', 'id', 'origin', 'reason', 'result', 'source', 'stage'];
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

function logDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SQL.CREATE_LOG);
  /** The same three steps as VelnoraSmsStagingStore.log. */
  const log = (at: number, origin = 'VM-DEMOBK-S', reason = 'otp') => {
    const key = ['sms', origin, 'receiver', 'dropped', reason];
    if (Number(db.prepare(SQL.COALESCE).run(at, ...key, at - COALESCE_MS).changes) === 0) db.prepare(SQL.INSERT).run(at, ...key);
    db.prepare(SQL.PRUNE).run(at - MAX_AGE, MAX_ROWS);
  };
  const rows = () => db.prepare(SQL.READ).all() as Record<string, unknown>[];
  return { db, log, rows };
}

await test('retention is 500 rows or 14 days', () => {
  assert.equal(MAX_ROWS, 500); assert.equal(MAX_AGE, 14 * 24 * 3600_000);
  const { log, rows } = logDb();
  for (let i = 0; i < 620; i += 1) log(NOW + i * 2 * COALESCE_MS);
  assert.equal(rows().length, 500, 'only the newest 500 stay');
  assert.equal(rows()[499].at, NOW + 120 * 2 * COALESCE_MS, 'the oldest 120 went');
  const old = logDb();
  old.log(NOW - MAX_AGE - 1000, 'VM-OLDOLD-S');
  old.log(NOW - MAX_AGE + 60_000, 'VM-KEPTBK-S');
  old.log(NOW, 'VM-NEWNEW-S');
  assert.deepEqual(old.rows().map((r) => r.origin), ['VM-NEWNEW-S', 'VM-KEPTBK-S'], 'older than 14 days is pruned');
});

await test('identical entries close together are counted on one row; different or later ones are not', () => {
  const { log, rows } = logDb();
  log(NOW); log(NOW + 1000); log(NOW + 2000);
  assert.equal(rows().length, 1); assert.equal(rows()[0].count, 3); assert.equal(rows()[0].at, NOW + 2000);
  log(NOW + 3000, 'VM-DEMOBK-S', 'sender_filtered');
  log(NOW + 3 * COALESCE_MS);
  assert.equal(rows().length, 3);
});

await test('privacy: the table has no column for a body, an amount, a name or an account, and Clear empties it', () => {
  const { db, log, rows } = logDb();
  const columns = (db.prepare('PRAGMA table_info(capture_log)').all() as { name: string }[]).map((c) => c.name).sort();
  assert.deepEqual(columns, ALLOWED_COLUMNS);
  for (const name of columns) assert.doesNotMatch(name, /body|text|amount|name|user|owner|account|balance|merchant|title|reference/i);
  log(NOW); assert.equal(rows().length, 1);
  assert.deepEqual(Object.keys(rows()[0]).sort(), ALLOWED_COLUMNS.filter((c) => c !== 'id'));
  db.exec(SQL.CLEAR); assert.equal(rows().length, 0);
  assert.doesNotMatch(readFileSync(new URL('../syncEngine.ts', import.meta.url), 'utf8'), /capture_?log/i, 'never synced');
});

await test('privacy: extra fields and unexpected values never reach the screen or the export', () => {
  const secret = { body: 'Rs 500 debited to Demo Person', amount: 500, name: 'Demo Person', user_id: 'user-A' };
  const base = { at: NOW, source: 'sms', origin: 'VM-DEMOBK-S', stage: 'parse', result: 'dropped', reason: 'promotion', count: 1 };
  const raw = [
    { ...base, ...secret },
    { ...base, origin: 'Demo Person' },
    { ...base, origin: '+910000000000' },
    { ...base, source: 'truecaller_notification', origin: 'Demo Person' },
    { ...base, source: 'payment_notification', origin: 'Demo Person' },
    { ...base, reason: secret.body }, { ...base, stage: 'Demo Person' }, { ...base, result: '500' }, { ...base, source: 'whatsapp' }, null,
  ];
  const clean = sanitizeLogRows(raw);
  assert.equal(clean.length, 5, 'rows with an unknown code are left out');
  for (const row of clean) assert.deepEqual(Object.keys(row).sort(), ALLOWED_COLUMNS.filter((c) => c !== 'id'));
  assert.deepEqual(clean.map((r) => r.origin), ['VM-DEMOBK-S', 'other', 'other', 'other', 'other']);
  const text = formatCaptureLog(raw, new Date(NOW));
  assert.doesNotMatch(text, /Demo Person|user-A|debited|\+91|\b500 debited/);
  assert.match(text, /sms VM-DEMOBK-S parse dropped promotion/);
  assert.deepEqual(sanitizeLogRows('nonsense'), []);
});

await test('JS and Kotlin use the same fixed vocabulary', () => {
  const set = (name: string) => [...new RegExp(`val ${name} = setOf\\(([\\s\\S]*?)\\n?\\s*\\)\\n`).exec(RULES)![1].matchAll(/"([a-z_]+)"|\b(SMS|PAYMENT|TRUECALLER)\b/g)]
    .map((m) => m[1] ?? { SMS: 'sms', PAYMENT: 'payment_notification', TRUECALLER: 'truecaller_notification' }[m[2] as 'SMS']).sort();
  assert.deepEqual(set('LOG_STAGES'), [...LOG_STAGES].sort());
  assert.deepEqual(set('LOG_RESULTS'), [...LOG_RESULTS].sort());
  assert.deepEqual(set('LOG_SOURCES'), [...LOG_SOURCES].sort());
  assert.deepEqual(set('LOG_REASONS'), Object.keys(REASON_LABELS).sort());
});

const sms = (body: string, sender = 'VM-DEMOBK-S') => ({ sender, body, receivedAt: NOW, partCount: 1, source: 'sms' as const });

await test('a parse rejection is explained by a reason code, without changing what the parser accepts', () => {
  const cases: [string, string][] = [
    ['Your OTP is 123456 for login', 'otp'],
    ['Flat 50% off! Use coupon DEMO today', 'promotion'],
    ['Transaction of Rs 500.00 failed', 'failed_wording'],
    ['Rs 500.00 payment is pending', 'pending_wording'],
    ['Your balance is Rs 500.00', 'no_status_word'],
    ['Rs 500.00 will be debited tomorrow', 'excluded_wording'],
    ['Rs 500.00 reversal will be credited soon', 'excluded_wording'],
    ['UPI txn of Rs 500.00 is successful', 'no_direction_or_amount'],
  ];
  for (const [body, reason] of cases) {
    assert.equal(parseSmsTransaction(sms(body)), null, body);
    assert.equal(explainRejection(sms(body)), reason, body);
  }
  assert.equal(explainRejection(sms('Rs 500.00 debited', '+910000000000')), 'sender_not_supported');
  assert.equal(explainRejection(sms('   ')), 'empty_message');
});

await test('the note for each outcome', () => {
  const note = (r: Partial<SmsProcessResult>, gaveUp = false) => { const n = captureNote(sms('Your OTP is 123456'), r as SmsProcessResult, gaveUp); return `${n.stage}/${n.result}/${n.reason}`; };
  assert.equal(note({ action: 'saved', transaction: {} as never }), 'insert/saved/saved');
  assert.equal(note({ action: 'saved', transaction: { possible_duplicate_of: 'x' } as never }), 'match/held/possible_duplicate');
  assert.equal(note({ action: 'duplicate_ignored', matchedBy: 'reference' }), 'match/dropped/same_reference');
  assert.equal(note({ action: 'duplicate_ignored', matchedBy: 'fingerprint' }), 'match/dropped/same_fingerprint');
  assert.equal(note({ action: 'duplicate_ignored', matchedBy: 'cross_source' }), 'match/dropped/same_payment_other_source');
  assert.equal(note({ action: 'unsupported_or_invalid' }), 'parse/dropped/otp');
  assert.equal(note({ action: 'error', reason: 'database is locked' }), 'insert/retry/persist_failed');
  assert.equal(note({ action: 'error', reason: 'processor_exception' }), 'insert/retry/processor_exception');
  assert.equal(note({ action: 'error', reason: 'x' }, true), 'insert/dead/max_attempts');
});

function fakeStore(items: StagedSms[], options: { logFails?: boolean } = {}) {
  const calls: unknown[][] = []; let claimed = false;
  const store: SmsStagingStore = {
    async setOwnerHint() {}, async counts() { return { pending: 0, dead: 0, heldForOthers: 0, ownerless: 0 }; },
    async claim() { if (claimed) return []; claimed = true; return items; },
    async complete(id) { calls.push(['complete', id]); },
    async scheduleRetry(id) { calls.push(['retry', id]); },
    async markDead(id) { calls.push(['dead', id]); },
    async purgeOwner(owner) { calls.push(['purge', owner]); },
    async clearCaptureLog() { calls.push(['clearLog']); },
    async logStagedOutcome(...args) { if (options.logFails) throw new Error('log unavailable'); calls.push(['log', ...args]); },
  };
  return { store, calls };
}
const staged = (id: number, attempts = 1): StagedSms => ({ id, sender: 'Demo Person', body: 'Rs 500.00 debited to Demo Person', receivedAt: NOW, partCount: 1, attempts, source: 'truecaller_notification' });
const outcomes: Record<number, SmsProcessResult> = {
  1: { success: true, action: 'saved', transaction: {} as never }, 2: { success: true, action: 'duplicate_ignored', matchedBy: 'reference' },
  3: { success: false, action: 'error', reason: 'Demo Person Rs 500' }, 4: { success: false, action: 'error', reason: 'x' },
};

await test('the drain logs each outcome before completing the event, passing only an id and codes', async () => {
  const { store, calls } = fakeStore([staged(1), staged(2), staged(3), staged(4, MAX_ATTEMPTS)]);
  let n = 0;
  await drainStagedSms(store, null, undefined, { processor: async () => outcomes[++n], now: () => NOW });
  assert.deepEqual(calls, [
    ['log', 1, 'insert', 'saved', 'saved'], ['complete', 1],
    ['log', 2, 'match', 'dropped', 'same_reference'], ['complete', 2],
    ['log', 3, 'insert', 'retry', 'persist_failed'], ['retry', 3],
    ['log', 4, 'insert', 'dead', 'max_attempts'], ['dead', 4],
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /Demo Person|500|debited/);
});

await test('a failing log changes nothing about what happens to the events', async () => {
  const { store, calls } = fakeStore([staged(1), staged(3)], { logFails: true });
  const results = [outcomes[1], outcomes[3]];
  const summary = await drainStagedSms(store, null, undefined, { processor: async () => results.shift()!, now: () => NOW });
  assert.deepEqual(calls, [['complete', 1], ['retry', 3]]);
  assert.deepEqual([summary.saved, summary.retried], [1, 1]);
});

await test('"Delete local data" removes the account\'s staged events and clears the log', async () => {
  const { store, calls } = fakeStore([]);
  await purgeCaptureData(store, 'user-A');
  assert.deepEqual(calls, [['purge', 'user-A'], ['clearLog']]);
});

console.log(`${passed} passed`);
