"""Project management endpoints"""

import os
import re
import uuid
import shutil
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional, List

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import FileResponse

from pydantic import BaseModel

from app.models.project import (
    ProjectCreate,
    ProjectUpdate,
    ProjectResponse,
    ProjectQuery,
    SpatialZone,
    SpatialRelation,
    UploadedImage,
)
from app.models.user import UserResponse
from app.api.deps import get_current_user


class ZoneAssignment(BaseModel):
    image_id: str
    zone_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Analysis-artefact invalidation
# ---------------------------------------------------------------------------
#
# Whenever the project's spatial_zones list is mutated (zone added, removed,
# reshaped, or images reassigned to different zones), every analysis blob
# downstream becomes stale:
#   - zone_analysis_result is computed against zones that no longer exist
#   - design_strategy_result(s) cite zones / clusters that are stale
#   - ai_report / ai_reports prose names units that may not match the
#     project's current spatial_zones
#
# Without invalidation the user is left in an inconsistent state where
# (a) the project record says 2 zones but (b) the cached analysis was run
# on 1 zone, and the Reports page's entry-gate logic ends up routing them
# into the wrong path. We invalidate ALL three layers (Stage 2.5 / 3 /
# narrative) at once because they're a strict dependency chain — if zones
# change, even a "valid" cached strategy or report would describe the
# wrong spatial unit.
#
# We do not try to be clever about "did anything actually change" (e.g.
# pure rename vs geometry move): the cost of a false-positive invalidation
# is one re-run of the pipeline (5-15 minutes); the cost of a missed
# invalidation is silently wrong analysis. We err on the side of safety.
def _invalidate_analysis_artefacts(project: ProjectResponse) -> bool:
    """Wipe Stage 2.5 / 3 / AI report fields. Returns True if anything
    was actually cleared (so callers can decide whether to log the event).

    Used when something downstream of Stage 1 changes (zones, image set,
    image-zone assignment, GPS, selected indicators). Stage 1 itself
    (recommendations / selected_indicators) is preserved — those are still
    relevant under the new conditions.
    """
    had_artefacts = bool(
        project.zone_analysis_result
        or project.design_strategy_result
        or project.design_strategy_results
        or project.ai_report
        or project.ai_reports
        # v4.x — also invalidate any per-view panorama results we've stashed.
        # `active_panorama_views` (the user's UI selection) is NOT invalidated:
        # they still want the same set of views once the pipeline is rerun.
        or project.panorama_view_results
    )
    project.zone_analysis_result = None
    project.design_strategy_result = None
    project.design_strategy_results = {}
    project.ai_report = None
    project.ai_report_meta = None
    project.ai_reports = {}
    project.ai_report_metas = {}
    project.panorama_view_results = {}
    return had_artefacts


# Stage 1 is the LLM-driven indicator recommendation step. Its inputs are
# the project's design_brief, performance_dimensions, and target dimensions
# (passed as part of the brief). When any of those change, the recommended
# indicators may no longer match the design intent — and selected_indicators
# (a subset of the recommendations) is also stale by extension. Everything
# downstream (pipeline metrics, zone analysis, strategies, AI report) was
# computed against the old indicator set and must be wiped too.
#
# We deliberately keep this separate from `_invalidate_analysis_artefacts`
# because zone/image changes do NOT invalidate Stage 1 (the recommended
# indicators are still valid for the new spatial layout). Only brief/
# dimension changes hit Stage 1.
def _invalidate_stage1_and_downstream(project: ProjectResponse) -> bool:
    """Wipe Stage 1 recommendations + selected_indicators + everything
    downstream. Returns True if anything was actually cleared.
    """
    had_stage1 = bool(
        project.stage1_recommendations
        or project.stage1_relationships
        or project.stage1_summary
        or project.selected_indicators
    )
    project.stage1_recommendations = []
    project.stage1_relationships = []
    project.stage1_summary = None
    project.selected_indicators = []
    had_downstream = _invalidate_analysis_artefacts(project)
    return had_stage1 or had_downstream


