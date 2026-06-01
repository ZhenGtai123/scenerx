"""Cross-platform path normalisation for image / mask paths stored in SQLite.

Projects created before the docker move stored absolute Windows paths
like `D:\\green-svc\\greensvc\\packages\\backend\\temp\\uploads\\<proj>\\img.png`.
Inside the linux container that path is unreachable; reads return 404.

These helpers do two things:

* `resolve_to_container(stored)`     — accept any stored path (Windows
  absolute, Linux absolute, already-relative) and return a `Path` that
  actually exists on the current filesystem when one can be found.

* `migrate_project_paths(project)`   — best-effort, in-place rewrite of
  one project's `filepath` and `mask_filepaths` to relative form, so
  future reads don't need fallback. Idempotent.
"""

from __future__ import annotations

from pathlib import Path, PureWindowsPath, PurePosixPath
from typing import Optional

from app.core.config import get_settings


# Path segments we recognise as the root of a known sub-tree under
# `<temp>/`. Order matters — longer / more specific first.
_KNOWN_SEGMENTS = ("uploads", "masks", "thumbnails")


def _extract_tail(stored: str) -> Optional[str]:
    """Pull the `<segment>/...` suffix out of a stored path string.

    Works for:
      * Windows absolute: `D:\\...\\temp\\uploads\\proj\\img.png`
      * POSIX absolute:   `/app/temp/uploads/proj/img.png`
      * Already-relative: `uploads/proj/img.png`
    Returns None when no known segment is in the path.
    """
    if not stored:
        return None
    norm = stored.replace("\\", "/")
    for seg in _KNOWN_SEGMENTS:
        marker = f"/{seg}/"
        idx = norm.find(marker)
        if idx != -1:
            return norm[idx + 1:]
        # Already-relative form: starts with `<segment>/`.
        if norm.startswith(f"{seg}/"):
            return norm
    return None


def resolve_to_container(stored: str) -> Path:
    """Map a stored path to a Path on the running container/host fs.

    Lookup:
      1. Path(stored) as-is — works for local-Python runs where the
         original absolute path is still valid.
      2. <temp_full_path>/<extracted tail> — works after the move to
         docker, when the host paths baked into the DB are unreachable
         but the file is mounted at the canonical container location.
      3. Fall back to Path(stored) so the caller still gets a non-None
         value and the usual `.exists()` check fails loudly.
    """
    if not stored:
        return Path("")

    # PureWindowsPath handles backslashes even when run on Linux;
    # if the file actually exists at the stored path (local dev), use it.
    try:
        as_is = Path(stored)
        if as_is.exists():
            return as_is
    except OSError:
        # Path() may raise on weird Windows colon paths under WSL — ignore.
        pass

    tail = _extract_tail(stored)
    if tail is None:
        return Path(stored)

    settings = get_settings()
    candidate = settings.temp_full_path / tail
    return candidate


def migrate_project_paths(project) -> bool:
    """Rewrite one project's image/mask paths to container-relative
    (`<segment>/<project>/<file>`) form.

    Returns True when at least one field was changed (caller can save
    the project back). Idempotent — already-relative paths are left
    alone.
    """
    changed = False
    for img in getattr(project, "uploaded_images", []) or []:
        tail = _extract_tail(getattr(img, "filepath", "") or "")
        if tail and tail != getattr(img, "filepath", ""):
            img.filepath = tail
            changed = True
        mf = getattr(img, "mask_filepaths", None) or {}
        for key, value in list(mf.items()):
            if not isinstance(value, str):
                continue
            t = _extract_tail(value)
            if t and t != value:
                mf[key] = t
                changed = True
    return changed
