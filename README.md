# Velnora

Personal finance and expense tracker built with React Native and FastAPI.

## Current slice

- React Native TypeScript mobile shell with Home, Activity, People, and Analytics views.
- Local-first transaction creation with AsyncStorage persistence.
- Canonical transaction records drive totals, activity, people summaries, and category analysis.
- FastAPI transaction contract under `/api/v1` with decimal-safe amounts and UUIDs.
- Welcome, sign-up, sign-in, forgot-password, session restore, refresh, and logout flows.
- Argon2id password hashing and JWT access/refresh sessions in the development API store.
- No bank credentials, payment processing, or fabricated production records.

## Run the mobile app

```powershell
npm install
npx expo start
```

Use the Expo development build or web preview for the first slice. Automatic SMS detection is available only through the Phase 1 custom Android development build described below; it is not available in Expo Go.

## Phase 1 Android SMS foundation

The Android receiver reads eligible incoming SMS bodies in memory and emits them to the JavaScript parser only while the app process is active. The parser supports configurable sender and content rules, extracts successful debit/credit transactions, and ignores failed, pending, ambiguous, malformed, or duplicate messages. Raw SMS bodies, OTPs, passwords, and PINs are not logged, persisted, or uploaded. Configure sender regex patterns in the `supportedSenderPatterns` array in [app.json](./app.json); the default pattern accepts common alphanumeric bank sender IDs, but production deployments should narrow it to the bank sender IDs they expect.

This feature requires `android.permission.RECEIVE_SMS` and a runtime permission prompt. It does not request `READ_SMS`, because Phase 1 does not read historical inbox messages. The broadcast receiver may receive messages while the app process is alive, but events are intentionally dropped when the JavaScript/native module is not initialized; no background queue is implemented yet. Android battery, permission, and manufacturer background restrictions can also affect delivery.

Expo Go cannot load this local native module. Build a custom development client after configuring the sender patterns:

```powershell
npm install
npx expo prebuild
npx expo run:android
```

With a physical Samsung Galaxy A36, enable Developer options and USB debugging, connect the phone, verify it with `adb devices`, then run `npx expo run:android`. The app must be rebuilt after changing `app.json`, native module code, or Android permissions. Do not use Accessibility Services or notification scraping as a substitute for the SMS permission.

### Phase 1 manual test plan

1. Install the custom development build and confirm the app launches; Expo Go is expected not to expose `VelnoraSms`.
2. Request `RECEIVE_SMS`, accept it, and verify `isSmsPermissionGranted()` reports `true`.
3. Deny the permission and verify the app remains usable and no SMS event is delivered.
4. Configure a narrow fictional/test sender pattern and a matching parser rule, then send a test SMS; verify the resulting structured transaction appears in Activity.
5. Send an SMS from a non-matching sender; verify no event is delivered.
6. Send malformed, failed, pending, or empty-content test messages; verify no transaction is created and no raw text appears in logs or storage.
7. Deliver the same broadcast twice; verify the in-memory sender/timestamp/part-count dedupe emits one event.
8. Force-stop/restart the app and document that events received before the module initializes are not queued; the current receiver does not implement a background queue.

## Run the API

From PowerShell at the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
python -m backend.app
```

From Git Bash, use the POSIX-style path for activation:

```bash
source .venv/Scripts/activate
pip install -r backend/requirements.txt
python -m backend.app
```

If the virtual environment is inside `backend` instead, run these commands from
the `backend` directory:

```bash
source .venv/Scripts/activate
python -m app
```

Do not run a drive-letter path such as `e:\Suyog\velnora\backend\.venv\Scripts\activate`
directly in Git Bash. Use `source /e/Suyog/velnora/backend/.venv/Scripts/activate`
or the relative command above. The default launcher does not use Uvicorn's
reloader, so stopping it with `Ctrl+C` exits cleanly. To enable automatic reload
during development, set `VELNORA_RELOAD=true` before starting the API.

The development API listens on `0.0.0.0:8000` so a phone on the same private Wi-Fi network can reach it. Set `EXPO_PUBLIC_API_URL` to the computer's current LAN address, for example `http://192.168.1.25:8000`, before starting Expo. If it is unset, the app derives the API host from Expo's development host; the explicit environment variable is recommended for a physical device.

On Windows, allow Python/Uvicorn through Windows Defender Firewall on Private networks, or run this elevated PowerShell command once:

```powershell
New-NetFirewallRule -DisplayName "Velnora API (TCP 8000)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -Profile Private
```

Keep the phone and computer on the same Wi-Fi network, verify `http://<computer-lan-ip>:8000/api/v1/health` from the phone browser, and start Expo after setting the URL. Do not use `localhost` for a physical phone.

Set `VELNORA_JWT_SECRET` to a long random value before using the API outside local development. The current auth and transaction repositories are in-memory development implementations; accounts and financial records are lost on process restart until PostgreSQL and Alembic are configured. The app does not claim cloud persistence in this mode.

Password reset intentionally returns a development configuration error because no real email delivery provider is configured. Do not change that response to a success message without implementing short-lived, single-use reset tokens and delivery.

## Verification

```powershell
npx tsc --noEmit
python -m compileall backend/app
python -m pytest backend/app
```

All sample values in future tests must be fictional. The app should only display records created by the user or parsed from explicitly supported sources.