class BatchImageDelete(BaseModel):
    image_ids: List[str]
from app.core.config import get_settings
from app.db.project_store import get_project_store, ProjectStore

router = APIRouter()


def _parse_coords_from_filename(filename: str) -> tuple[float, float] | None:
    """Try to extract (latitude, longitude) from the filename.

    Supports underscore/space-separated formats common in street-view datasets::

        0_0_120.1256806_30.2549131_杨公堤_201709_front
              ^^^^^^^^^  ^^^^^^^^^
              longitude   latitude

    Also handles dot-separated legacy format (``0.0.120.1256806.30.2549131...``).

    Returns (latitude, longitude) rounded to 7 decimal places, or None.
    """
    stem = Path(filename).stem

    # Split by common separators, then find segments that look like coordinates
    # e.g. "0_0_120.1256806_30.2549131_杨公堤_201709_front" → ["120.1256806", "30.2549131"]
    candidates: list[float] = []
    for seg in re.split(r'[_ \-]+', stem):
        m = re.fullmatch(r'\d{1,3}\.\d{4,}', seg)
        if m:
            value = float(m.group())
            if 1.0 <= abs(value) <= 180.0:
                candidates.append(value)

    if len(candidates) >= 2:
        a, b = candidates[-2], candidates[-1]
        return _assign_lat_lng(a, b)

    # Legacy fallback: dot-separated format where dots serve as both decimal
    # separator AND field delimiter (e.g. "0.0.120.1256806.30.2549131...")
    ascii_prefix = re.split(r'[^\x00-\x7f]', stem, maxsplit=1)[0].rstrip('. _-')
    parts = ascii_prefix.split('.')
    legacy_candidates: list[float] = []
    i = 0
    while i < len(parts) - 1:
        int_part = parts[i]
        dec_part = parts[i + 1]
        if re.fullmatch(r'\d{1,3}', int_part) and re.fullmatch(r'\d{4,}', dec_part):
            value = float(f"{int_part}.{dec_part}")
            if 1.0 <= abs(value) <= 180.0:
                legacy_candidates.append(value)
                i += 2
                continue
        i += 1

    if len(legacy_candidates) >= 2:
        a, b = legacy_candidates[-2], legacy_candidates[-1]
        return _assign_lat_lng(a, b)

    return None


def _assign_lat_lng(a: float, b: float) -> tuple[float, float] | None:
    """Given two coordinate candidates, return (latitude, longitude)."""
    if abs(a) <= 90 and abs(b) <= 90:
        # Both could be latitude — assume (lng, lat) order (common in Chinese datasets)
        lat, lng = b, a
    elif abs(a) <= 90:
        lat, lng = a, b
    elif abs(b) <= 90:
        lat, lng = b, a
    else:
        return None
    return round(lat, 7), round(lng, 7)


def get_projects_store() -> ProjectStore:
    """Get the SQLite-backed project store (used by vision.py, analysis.py)."""
    return get_project_store()


