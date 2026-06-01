"""Vision analysis endpoints"""

import json
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, UploadFile, File, Form, Query

from app.api.deps import get_vision_client, get_settings_dep, get_current_user
from app.models.user import UserResponse
from app.core.config import Settings
from app.services.vision_client import VisionModelClient
from app.models.vision import (
    VisionAnalysisRequest,
    VisionAnalysisResponse,
    PanoramaViewResult,
    PanoramaAnalysisResponse,
    SemanticConfig,
)
from app.api.routes.projects import get_projects_store

logger = logging.getLogger(__name__)

router = APIRouter()


async def _save_masks_to_project(
    response: VisionAnalysisResponse,
    project_id: str,
    image_id: str,
    settings: Settings,
) -> dict[str, str]:
    """Save mask images from vision response to disk and return filepath mapping."""
    mask_dir = settings.temp_full_path / "masks" / project_id / image_id
    mask_dir.mkdir(parents=True, exist_ok=True)
    saved: dict[str, str] = {}
    for key, data in response.images.items():
        if isinstance(data, bytes) and len(data) > 0:
            path = mask_dir / f"{key}.png"
            path.write_bytes(data)
            saved[key] = str(path)
    return saved


@router.get("/semantic-config")
async def get_semantic_config(
    settings: Settings = Depends(get_settings_dep),
):
    """Get semantic class configuration"""
    config_path = settings.data_path / "Semantic_configuration.json"

    if not config_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Semantic configuration file not found"
        )

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    return {
        "total_classes": len(config),
        "classes": config,
    }


@router.post("/analyze", response_model=VisionAnalysisResponse)
async def analyze_image(
    file: UploadFile = File(...),
    request_data: str = Form(...),
    vision_client: VisionModelClient = Depends(get_vision_client),
    settings: Settings = Depends(get_settings_dep),
    _user: UserResponse = Depends(get_current_user),
):
    """
    Analyze an uploaded image using Vision API

    The request_data should be a JSON string with VisionAnalysisRequest fields.
    """
    # Parse request data
    try:
        request_dict = json.loads(request_data)
        request = VisionAnalysisRequest(**request_dict)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid request data: {e}")

    # Validate parameters
    valid, error = vision_client.validate_parameters(
        request.semantic_classes,
        request.semantic_countability,
        request.openness_list,
    )
    if not valid:
        raise HTTPException(status_code=400, detail=error)

    # Save uploaded file to temp location
    settings.ensure_directories()
    # Strip any directory components from the client-supplied filename to
    # prevent path traversal (e.g. "../../x"). Keep only the basename.
    _safe_name = (file.filename or "image").replace("\\", "/").rsplit("/", 1)[-1]
    temp_path = settings.temp_full_path / f"upload_{_safe_name}"

    try:
        content = await file.read()
        with open(temp_path, 'wb') as f:
            f.write(content)

        # Call Vision API
        result = await vision_client.analyze_image(str(temp_path), request)

        # Update image path in result
        result.image_path = str(temp_path)

        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze/panorama", response_model=PanoramaAnalysisResponse)
