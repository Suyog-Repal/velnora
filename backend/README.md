# Velnora API

The API currently uses an in-memory development repository. It implements authenticated registration, login, refresh rotation, logout revocation, `/api/v1/me`, and bearer-scoped transactions. Passwords are Argon2id hashes and tokens are JWTs; no plaintext credentials or financial message bodies are logged.

Production prerequisites are PostgreSQL/SQLAlchemy/Alembic migrations, a strong `VELNORA_JWT_SECRET`, rate limiting at the edge, and an email provider for password reset. Until those are configured, account data is lost when the process restarts.