@router.post("", response_model=ProjectResponse)
async def create_project(project: ProjectCreate, _user: UserResponse = Depends(get_current_user)):
    """Create a new project"""
    store = get_project_store()
    project_id = str(uuid.uuid4())[:8]

    # Convert SpatialZoneCreate to SpatialZone with proper IDs
    zones = []
    for i, zone_data in enumerate(project.spatial_zones):
        zone = SpatialZone(
            zone_id=zone_data.zone_id or f"zone_{i+1}",
            zone_name=zone_data.zone_name,
            zone_types=zone_data.zone_types,
            area=zone_data.area,
            status=zone_data.status,
            description=zone_data.description,
        )
        zones.append(zone)

    response = ProjectResponse(
        id=project_id,
        created_at=datetime.now(),
        project_name=project.project_name,
        project_location=project.project_location,
        site_scale=project.site_scale,
        project_phase=project.project_phase,
        koppen_zone_id=project.koppen_zone_id,
        country_id=project.country_id,
        space_type_id=project.space_type_id,
        lcz_type_id=project.lcz_type_id,
        age_group_id=project.age_group_id,
        design_brief=project.design_brief,
        performance_dimensions=project.performance_dimensions,
        subdimensions=project.subdimensions,
        spatial_zones=zones,
        spatial_relations=project.spatial_relations,
        uploaded_images=[],
    )

    store.save(response)
    return response


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    limit: int = Query(default=50, le=100),
    offset: int = Query(default=0, ge=0),
):
    """List all projects"""
    store = get_project_store()
    return store.list(limit, offset)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: str):
    """Get project by ID"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    return project


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(project_id: str, updates: ProjectUpdate, _user: UserResponse = Depends(get_current_user)):
    """Update project"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    # Apply updates
    update_data = updates.model_dump(exclude_unset=True)

    # Stage 1 invalidation — design_brief, performance_dimensions, and the
    # project-level target dimensions feed directly into the Stage 1 LLM
    # prompt that produces stage1_recommendations. If any of these change,
    # the cached recommendations were derived from a stale prompt and must
    # be discarded along with the entire downstream pipeline.
    #
    # Snapshot the current values before applying the update so we can do a
    # precise old-vs-new compare. Only fire the invalidation when the value
    # actually changed (no-op writes from the UI shouldn't nuke caches).
    stage1_input_fields = ('design_brief', 'performance_dimensions', 'target_dimensions')
    stage1_input_changed = False
    for field in stage1_input_fields:
        if field in update_data:
            old_value = getattr(project, field, None)
            new_value = update_data[field]
            if old_value != new_value:
                stage1_input_changed = True
                break

    # Handle spatial_zones conversion separately
    if 'spatial_zones' in update_data:
        zones = []
        for i, zone_data in enumerate(update_data['spatial_zones']):
            zone = SpatialZone(
                zone_id=zone_data.get('zone_id') or f"zone_{i+1}",
                zone_name=zone_data.get('zone_name', ''),
                zone_types=zone_data.get('zone_types', []),
                area=zone_data.get('area'),
                status=zone_data.get('status', 'existing'),
                description=zone_data.get('description', ''),
            )
            zones.append(zone)
        project.spatial_zones = zones
        del update_data['spatial_zones']

        # Orphan-image cascade-delete — when the wizard removes a zone, any
        # image previously assigned to that zone gets DELETED entirely (file
        # + record), per product semantics: removing a zone removes its
        # images too. Without this:
        #   - orphans still count as "Assigned" in the project header
        #     (artificially inflating the count)
        #   - they flow into the analysis pipeline, which then operates on
        #     images whose zone is gone
        # Mirrors the delete-image / batch-delete pattern: os.remove the
        # file, drop from uploaded_images list. Images with zone_id=None
        # (truly ungrouped, never assigned) are preserved — the cascade
        # only applies to images that were tied to a removed zone.
        new_zone_ids = {z.zone_id for z in zones}
        kept: list = []
        deleted_orphan_ids: list[str] = []
        deleted_orphan_zones: set[str] = set()
        for img in project.uploaded_images:
            if img.zone_id is not None and img.zone_id not in new_zone_ids:
                try:
                    os.remove(img.filepath)
                except Exception:
                    pass  # missing file is non-fatal
                deleted_orphan_ids.append(img.image_id)
                deleted_orphan_zones.add(img.zone_id)
            else:
                kept.append(img)
        if deleted_orphan_ids:
            project.uploaded_images = kept
            logger.info(
                "Project %s: deleted %d images orphaned by spatial_zones update "
                "(zones removed: %s)",
                project_id, len(deleted_orphan_ids),
                sorted(deleted_orphan_zones),
            )

        # Zones changed → wipe Stage 2.5 / 3 / AI report. The user must
        # re-run the pipeline before any analysis appears in Reports.
        if _invalidate_analysis_artefacts(project):
            logger.info(
                "Project %s: invalidated analysis artefacts after spatial_zones update",
                project_id,
            )

    # Handle spatial_relations separately
    if 'spatial_relations' in update_data:
        relations = []
        for rel_data in update_data['spatial_relations']:
            relation = SpatialRelation(
                from_zone=rel_data.get('from_zone', ''),
                to_zone=rel_data.get('to_zone', ''),
                relation_type=rel_data.get('relation_type', ''),
                direction=rel_data.get('direction', 'single'),
            )
            relations.append(relation)
        project.spatial_relations = relations
        del update_data['spatial_relations']

    # v4.x — Panorama view switching. When the caller flips
    # `active_panorama_view` to a different view, mirror that view's stored
    # bucket into the legacy top-level slots so the Reports page reads the
    # right result set without per-component plumbing. If the target view
    # has no stored bucket yet (pipeline not run for it), clear the legacy
    # slots — better an empty Reports page than stale results from a
    # different view masquerading as the current one.
    if 'active_panorama_view' in update_data:
        new_view = update_data['active_panorama_view']
        old_view = project.active_panorama_view
        if new_view != old_view:
            # First, snapshot the CURRENT top-level slots back into the old
            # view's bucket. This catches any in-flight edits (AI report
            # regenerations, strategy tweaks) that happened against the
            # legacy slots while the user was looking at old_view.
            # NOTE: keep `selected_indicators` out of the per-view bucket.
            # It's a user-level live setting; mirroring it per-view would
            # silently stomp the user's current pick on every view switch.
            #
            # `image_metrics` IS mirrored per-view: each view's pipeline run
            # produces a different set of img.metrics_results values (because
            # different masks → different indicator values), and downstream
            # endpoints (clustering by-project, within-zone clustering,
            # chart-summary) read img.metrics_results directly. Without
            # snapshotting + restoring per-view, clustering would always
            # operate on whatever the LAST pipeline run left behind — the
            # "Cluster view 跨视角数据相同" bug.
            if old_view:
                project.panorama_view_results[old_view] = {
                    "zone_analysis_result": project.zone_analysis_result,
                    "ai_reports": dict(project.ai_reports),
                    "ai_report_metas": dict(project.ai_report_metas),
                    "design_strategy_results": dict(project.design_strategy_results),
                    "analysis_results_updated_at": (
                        project.analysis_results_updated_at.isoformat()
                        if project.analysis_results_updated_at else None
                    ),
                    "image_metrics": {
                        img.image_id: dict(img.metrics_results)
                        for img in project.uploaded_images
                        if img.metrics_results
                    },
                }
            # Then hydrate the new view's bucket into the legacy slots.
            bucket = project.panorama_view_results.get(new_view) or {}
            project.zone_analysis_result = bucket.get("zone_analysis_result")
            project.ai_reports = dict(bucket.get("ai_reports") or {})
            project.ai_report_metas = dict(bucket.get("ai_report_metas") or {})
            project.design_strategy_results = dict(bucket.get("design_strategy_results") or {})
            # Restore per-image metrics from the new view's bucket IF the
            # bucket carries an `image_metrics` field. Backward-compat: old
            # buckets persisted before the per-view metrics fix don't have
            # this field — in that case we LEAVE img.metrics_results alone
            # rather than wiping it to {} (which would break a subsequent
            # cluster run with "no data"). The user gets a one-time stale
            # metrics-for-current-view until they re-run the pipeline for
            # this view, which populates the new schema. Re-clustering after
            # a fresh pipeline run produces per-view-correct results.
            if "image_metrics" in bucket:
                view_image_metrics = bucket["image_metrics"] or {}
                for img in project.uploaded_images:
                    img.metrics_results = dict(view_image_metrics.get(img.image_id) or {})
            # Parse back the stored isoformat string if present.
            ts = bucket.get("analysis_results_updated_at")
            if isinstance(ts, str):
                try:
                    project.analysis_results_updated_at = datetime.fromisoformat(ts)
                except ValueError:
                    project.analysis_results_updated_at = None
            else:
                project.analysis_results_updated_at = None

    # Apply remaining simple field updates
    for field, value in update_data.items():
        setattr(project, field, value)

    # Run the Stage 1 invalidation AFTER the update is applied, so the diff
    # we already detected acts on the now-current state. The helper wipes
    # stage1_* fields plus all downstream artefacts (zone_analysis, design
    # strategies, AI report) — the user must re-run Get Recommendations,
    # Pipeline, and Reports.
    if stage1_input_changed and _invalidate_stage1_and_downstream(project):
        logger.info(
            "Project %s: invalidated Stage 1 + downstream after design_brief / "
            "dimensions update",
            project_id,
        )

    project.updated_at = datetime.now()
    store.save(project)
    return project


