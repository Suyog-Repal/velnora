# Deploying the Velnora backend on Render (manual guide)

This guide is for you to follow by hand. Nothing in the repository deploys itself, creates a database, runs a migration or
contains a secret. Anything in `<angle brackets>` is a placeholder you replace. Render's dashboard changes over time, so
treat button names as a guide and check Render's own documentation if something looks different.

**Repository facts this guide relies on (verified in the code)**

| Item | Value |
|---|---|
| Backend package | `backend/` (the code imports itself as `backend.app...`, so the service must run from the **repository root**) |
| FastAPI app | `backend.app.main:app` |
| Dependencies | `backend/requirements.txt` |
| Migrations | Alembic, `alembic.ini` at the repository root (scripts in `backend/alembic/versions`, 4 revisions, single head) |
| Health check (no DB) | `GET /api/v1/health` → `{"status":"ok","service":"velnora-api"}` |
| Readiness (checks DB) | `GET /api/v1/health/ready` → `{"status":"ok","database":"ok"}` or `503` |
| API docs | `/api/docs` |

---

## Step 1. Create the PostgreSQL database (you do this)

Use any managed PostgreSQL. The project already used Neon during development; Render's own PostgreSQL also works.

**Neon:** create a project/database, then copy two connection strings from the dashboard:
the **pooled** one (host contains `-pooler`) and, optionally, the **direct** one.

**Render PostgreSQL:** *New → PostgreSQL*. Use the **Internal Database URL** for the web service (same region, private network).
Use the **External Database URL** only from your own computer (for migrations).

