"""
SQLAlchemy 2.x Session and Engine Management for Neon PostgreSQL.
Provides pooled connection engine for application runtime and direct engine for migrations.
Configured for Neon serverless architecture with pool pre-ping and connection recycling.
"""

from collections.abc import Generator
from typing import Optional
from sqlalchemy import create_engine, Engine
from sqlalchemy.orm import sessionmaker, Session, declarative_base

# All environment handling (including loading backend/.env for local development) lives in config.py.
from backend.app.config import get_settings, normalize_database_url  # noqa: F401  (normalize re-exported for backend.app.db)


def get_pooled_database_url() -> str:
    """Get the pooled database URL (``DATABASE_URL``) for application runtime operations."""
    return get_settings().database_url


def get_direct_database_url() -> str:
    """
    Get the direct database URL for Alembic migrations and DDL operations.
    ``DIRECT_DATABASE_URL`` when configured; otherwise derived from ``DATABASE_URL`` (Neon: drops the ``-pooler``
    host suffix; other providers such as Render Postgres use the same URL).
    """
    return get_settings().direct_database_url

# Base class for SQLAlchemy ORM models
Base = declarative_base()

# Global engine instances (lazy initialized)
_runtime_engine: Optional[Engine] = None
_direct_engine: Optional[Engine] = None
_SessionLocal: Optional[sessionmaker[Session]] = None

def get_runtime_engine() -> Engine:
    """Get or initialize the pooled runtime engine for FastAPI operations."""
    global _runtime_engine
    if _runtime_engine is None:
        db_url = get_pooled_database_url()
        _runtime_engine = create_engine(
            db_url,
            pool_pre_ping=True,      # Vital for Neon serverless: drops dead connections on resume
            pool_recycle=300,        # Recycle connections every 5 minutes
            pool_size=10,
            max_overflow=20,
            future=True,
        )
    return _runtime_engine

def get_direct_engine() -> Engine:
    """Get or initialize the direct engine for migrations and administrative tasks."""
    global _direct_engine
    if _direct_engine is None:
        direct_url = get_direct_database_url()
        _direct_engine = create_engine(
            direct_url,
            pool_pre_ping=True,
            future=True,
        )
    return _direct_engine

def get_session_factory() -> sessionmaker[Session]:
    """Get the sessionmaker bound to the runtime pooled engine."""
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=get_runtime_engine(),
            expire_on_commit=False,
        )
    return _SessionLocal

def get_db() -> Generator[Session, None, None]:
    """
    FastAPI dependency that provides a transactional database session per request.
    Closes the session when request completes.
    """
    SessionLocal = get_session_factory()
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
