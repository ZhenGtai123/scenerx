"""
SceneRx API - FastAPI Application
Urban greenspace visual analysis backend
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import get_settings
from app.db.project_store import init_project_store, get_project_store
from app.api.routes import health, config, metrics, projects, vision, indicators, tasks, auth, analysis, encoding, nature_export

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events"""
    # Startup
    settings = get_settings()
    settings.ensure_directories()
    logger.info("SceneRx API starting up...")
    logger.info(f"Data directory: {settings.data_path}")
    logger.info(f"Vision API URL: {settings.vision_api_url}")

    # Initialize SQLite project store
    settings.ensure_directories()
    store = init_project_store(settings.sqlite_path)
    logger.info("SQLite project store initialized at %s", settings.sqlite_path)

    yield

    # Shutdown
    store.close()
    logger.info("SceneRx API shutting down...")


def create_app() -> FastAPI:
    """Create and configure FastAPI application"""
    settings = get_settings()

    app = FastAPI(
        title="SceneRx API",
        description="Urban greenspace visual analysis API",
        version="1.0.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    # CORS middleware for React frontend
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",   # Create React App default
            "http://localhost:5173",   # Vite default
            "http://127.0.0.1:3000",
            "http://127.0.0.1:5173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Include routers
    app.include_router(
        health.router,
        tags=["Health"],
    )
    app.include_router(
        config.router,
        prefix="/api/config",
        tags=["Configuration"],
    )
    app.include_router(
        metrics.router,
        prefix="/api/metrics",
        tags=["Metrics"],
    )
    app.include_router(
        projects.router,
        prefix="/api/projects",
        tags=["Projects"],
    )
    app.include_router(
        vision.router,
        prefix="/api/vision",
        tags=["Vision Analysis"],
    )
    app.include_router(
        indicators.router,
        prefix="/api/indicators",
        tags=["Indicators"],
    )
    app.include_router(
        tasks.router,
        prefix="/api/tasks",
        tags=["Background Tasks"],
    )
    app.include_router(
        auth.router,
        prefix="/api/auth",
        tags=["Authentication"],
    )
    app.include_router(
        analysis.router,
        prefix="/api/analysis",
        tags=["Analysis Pipeline"],
    )
    app.include_router(
        encoding.router,
        prefix="/api/encoding",
        tags=["Encoding Dictionary"],
    )
    # Nature-style chart redraw + ZIP export — server-side matplotlib
    # pipeline that mirrors the paper figures' typography and palette.
    # The router declares its own /projects/{id}/nature-bundle.zip path.
    app.include_router(
        nature_export.router,
        prefix="/api",
        tags=["Nature Export"],
    )

    # Serve uploaded images as static files
    uploads_path = settings.temp_full_path / "uploads"
    uploads_path.mkdir(parents=True, exist_ok=True)
    app.mount("/api/uploads", StaticFiles(directory=str(uploads_path)), name="uploads")

    # Serve vision analysis mask images as static files
    masks_path = settings.temp_full_path / "masks"
    masks_path.mkdir(parents=True, exist_ok=True)
    app.mount("/api/masks", StaticFiles(directory=str(masks_path)), name="masks")

    return app


# Create app instance
app = create_app()


def _check_port_available(host: str, port: int) -> tuple[bool, OSError | None]:
    """Pre-flight bind to detect port conflicts before uvicorn swallows them.

    On Windows, Hyper-V / WSL2 dynamically reserves chunks of the ephemeral
    port range at boot. A reservation lasts until the next reboot, then
    typically lands on a different range — meaning *any* fixed default port
    can be unlucky. We probe the port up front so we can give the user a
    pointed error message instead of uvicorn's terse "Errno 13" trace.
    """
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
    except OSError as exc:
        return False, exc
    finally:
        sock.close()
    return True, None


def _print_port_error(host: str, port: int, err: OSError) -> None:
    """Format a developer-actionable error for a failed port bind."""
    import sys

    is_windows = sys.platform == "win32"
    is_reserved = is_windows and getattr(err, "winerror", None) == 10013

    bar = "=" * 70
    print(f"\n{bar}", file=sys.stderr)
    print(
        f"X  Cannot bind backend on {host}:{port}  ({err})",
        file=sys.stderr,
    )
    print(bar, file=sys.stderr)
    if is_reserved:
        print(
            f"\nPort {port} is reserved by Windows (typically Hyper-V or WSL2)."
            "\nThese reservations are dynamic and can shift on every reboot,"
            "\nso *any* fixed port may be unlucky on a given day.",
            file=sys.stderr,
        )
        print("\nTwo fixes:", file=sys.stderr)
        print(
            f"\n  [1] One-shot: pick another port for this run."
            f"\n      PowerShell:  $env:PORT='8500'; python -m app.main"
            f"\n      Bash:        PORT=8500 python -m app.main"
            f"\n      Or set PORT=NNNN in packages/backend/.env",
            file=sys.stderr,
        )
        print(
            f"\n  [2] Permanent (recommended): reserve port {port} for SceneRx"
            f"\n      so Hyper-V never grabs it. Run once in an *Administrator*"
            f"\n      PowerShell, then restart this command:"
            f"\n"
            f"\n        netsh int ipv4 add excludedportrange protocol=tcp \\"
            f"\n          startport={port} numberofports=1 store=persistent"
            f"\n"
            f"\n      The store=persistent flag survives reboots.",
            file=sys.stderr,
        )
        print(
            "\n  Inspect current Hyper-V / WSL2 reservations with:"
            "\n    netsh interface ipv4 show excludedportrange protocol=tcp",
            file=sys.stderr,
        )
    else:
        print(
            "\nLikely causes:"
            "\n  - Another process is already listening on this port."
            f"\n    Check with: lsof -i :{port}   (or  netstat -ano | findstr :{port}  on Windows)"
            "\n  - The OS is restricting access (run as a non-privileged user, or pick port >= 1024).",
            file=sys.stderr,
        )
        print(
            f"\nSet PORT=NNNN in packages/backend/.env or via env var to use a different port.",
            file=sys.stderr,
        )
    print(f"\n{bar}\n", file=sys.stderr)


if __name__ == "__main__":
    import sys
    import uvicorn

    settings = get_settings()
    ok, err = _check_port_available(settings.host, settings.port)
    if not ok and err is not None:
        _print_port_error(settings.host, settings.port, err)
        sys.exit(1)

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )
