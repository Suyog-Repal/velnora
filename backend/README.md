# Velnora API

FastAPI + SQLAlchemy 2 + PostgreSQL (Alembic migrations). Authentication uses Argon2id password hashes and JWT access/refresh tokens
with refresh rotation and logout revocation; transactions, categories, profiles, receipts and offline-first sync are scoped to the
bearer's account. No plaintext credentials or financial message bodies are logged.

## Configuration

All settings are environment variables, read in one place (`app/config.py`). Copy `.env.example` to `backend/.env` for local
development (git-ignored). In production set them as environment variables on the host, never in a file in the repository.

| Variable | Purpose |
|---|---|
| `ENVIRONMENT` | `development` (default), `staging`, `production`. `production` enforces strict checks at start-up |
| `DATABASE_URL` | PostgreSQL URL for the running API |
| `DIRECT_DATABASE_URL` | Optional direct URL for Alembic (derived from `DATABASE_URL` if unset) |
| `JWT_SECRET_KEY` | Token signing secret (≥ 32 characters in production) |
| `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` / `JWT_REFRESH_TOKEN_EXPIRE_DAYS` | Token lifetimes (15 / 30) |
| `VELNORA_CORS_ORIGINS` | Allowed web origins (never `*` in production) |
| `LOG_LEVEL` | `INFO` by default |

## Run, test, migrate

From the **`backend/` directory** (Render's Root Directory):

```
pip install -r requirements.txt
python -m app                               # local (honours VELNORA_HOST / VELNORA_PORT, or PORT)
uvicorn app.main:app --host 0.0.0.0 --port $PORT   # production style (Render)
alembic upgrade head                        # apply migrations (you choose when)
pip install pytest pytest-asyncio httpx && python -m pytest   # tests (see below)
```

Tests that use the database create and delete rows, so they need a disposable PostgreSQL database that has been migrated with
`alembic upgrade head`. Set `TEST_DATABASE_URL` to it, or run PostgreSQL on this machine with the URL in `DATABASE_URL` (the default
is `localhost:5432/velnora`). The run stops before connecting if the target is a remote `DATABASE_URL`, if `TEST_DATABASE_URL` is the
same database as `DATABASE_URL`, or if `ENVIRONMENT=production`. If the database cannot be reached those tests fail at once and say so.

Health: `GET /api/v1/health` (liveness, no database) and `GET /api/v1/health/ready` (checks the database; returns only ok/unavailable).

Deploying to Render: see [`docs/RENDER_DEPLOYMENT.md`](../docs/RENDER_DEPLOYMENT.md).
Not yet available: password-reset email delivery (needs an email provider) and edge rate limiting.
