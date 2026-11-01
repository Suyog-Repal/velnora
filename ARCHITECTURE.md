# Velnora architecture assessment

## Current foundation

- `App.tsx` is a React Native first slice with local-first AsyncStorage persistence.
- A canonical transaction record drives Home, Activity, People, and Analytics views.
- `backend/app/main.py` exposes a typed FastAPI transaction contract with UUID identifiers and decimal amounts.
- `backend/app/auth.py` owns password hashing, JWT issuance, refresh rotation, revocation, and bearer-derived user identity.
- `auth.ts` stores only the session envelope in Expo SecureStore; passwords never enter local storage.
- No SMS permission, raw SMS storage, bank connection, payment initiation, or fabricated production data is present.

## Next implementation checklist

- Replace the in-memory API ledger with SQLAlchemy models and Alembic migrations for users, transactions, contacts, categories, rules, budgets, goals, preferences, and sync checkpoints.
- Replace the in-memory auth store with PostgreSQL-backed users and refresh-token records, then add Alembic migrations and server-side rate limiting.
- Keep password-reset delivery disabled until a real provider and single-use token store are configured.
- Split the mobile domain into repositories and services, then add offline mutation queue, idempotency keys, conflict handling, and sync status.
- Add contact resolution with explicit user confirmation for ambiguous matches and canonical contact summaries.
- Add categories, rules, filters, editing, deletion, refunds, reversals, failed states, and transfer accounting.
- Add native Android SMS receiver only after permission rationale, Play policy, supported-format parsing, privacy review, and statement-import fallback are documented.
- Add secure export and deletion workflows, redacted logging, rate limiting, and database row-level isolation.
