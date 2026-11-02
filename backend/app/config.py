"""
Application Configuration Module for Velnora Backend.
Loads environment variables and configuration for FastAPI, SQLAlchemy, psycopg, and Alembic.
Never hardcodes database credentials, tokens, or encryption keys.
"""

import os
from pathlib import Path
from typing import Literal

BASE_DIR = Path(__file__).resolve().parent.parent

try:
    from pydantic import Field
    from pydantic_settings import BaseSettings, SettingsConfigDict

    class Settings(BaseSettings):
        DATABASE_URL: str = Field(
            default="postgresql+psycopg://user:password@localhost:5432/velnora",
            description="Pooled Neon PostgreSQL connection string for FastAPI runtime operations",
        )
        DIRECT_DATABASE_URL: str = Field(
            default="postgresql+psycopg://user:password@localhost:5432/velnora",
            description="Direct Neon PostgreSQL connection string for Alembic migrations and DDL",
        )
        JWT_SECRET_KEY: str = Field(
            default="development-only-change-me",
            description="Secret key for JWT token generation and verification",
        )
        ENVIRONMENT: Literal["development", "staging", "production"] = "development"
        VELNORA_CORS_ORIGINS: str = "http://localhost:8081"

        model_config = SettingsConfigDict(
            env_file=str(BASE_DIR / ".env"),
            env_file_encoding="utf-8",
            extra="ignore",
        )

    settings = Settings()

except ImportError:
    # Standard library fallback when pydantic-settings is not yet installed in host environment
    class FallbackSettings:
        def __init__(self) -> None:
            # Simple .env file parser if python-dotenv is not installed
            env_file = BASE_DIR / ".env"
            if env_file.exists():
                with open(env_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key, val = line.split("=", 1)
                            key = key.strip()
                            val = val.strip().strip("'\"")
                            if key not in os.environ:
                                os.environ[key] = val

            self.DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg://user:password@localhost:5432/velnora")
            self.DIRECT_DATABASE_URL = os.getenv("DIRECT_DATABASE_URL", "postgresql+psycopg://user:password@localhost:5432/velnora")
            self.JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", os.getenv("VELNORA_JWT_SECRET", "development-only-change-me"))
            self.ENVIRONMENT = os.getenv("ENVIRONMENT", os.getenv("VELNORA_ENV", "development"))
            self.VELNORA_CORS_ORIGINS = os.getenv("VELNORA_CORS_ORIGINS", "http://localhost:8081")

    settings = FallbackSettings()  # type: ignore
