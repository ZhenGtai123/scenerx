"""Project-related Pydantic models"""

from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, Field


class SpatialZoneCreate(BaseModel):
    """Schema for creating a spatial zone"""
    zone_id: str = ""
    zone_name: str
    zone_types: list[str] = Field(default_factory=list)
    area: Optional[float] = None
    status: str = "existing"
    description: str = ""


class SpatialZone(BaseModel):
    """Spatial zone within a project"""
    zone_id: str
    zone_name: str
    zone_types: list[str] = Field(default_factory=list)
    area: Optional[float] = None
    status: str = "existing"
    description: str = ""


class SpatialRelation(BaseModel):
    """Spatial relation between zones"""
    from_zone: str
    to_zone: str
    relation_type: str
    direction: str = "single"


class UploadedImage(BaseModel):
    """Uploaded image metadata"""
    image_id: str
    filename: str
    filepath: str
    zone_id: Optional[str] = None
    has_gps: bool = False
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    metrics_results: dict[str, Optional[float]] = Field(default_factory=dict)
    mask_filepaths: dict[str, str] = Field(default_factory=dict)
    # 25 keys from Vision API (HEX_IMAGE_KEYS):
    #   Base (5): semantic_map, depth_map, openness_map, fmb_map, original
    #   FMB masks (3): foreground_map, middleground_map, background_map
    #   Cross-products (5×3=15): {semantic,depth,openness,original,fmb}_{foreground,middleground,background}
    #   Extra (2): sky_mask, semantic_raw


class ProjectCreate(BaseModel):
    """Schema for creating a new project"""
    project_name: str
    project_location: str = ""
    site_scale: str = ""
    project_phase: str = ""

    # Site Context
    koppen_zone_id: str = ""
    country_id: str = ""
    space_type_id: str = ""
    lcz_type_id: str = ""
    age_group_id: str = ""

    # Performance Goals
    design_brief: str = ""
    performance_dimensions: list[str] = Field(default_factory=list)
    subdimensions: list[str] = Field(default_factory=list)

    # Spatial data (optional on create)
    spatial_zones: list[SpatialZoneCreate] = Field(default_factory=list)
    spatial_relations: list[SpatialRelation] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    """Schema for updating an existing project"""
    project_name: Optional[str] = None
    project_location: Optional[str] = None
    site_scale: Optional[str] = None
    project_phase: Optional[str] = None
    koppen_zone_id: Optional[str] = None
    country_id: Optional[str] = None
    space_type_id: Optional[str] = None
    lcz_type_id: Optional[str] = None
    age_group_id: Optional[str] = None
    design_brief: Optional[str] = None
    performance_dimensions: Optional[list[str]] = None
    subdimensions: Optional[list[str]] = None
    spatial_zones: Optional[list[SpatialZoneCreate]] = None
    spatial_relations: Optional[list[SpatialRelation]] = None
    # Panorama view scoping — see ProjectResponse for full semantics.
    active_panorama_views: Optional[list[str]] = None
    active_panorama_view: Optional[str] = None