Rules:
- Keep these URLs private. They contain the password. Never paste them into GitHub, the mobile app, chat, or this repo.
- `postgres://` and `postgresql://` URLs are accepted; the backend converts them to the `psycopg` driver automatically.
- Keep `?sslmode=require` if your provider gives it (Neon does; Render's *external* URL needs SSL too).
- Do not reuse your development database for production if it holds test data.

## Step 2. Create the Render Web Service

1. Render dashboard → **New → Web Service** → connect the GitHub repository `Suyog-Repal/velnora`.
2. **Branch:** `main` (or your release branch).
3. **Root Directory:** leave **empty** (repository root). Do **not** set it to `backend`, the imports would break.
4. **Language / Runtime:** Python 3.
5. **Build Command:**
   ```
   pip install -r backend/requirements.txt
   ```
6. **Start Command (exact):**
   ```
   uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT
   ```
   Render provides `$PORT`; the app must not use a fixed port in production.
7. **Health Check Path:** `/api/v1/health`
8. **Python version:** set the environment variable `PYTHON_VERSION` to a full version such as the one used in development
   (3.13.x). Render requires the full `major.minor.patch` form; pick a patch release Render supports.
9. **Plan:** Free instances sleep when idle, so the first request after a pause can take about a minute. The mobile app is
   offline-first and retries, so this only delays sync, but a paid instance avoids it.

## Step 3. Environment variables

Add these under the service's **Environment** tab. Do **not** upload a `.env` file.

| Variable | Purpose | Required | Placeholder / example | Where to get it |
|---|---|---|---|---|
| `ENVIRONMENT` | `production` turns on strict start-up checks | **Yes** | `production` | You type it |
| `DATABASE_URL` | PostgreSQL URL used by the running API | **Yes** | `postgresql://<user>:<password>@<host>/<dbname>` | Step 1 (Neon pooled URL / Render Internal URL) |
| `JWT_SECRET_KEY` | Signs login tokens, ≥ 32 random characters | **Yes** | `<generated-secret>` | Generate (below). Keep it secret; changing it logs everyone out |
| `VELNORA_CORS_ORIGINS` | Allowed **web** origins, comma-separated. Native Android requests are not subject to CORS | Recommended | `https://<your-web-origin>` | Only if you serve a web client. Never `*` |
| `PYTHON_VERSION` | Python runtime | Recommended | `3.13.x` | Step 2 |
| `DIRECT_DATABASE_URL` | Non-pooled URL for migrations | Optional | `postgresql://<user>:<password>@<direct-host>/<dbname>` | Neon "direct" string. If omitted it is derived from `DATABASE_URL` |
| `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` | Access-token lifetime | Optional (default `15`) | `15` | You choose |
| `JWT_REFRESH_TOKEN_EXPIRE_DAYS` | Refresh-token lifetime | Optional (default `30`) | `30` | You choose |
| `LOG_LEVEL` | `DEBUG`/`INFO`/`WARNING`/`ERROR` | Optional (default `INFO`) | `INFO` | You choose |

Generate the JWT secret on your own computer (never in a shared place):

```
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

With `ENVIRONMENT=production` the service **refuses to start** (with a message naming the variable, never its value) if:
`DATABASE_URL` is missing or still a placeholder, `JWT_SECRET_KEY` is missing/default/shorter than 32 characters, or
`VELNORA_CORS_ORIGINS` contains `*`. That is intentional: a bad configuration fails loudly in the Render logs instead of
running insecurely. (Older names `VELNORA_ENV` and `VELNORA_JWT_SECRET` are still honoured, but use the names above.)

## Step 4. Database schema (migrations), done by you, after reviewing

The production database starts empty. The schema comes from Alembic. **Nothing runs migrations automatically**, and none of
the migrations drop tables or delete data (verified: the full upgrade renders to `CREATE TABLE` / `ALTER TABLE ... ADD` only).

From your own computer, in the repository root, with the backend virtual environment active
(`pip install -r backend/requirements.txt`):

```powershell
# 1) Point this shell at the PRODUCTION database (use the direct / external URL). Nothing is written to disk.
$env:DIRECT_DATABASE_URL = "postgresql://<user>:<password>@<direct-or-external-host>/<dbname>"
$env:DATABASE_URL        = $env:DIRECT_DATABASE_URL     # only so the app's settings load; migrations use the direct URL

# 2) Review exactly what will run (this does NOT connect to the database)
alembic -c alembic.ini upgrade head --sql

# 3) Apply
alembic -c alembic.ini upgrade head

# 4) Confirm
alembic -c alembic.ini current        # should print e5b2c8d4a7f1 (head)

# 5) Clear the variables from this shell
Remove-Item Env:DIRECT_DATABASE_URL, Env:DATABASE_URL
```

Run it once on first setup, and again whenever a later release adds a migration. If your Render plan offers a
"Pre-Deploy Command" you may use `alembic -c alembic.ini upgrade head` there instead, but only after you have reviewed the
migrations as above. Alembic never runs unless you invoke it.

## Step 5. Verify the deployed backend

Replace `<service>` with the URL Render shows (`https://<service>.onrender.com`).

```powershell
$u = "https://<service>.onrender.com"
Invoke-RestMethod "$u/api/v1/health"          # {status: ok, service: velnora-api}  → the app is running
Invoke-RestMethod "$u/api/v1/health/ready"    # {status: ok, database: ok}          → it can reach PostgreSQL (503 = it cannot)
```

- **Deploy status:** Render → service → *Events*/*Logs*. A `Invalid Velnora configuration: ...` line means a variable from Step 3 is wrong.
- **API explorer:** open `<service URL>/api/docs`.
- **Authentication endpoints** (real routes):
  ```powershell
  $reg = Invoke-RestMethod "$u/api/v1/auth/register" -Method Post -ContentType "application/json" `
    -Body (@{ full_name="Test User"; email="you+test@example.com"; password="<a-strong-password>"; terms_accepted=$true } | ConvertTo-Json)
  $token = $reg.access_token
  Invoke-RestMethod "$u/api/v1/me" -Headers @{ Authorization = "Bearer $token" }
  ```
  Login is `POST /api/v1/auth/login` with `{ "email", "password" }`.
- **Transactions:**
  ```powershell
  $h = @{ Authorization = "Bearer $token" }
  Invoke-RestMethod "$u/api/v1/transactions" -Method Post -Headers $h -ContentType "application/json" `
    -Body (@{ amount=10.50; direction="expense"; counterparty="Test"; category="Other Expenses" } | ConvertTo-Json)
  Invoke-RestMethod "$u/api/v1/transactions" -Headers $h
  ```
  Delete your test account's data afterwards if you do not want it in production.
- **Sync endpoints** used by the app: `POST /api/v1/sync/push`, `GET /api/v1/sync/pull`, `GET /api/v1/sync/status`.

## Step 6. Point the mobile app at the deployed backend

The app reads one variable, `EXPO_PUBLIC_API_URL`, in one place (`auth.ts` → `src/services/apiConfig.ts`). It is **embedded in
the app at build time**, so set it *before* you build, and rebuild after changing it. It is not a secret.

```powershell
# PowerShell, same window you run the build in
$env:EXPO_PUBLIC_API_URL = "https://<service>.onrender.com"
```

(or put `EXPO_PUBLIC_API_URL=https://<service>.onrender.com` in a git-ignored `.env.production` file in the repository root).

- **An APK only knows the URL that existed when it was built.** Creating or editing `.env` afterwards changes nothing in an
  APK that is already installed: rebuild and reinstall. (Symptom of a build without it: the app log shows
  `EXPO_PUBLIC_API_URL is not set for this build`, and sign-up says the build has no server address configured.)
- **GitHub Actions builds:** `.env` is git-ignored and never reaches CI. The workflow reads the repository **variable**
  `EXPO_PUBLIC_API_URL` (Settings → Secrets and variables → Actions → Variables) and falls back to the Render URL. It fails
  the build if the URL is not a bare `https://` origin, or if the finished APK does not contain it.
- Use **`https://`** for release builds. Android blocks plain `http://` in release builds, and the app logs a warning if you try.
- If a release build has **no** URL, cloud sync is disabled (the app logs `EXPO_PUBLIC_API_URL is not set...`) and everything
  else works offline. It never falls back to `localhost` in a release build.
- **Development** is unchanged: leave it unset and the app follows the Expo dev-server host on port 8000, or set it to your
  computer's LAN address. Do not commit that address.
- Never put `DATABASE_URL`, `JWT_SECRET_KEY` or any backend secret in an `EXPO_PUBLIC_` variable.

## Step 7. Production test checklist

**Backend (from your computer, no phone needed)**
- [ ] `/api/v1/health` returns `ok`; `/api/v1/health/ready` returns `database: ok`.
- [ ] Register a test user → receive `access_token` and `refresh_token`.
- [ ] Login with the same credentials; a wrong password is rejected.
- [ ] `GET /api/v1/me` works with the token and fails (401) without it.
- [ ] Create, edit (`PATCH /api/v1/transactions/{id}`) and delete a transaction; income vs expense is preserved.
- [ ] Another account cannot read the first account's transactions.
- [ ] Restart the Render service: the user and transactions are still there (data is in PostgreSQL).

**Physical device (Android phone with the production-configured build)**
- [ ] Register and log in from the app.
- [ ] Add an income and an expense; the Home totals and recorded balance are correct.
- [ ] Edit an expense and change it to income; totals update.
- [ ] Toast shows "recorded successfully", then "synced successfully" after the server confirms.
- [ ] Airplane mode: add a transaction → "saved on this device / saved offline"; reopen the app → it is still there.
- [ ] Turn airplane mode off: it syncs without duplicates; check it appears in `GET /api/v1/transactions`.
- [ ] Guest mode: transactions stay on the device and are never uploaded until you sign in and confirm the import.
- [ ] Sign in on a second device/account: data is isolated per account.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Logs: `Invalid Velnora configuration: ...` | A required variable is missing/weak/placeholder (Step 3). The message names it. |
| `/api/v1/health/ready` returns 503 | `DATABASE_URL` wrong, database not reachable, or SSL required (`?sslmode=require`). |
| `relation "users" does not exist` | Migrations not applied (Step 4). |
| First request takes ~1 minute | Free instance waking up. |
| App says "This build of Velnora has no server address configured" | The APK was built without `EXPO_PUBLIC_API_URL`. Set it (Step 6) and rebuild/reinstall. |
| App says "Unable to reach Velnora. Check your internet connection" | The request got no response (offline, DNS, TLS). The log line shows the real cause. |
| App says the server "did not respond in time" / "is starting up" | A free Render instance sleeps when idle; the first request can take ~35 s. Wait and retry. |
| Any other message | The server answered; the message is the server's own (for example "An account with that email already exists"). |

To see exactly what the app sent and what came back (no passwords, tokens or bodies are ever logged):
`adb logcat -s ReactNativeJS` and look for the `[Velnora API]` lines.

## Known limitations to plan for (not changed by this phase)

- **Password reset email is not configured.** `POST /api/v1/auth/forgot-password` returns 503 until an email provider is added.
- **Rate limiting** is expected at the edge (not in the app).
- The Android project uses the **debug keystore** and the placeholder application id `com.anonymous.velnora`. Before publishing to
  Google Play you need your own release keystore; choose the final application id **before** the first public release, because
  it cannot be changed afterwards without publishing a new app.
