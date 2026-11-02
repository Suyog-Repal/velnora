"""
SQLAlchemy 2.x Session and Engine Management for Neon PostgreSQL.
Provides pooled connection engine for application runtime and direct engine for migrations.
Configured for Neon serverless architecture with pool pre-ping and connection recycling.
"""

import os
from collections.abc import Generator
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from sqlalchemy import create_engine, Engine
from sqlalchemy.orm import sessionmaker, Session, declarative_base

# Load environment configuration from backend/.env if not already loaded
BASE_DIR = Path(__file__).resolve().parent.parent.parent
env_path = BASE_DIR / "backend" / ".env" if (BASE_DIR / "backend" / ".env").exists() else BASE_DIR / ".env"
load_dotenv(dotenv_path=env_path)

def normalize_database_url(url: Optional[str]) -> str:
    """Normalize postgres URL to postgresql+psycopg:// and ensure sslmode."""
    if not url:
        return "postgresql+psycopg://user:password@localhost:5432/velnora"
    
    # Strip quotes if present
    clean_url = url.strip().strip("'\"")
    
    # Replace generic postgresql:// or postgres:// with postgresql+psycopg://
    if clean_url.startswith("postgresql://"):
        clean_url = clean_url.replace("postgresql://", "postgresql+psycopg://", 1)
    elif clean_url.startswith("postgres://"):
        clean_url = clean_url.replace("postgres://", "postgresql+psycopg://", 1)
        
    return clean_url

def get_pooled_database_url() -> str:
    """Get the pooled database URL for application runtime operations."""
    return normalize_database_url(os.getenv("DATABASE_URL"))

def get_direct_database_url() -> str:
    """
    Get the direct database URL for Alembic migrations and DDL operations.
    If DIRECT_DATABASE_URL is not explicitly configured, gracefully derives
    the direct connection from DATABASE_URL by removing the Neon -pooler suffix.
    """
    raw_direct = os.getenv("DIRECT_DATABASE_URL", "").strip().strip("'\"")
    if raw_direct and "<" not in raw_direct and "@" in raw_direct:
        return normalize_database_url(raw_direct)
    
    # Graceful fallback: derive direct hostname from pooled URL by removing -pooler
    pooled = get_pooled_database_url()
    if "-pooler." in pooled:
        return pooled.replace("-pooler.", ".")
    return pooled

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
