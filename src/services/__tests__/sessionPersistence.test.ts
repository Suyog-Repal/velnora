/**
 * Session storage: a refreshed session that cannot be written is kept in memory and retried with backoff, never dropped,
 * and the shared refresh keeps using it. Pure logic with a fake store and a fake clock; it says nothing about a real
 * Android Keystore (see docs/MANUAL_TEST_AUTH_RESILIENCE.md).
 */
import assert from 'node:assert/strict';
import { createSessionStore, createWriteFailureInjector, defaultBackoffMs, isValidSession, parseDebugFailCount, type SessionStorePort } from '../sessionPersistence.ts';
import { createSharedRefresh, type RefreshableSession } from '../sessionRefresh.ts';

interface S extends RefreshableSession { tag?: string }
const session = (refresh: string, access = `a-${refresh}`): S => ({ access_token: access, refresh_token: refresh, user: { id: 'u1' } });

/** In-memory secure store whose writes can be made to fail. */
class FakeStore implements SessionStorePort {
  value: string | null = null;
  failWrites = 0; // fail this many writes, then succeed
  alwaysFail = false;
  writes = 0;
  removed = 0;
  failReads = false;
  async read() { if (this.failReads) throw new Error('keystore not ready'); return this.value; }
  async write(v: string) { this.writes += 1; if (this.alwaysFail || this.failWrites > 0) { if (this.failWrites > 0) this.failWrites -= 1; throw new Error('keystore unavailable'); } this.value = v; }
  async remove() { this.removed += 1; this.value = null; }
}