async def analyze_image_panorama(
    file: UploadFile = File(...),
    request_data: str = Form(...),
    vision_client: VisionModelClient = Depends(get_vision_client),
    settings: Settings = Depends(get_settings_dep),
    _user: UserResponse = Depends(get_current_user),
):
    """
    Analyze an uploaded image as panorama (split into left/front/right views).
    """
    try:
        request_dict = json.loads(request_data)
        request = VisionAnalysisRequest(**request_dict)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid request data: {e}")

    valid, error = vision_client.validate_parameters(
        request.semantic_classes, request.semantic_countability, request.openness_list,
    )
    if not valid:
        raise HTTPException(status_code=400, detail=error)

    settings.ensure_directories()
    # Strip any directory components from the client-supplied filename to
    # prevent path traversal (e.g. "../../x"). Keep only the basename.
    _safe_name = (file.filename or "image").replace("\\", "/").rsplit("/", 1)[-1]
    temp_path = settings.temp_full_path / f"upload_{_safe_name}"

    try:
        content = await file.read()
        with open(temp_path, 'wb') as f:
            f.write(content)

        views_result = await vision_client.analyze_panorama(str(temp_path), request)

        panorama_views: dict[str, PanoramaViewResult] = {}
        for view_name, view_response in views_result.items():
            panorama_views[view_name] = PanoramaViewResult(
                status=view_response.status,
                mask_paths=view_response.mask_paths if view_response.mask_paths else {},
                statistics=view_response.statistics,
                processing_time=view_response.processing_time,
                error=view_response.error,
            )

        all_success = all(v.status == "success" for v in panorama_views.values())
        return PanoramaAnalysisResponse(
            status="success" if all_success else "partial",
            views=panorama_views,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze/path", response_model=VisionAnalysisResponse)
async def analyze_image_by_path(
    image_path: str,
    request: VisionAnalysisRequest,
    vision_client: VisionModelClient = Depends(get_vision_client),
    settings: Settings = Depends(get_settings_dep),
    project_id: Optional[str] = Query(None),
    image_id: Optional[str] = Query(None),
    _user: UserResponse = Depends(get_current_user),
):
    """
    Analyze an image from a local path.

    Optionally pass project_id and image_id query params to persist masks.
    """
    # Guard against path traversal: only allow images under the app's own
    # directory tree (temp/uploads, data, outputs all live under base_dir).
    # Without this, an authenticated caller could read ANY file on disk
    # (e.g. secrets, /etc/passwd) via a crafted image_path. We resolve first
    # (collapsing `..` and symlinks) and require containment, then use the
    # resolved path for the existence check + analysis to avoid TOCTOU.
    try:
        resolved_path = Path(image_path).resolve()
        resolved_path.relative_to(settings.base_dir.resolve())
    except (ValueError, OSError):
        raise HTTPException(
            status_code=403,
            detail="image_path must be inside the application directory",
        )
    if not resolved_path.exists():
        raise HTTPException(status_code=404, detail=f"Image not found: {image_path}")
    image_path = str(resolved_path)

    # Validate parameters
    valid, error = vision_client.validate_parameters(
        request.semantic_classes,
        request.semantic_countability,
        request.openness_list,
    )
    if not valid:
        raise HTTPException(status_code=400, detail=error)

    # Call Vision API
    result = await vision_client.analyze_image(image_path, request)

    # Persist masks if project context provided
    if project_id and image_id and result.status == "success" and result.images:
        saved = await _save_masks_to_project(result, project_id, image_id, settings)
        if saved:
            result.mask_paths = saved
            projects_store = get_projects_store()
            project = projects_store.get(project_id)
            if project:
                for img in project.uploaded_images:
                    if img.image_id == image_id:
                        img.mask_filepaths.update(saved)
                        break
                projects_store.save(project)

    return result


@router.post("/analyze/project-image", response_model=VisionAnalysisResponse)
async def analyze_project_image(
    project_id: str = Query(...),
    image_id: str = Query(...),
    request: VisionAnalysisRequest = Body(...),
    vision_client: VisionModelClient = Depends(get_vision_client),
    settings: Settings = Depends(get_settings_dep),
    _user: UserResponse = Depends(get_current_user),
):
    """
    Analyze a project image and persist masks to the project.

    Looks up the image from the in-memory project store, runs vision analysis,
    saves masks to disk, and updates the image's mask_filepaths.
    """
    logger.info("analyze_project_image called: project_id=%s image_id=%s filepath=%s",
                project_id, image_id, getattr(request, 'image_id', ''))
    projects_store = get_projects_store()
    project = projects_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    # Find image
    img = None
    for i in project.uploaded_images:
        if i.image_id == image_id:
            img = i
            break
    if not img:
        raise HTTPException(status_code=404, detail=f"Image not found: {image_id}")

    from app.db.path_resolver import resolve_to_container
    resolved_filepath = resolve_to_container(img.filepath)
    if not resolved_filepath.exists():
        raise HTTPException(status_code=404, detail=f"Image file not found on disk: {img.filepath}")

    # Validate parameters
    logger.info(
        "analyze_project_image: project=%s image=%s classes=%d countability=%d openness=%d",
        project_id, image_id,
        len(request.semantic_classes), len(request.semantic_countability), len(request.openness_list),
    )
    valid, error = vision_client.validate_parameters(
        request.semantic_classes,
        request.semantic_countability,
        request.openness_list,
    )
    if not valid:
        logger.warning("validate_parameters failed: %s", error)
        raise HTTPException(status_code=400, detail=error)

    # Name the Vision API's output folder after the original image (its
    # filename stem) instead of the internal UUID, so AI_City_View's
    # outputs/<name>/ is human-readable. Falls back to the UUID when the
    # record somehow has no filename. Only affects the upstream folder name;
    # greensvc's own mask storage still keys on image_id.
    request.image_id = Path(img.filename).stem if img.filename else image_id

    # Call Vision API
    result = await vision_client.analyze_image(str(resolved_filepath), request)

    # Save masks to disk and link to project image
    if result.status == "success" and result.images:
        saved = await _save_masks_to_project(result, project_id, image_id, settings)
        img.mask_filepaths.update(saved)
        projects_store.save(project)
        result.mask_paths = saved
        logger.info("Saved %d masks for project %s image %s", len(saved), project_id, image_id)

    return result


@router.post("/analyze/project-image/panorama", response_model=PanoramaAnalysisResponse)
async def analyze_project_image_panorama(
    project_id: str = Query(...),
    image_id: str = Query(...),
    request: VisionAnalysisRequest = Body(...),
    vision_client: VisionModelClient = Depends(get_vision_client),
    settings: Settings = Depends(get_settings_dep),
    _user: UserResponse = Depends(get_current_user),
):
    """
    Analyze a project image as a panorama (split into left/front/right views).
    Each view produces its own set of masks saved under {image_id}_{view}/.
    """
    logger.info("analyze_project_image_panorama: project_id=%s image_id=%s", project_id, image_id)
    projects_store = get_projects_store()
    project = projects_store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    img = None
    for i in project.uploaded_images:
        if i.image_id == image_id:
            img = i
            break
    if not img:
        raise HTTPException(status_code=404, detail=f"Image not found: {image_id}")

    from app.db.path_resolver import resolve_to_container
    resolved_filepath = resolve_to_container(img.filepath)
    if not resolved_filepath.exists():
        raise HTTPException(status_code=404, detail=f"Image file not found on disk: {img.filepath}")

    valid, error = vision_client.validate_parameters(
        request.semantic_classes,
        request.semantic_countability,
        request.openness_list,
    )
    if not valid:
        raise HTTPException(status_code=400, detail=error)

    # v4.x — Honor the user's "Views for downstream analysis" picker. If the
    # project carries a non-empty `active_panorama_views`, restrict to those
    # views only: don't save unselected views' masks to disk and don't put
    # their entries in `img.mask_filepaths`. Empty/missing falls back to the
    # legacy behaviour of saving all three views (so non-panorama callers and
    # older projects that pre-date the picker keep working unchanged).
    #
    # NOTE on the upstream API cost: the Vision API's panorama endpoint
    # always processes all three view crops in one call — there's no
    # "process only these views" parameter on its side. We DO still pay for
    # those crops upstream; what changes here is that we discard the
    # unselected views' outputs instead of persisting them to disk + the
    # project record + the downstream pipeline. From the user's perspective
    # (Vision Analysis preview, mask ZIP, indicator/clustering/report
    # pipeline, AI report), the unselected views simply don't exist.
    allowed_views = set(project.active_panorama_views or []) or {"left", "front", "right"}
    skipped_views: list[str] = []

    # Name each view's Vision API output folder after the original image
    # (<stem>_<view>) instead of the internal UUID, so AI_City_View's
    # outputs/ is human-readable. AI_City_View appends _<view> per crop.
    # Only affects the upstream folder name; greensvc's own per-view mask
    # storage still keys on the UUID image_id (view_image_id below).
    request.image_id = Path(img.filename).stem if img.filename else image_id

    views_result = await vision_client.analyze_panorama(str(resolved_filepath), request)

    panorama_views: dict[str, PanoramaViewResult] = {}
    for view_name, view_response in views_result.items():
        if view_name not in allowed_views:
            skipped_views.append(view_name)
            continue
        if view_response.status == "success" and view_response.images:
            view_image_id = f"{image_id}_{view_name}"
            saved = await _save_masks_to_project(view_response, project_id, view_image_id, settings)
            img.mask_filepaths.update({f"{view_name}_{k}": v for k, v in saved.items()})
            panorama_views[view_name] = PanoramaViewResult(
                status="success",
                mask_paths=saved,
                statistics=view_response.statistics,
                processing_time=view_response.processing_time,
            )
        else:
            panorama_views[view_name] = PanoramaViewResult(
                status="error",
                error=view_response.error or "View analysis failed",
            )

    # Cleanup pass — if a view used to be selected and got processed in a
    # previous run, but the user has since unchecked it, purge its stale
    # entries from `mask_filepaths` (and the on-disk PNGs) so the project
    # record reflects the current selection. Without this, a user who
    # processed all three views then unchecks Front would still see Front's
    # masks lingering in the preview, the ZIP download, and the per-view
    # bucket.
    stale_keys = [k for k in list(img.mask_filepaths.keys())
                  for v in (k.split("_", 1),)
                  if len(v) == 2 and v[0] in ("left", "front", "right") and v[0] not in allowed_views]
    for key in stale_keys:
        stale_path = img.mask_filepaths.pop(key, None)
        if stale_path:
            try:
                Path(stale_path).unlink(missing_ok=True)
            except Exception as e:
                logger.warning("Failed to unlink stale mask %s: %s", stale_path, e)
    if stale_keys:
        logger.info(
            "Purged %d stale mask entries for unchecked panorama views on image %s: %s",
            len(stale_keys), image_id, sorted(set(k.split("_", 1)[0] for k in stale_keys)),
        )
    if skipped_views:
        logger.info(
            "Skipped saving %d unchecked panorama views for image %s: %s",
            len(skipped_views), image_id, sorted(skipped_views),
        )

    projects_store.save(project)

    all_success = all(v.status == "success" for v in panorama_views.values())
    return PanoramaAnalysisResponse(
        status="success" if all_success else "partial",
        views=panorama_views,
    )


@router.post("/batch", response_model=list[VisionAnalysisResponse])
async def batch_analyze(
    image_paths: list[str],
    request: VisionAnalysisRequest,
    vision_client: VisionModelClient = Depends(get_vision_client),
    _user: UserResponse = Depends(get_current_user),
):
    """Analyze multiple images"""
    # Validate all images exist
    missing = [p for p in image_paths if not Path(p).exists()]
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Images not found: {missing[:5]}..."
        )

    # Validate parameters
    valid, error = vision_client.validate_parameters(
        request.semantic_classes,
        request.semantic_countability,
        request.openness_list,
    )
    if not valid:
        raise HTTPException(status_code=400, detail=error)

    results = await vision_client.batch_analyze(image_paths, request)
    return results


@router.get("/health")
async def vision_health(
    vision_client: VisionModelClient = Depends(get_vision_client),
):
    """Check Vision API health"""
    healthy = await vision_client.check_health()
    return {"healthy": healthy, "url": vision_client.base_url}