class ProjectResponse(BaseModel):
    """Schema for project response"""
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    # Basic info
    project_name: str
    project_location: str = ""
    site_scale: str = ""
    project_phase: str = ""

    # Site Context
    koppen_zone_id: str = ""
    country_id: str = ""
    space_type_id: str = ""
    lcz_type_id: str = ""
    age_group_id: str = ""

    # Performance Goals
    design_brief: str = ""
    performance_dimensions: list[str] = Field(default_factory=list)
    subdimensions: list[str] = Field(default_factory=list)

    # Spatial data
    spatial_zones: list[SpatialZone] = Field(default_factory=list)
    spatial_relations: list[SpatialRelation] = Field(default_factory=list)
    uploaded_images: list[UploadedImage] = Field(default_factory=list)

    # Persisted analysis artefacts. Stored as raw dicts so this module stays
    # decoupled from the (much larger) analysis model graph; the pipeline
    # already produces these via model_dump(mode="json") and the frontend
    # consumes them via its own TypeScript types.
    #
    # Stage 1 (LLM indicator recommendations + user's selected subset).
    # Stored on the project so a returning user — possibly in a different
    # browser — sees the same selection that drove their pipeline run.
    stage1_recommendations: list[dict[str, Any]] = Field(default_factory=list)
    stage1_relationships: list[dict[str, Any]] = Field(default_factory=list)
    stage1_summary: Optional[dict[str, Any]] = None
    selected_indicators: list[dict[str, Any]] = Field(default_factory=list)
    # Stage 2.5 / Stage 3 / AI report.
    zone_analysis_result: Optional[dict[str, Any]] = None
    design_strategy_result: Optional[dict[str, Any]] = None
    # Legacy single-slot fields. Kept for backward compat with old project
    # rows that pre-date the per-view split below — read at hydration as a
    # fallback into the 'zones' slot. New writes go through ai_reports.
    ai_report: Optional[str] = None
    ai_report_meta: Optional[dict[str, Any]] = None
    # v4 / Module 12 — per-view AI reports. The Reports page can be
    # toggled between zones view (original user zones) and clusters view
    # (cluster-as-zone payload). Each view gets its own independently
    # generated narrative report. Keys are 'zones' or 'clusters'.
    ai_reports: dict[str, Optional[str]] = Field(default_factory=dict)
    ai_report_metas: dict[str, Optional[dict[str, Any]]] = Field(default_factory=dict)
    # v4 / Module 14 — per-view design strategies (parallel to ai_reports).
    # In Option C the user can toggle Strategies tab between zones-derived
    # and clusters-derived strategies; each must persist independently so
    # toggling doesn't lose work. ``design_strategy_result`` (legacy) still
    # mirrors whichever slot was last written, for backward compat with
    # older clients.
    design_strategy_results: dict[str, Optional[dict[str, Any]]] = Field(default_factory=dict)
    analysis_results_updated_at: Optional[datetime] = None

    # v4.x — Panorama per-view pipeline scoping.
    # `active_panorama_views` is the user's choice in Vision Analysis of which
    # panorama views (subset of ["left", "front", "right"]) participate in
    # downstream indicator / clustering / report runs. Empty list means the
    # project is not in panorama mode and runs the legacy single-view path
    # unchanged. When non-empty, each selected view is treated as an
    # INDEPENDENT report: the pipeline runs once per view with that view's
    # masks aliased to the standard `semantic_map` slot, and the result is
    # persisted under `panorama_view_results[view]`.
    #
    # `active_panorama_view` is the view the user is currently looking at on
    # the Reports page. The pipeline mirrors `panorama_view_results[view]`
    # back into the legacy top-level slots (zone_analysis_result,
    # ai_reports, design_strategy_results, …) so the existing Reports
    # rendering path keeps working without per-component changes.
    active_panorama_views: list[str] = Field(default_factory=list)
    active_panorama_view: Optional[str] = None
    # Per-view full result bucket. Schema of each value mirrors the legacy
    # top-level slots: {
    #   "zone_analysis_result": dict | None,
    #   "ai_reports": {viewId → str},
    #   "ai_report_metas": {viewId → dict},
    #   "design_strategy_results": {viewId → dict},
    #   "selected_indicators": list[dict],
    #   "analysis_results_updated_at": isoformat str | None,
    # }
    # Stored as opaque dicts to avoid coupling project.py to the larger
    # analysis-model graph (same reasoning as zone_analysis_result above).
    panorama_view_results: dict[str, dict[str, Any]] = Field(default_factory=dict)


class ProjectQuery(BaseModel):
    """Full project query for export/API calls"""
    query_metadata: dict = Field(default_factory=dict)
    project: dict = Field(default_factory=dict)
    context: dict = Field(default_factory=dict)
    performance_query: dict = Field(default_factory=dict)
    spatial_zones: list[dict] = Field(default_factory=list)
    site_photos: dict = Field(default_factory=dict)

    @classmethod
    def from_project(cls, project: ProjectResponse) -> "ProjectQuery":
        """Create ProjectQuery from ProjectResponse"""
        return cls(
            query_metadata={
                "query_version": "2.0",
                "generated_at": datetime.now().isoformat(),
                "system": "SceneRx-AI"
            },
            project={
                "name": project.project_name,
                "location": project.project_location or None
            },
            context={
                "climate": {"koppen_zone_id": project.koppen_zone_id},
                "urban_form": {
                    "space_type_id": project.space_type_id,
                    "lcz_type_id": project.lcz_type_id or None
                },
                "user": {"age_group_id": project.age_group_id or None},
                "country_id": project.country_id or None
            },
            performance_query={
                "design_brief": project.design_brief or None,
                "dimensions": project.performance_dimensions,
                "subdimensions": project.subdimensions
            },
            spatial_zones=[
                {
                    "zone_id": z.zone_id,
                    "zone_name": z.zone_name,
                    "zone_types": z.zone_types,
                    "description": z.description
                }
                for z in project.spatial_zones
            ],
            site_photos={
                "total_images": len(project.uploaded_images),
                "grouped_images": len([i for i in project.uploaded_images if i.zone_id]),
            }
        )
