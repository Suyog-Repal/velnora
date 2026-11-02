"""
Database package for Velnora backend.
Exports Base, engine getters, session generators, and ORM models.
"""

from .session import (
    Base,
    get_db,
    get_direct_database_url,
    get_direct_engine,
    get_pooled_database_url,
    get_runtime_engine,
    get_session_factory,
    normalize_database_url,
)

from .models import (
    Category,
    Device,
    RefreshToken,
    Transaction,
    User,
    UserProfile,
)

__all__ = [
    "Base",
    "get_db",
    "get_direct_database_url",
    "get_direct_engine",
    "get_pooled_database_url",
    "get_runtime_engine",
    "get_session_factory",
    "normalize_database_url",
    "Category",
    "Device",
    "RefreshToken",
    "Transaction",
    "User",
    "UserProfile",
]
