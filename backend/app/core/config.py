import os
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "ResQFlow"
    APP_VERSION: str = "0.1.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    PORT: int = 8000

    # Supabase PostgreSQL / Local SQLite connection string
    # Defaults to local SQLite if left empty
    DATABASE_URL: str = ""
    SUPABASE_DATABASE_URL: str = ""

    # CORS Configuration
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Routing Configuration
    OSRM_BASE_URL: str = "https://router.project-osrm.org"

    # Center of Emergency Operations: Mangaluru, Karnataka, India
    DEFAULT_LATITUDE: float = 12.9141
    DEFAULT_LONGITUDE: float = 74.8560
    DEFAULT_CITY: str = "Mangaluru, Karnataka"

    @property
    def cors_origin_list(self) -> List[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    @property
    def effective_database_url(self) -> str:
        url = (self.SUPABASE_DATABASE_URL or self.DATABASE_URL or os.environ.get("SUPABASE_DATABASE_URL") or os.environ.get("DATABASE_URL") or "").strip()
        if not url:
            # Resilient fallback: SQLite in local backend directory
            return "sqlite:///./resqflow.db"
        # Fix legacy postgres:// URL scheme from Supabase/Heroku for SQLAlchemy
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        return url

settings = Settings()
