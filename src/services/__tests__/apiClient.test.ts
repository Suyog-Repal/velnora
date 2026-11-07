/**
 * Registration / login client: request shape, failure classification and log safety.
 * Uses a fake fetch (no network). The registration route and schema are pinned to the backend by
 * backend/app/test_phase7_config.py::test_register_contract_matches_the_mobile_client.
 */
import assert from 'node:assert/strict';
import { AUTH_PATHS, AuthRequestError, MESSAGES, apiRequest, expectSession, readErrorDetail, registerBody, type ApiClientOptions } from '../apiClient.ts';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`✓ ${name}`); };

const BASE = 'https://velnora-backend.example.test';
const PASSWORD = 'Hunter2-Secret!';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SESSION = { user: { id: 'u1', full_name: 'Asha', email: 'asha@example.test' }, access_token: 'ACCESS-TOKEN-VALUE', refresh_token: 'REFRESH-TOKEN-VALUE', token_type: 'bearer' };

function harness(fetchImpl: typeof fetch, overrides: Partial<ApiClientOptions> = {}) {
  const logs: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const wrapped = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return fetchImpl(url as never, init); }) as typeof fetch;
  return { logs, calls, opts: { baseUrl: BASE, fetchImpl: wrapped, timeoutMs: 150, log: (_l: 'info' | 'warn', line: string) => logs.push(line), ...overrides } as ApiClientOptions };
}
async function failure(promise: Promise<unknown>): Promise<AuthRequestError> {
  try { await promise; } catch (e) { assert.ok(e instanceof AuthRequestError, `expected AuthRequestError, got ${String(e)}`); return e; }
  throw new Error('expected the request to fail');
}
const body = (extra = {}) => JSON.stringify({ ...registerBody('Asha', 'asha@example.test', PASSWORD), ...extra });

await test('registration request: exact method, URL, headers and the fields the backend declares', async () => {
  const h = harness(async () => json(201, SESSION));
  const out = expectSession<typeof SESSION>(await apiRequest<unknown>(h.opts, AUTH_PATHS.register, { method: 'POST', body: body() }));
  assert.equal(out.user.id, 'u1');
  const [call] = h.calls;
  assert.equal(call.url, `${BASE}/api/v1/auth/register`);
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(JSON.parse(String(call.init.body))).sort(), ['email', 'full_name', 'password', 'terms_accepted']);
  assert.equal(JSON.parse(String(call.init.body)).terms_accepted, true);
  assert.deepEqual(Object.values(AUTH_PATHS).every((p) => p.startsWith('/api/v1/auth/')), true, 'one /api/v1 prefix, never doubled');
  assert.ok(!`${BASE}${AUTH_PATHS.register}`.includes('/api/v1/api/'));
});

await test('not configured: reported as a configuration problem, nothing is sent', async () => {
  const h = harness(async () => json(200, {}), { baseUrl: '' });
  const e = await failure(apiRequest(h.opts, AUTH_PATHS.register, { method: 'POST', body: body() }));
  assert.equal(e.kind, 'config'); assert.equal(e.message, MESSAGES.config);
  assert.notEqual(e.message, MESSAGES.connection, 'must NOT claim the server is unreachable');
  assert.equal(h.calls.length, 0, 'no request to a blank URL');
  assert.match(h.logs.join('\n'), /EXPO_PUBLIC_API_URL/);
});

await test('network failure: "connection", with the real cause only in the log', async () => {
  const h = harness(async () => { throw new TypeError('Network request failed'); });
  const e = await failure(apiRequest(h.opts, AUTH_PATHS.login, { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: PASSWORD }) }));
  assert.equal(e.kind, 'connection'); assert.equal(e.message, MESSAGES.connection); assert.equal(e.status, undefined);
  assert.match(h.logs[0], /POST https:\/\/velnora-backend\.example\.test\/api\/v1\/auth\/login -> no response \(network failure: TypeError: Network request failed\)/);
});

