"""
Application Configuration
Uses Pydantic Settings for environment variable management
"""

from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_env_file() -> str:
    """Locate the .env file.

    Lookup order:
      1. packages/backend/.env   — local-dev override, if present.
      2. <repo root>/.env        — the single source of truth shared with docker-compose.
      3. ".env"                  — final fallback (cwd-relative).

    Returning the first existing file means a developer running the
    backend directly picks up the same keys docker-compose would use,
    so users don't need three separate .env copies.
    """
    backend_dir = Path(__file__).resolve().parent.parent.parent
    candidates = [
        backend_dir / ".env",
        backend_dir.parent.parent / ".env",
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return ".env"


class Settings(BaseSettings):
    """Application settings loaded from environment variables"""

    model_config = SettingsConfigDict(
        env_file=_find_env_file(),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",  # Ignore extra env vars from old .env files
    )

    # LLM Provider
    llm_provider: str = "gemini"  # gemini | openai | anthropic | deepseek

    # API Keys (per provider)
    google_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    deepseek_api_key: str = ""

    # Model names (per provider)
    gemini_model: str = "gemini-2.5-flash"
    openai_model: str = "gpt-4o"
    anthropic_model: str = "claude-sonnet-4-20250514"
    deepseek_model: str = "deepseek-chat"

    # External Services
    vision_api_url: str = "http://127.0.0.1:8000"

    # Server Configuration
    host: str = "0.0.0.0"
    port: int = 8080
    debug: bool = False

    # Redis Configuration
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_db: int = 0

    # JWT Authentication
    auth_enabled: bool = False  # Set True to enforce auth on all endpoints
    secret_key: str = "your-secret-key-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 30

    # PostgreSQL Database
    database_url: str = "postgresql://postgres:postgres@localhost:5432/scenerx"

    # SQLite (lightweight persistence)
    sqlite_db_name: str = "scenerx.db"

    # Knowledge base filenames (configurable via env)
    kb_evidence_file: str = "SVCs_P_Evidence.json"
    kb_appendix_file: str = "Encoding_Dictionary.json"
    kb_context_file: str = "Transferability_Context.json"
    kb_iom_file: str = "I_SVCs_Operations.json"

    # Paths (relative to backend/)
    data_dir: str = "data"
    metrics_library_path: str = "data/A_indicators.xlsx"
    metrics_code_dir: str = "data/metrics_code"
    knowledge_base_dir: str = "data/knowledge_base"
    output_dir: str = "outputs"
    temp_dir: str = "temp"

    # Computed paths
    @property
    def base_dir(self) -> Path:
        """Get the base directory (backend/)"""
        return Path(__file__).parent.parent.parent

    @property
    def data_path(self) -> Path:
        return self.base_dir / self.data_dir

    @property
    def metrics_library_full_path(self) -> Path:
        return self.base_dir / self.metrics_library_path

    @property
    def metrics_code_full_path(self) -> Path:
        return self.base_dir / self.metrics_code_dir

    @property
    def knowledge_base_full_path(self) -> Path:
        return self.base_dir / self.knowledge_base_dir

    @property
    def output_full_path(self) -> Path:
        return self.base_dir / self.output_dir

    @property
    def temp_full_path(self) -> Path:
        return self.base_dir / self.temp_dir

    @property
    def sqlite_path(self) -> str:
        return str(self.data_path / self.sqlite_db_name)

    def ensure_directories(self) -> None:
        """Ensure all required directories exist"""
        for path in [
            self.data_path,
            self.metrics_code_full_path,
            self.knowledge_base_full_path,
            self.output_full_path,
            self.temp_full_path,
        ]:
            path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()


def update_env_file(updates: dict[str, str]) -> None:
    """Update key=value pairs in the .env file, preserving comments and order.

    Existing keys are updated in-place; new keys are appended at the end.
    """
    env_path = Path(_find_env_file())
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []

    remaining = dict(updates)  # keys still to write
    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        # Skip blank / comment lines unchanged
        if not stripped or stripped.startswith("#"):
            new_lines.append(line)
            continue
        # Parse KEY=VALUE
        if "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in remaining:
                new_lines.append(f"{key}={remaining.pop(key)}")
                continue
        new_lines.append(line)

    # Append any keys that weren't found in the file
    for key, value in remaining.items():
        new_lines.append(f"{key}={value}")

    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
