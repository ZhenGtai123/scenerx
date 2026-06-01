"""SQLite-backed project store with dict-like read interface."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime
from typing import Optional

from app.models.project import ProjectResponse

logger = logging.getLogger(__name__)

# Warn when a single project's serialized JSON exceeds this. A large blob is a
# signal that unbounded per-image data (e.g. image_records, duplicated across
# panorama views / cluster_view) is leaking into the project record, which
# makes every read/write of that project slow.
_PROJECT_SIZE_WARN_BYTES = 5 * 1024 * 1024


def _strip_image_records(project: ProjectResponse) -> None:
    """Drop the derived per-image ``image_records`` arrays from every
    zone_analysis_result the project carries (top-level + its cluster_view /
    analysis_views, and every panorama_view_results bucket) before persisting.

    image_records are O(N_images × indicators × layers) and fully rebuildable
    from ``uploaded_images[].metrics_results`` (frontend
    ChartContext.rebuildImageRecords; backend nature_export._rebuild_image_records).
    Persisting them — duplicated across the cluster_view and every panorama
    view — made the project blob O(images) and bloated a 1,161-image project to
    ~88 MB. Stripping keeps the stored record O(structure).

    Mutates in place; the dropped arrays are derived data, so losing the
    in-memory copy after save is harmless (consumers rebuild on demand).
    """
    def _strip_za(za) -> None:
        if not isinstance(za, dict):
            return
        if za.get("image_records"):
            za["image_records"] = []
        _strip_za(za.get("cluster_view"))
        for sub in (za.get("analysis_views") or {}).values():
            _strip_za(sub)

    _strip_za(project.zone_analysis_result)
    for bucket in (project.panorama_view_results or {}).values():
        if isinstance(bucket, dict):
            _strip_za(bucket.get("zone_analysis_result"))


def _has_image_records(project: ProjectResponse) -> bool:
    """True if any zone_analysis_result the project carries still holds
    non-empty image_records — i.e. stripping would actually shrink it. Lets the
    startup heal skip projects that are large for legitimate reasons (e.g. many
    uploaded_images) instead of re-saving them uselessly on every boot.
    """
    def _check(za) -> bool:
        if not isinstance(za, dict):
            return False
        if za.get("image_records"):
            return True
        if _check(za.get("cluster_view")):
            return True
        return any(_check(v) for v in (za.get("analysis_views") or {}).values())

    if _check(project.zone_analysis_result):
        return True
    return any(
        isinstance(b, dict) and _check(b.get("zone_analysis_result"))
        for b in (project.panorama_view_results or {}).values()
    )

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
);
"""


class ProjectStore:
    """Thread-safe SQLite store for ProjectResponse objects."""

    def __init__(self, db_path: str):
        self._db_path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute(_CREATE_TABLE)
        self._conn.commit()
        logger.info("ProjectStore initialized at %s", db_path)

    # -- read interface (no lock needed for WAL readers) --

    def get(self, project_id: str) -> Optional[ProjectResponse]:
        # Fetch the raw blob under the lock (the shared connection is not safe
        # for concurrent access from threadpool workers), but run the expensive
        # Pydantic deserialize OUTSIDE the lock so parallel reads — e.g. several
        # view-switch GETs offloaded to the threadpool — parse concurrently
        # instead of serializing on the lock.
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        if row is None:
            return None
        return ProjectResponse.model_validate_json(row[0])

    def __contains__(self, project_id: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        return row is not None

    def __getitem__(self, project_id: str) -> ProjectResponse:
        proj = self.get(project_id)
        if proj is None:
            raise KeyError(project_id)
        return proj

    def list(self, limit: int = 50, offset: int = 0) -> list[ProjectResponse]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM projects ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [ProjectResponse.model_validate_json(r[0]) for r in rows]

    def values(self) -> list[ProjectResponse]:
        """Backward-compat: return all projects."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM projects ORDER BY created_at DESC"
            ).fetchall()
        return [ProjectResponse.model_validate_json(r[0]) for r in rows]

    # -- write interface (locked) --

    def save(self, project: ProjectResponse) -> None:
        # Strip derived per-image image_records before persisting — keeps the
        # project blob O(structure), not O(images). See _strip_image_records.
        _strip_image_records(project)
        data = project.model_dump_json()
        if len(data) > _PROJECT_SIZE_WARN_BYTES:
            logger.warning(
                "Project %s serialized to %.1f MB (budget %d MB). Unbounded "
                "per-image data (e.g. image_records duplicated across panorama "
                "views / cluster_view) is likely leaking into the project blob — "
                "every read/write of this project will be slow.",
                project.id, len(data) / 1e6,
                _PROJECT_SIZE_WARN_BYTES // (1024 * 1024),
            )
        created = project.created_at.isoformat() if project.created_at else None
        updated = project.updated_at.isoformat() if project.updated_at else None
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO projects (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (project.id, data, created, updated),
            )
            self._conn.commit()

    def delete(self, project_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM projects WHERE id = ?", (project_id,)
            )
            self._conn.commit()
            return cur.rowcount > 0

    def heal_oversized_projects(self) -> int:
        """Re-save any project whose stored blob exceeds the size budget so the
        image_records strip in save() shrinks it. Idempotent: a stripped project
        is under budget and is skipped on the next startup. Uses the cheap SQL
        ``length(data)`` to find candidates without deserializing every project.
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT id FROM projects WHERE length(data) > ?",
                (_PROJECT_SIZE_WARN_BYTES,),
            ).fetchall()
        healed = 0
        for (pid,) in rows:
            proj = self.get(pid)
            if proj is not None and _has_image_records(proj):
                self.save(proj)  # save() strips image_records
                healed += 1
        if healed:
            logger.info(
                "Healed %d oversized project(s) by stripping derived image_records",
                healed,
            )
        return healed

    def close(self) -> None:
        self._conn.close()
        logger.info("ProjectStore closed")


# -- module-level singleton --

_store: Optional[ProjectStore] = None


def init_project_store(db_path: str) -> ProjectStore:
    global _store
    if _store is not None:
        _store.close()
    _store = ProjectStore(db_path)
    return _store


def get_project_store() -> ProjectStore:
    if _store is None:
        raise RuntimeError("ProjectStore not initialized — call init_project_store() first")
    return _store