await test('timeout (server still waking up): a distinct "timeout" error', async () => {
  const h = harness((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')))), { timeoutMs: 30 });
  const e = await failure(apiRequest(h.opts, AUTH_PATHS.register, { method: 'POST', body: body() }));
  assert.equal(e.kind, 'timeout'); assert.equal(e.message, MESSAGES.timeout);
  assert.match(h.logs[0], /timeout/);
});

await test('HTTP 4xx: the server message is shown (duplicate e-mail, wrong password, terms)', async () => {
  for (const [status, detail] of [[409, 'An account with that email already exists'], [401, 'Invalid email or password'], [400, 'Terms acceptance is required'], [400, 'Password must contain an uppercase letter and a number']] as const) {
    const h = harness(async () => json(status, { detail }));
    const e = await failure(apiRequest(h.opts, AUTH_PATHS.register, { method: 'POST', body: body() }));
    assert.deepEqual([e.kind, e.status, e.message], ['client', status, detail]);
    assert.match(h.logs[0], new RegExp(`HTTP ${status} \\(client error\\)`));
  }
});

await test('HTTP 422 validation: "field: message" is shown and what the user typed is never echoed or logged', async () => {
  const h = harness(async () => json(422, { detail: [{ type: 'value_error', loc: ['body', 'email'], msg: 'value is not a valid email address: An email address must have an @-sign.', input: `not-an-email ${PASSWORD}`, ctx: {} }] }));
  const e = await failure(apiRequest(h.opts, AUTH_PATHS.register, { method: 'POST', body: body() }));
  assert.deepEqual([e.kind, e.status], ['client', 422]);
  assert.equal(e.message, 'email: value is not a valid email address: An email address must have an @-sign.');
  assert.ok(!e.message.includes(PASSWORD) && !h.logs.join('\n').includes(PASSWORD), 'the echoed input is dropped');
});

await test('HTTP 5xx / sleeping server: "server" errors with the right wording, even for non-JSON bodies', async () => {
  const cases: [Response, string][] = [
    [new Response('<html>Service Unavailable</html>', { status: 503 }), MESSAGES.starting],
    [new Response('Bad Gateway', { status: 502 }), MESSAGES.starting],
    [json(500, {}), MESSAGES.unavailable],
    [json(500, { detail: 'Internal error' }), 'Internal error'],
  ];
  for (const [response, expected] of cases) {
    const h = harness(async () => response.clone());
    const e = await failure(apiRequest(h.opts, AUTH_PATHS.register, { method: 'POST', body: body() }));
    assert.equal(e.kind, 'server'); assert.equal(e.message, expected);
  }
});

await test('a 2xx that is not a Velnora session (wrong URL / proxy page) is rejected as such', async () => {
  const h = harness(async () => new Response('<html>Welcome to nginx</html>', { status: 200 }));
  const raw = await apiRequest<unknown>(h.opts, AUTH_PATHS.register, { method: 'POST', body: body() });
  assert.throws(() => expectSession(raw), (e: unknown) => e instanceof AuthRequestError && e.kind === 'server' && e.message === MESSAGES.unexpected);
  assert.throws(() => expectSession({ access_token: 'x' }), AuthRequestError);
  assert.doesNotThrow(() => expectSession(SESSION));
});

await test('logs never contain passwords, tokens, the Authorization header or request bodies', async () => {
  const h = harness(async () => json(201, SESSION));
  await apiRequest(h.opts, AUTH_PATHS.refresh, { method: 'POST', headers: { Authorization: 'Bearer ACCESS-TOKEN-VALUE' }, body: JSON.stringify({ refresh_token: 'REFRESH-TOKEN-VALUE' }) });
  const failing = harness(async () => json(401, { detail: 'Invalid email or password' }));
  await failure(apiRequest(failing.opts, AUTH_PATHS.login, { method: 'POST', body: JSON.stringify({ email: 'asha@example.test', password: PASSWORD }) }));
  const text = [...h.logs, ...failing.logs].join('\n');
  for (const secret of [PASSWORD, 'ACCESS-TOKEN-VALUE', 'REFRESH-TOKEN-VALUE', 'Bearer', 'asha@example.test']) assert.ok(!text.includes(secret), `log leaked ${secret}`);
  assert.match(text, /HTTP 201/); assert.match(text, /HTTP 401/);
});

await test('readErrorDetail understands both FastAPI error shapes', () => {
  assert.equal(readErrorDetail({ detail: 'plain' }), 'plain');
  assert.equal(readErrorDetail({ detail: [{ loc: ['body', 'password'], msg: 'Value error, too short' }] }), 'password: too short');
  assert.equal(readErrorDetail({ detail: [{ msg: 'no location' }] }), 'no location');
  assert.equal(readErrorDetail({ detail: [] }), null);
  assert.equal(readErrorDetail(null), null);
  assert.equal(readErrorDetail('<html>'), null);
});

console.log(`\n${passed} API client tests passed`);
