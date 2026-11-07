"""
Centralised environment configuration for the Velnora backend.

Every runtime setting (database, JWT, CORS, logging) is read here, once, from environment variables
(optionally pre-populated from ``backend/.env`` / ``.env`` for local development). Nothing secret is hardcoded.

Environment variable names (existing names are kept; legacy aliases are still honoured):

====================================  =====================================================================
``ENVIRONMENT`` (alias ``VELNORA_ENV``)       ``development`` (default) | ``staging`` | ``production``
``DATABASE_URL``                       PostgreSQL URL used by the running API (pooled URL on Neon)
``DIRECT_DATABASE_URL`` (optional)     Direct URL used by Alembic migrations; derived from DATABASE_URL if unset
``JWT_SECRET_KEY`` (alias ``VELNORA_JWT_SECRET``)   JWT signing secret (>= 32 chars in production)
``JWT_ACCESS_TOKEN_EXPIRE_MINUTES``    access-token lifetime, default 15
``JWT_REFRESH_TOKEN_EXPIRE_DAYS``      refresh-token lifetime, default 30
``VELNORA_CORS_ORIGINS``               comma-separated allowed origins (never ``*`` in production)
``LOG_LEVEL``                          DEBUG | INFO (default) | WARNING | ERROR | CRITICAL
====================================  =====================================================================

In ``production`` an unsafe or missing value raises :class:`ConfigError` at start-up with a message that names the
variable but never prints its value, so a bad Render configuration fails fast and clearly.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Mapping, Optional

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
REPO_ROOT = BASE_DIR.parent

ENVIRONMENTS = ("development", "staging", "production")

# Development-only fallbacks. These are deliberately recognisable so production validation can reject them.
DEV_JWT_SECRET = "development-only-change-me"
DEV_DATABASE_URL = "postgresql+psycopg://user:password@localhost:5432/velnora"
DEFAULT_CORS_ORIGINS = "http://localhost:8081"
MIN_PRODUCTION_JWT_SECRET_LENGTH = 32
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


class ConfigError(RuntimeError):
    """Raised when the environment configuration is invalid. Messages never contain secret values."""


def normalize_database_url(url: Optional[str]) -> str:
    """Normalise a PostgreSQL URL to the ``postgresql+psycopg://`` driver form (Render/Neon give ``postgres(ql)://``)."""
    if not url:
        return DEV_DATABASE_URL
    clean = url.strip().strip("'\"")
    if clean.startswith("postgresql://"):
        clean = clean.replace("postgresql://", "postgresql+psycopg://", 1)
    elif clean.startswith("postgres://"):
        clean = clean.replace("postgres://", "postgresql+psycopg://", 1)
    return clean


def derive_direct_database_url(direct_raw: Optional[str], pooled_url: str) -> str:
    """
    URL for Alembic/DDL. Uses DIRECT_DATABASE_URL when it is a real URL; otherwise derives it from the pooled URL
    (Neon: drop the ``-pooler`` host suffix; any other provider, e.g. Render Postgres: the same URL is used).
    """
    raw = (direct_raw or "").strip().strip("'\"")
    if raw and "<" not in raw and "@" in raw:
        return normalize_database_url(raw)
    if "-pooler." in pooled_url:
        return pooled_url.replace("-pooler.", ".")
    return pooled_url


def parse_origins(raw: Optional[str]) -> list[str]:
    return [o.strip() for o in (raw or "").split(",") if o.strip()]


@dataclass(frozen=True)
class Settings:
    environment: str
    database_url: str
    direct_database_url: str
    jwt_secret_key: str
    jwt_access_token_expire_minutes: int
    jwt_refresh_token_expire_days: int
    cors_origins: tuple[str, ...]
    log_level: str

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def cors_allows_credentials(self) -> bool:
        """Credentialed CORS is only ever combined with an explicit origin list, never with the ``*`` wildcard."""
        return "*" not in self.cors_origins


def _first(env: Mapping[str, str], *names: str) -> Optional[str]:
    for name in names:
        value = env.get(name)
        if value is not None and value.strip() != "":
            return value.strip().strip("'\"")
    return None


def _positive_int(env: Mapping[str, str], name: str, default: int, problems: list[str]) -> int:
    raw = _first(env, name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        problems.append(f"{name} must be a whole number")
        return default
    if value <= 0:
        problems.append(f"{name} must be greater than zero")
        return default
    return value


def load_settings(env: Optional[Mapping[str, str]] = None) -> Settings:
    """
    Build :class:`Settings` from ``env`` (default ``os.environ``). Pure and side-effect free, so it can be tested with
    plain dictionaries. Raises :class:`ConfigError` listing every problem found (variable names only).
    """
    env = os.environ if env is None else env
    problems: list[str] = []

    environment = (_first(env, "ENVIRONMENT", "VELNORA_ENV") or "development").lower()
    if environment not in ENVIRONMENTS:
        problems.append(f"ENVIRONMENT must be one of {', '.join(ENVIRONMENTS)}")
        environment = "development"
    production = environment == "production"

    database_raw = _first(env, "DATABASE_URL")
    database_url = normalize_database_url(database_raw)
    if production:
        if database_raw is None:
            problems.append("DATABASE_URL is required in production")
        elif "<" in database_raw or "user:password@" in database_raw:
            problems.append("DATABASE_URL still contains placeholder values")
        elif not database_url.startswith("postgresql+psycopg://"):
            problems.append("DATABASE_URL must be a PostgreSQL URL (postgresql://...)")
    direct_database_url = derive_direct_database_url(_first(env, "DIRECT_DATABASE_URL"), database_url)

    secret = _first(env, "JWT_SECRET_KEY", "VELNORA_JWT_SECRET")
    if production:
        if secret is None or secret == DEV_JWT_SECRET:
            problems.append("JWT_SECRET_KEY must be set to a strong secret in production")
        elif len(secret) < MIN_PRODUCTION_JWT_SECRET_LENGTH:
            problems.append(f"JWT_SECRET_KEY must be at least {MIN_PRODUCTION_JWT_SECRET_LENGTH} characters in production")
    secret = secret or DEV_JWT_SECRET

    access_minutes = _positive_int(env, "JWT_ACCESS_TOKEN_EXPIRE_MINUTES", 15, problems)
    refresh_days = _positive_int(env, "JWT_REFRESH_TOKEN_EXPIRE_DAYS", 30, problems)

    origins = tuple(parse_origins(_first(env, "VELNORA_CORS_ORIGINS") or DEFAULT_CORS_ORIGINS))
    if production and "*" in origins:
        problems.append("VELNORA_CORS_ORIGINS must list explicit origins in production (not '*')")

    log_level = (_first(env, "LOG_LEVEL") or "INFO").upper()
    if log_level not in LOG_LEVELS:
        problems.append(f"LOG_LEVEL must be one of {', '.join(LOG_LEVELS)}")
        log_level = "INFO"

    if problems:
        raise ConfigError("Invalid Velnora configuration: " + "; ".join(problems) + ".")

    return Settings(
        environment=environment,
        database_url=database_url,
        direct_database_url=direct_database_url,
        jwt_secret_key=secret,
        jwt_access_token_expire_minutes=access_minutes,
        jwt_refresh_token_expire_days=refresh_days,
        cors_origins=origins,
        log_level=log_level,
    )


def _load_dotenv_files() -> None:
    """Local development convenience: populate os.environ from backend/.env (or repo-root .env). Never overrides real env vars."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # python-dotenv is a declared dependency; tolerate its absence in stripped environments
        return
    for candidate in (BASE_DIR / ".env", REPO_ROOT / ".env"):
        if candidate.exists():
            load_dotenv(dotenv_path=candidate, override=False)
            return


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, loaded on first use (after any local .env files)."""
    _load_dotenv_files()
    return load_settings()


def configure_logging(settings: Optional[Settings] = None) -> None:
    """Apply LOG_LEVEL to the root logger once. Request bodies, tokens and passwords are never logged by the API."""
    level = getattr(logging, (settings or get_settings()).log_level, logging.INFO)
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    else:
        root.setLevel(level)
