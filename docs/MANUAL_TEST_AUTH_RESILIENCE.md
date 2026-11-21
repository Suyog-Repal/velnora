# Manual test: sign-in resilience and diagnostics

`npm test` covers the logic (`sessionPersistence`, `sessionRefresh`, `guestMode` restore, `sessionNotices`, `diagnostics`
tests) and the backend tests cover token rotation and the 60-second reuse grace. They cannot show a real Android Keystore,
a real network, the notices on screen, or background tasks, so run this on a device. Debug build over USB
(`npx expo run:android --device`) is easiest because it allows plain-HTTP test servers.

Backend steps 1 to 3 must be deployed first (atomic rotation, 60 s reuse grace, `auth refresh outcome=` log lines).

## Setup

1. Sign in with a test account. Make a few transactions so there is data.
2. Profile > Privacy & data > **Copy diagnostics** (opens the share sheet; choose Copy, or share it to yourself) and paste it
   somewhere. You should see lines such as `load_session result=ok`, `refresh_start source=launch`, `refresh_http status=200`.
   Nothing in it may contain a token, password, e-mail address, account id or an amount.

## A. Only a 401 ends the session (400 / 403 / 422 keep it)

A 403 is produced with a tiny pass-through server on your PC. Save as `stub.mjs` and run `node stub.mjs https://<your-render-host> 8787 403`
(third argument is the status to return for `/api/v1/auth/refresh`: 403, 400, 422 or 401; everything else is passed through):

```js
import http from 'node:http';
const [target, port = '8787', status = '403'] = process.argv.slice(2);
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/v1/auth/refresh')) {
    res.writeHead(Number(status), { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ detail: status === '401' ? 'Invalid or revoked session' : 'Forbidden' }));
  }
  const body = await new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
  const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
  const r = await fetch(target + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(port), () => console.log(`stub on :${port} -> ${target}, refresh answers ${status}`));
```

Build the debug app with `EXPO_PUBLIC_API_URL=http://<your-PC-LAN-IP>:8787` (phone and PC on the same Wi-Fi), sign in through
the stub (login is passed through), then:

| # | Steps | Expected |
|---|-------|----------|
| A1 | Stub with status **403**. Force-close the app and reopen it. | App opens with your data. A card **"Can't verify your sign-in"** shows with **Retry** and **Sign in again**. You are NOT sent to the sign-in screen and there is no "Your session has ended" message. Syncing is paused. |
| A2 | Tap **Retry** while the stub still answers 403. | Button shows "Checking…", then a toast "Still can't verify your sign-in…". Card stays. |
| A3 | Restart the stub with status **200 behaviour** (stop it and use the real host in the app, or run the stub with a pass-through of refresh) and tap **Retry**. | Card disappears, sync resumes. |
| A4 | Repeat A1 with **400** and **422**. | Same as A1. |
| A5 | Stub with status **401**; reopen the app. | Sign-in screen with exactly: "Your session has ended. Sign in again; your data on this device is preserved." Local data is still there after signing in. |
| A6 | Back to A1 (403), then tap **Sign in again**. | Sign-in screen with "Sign in again to keep syncing. Your data on this device is preserved." After signing in your data is intact. |
| A7 | Stop the stub entirely (no server) and reopen. | "Offline · working from local data" line, no "Can't verify" card, session kept. |
| A8 | In the diagnostics: `refresh_http status=403 kind=client`, `notice_shown notice=cant_verify`, and for A5 `session_cleared site=launch_expired`. | |

## B. Saved sign-in could not be read / no session found

| # | Steps | Expected |
|---|-------|----------|
| B1 | **Reinstall/restore:** with a signed-in account and data, run `adb shell bmgr backupnow com.anonymous.velnora` then `adb uninstall com.anonymous.velnora` and `adb install` the same APK, then `adb shell bmgr restore com.anonymous.velnora` (or use a phone-to-phone restore). | Data is back but sign-in is not: sign-in screen shows "No saved sign-in was found on this device. This can happen after a reinstall or a restore…". Shown once; the next launch (still signed out) shows no notice. |
| B2 | Fresh install on a clean phone / emulator, first launch. | NO notice about a missing sign-in. |
| B3 | Sign out normally and reopen. | No "no session" notice (you signed out on purpose). |
| B4 | **Unreadable sign-in:** needs a corrupt stored value, which cannot be made from outside the app. Only the unit tests cover it; if you have a debug build you can overwrite the secure-store entry `velnora.session.v1` with junk using a temporary one-line script. | "Your saved sign-in couldn't be read on this device…". The stored value is NOT deleted (diagnostics: `load_session result=parse_error`). |
| B5 | Receive a bank SMS while the app is closed, then open it. | The transaction is captured and you are still signed in (background tasks never end a session). Diagnostics show `headless_task task=capture_drain session_present=true`. |

## C. Failed secure-store save (needs a debug switch, not yet in the app)

Android cannot be made to fail a Keystore write from outside the app, and the app has no switch for it yet. The unit tests
(`sessionPersistence.test.ts`) prove the behaviour with a fake store: the new tokens stay in memory, the write is retried
1 s, 2 s, 4 s ... up to 60 s, a foreground event retries at once, and the spent token is never re-sent.
To test it on a device a small debug-only "fail the next N session saves" setting is needed; ask for it before relying on C.
With it, the expected result would be: after a refresh with a failing save you stay signed in for the whole run
(`save_session_fail retry=...` repeating in diagnostics), and once saves work again `save_session_ok` appears and a restart
keeps you signed in.

## D. Server side (Render logs)

| # | Steps | Expected |
|---|-------|----------|
| D1 | Open the app after the backend deploy. | A log line `auth refresh outcome=ok reason=- token_age_s=...`. |
| D2 | Stub that answers refresh with 401 does not reach the server, so use the real one: kill the app right after it starts refreshing (airplane mode on mid-request) and reopen quickly. | `outcome=within_grace` on the retry if the first request had already rotated the token. No sign-out. |
| D3 | No log line contains a token, e-mail or account id. | |

## E. Diagnostics

| # | Steps | Expected |
|---|-------|----------|
| E1 | Use the app for a while (sync, background, change networks), then Copy diagnostics. | Lines with times, `app=` (active/background) and `net=` (wifi/cellular/none), at most the last 200 events. |
| E2 | Per sync cycle: `sync_cycle pending=.. eligible=.. waiting=.. failed=.. error_codes={..} http={200:..,401:..}`. | Numbers add up: pending = eligible + waiting + failed. |
| E3 | Close and reopen the app, copy again. | Earlier events are still there (kept across launches). |
| E4 | Read the whole text. | No tokens, passwords, e-mail addresses, account ids or amounts. |
| E5 | Guest mode. | Privacy & data (and so Copy diagnostics) is only reachable when signed in, as before. |

## What to note when something goes wrong

How long since sign-in and since the app was last open; whether it was swiped away; Wi-Fi, mobile data or airplane mode;
whether the phone restarted or the app was updated, reinstalled or restored; which message you saw; then Copy diagnostics and
send it with the time it happened.
