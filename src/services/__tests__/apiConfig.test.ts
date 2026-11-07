import assert from 'node:assert/strict';
import { resolveApiUrl } from '../apiConfig.ts';
import { configureApiBaseUrl, getBaseApiUrl, pushSync } from '../syncApi.ts';

let passed = 0;
const test = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { passed++; console.log(`✓ ${name}`); });

await test('production URL is used as-is, trailing slashes removed, no problem reported', () => {
  const r = resolveApiUrl({ envUrl: ' https://velnora-api.example.test/// ', hostUri: '192.168.1.5:8081', isDev: false });
  assert.deepEqual(r, { url: 'https://velnora-api.example.test', source: 'env', problem: null });
});

await test('development without a URL follows the Expo dev-server host, else localhost', () => {
  assert.deepEqual(resolveApiUrl({ envUrl: '', hostUri: '192.168.1.5:8081', isDev: true }), { url: 'http://192.168.1.5:8000', source: 'dev-server', problem: null });
  assert.equal(resolveApiUrl({ envUrl: undefined, hostUri: null, isDev: true }).url, 'http://localhost:8000');
});

await test('development can point at a custom LAN address via the env var (nothing is hardcoded)', () => {
  assert.equal(resolveApiUrl({ envUrl: 'http://10.0.2.2:8000', hostUri: '192.168.1.5:8081', isDev: true }).url, 'http://10.0.2.2:8000');
  assert.equal(resolveApiUrl({ envUrl: 'http://10.0.2.2:8000', isDev: true }).problem, null);
});

await test('a release build with no URL disables cloud sync instead of silently using localhost', () => {
  const r = resolveApiUrl({ envUrl: '', hostUri: '192.168.1.5:8081', isDev: false });
  assert.equal(r.url, ''); assert.equal(r.source, 'unset'); assert.match(r.problem ?? '', /EXPO_PUBLIC_API_URL is not set/);
  assert.match(r.problem ?? '', /sign-in, account creation/);
});

await test('malformed and cleartext production URLs are flagged', () => {
  const bad = resolveApiUrl({ envUrl: 'velnora-api.example.test', isDev: false });
  assert.equal(bad.url, ''); assert.match(bad.problem ?? '', /must start with http/);
  const clear = resolveApiUrl({ envUrl: 'http://velnora-api.example.test', isDev: false });
  assert.equal(clear.url, 'http://velnora-api.example.test'); assert.match(clear.problem ?? '', /https/);
  assert.equal(resolveApiUrl({ envUrl: 'http://velnora-api.example.test', isDev: true }).problem, null);
});

await test('sync requests use the one configured base URL (no second, divergent default)', async () => {
  configureApiBaseUrl('https://velnora-api.example.test/');
  assert.equal(getBaseApiUrl(), 'https://velnora-api.example.test');
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => { seen.push(String(url)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as typeof fetch;
  try {
    await pushSync('token', { items: [] });          // no explicit base URL, exactly as the sync engine calls it
    assert.deepEqual(seen, ['https://velnora-api.example.test/api/v1/sync/push']);
  } finally { globalThis.fetch = realFetch; }
});

await test('an unset production URL makes sync fail as an ordinary connection error (changes stay queued)', async () => {
  configureApiBaseUrl('');
  assert.equal(getBaseApiUrl(), '');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
  try {
    await assert.rejects(() => pushSync('token', { items: [] }), (e: unknown) => (e as { kind?: string }).kind === 'connection');
  } finally { globalThis.fetch = realFetch; }
});

console.log(`\n${passed} API config tests passed`);
