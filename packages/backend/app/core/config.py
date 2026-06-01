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
    # The SQLite DB lives in its OWN dir, separate from data_dir, so it can be
    # backed by a fast Docker named volume while the (read-mostly) config files
    # in data_dir stay on the host bind mount. Writing the multi-MB project blob
    # to a Docker Desktop Windows bind mount measured ~37x slower than
    # container-local storage (3.5-7.7s vs ~95ms for a 13.7MB write) and was the
    # dominant cost of every save — view switch, pipeline run, project edit.
    db_dir: str = "dbdata"

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
    def db_path(self) -> Path:
        """Directory holding the SQLite DB — backed by a fast Docker volume,
        separate from the bind-mounted data_dir. See db_dir."""
        return self.base_dir / self.db_dir

    @property
    def sqlite_path(self) -> str:
        return str(self.db_path / self.sqlite_db_name)

    def ensure_directories(self) -> None:
        """Ensure all required directories exist"""
        for path in [
            self.data_path,
            self.db_path,
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


import os
import tempfile
import threading


_ENV_WRITE_LOCK = threading.Lock()

# Characters that, if present in a value, require single-quoting so the
# .env loader and docker-compose's `${VAR}` interpolation don't choke:
#   '#' — pydantic-settings / dotenv treat unquoted '#' as start-of-comment
#   '$' — docker-compose expands `$VAR` inside unquoted values
#   ' ' — readability + some parsers split on it
#   '"' — would clash with an outer double-quote wrap
_SHELL_UNSAFE = set("#$ \"'\n\r")


def _quote_env_value(value: str) -> str:
    """Single-quote a value if it contains characters that would mis-parse
    when the file is reloaded.

    Single quotes in a single-quoted value are escaped as `'\''` (the
    POSIX-shell convention that python-dotenv also understands).
    """
    if value == "" or not any(c in _SHELL_UNSAFE for c in value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def update_env_file(updates: dict[str, str]) -> None:
    """Update key=value pairs in the .env file, preserving comments and order.

    Existing keys are updated in-place; new keys are appended at the end.
    Values that contain shell-unsafe characters (`#`, `$`, whitespace,
    quotes) are single-quoted so the file round-trips correctly.

    The whole operation is serialised through a process-wide lock and
    persisted via an atomic rename so concurrent PUTs from the Settings
    UI can't interleave half-written lines.
    """
    env_path = Path(_find_env_file())

    with _ENV_WRITE_LOCK:
        # Ensure the file (and parent dir) exist before we read+rewrite.
        # The compose bind-mount of `./.env` creates a host-side directory
        # if the file is missing, so create the file ahead of time when
        # we're running on the host. (Inside the container the file is
        # always already present because compose mounted it.)
        env_path.parent.mkdir(parents=True, exist_ok=True)
        if not env_path.exists():
            env_path.touch()

        lines = env_path.read_text(encoding="utf-8").splitlines()
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
                    new_lines.append(f"{key}={_quote_env_value(remaining.pop(key))}")
                    continue
            new_lines.append(line)

        # Append any keys that weren't found in the file
        for key, value in remaining.items():
            new_lines.append(f"{key}={_quote_env_value(value)}")

        # Atomic write where possible: temp file in same dir, then rename.
        # Fallback to direct write when the target is a docker bind-mounted
        # file (rename onto a bind mount fails with EBUSY because the
        # mount holds the destination inode).
        content = "\n".join(new_lines) + "\n"
        fd, tmp_path = tempfile.mkstemp(
            prefix=".env.", dir=str(env_path.parent), text=False,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
                fh.write(content)
            try:
                os.replace(tmp_path, env_path)
            except OSError as err:
                # EBUSY (docker bind mount) or EXDEV (cross-device rename) —
                # in both cases atomicity is impossible; just rewrite in place.
                if err.errno not in (16, 18):  # EBUSY=16, EXDEV=18
                    raise
                env_path.write_text(content, encoding="utf-8")
                os.unlink(tmp_path)
        except Exception:
            # Best-effort cleanup on failure
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                pass
            raise