/** Fake clock: tasks run only when the test says so. */
function fakeClock() {
  const tasks: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; tasks.push(t); return () => { t.cancelled = true; }; },
    delays: () => tasks.map((t) => t.ms),
    live: () => tasks.filter((t) => !t.cancelled).length,
    /** Runs the next live task and lets its promise chain settle. */
    async runNext() { const t = tasks.find((x) => !x.cancelled); assert.ok(t, 'a retry should be scheduled'); t.cancelled = true; t.fn(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed += 1; console.log(`✓ ${name}`); }

async function main() {
  await test('backoff: 1 s, 2 s, 4 s ... capped at 60 s', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(defaultBackoffMs), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  await test('a refreshed session that saves fine is stored and nothing is pending', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    const store = createSessionStore<S>(port, { schedule: clock.schedule });
    assert.equal(await store.persistIssued(session('r2')), 'saved');
    assert.equal(store.hasPending(), false);
    assert.equal(JSON.parse(port.value!).refresh_token, 'r2');
    assert.equal(clock.live(), 0);
  });

  await test('a failed save keeps the new session in memory, load returns it, and the write is retried with backoff until it works', async () => {
    const port = new FakeStore(); const clock = fakeClock(); const events: string[] = [];
    port.value = JSON.stringify(session('r1')); // the OLD, now-rotated token is what storage still holds
    port.failWrites = 2;
    const store = createSessionStore<S>(port, { schedule: clock.schedule, onEvent: (e) => { if (e !== 'load_session') events.push(e); } });

    assert.equal(await store.persistIssued(session('r2')), 'deferred');
    assert.equal(store.hasPending(), true);
    assert.equal((await store.load())!.refresh_token, 'r2', 'the unsaved session outranks the stale stored one');
    assert.equal(JSON.parse(port.value!).refresh_token, 'r1', 'storage is untouched until a write succeeds');

    await clock.runNext();                                   // retry 1 fails (second failure)
    assert.equal(store.hasPending(), true);
    assert.equal((await store.load())!.refresh_token, 'r2');
    await clock.runNext();                                   // retry 2 succeeds
    assert.equal(store.hasPending(), false);
    assert.equal(JSON.parse(port.value!).refresh_token, 'r2');
    assert.deepEqual(clock.delays(), [1000, 2000]);
    assert.equal(clock.live(), 0, 'no retry is left once it is written');
    assert.deepEqual(events, ['save_session_fail', 'save_session_fail', 'save_session_ok']);
  });

  await test('it never gives up: a store that always fails keeps the session and keeps retrying at the capped delay', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    port.alwaysFail = true;
    const store = createSessionStore<S>(port, { schedule: clock.schedule });
    await store.persistIssued(session('r2'));
    for (let i = 0; i < 9; i += 1) await clock.runNext();
    assert.equal(store.hasPending(), true);
    assert.equal((await store.load())!.refresh_token, 'r2');
    assert.deepEqual(clock.delays().slice(-3), [60000, 60000, 60000]);
    port.alwaysFail = false;                                  // the keystore recovers
    await clock.runNext();
    assert.equal(store.hasPending(), false);
    assert.equal(JSON.parse(port.value!).refresh_token, 'r2');
  });

  await test('a newer refreshed session replaces an unsaved older one, and the latest is what gets written', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    port.failWrites = 1;
    const store = createSessionStore<S>(port, { schedule: clock.schedule });
    await store.persistIssued(session('r2'));
    assert.equal(await store.persistIssued(session('r3')), 'saved'); // storage works again; r3 is written directly
    assert.equal(JSON.parse(port.value!).refresh_token, 'r3');
    assert.equal(store.hasPending(), false);
    await clock.runNext().catch(() => undefined);              // a stale retry must not overwrite r3 with r2
    assert.equal(JSON.parse(port.value!).refresh_token, 'r3');
  });

  await test('flushPending (app returns to the foreground) writes right away', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    port.failWrites = 1;
    const store = createSessionStore<S>(port, { schedule: clock.schedule });
    await store.persistIssued(session('r2'));
    assert.equal(await store.flushPending(), true);
    assert.equal(JSON.parse(port.value!).refresh_token, 'r2');
    assert.equal(store.hasPending(), false);
    assert.equal(await store.flushPending(), true, 'nothing pending is a no-op');
  });

  await test('clear (sign out) drops the pending session and cancels the retry', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    port.alwaysFail = true;
    const store = createSessionStore<S>(port, { schedule: clock.schedule });
    await store.persistIssued(session('r2'));
    await store.clear();
    assert.equal(store.hasPending(), false);
    assert.equal(clock.live(), 0);
    assert.equal(await store.load(), null);
    assert.equal(port.removed, 1);
  });

  await test('login save reports a failed write to the caller and clears an older pending session', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    port.failWrites = 1;
    const store = createSessionStore<S>(port, { schedule: clock.schedule });
    await store.persistIssued(session('old'));
    port.failWrites = 1;
    await assert.rejects(store.save(session('fresh-login')), /keystore unavailable/);
    assert.equal(store.hasPending(), false, 'the old pending session must not later overwrite a newer sign-in');
    assert.equal(clock.live(), 0);
    await store.save(session('fresh-login'));
    assert.equal(JSON.parse(port.value!).refresh_token, 'fresh-login');
  });

  const full = { user: { id: 'u1', full_name: 'A B', email: 'a@x.com' }, access_token: 'acc', refresh_token: 'ref', token_type: 'bearer' };

  await test('session shape: only a complete session is accepted', () => {
    assert.equal(isValidSession(full), true);
    assert.equal(isValidSession({ ...full, token_type: undefined }), true, 'token_type is optional');
    for (const bad of [null, undefined, 'x', 5, [], {}, { ...full, access_token: '' }, { ...full, refresh_token: undefined }, { ...full, refresh_token: 7 },
      { ...full, user: null }, { ...full, user: { ...full.user, id: '' } }, { ...full, user: { ...full.user, full_name: undefined } }, { ...full, user: { ...full.user, email: 5 } }, { ...full, user: 'u1' }]) {
      assert.equal(isValidSession(bad), false, JSON.stringify(bad));
    }
  });

  await test('loadDetailed says why there is no session: missing, read_error, parse_error, invalid_shape (and ok)', async () => {
    const port = new FakeStore(); const events: string[] = [];
    const store = createSessionStore(port, { validate: isValidSession, onEvent: (e, d) => { if (e === 'load_session') events.push(String(d?.result)); } });
    assert.deepEqual(await store.loadDetailed(), { status: 'missing' });
    port.value = JSON.stringify(full);
    assert.deepEqual(await store.loadDetailed(), { status: 'ok', session: full });
    port.value = '{not json';
    assert.deepEqual(await store.loadDetailed(), { status: 'parse_error' });
    port.value = JSON.stringify({ user: { id: 'u1' }, access_token: 'a' });
    assert.deepEqual(await store.loadDetailed(), { status: 'invalid_shape' });
    port.value = JSON.stringify(full); port.failReads = true;
    assert.deepEqual(await store.loadDetailed(), { status: 'read_error' });
    assert.deepEqual(events, ['missing', 'ok', 'parse_error', 'invalid_shape', 'read_error']);
  });

  await test('loading NEVER deletes or rewrites what is stored, whatever it finds (so a headless task cannot end a session)', async () => {
    for (const stored of ['{not json', JSON.stringify({ user: {} }), JSON.stringify(full), null]) {
      const port = new FakeStore(); port.value = stored;
      const store = createSessionStore(port, { validate: isValidSession });
      await store.load(); await store.loadDetailed();
      port.failReads = true; await store.load();
      port.failReads = false;
      assert.equal(port.value, stored, 'storage is untouched');
      assert.equal(port.removed, 0);
      assert.equal(port.writes, 0);
    }
  });

  await test('load returns null for every non-ok result (callers that only need a session, e.g. background tasks)', async () => {
    const port = new FakeStore();
    const store = createSessionStore(port, { validate: isValidSession });
    assert.equal(await store.load(), null);
    port.value = '{not json'; assert.equal(await store.load(), null);
    port.value = JSON.stringify(full); assert.deepEqual(await store.load(), full);
  });

  await test('only clear() removes the stored session', async () => {
    const port = new FakeStore(); port.value = JSON.stringify(full);
    const store = createSessionStore(port, { validate: isValidSession });
    await store.clear();
    assert.equal(port.value, null);
    assert.equal(port.removed, 1);
  });

  await test('debug switch: the env value is parsed strictly, anything unusable means off', () => {
    assert.equal(parseDebugFailCount('3'), 3);
    assert.equal(parseDebugFailCount(' 6 '), 6);
    for (const off of [undefined, '', '0', '-1', '2.5', 'abc', '3x', '51', '1e3', 'true']) assert.equal(parseDebugFailCount(off), 0, String(off));
  });

  await test('debug switch: disabled it returns the real port untouched', async () => {
    const port = new FakeStore();
    const injector = createWriteFailureInjector(0);
    assert.equal(injector.enabled, false);
    assert.equal(injector.wrap(port), port, 'the very same object: no wrapper, no behaviour change');
    injector.arm();
    await injector.wrap(port).write('x');
    assert.equal(port.value, 'x');
  });

  await test('debug switch: nothing fails until armed (sign-in is unaffected), then exactly N writes fail, once per run', async () => {
    const port = new FakeStore();
    const injector = createWriteFailureInjector(2);
    const wrapped = injector.wrap(port);
    await wrapped.write('login');                     // before the first refresh: passes
    assert.equal(port.value, 'login');
    injector.arm();
    await assert.rejects(wrapped.write('a'), /simulated/);
    await assert.rejects(wrapped.write('b'), /simulated/);
    await wrapped.write('c');                         // the third write goes through
    assert.equal(port.value, 'c');
    injector.arm();                                   // a later refresh does not re-arm it
    await wrapped.write('d');
    assert.equal(port.value, 'd');
    assert.equal(await wrapped.read(), 'd');
    await wrapped.remove();
    assert.equal(port.value, null);
  });

  await test('debug switch with the real store: the refreshed session stays in memory through N failures, then is written', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    const injector = createWriteFailureInjector(3);
    port.value = JSON.stringify(session('r1'));
    const store = createSessionStore<S>(injector.wrap(port), { schedule: clock.schedule });
    await store.save(session('r1'));                  // sign-in works
    injector.arm();                                   // what auth.ts does on a successful refresh
    assert.equal(await store.persistIssued(session('r2')), 'deferred');
    assert.equal((await store.load())!.refresh_token, 'r2');
    await clock.runNext(); await clock.runNext();     // failures 2 and 3
    assert.equal(store.hasPending(), true);
    assert.equal((await store.load())!.refresh_token, 'r2', 'still signed in with the new tokens');
    await clock.runNext();                            // write 4 succeeds
    assert.equal(store.hasPending(), false);
    assert.equal(JSON.parse(port.value!).refresh_token, 'r2');
    assert.deepEqual(clock.delays(), [1000, 2000, 4000]);
  });

  await test('with the shared refresh: after a refresh whose save failed, the next refresh uses the NEW token and never re-sends the spent one', async () => {
    const port = new FakeStore(); const clock = fakeClock();
    port.value = JSON.stringify(session('r1'));
    port.failWrites = 99;                                      // every write fails for now
    const store = createSessionStore<S>(port, { schedule: clock.schedule });
    const sent: string[] = [];
    // The same wiring as auth.ts: network call, then persistIssued; loadStored is the store's load.
    const refreshOnce = createSharedRefresh<S>({
      loadStored: () => store.load(),
      refresh: async (s) => { sent.push(s.refresh_token); const next = session(`r${sent.length + 1}`); await store.persistIssued(next); return next; },
    });

    const first = await refreshOnce(session('r1'));            // server rotated r1 -> r2; the save failed
    assert.equal(first.refresh_token, 'r2');
    assert.equal(store.hasPending(), true);
    // A caller still holding the OLD session (e.g. a sync that got a 401 before the refresh finished) asks again:
    const again = await refreshOnce(session('r1'));
    assert.equal(again.refresh_token, 'r2', 'handed the already-issued session');
    assert.deepEqual(sent, ['r1'], 'the rotated token r1 was spent exactly once');
    // A caller with the new session refreshes next: it sends r2 (the pending one), not the stale r1 from storage.
    const next = await refreshOnce(session('r2'));
    assert.equal(next.refresh_token, 'r3');
    assert.deepEqual(sent, ['r1', 'r2']);
  });

  console.log(`${passed} tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
