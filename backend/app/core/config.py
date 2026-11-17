import os
import urllib.parse
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict

def sanitize_database_url(url: str) -> str:
    """
    Sanitizes database URLs:
      - Converts legacy 'postgres://' to 'postgresql://'
      - URL-encodes special characters (such as '@') in the password if unescaped
      - Ensures sslmode=require for remote cloud databases (e.g. Supabase)
    """
    if not url:
        return ""

    url = url.strip()
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg2://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)

    # For postgres URLs, sanitize password containing unescaped '@'
    if url.startswith("postgresql://") or url.startswith("postgresql+"):
        if "://" in url:
            scheme, rest = url.split("://", 1)
            # Find the host separator '@' (rightmost '@' before port/dbname)
            if "@" in rest:
                last_at = rest.rfind("@")
                userinfo = rest[:last_at]
                host_part = rest[last_at + 1:]

                if ":" in userinfo:
                    user, pwd = userinfo.split(":", 1)
                    # If password contains literal '@' that isn't already %40
                    if "@" in pwd and "%40" not in pwd:
                        pwd = urllib.parse.quote_plus(pwd)
                    userinfo = f"{user}:{pwd}"

                url = f"{scheme}://{userinfo}@{host_part}"

        # Ensure SSL requirement for cloud postgres if not specified
        if "sslmode" not in url and ("supabase.com" in url or "amazonaws.com" in url):
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}sslmode=require"

    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("backend/.env", ".env"),
        extra="ignore",
    )

    APP_NAME: str = "ResQFlow"
    APP_VERSION: str = "0.1.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    PORT: int = 8000

    # Supabase PostgreSQL connection string
    # If empty, defaults to local SQLite for offline development
    DATABASE_URL: str = ""
    SUPABASE_DATABASE_URL: str = ""

    # CORS Configuration
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Routing Configuration
    OSRM_BASE_URL: str = "https://router.project-osrm.org"

    # Regional Operations Hub: Mangaluru, Karnataka, India
    DEFAULT_LATITUDE: float = 12.9141
    DEFAULT_LONGITUDE: float = 74.8560
    DEFAULT_CITY: str = "Mangaluru, Karnataka"

    @property
    def cors_origin_list(self) -> List[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    @property
    def is_postgres_configured(self) -> bool:
        raw = (self.DATABASE_URL or self.SUPABASE_DATABASE_URL or os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DATABASE_URL") or "").strip()
        return bool(raw and not raw.startswith("sqlite"))

    @property
    def effective_database_url(self) -> str:
        raw = (self.DATABASE_URL or self.SUPABASE_DATABASE_URL or os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DATABASE_URL") or "").strip()
        if not raw:
            # Explicit local development fallback
            return "sqlite:///./resqflow.db"
        return sanitize_database_url(raw)

settings = Settings()