@router.delete("/{project_id}")
async def delete_project(project_id: str, _user: UserResponse = Depends(get_current_user)):
    """Delete project"""
    store = get_project_store()
    if not store.delete(project_id):
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    return {"success": True, "project_id": project_id}


# Zone management
@router.post("/{project_id}/zones", response_model=SpatialZone)
async def add_zone(
    project_id: str,
    zone_name: str,
    zone_types: list[str] = None,
    description: str = "",
):
    """Add a spatial zone to project"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    zone_id = f"zone_{len(project.spatial_zones) + 1}"

    zone = SpatialZone(
        zone_id=zone_id,
        zone_name=zone_name,
        zone_types=zone_types or [],
        description=description,
    )

    project.spatial_zones.append(zone)
    # Zones changed → invalidate cached analysis (see helper docstring).
    if _invalidate_analysis_artefacts(project):
        logger.info(
            "Project %s: invalidated analysis artefacts after add_zone",
            project_id,
        )
    project.updated_at = datetime.now()
    store.save(project)
    return zone


@router.delete("/{project_id}/zones/{zone_id}")
async def delete_zone(project_id: str, zone_id: str):
    """Remove a spatial zone (and any images assigned to it)."""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    project.spatial_zones = [z for z in project.spatial_zones if z.zone_id != zone_id]

    # Cascade-delete images that were assigned to this zone (file + record).
    # Mirrors the wizard PUT path's orphan-cleanup: removing a zone removes
    # its images too. Previously this endpoint only set zone_id=None, which
    # diverged from the wizard's semantics and left orphan images
    # contaminating the "Assigned" count and the pipeline.
    kept = []
    deleted_image_ids: list[str] = []
    for img in project.uploaded_images:
        if img.zone_id == zone_id:
            try:
                os.remove(img.filepath)
            except Exception:
                pass
            deleted_image_ids.append(img.image_id)
        else:
            kept.append(img)
    if deleted_image_ids:
        project.uploaded_images = kept
        logger.info(
            "Project %s: cascade-deleted %d images with delete_zone %s",
            project_id, len(deleted_image_ids), zone_id,
        )

    # Zones changed → invalidate cached analysis.
    if _invalidate_analysis_artefacts(project):
        logger.info(
            "Project %s: invalidated analysis artefacts after delete_zone %s",
            project_id, zone_id,
        )
    project.updated_at = datetime.now()
    store.save(project)
    return {"success": True, "zone_id": zone_id}


# Image management
@router.post("/{project_id}/images")
async def upload_images(
    project_id: str,
    files: List[UploadFile] = File(...),
    zone_id: Optional[str] = Form(None),
    _user: UserResponse = Depends(get_current_user),
):
    """Upload images to a project"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    settings = get_settings()

    # Create project upload directory
    upload_dir = settings.temp_full_path / "uploads" / project_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    uploaded = []
    for file in files:
        # Generate unique image ID
        image_id = f"img_{uuid.uuid4().hex[:8]}"
        # Strip directory part from filename (folder uploads send relative path)
        raw_name = file.filename or "unknown.jpg"
        safe_name = raw_name.replace('\\', '/').rsplit('/', 1)[-1]
        filename = f"{image_id}_{safe_name}"
        filepath = upload_dir / filename

        # Save file
        with open(filepath, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # Extract EXIF GPS coordinates
        has_gps = False
        latitude = None
        longitude = None
        try:
            from PIL import Image as PILImage
            from PIL.ExifTags import TAGS, GPSTAGS

            with PILImage.open(filepath) as img:
                exif = img.getexif()
                if exif:
                    # GPS info is in IFD 0x8825
                    gps_ifd = exif.get_ifd(0x8825)
                    if gps_ifd:
                        def _dms_to_dd(dms, ref):
                            d, m, s = float(dms[0]), float(dms[1]), float(dms[2])
                            dd = d + m / 60 + s / 3600
                            return -dd if ref in ("S", "W") else dd

                        lat_dms = gps_ifd.get(2)  # GPSLatitude
                        lat_ref = gps_ifd.get(1)   # GPSLatitudeRef
                        lng_dms = gps_ifd.get(4)  # GPSLongitude
                        lng_ref = gps_ifd.get(3)   # GPSLongitudeRef
                        if lat_dms and lng_dms and lat_ref and lng_ref:
                            latitude = round(_dms_to_dd(lat_dms, lat_ref), 6)
                            longitude = round(_dms_to_dd(lng_dms, lng_ref), 6)
                            has_gps = True
        except Exception:
            pass  # Not an image with EXIF or Pillow issue — skip silently

        # Fallback: extract coordinates from filename
        # Handles patterns like: 0.0.120.1256806.30.2549131桥公 201709 rightp9
        if not has_gps:
            coords = _parse_coords_from_filename(safe_name)
            if coords:
                latitude, longitude = coords
                has_gps = True
                logger.debug("GPS from filename %s: lat=%s, lng=%s", safe_name, latitude, longitude)

        # Create image record (use safe_name, not file.filename which may contain path)
        image = UploadedImage(
            image_id=image_id,
            filename=safe_name,
            filepath=str(filepath),
            zone_id=zone_id,
            has_gps=has_gps,
            latitude=latitude,
            longitude=longitude,
        )
        project.uploaded_images.append(image)
        uploaded.append(image)

    # New images mean the cached pipeline metrics, zone analysis, and AI
    # report no longer reflect the full image set — they were computed
    # against a smaller list. Wipe the downstream artefacts so the Reports
    # page surfaces "needs re-run" instead of silently mixing old analysis
    # with newly added images. Stage 1 (recommendations + selected
    # indicators) stays put; uploading images doesn't change which
    # indicators are relevant.
    if uploaded and _invalidate_analysis_artefacts(project):
        logger.info(
            "Project %s: invalidated analysis artefacts after uploading %d images",
            project_id, len(uploaded),
        )

    project.updated_at = datetime.now()
    store.save(project)
    return {
        "success": True,
        "uploaded_count": len(uploaded),
        "images": uploaded,
    }


@router.get("/{project_id}/images/{image_id}/thumbnail")
async def get_image_thumbnail(
    project_id: str,
    image_id: str,
    size: int = Query(default=160, ge=40, le=400),
):
    """Return a cached thumbnail for the given image."""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    img = next((i for i in project.uploaded_images if i.image_id == image_id), None)
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")

    from app.db.path_resolver import resolve_to_container
    original = resolve_to_container(img.filepath)
    if not original.exists():
        raise HTTPException(status_code=404, detail="Image file missing")

    settings = get_settings()
    thumb_dir = settings.temp_full_path / "thumbnails" / project_id
    thumb_dir.mkdir(parents=True, exist_ok=True)
    thumb_path = thumb_dir / f"{image_id}_{size}.jpg"

    if not thumb_path.exists():
        from PIL import Image as PILImage

        with PILImage.open(original) as pil_img:
            pil_img.thumbnail((size, size))
            if pil_img.mode in ("RGBA", "P"):
                pil_img = pil_img.convert("RGB")
            pil_img.save(thumb_path, "JPEG", quality=75)

    return FileResponse(
        thumb_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.put("/{project_id}/images/batch-zone")
async def batch_assign_zones(
    project_id: str,
    assignments: List[ZoneAssignment],
):
    """Batch assign images to zones"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    image_lookup = {img.image_id: img for img in project.uploaded_images}

    updated = 0
    for item in assignments:
        img = image_lookup.get(item.image_id)
        if img and img.zone_id != item.zone_id:
            img.zone_id = item.zone_id
            updated += 1

    if updated > 0:
        # Image-to-zone mapping changed → zone-level statistics are now
        # stale (different sets of images contribute to each zone). Same
        # invariant as zones-list mutation: invalidate Stage 2.5 / 3 / AI.
        if _invalidate_analysis_artefacts(project):
            logger.info(
                "Project %s: invalidated analysis artefacts after batch reassigning %d images",
                project_id, updated,
            )
        project.updated_at = datetime.now()
        store.save(project)

    return {"success": True, "updated": updated}


@router.put("/{project_id}/images/{image_id}/zone")
async def assign_image_to_zone(
    project_id: str,
    image_id: str,
    zone_id: Optional[str] = None,
):
    """Assign or unassign an image to a zone"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    for img in project.uploaded_images:
        if img.image_id == image_id:
            zone_changed = img.zone_id != zone_id
            img.zone_id = zone_id
            if zone_changed:
                # Image moved to a different zone → zone-level statistics
                # are stale for both the source and destination zone.
                if _invalidate_analysis_artefacts(project):
                    logger.info(
                        "Project %s: invalidated analysis artefacts after reassigning image %s",
                        project_id, image_id,
                    )
            project.updated_at = datetime.now()
            store.save(project)
            return {"success": True, "image_id": image_id, "zone_id": zone_id}

    raise HTTPException(status_code=404, detail=f"Image not found: {image_id}")


@router.post("/{project_id}/images/batch-delete")
async def batch_delete_images(
    project_id: str,
    payload: BatchImageDelete,
    _user: UserResponse = Depends(get_current_user),
):
    """Delete multiple images from a project in one request."""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    target_ids = set(payload.image_ids)
    if not target_ids:
        return {"success": True, "deleted": 0, "deleted_ids": [], "not_found": []}

    deleted_ids: list[str] = []
    remaining: list[UploadedImage] = []
    for img in project.uploaded_images:
        if img.image_id in target_ids:
            try:
                os.remove(img.filepath)
            except Exception:
                pass
            deleted_ids.append(img.image_id)
        else:
            remaining.append(img)

    not_found = sorted(target_ids - set(deleted_ids))

    if deleted_ids:
        project.uploaded_images = remaining
        # Removing images shrinks the per-zone image set, so all
        # downstream stats are stale.
        if _invalidate_analysis_artefacts(project):
            logger.info(
                "Project %s: invalidated analysis artefacts after batch-deleting %d images",
                project_id, len(deleted_ids),
            )
        project.updated_at = datetime.now()
        store.save(project)

    return {
        "success": True,
        "deleted": len(deleted_ids),
        "deleted_ids": deleted_ids,
        "not_found": not_found,
    }


@router.delete("/{project_id}/images/{image_id}")
async def delete_image(project_id: str, image_id: str, _user: UserResponse = Depends(get_current_user)):
    """Delete an image from project"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    for i, img in enumerate(project.uploaded_images):
        if img.image_id == image_id:
            # Delete file if exists
            try:
                os.remove(img.filepath)
            except Exception:
                pass
            project.uploaded_images.pop(i)
            # Removing an image changes per-zone counts → stats stale.
            if _invalidate_analysis_artefacts(project):
                logger.info(
                    "Project %s: invalidated analysis artefacts after deleting image %s",
                    project_id, image_id,
                )
            project.updated_at = datetime.now()
            store.save(project)
            return {"success": True, "image_id": image_id}

    raise HTTPException(status_code=404, detail=f"Image not found: {image_id}")


@router.get("/{project_id}/images")
async def list_project_images(project_id: str):
    """Get all images for a project"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    return {
        "project_id": project_id,
        "total": len(project.uploaded_images),
        "images": project.uploaded_images,
    }


@router.post("/{project_id}/images/reparse-gps")
async def reparse_image_gps(
    project_id: str,
    _user: UserResponse = Depends(get_current_user),
):
    """Re-extract GPS coordinates from filenames for images that have no GPS data.

    This is useful when images were uploaded before filename-based coordinate
    parsing was available, or when EXIF data was missing.  It does NOT touch
    Vision API results or metrics — only updates ``has_gps / latitude / longitude``.
    """
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    updated = 0
    for img in project.uploaded_images:
        if img.has_gps:
            continue
        coords = _parse_coords_from_filename(img.filename)
        if coords:
            img.latitude, img.longitude = coords
            img.has_gps = True
            updated += 1

    if updated > 0:
        # GPS coordinates feed into spatial analysis (zone bounds checks,
        # spatial scatter charts, GPS-based clustering). New coordinates →
        # cached zone_analysis is computed against the wrong spatial
        # context, so invalidate the same way as image-level changes.
        if _invalidate_analysis_artefacts(project):
            logger.info(
                "Project %s: invalidated analysis artefacts after re-parsing GPS for %d images",
                project_id, updated,
            )
        project.updated_at = datetime.now()
        store.save(project)

    return {
        "project_id": project_id,
        "total_images": len(project.uploaded_images),
        "already_had_gps": sum(1 for img in project.uploaded_images if img.has_gps) - updated,
        "updated_from_filename": updated,
        "still_no_gps": sum(1 for img in project.uploaded_images if not img.has_gps),
    }


# Stage 1 selected-indicators state — separate endpoint because the toggle
# UI fires a save per click (debounced), and we don't want to round-trip the
# full project for a tiny list.
@router.put("/{project_id}/selected-indicators")
async def update_selected_indicators(
    project_id: str,
    indicators: list[dict],
    _user: UserResponse = Depends(get_current_user),
):
    """Persist the user's chosen subset of Stage 1 recommendations."""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    # Snapshot the previous selection so we can detect a real change. The
    # toggle UI fires this endpoint per click (debounced), and many writes
    # are no-ops when the user re-selects the same indicators — those
    # shouldn't blow away cached analysis.
    prev_ids = {s.get("indicator_id") for s in (project.selected_indicators or [])}
    new_ids = {s.get("indicator_id") for s in (indicators or [])}
    selection_changed = prev_ids != new_ids

    project.selected_indicators = indicators

    # Selection changed → cached pipeline output and everything downstream
    # was computed against a different indicator set. Wipe analysis +
    # strategies + AI report so the user is forced to re-run the pipeline
    # with the new selection. Stage 1 recommendations themselves remain
    # valid (we're choosing a subset of the same recommendation list).
    if selection_changed and _invalidate_analysis_artefacts(project):
        logger.info(
            "Project %s: invalidated analysis artefacts after selected_indicators change",
            project_id,
        )

    project.updated_at = datetime.now()
    store.save(project)
    return {"success": True, "count": len(indicators)}


# Export
@router.get("/{project_id}/export", response_model=ProjectQuery)
async def export_project(project_id: str):
    """Export project as ProjectQuery format"""
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    return ProjectQuery.from_project(project)
