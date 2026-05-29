"""Pydantic models for Stage 2.5 + Stage 3 analysis pipeline"""

from typing import Optional, Any, Literal
from pydantic import BaseModel, Field
from datetime import datetime


# ---------------------------------------------------------------------------
# Shared literal types
# ---------------------------------------------------------------------------

# #19 — single source of truth for the grouping-mode literal. Mirrors the
# frontend `GroupingMode` in packages/frontend/src/types/index.ts so the
# wire format on both sides is locked to the same set of values. Pydantic
# validates incoming requests against this; an unknown value yields a 422
# instead of silently falling back to "zones".
GroupingMode = Literal["zones", "clusters"]


# ---------------------------------------------------------------------------
# Shared / Input helpers
# ---------------------------------------------------------------------------

class IndicatorDefinitionInput(BaseModel):
    """Indicator definition provided by the caller (from calculator INDICATOR dict or codebook)."""
    id: str
    name: str
    unit: str = ""
    target_direction: str = "INCREASE"  # INCREASE | DECREASE | NEUTRAL
    definition: str = ""
    category: str = ""


class IndicatorLayerValue(BaseModel):
    """Flat record: one zone x one indicator x one layer."""
    zone_id: str
    zone_name: str
    indicator_id: str
    layer: str  # full | foreground | middleground | background
    n_images: int = 0
    mean: Optional[float] = None
    std: Optional[float] = None
    min: Optional[float] = None
    max: Optional[float] = None
    unit: str = ""
    area_sqm: float = 0


# ---------------------------------------------------------------------------
# Stage 2 v7.0  --  Image-level + Statistical enrichment
# (must precede ZoneAnalysisRequest which references ImageRecord)
# ---------------------------------------------------------------------------

class ImageRecord(BaseModel):
    """One image × one indicator × one layer measurement (long-format)."""
    image_id: str
    zone_id: str = ""
    zone_name: str = ""
    indicator_id: str
    layer: str  # full | foreground | middleground | background
    value: float
    lat: Optional[float] = None
    lng: Optional[float] = None


class GlobalIndicatorStats(BaseModel):
    """Per-indicator global descriptive statistics (Table M2 / S2).

    Includes per-layer Mean/Std/N, CV, and statistical test results.
    """
    indicator_id: str
    indicator_name: str = ""
    unit: str = ""
    target_direction: str = "INCREASE"
    # Per-layer breakdown: {layer: {N, Mean, Std, Min, Max}}
    by_layer: dict[str, dict[str, Optional[float]]] = Field(default_factory=dict)
    # Coefficient of variation (full layer, %)
    cv_full: Optional[float] = None
    # Shapiro-Wilk normality test on full-layer image values
    shapiro_w: Optional[float] = None
    shapiro_p: Optional[float] = None
    # Kruskal-Wallis test comparing the 4 layers
    kruskal_h: Optional[float] = None
    kruskal_p: Optional[float] = None


class DataQualityRow(BaseModel):
    """Per-indicator data quality diagnostics (Table M4 / S4)."""
    indicator_id: str
    total_images: int = 0
    fg_coverage_pct: Optional[float] = None
    mg_coverage_pct: Optional[float] = None
    bg_coverage_pct: Optional[float] = None
    is_normal: Optional[bool] = None  # Shapiro p > 0.05
    correlation_method: str = "pearson"  # pearson | spearman


# ---------------------------------------------------------------------------
# Stage 2.5  --  Zone Analysis
# ---------------------------------------------------------------------------

class ZoneAnalysisRequest(BaseModel):
    """Request for Stage 2.5 cross-zone statistical analysis (v7.0 descriptive)."""
    indicator_definitions: dict[str, IndicatorDefinitionInput]
    zone_statistics: list[IndicatorLayerValue]
    # v7.0: image-level records for statistical tests / figures
    image_records: list[ImageRecord] = Field(default_factory=list)


class EnrichedZoneStat(BaseModel):
    """Zone stat record enriched with Z-score and percentile (v6.0 descriptive)."""
    zone_id: str
    zone_name: str
    indicator_id: str
    layer: str
    unit: str = ""
    n_images: int = 0
    mean: Optional[float] = None
    std: Optional[float] = None
    min: Optional[float] = None
    max: Optional[float] = None
    area_sqm: float = 0
    z_score: Optional[float] = None
    percentile: Optional[float] = None


class ZoneDiagnostic(BaseModel):
    """Diagnostic summary for one zone (v6.0 descriptive — no evaluative fields)."""
    zone_id: str
    zone_name: str
    area_sqm: float = 0
    mean_abs_z: float = 0.0  # descriptive deviation measure
    rank: int = 0  # 1 = most distinctive (highest mean|z|)
    point_count: int = 0
    indicator_status: dict[str, dict[str, Any]] = Field(default_factory=dict)


class ComputationMetadata(BaseModel):
    """Metadata about the Stage 2.5 computation."""
    version: str = "2.5"
    generated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    system: str = "SceneRx-AI Stage 2.5"
    n_indicators: int = 0
    n_zones: int = 0
    n_segments: int = 0
    layers: list[str] = Field(default_factory=lambda: ["full", "foreground", "middleground", "background"])
    has_spatial_data: bool = False
    has_clustering: bool = False
    # Non-fatal warnings surfaced to the UI
    warnings: list[str] = Field(default_factory=list)


class ArchetypeProfile(BaseModel):
    """Profile for one KMeans cluster archetype."""
    archetype_id: int
    archetype_label: str = ""
    point_count: int = 0
    centroid_values: dict[str, float] = Field(default_factory=dict)
    centroid_z_scores: dict[str, float] = Field(default_factory=dict)


class SpatialSegment(BaseModel):
    """A spatial segment: one cluster of geo-located image points."""
    segment_id: str
    archetype_id: int
    archetype_label: str = ""
    point_count: int = 0
    point_ids: list[str] = Field(default_factory=list)
    lat_range: list[float] = Field(default_factory=list)
    lng_range: list[float] = Field(default_factory=list)
    centroid_indicators: dict[str, float] = Field(default_factory=dict)
    centroid_z_scores: dict[str, float] = Field(default_factory=dict)
    silhouette_score: float = 0.0


class ClusteringResult(BaseModel):
    """Full clustering output: method, archetypes, spatial segments."""
    method: str = "KMeans + KNN spatial smoothing"
    k: int = 0
    silhouette_score: float = 0.0
    silhouette_scores: list[dict] = Field(default_factory=list)  # [{k, silhouette}, ...]
    spatial_smooth_k: int = 7
    layer_used: str = "full"
    archetype_profiles: list[ArchetypeProfile] = Field(default_factory=list)
    spatial_segments: list[SpatialSegment] = Field(default_factory=list)
    # Per-point data (for before/after-smoothing spatial scatter + future viz)
    point_ids_ordered: list[str] = Field(default_factory=list)
    point_lats: list[float] = Field(default_factory=list)
    point_lngs: list[float] = Field(default_factory=list)
    labels_raw: list[int] = Field(default_factory=list)  # labels before KNN smoothing
    labels_smoothed: list[int] = Field(default_factory=list)  # labels after KNN smoothing
    # Ward hierarchical clustering linkage matrix (for dendrogram). Rows: [id1, id2, dist, count].
    dendrogram_linkage: list[list[float]] = Field(default_factory=list)
    # ── HDBSCAN-specific fields (v6.1) ──
    # Per-cluster persistence (HDBSCAN stability under density variation).
    # Higher = more robust cluster. Map: cluster_id (str) → score.
    cluster_persistence: dict[str, float] = Field(default_factory=dict)
    # Per-point silhouette coefficient (against final labels, noise → None).
    silhouette_per_point: list[Optional[float]] = Field(default_factory=list)
    # Number of points HDBSCAN labelled as noise (-1) before reassignment.
    noise_count: int = 0
    noise_point_ids: list[str] = Field(default_factory=list)
    # HDBSCAN condensed-tree edges for D3 visualization.
    # Each edge: {parent: int, child: int, lambda_val: float, child_size: int}.
    condensed_tree: list[dict] = Field(default_factory=list)
    # ── v6.2 — cluster-validity diagnostics (tendency · gap · stability) ──
    # Hopkins clustering-tendency on the standardised feature matrix:
    # ~0.5 = no structure (uniform cloud), → 1.0 = strong cluster structure.
    hopkins_statistic: Optional[float] = None
    # Tibshirani gap statistic per k: [{k, gap, s_k, is_selected}].
    # Independent K-validity criterion; does not override the chosen k.
    gap_statistic: list[dict] = Field(default_factory=list)
    # Hennig bootstrap stability: cluster_id (str) → mean Jaccard over
    # bootstrap resamples. ≥0.85 highly stable, 0.75-0.85 stable,
    # 0.60-0.75 a pattern, <0.60 unstable / dissolved.
    cluster_stability: dict[str, float] = Field(default_factory=dict)
    cluster_stability_method: str = ""


class ZoneAnalysisResult(BaseModel):
    """Complete result of Stage 2.5 zone analysis (v7.0)."""
    zone_statistics: list[EnrichedZoneStat] = Field(default_factory=list)
    zone_diagnostics: list[ZoneDiagnostic] = Field(default_factory=list)
    correlation_by_layer: dict[str, dict[str, dict[str, float]]] = Field(default_factory=dict)
    pvalue_by_layer: dict[str, dict[str, dict[str, float]]] = Field(default_factory=dict)
    indicator_definitions: dict[str, IndicatorDefinitionInput] = Field(default_factory=dict)
    layer_statistics: dict[str, dict] = Field(default_factory=dict)
    radar_profiles: dict[str, dict[str, float]] = Field(default_factory=dict)
    radar_profiles_by_layer: dict[str, dict[str, dict[str, float]]] = Field(default_factory=dict)
    computation_metadata: ComputationMetadata = Field(default_factory=ComputationMetadata)
    # Clustering (optional — requires geo-located image points with ≥20 data points)
    segment_diagnostics: list[ZoneDiagnostic] = Field(default_factory=list)
    clustering: Optional[ClusteringResult] = None
    # ── v7.0 additions ──
    # Image-level records (long-format, for violin/scatter/direction figures)
    image_records: list[ImageRecord] = Field(default_factory=list)
    # Per-indicator global statistics with statistical tests (Table M2)
    global_indicator_stats: list[GlobalIndicatorStats] = Field(default_factory=list)
    # Data quality diagnostics (Table M4)
    data_quality: list[DataQualityRow] = Field(default_factory=list)
    # Statistical sample unit:
    #   "zone_level"  — zones (or sub-zones from clustering) are samples; n_zones≥2
    #   "image_level" — image records are samples; used when n_zones<2 or by user opt-in
    analysis_mode: str = "zone_level"
    # Where the zones came from. Display-only metadata; does not affect compute path.
    #   "user"    — zones defined in the project wizard
    #   "cluster" — sub-zones derived from clustering (treated as zones for stats)
    #   None      — irrelevant when analysis_mode == "image_level"
    zone_source: Optional[str] = "user"


# ---------------------------------------------------------------------------
# Stage 3  --  Design Strategies
# ---------------------------------------------------------------------------

class ProjectContext(BaseModel):
    """Project context passed to the design engine."""
    project: dict = Field(default_factory=dict)
    context: dict = Field(default_factory=dict)
    performance_query: dict = Field(default_factory=dict)


class IOMQuery(BaseModel):
    """A single IOM query derived from diagnosis."""
    indicator_id: str
    direction: str  # increase | decrease | maintain
    direction_rationale: str = ""  # v6.0: why this direction
    priority: int = 1
    qualitative_target: str = ""
    constraints: list[str] = Field(default_factory=list)


class MatchedIOM(BaseModel):
    """An IOM record matched to a query, with score and expanded encodings."""
    iom_id: Optional[str] = None
    indicator_id: str = ""
    indicator_name: str = ""
    direction: str = ""
    score: float = 0
    linked_evidence_id: Optional[str] = None
    operation: dict = Field(default_factory=dict)
    predicted_effect: dict = Field(default_factory=dict)
    confidence_expanded: dict = Field(default_factory=dict)
    source_indicator: dict = Field(default_factory=dict)
    # v5.0 — signature-based matching
    signatures: list[dict] = Field(default_factory=list)
    scope: dict = Field(default_factory=dict)
    transferability: dict = Field(default_factory=dict)
    is_descriptive: bool = False
    source_citation: Optional[str] = None


class DesignStrategy(BaseModel):
    """One design strategy for a zone."""
    priority: int = 1
    strategy_name: Optional[str] = ""
    target_indicators: list[str] = Field(default_factory=list)
    spatial_location: Optional[str] = ""
    intervention: dict = Field(default_factory=dict)
    expected_effects: list[dict] = Field(default_factory=list)
    confidence: Optional[str] = ""
    potential_tradeoffs: Optional[str] = ""
    supporting_ioms: list[str] = Field(default_factory=list)
    # v5.0 — signature & evidence detail
    signatures: list[dict] = Field(default_factory=list)
    pathway: dict = Field(default_factory=dict)
    boundary_effects: Optional[str] = None
    transferability_note: Optional[str] = None
    implementation_guidance: Optional[str] = None


class ZoneDesignOutput(BaseModel):
    """Full design output for a single zone (v6.0)."""
    zone_id: str
    zone_name: str = ""
    mean_abs_z: float = 0.0  # v6.0: descriptive deviation
    diagnosis: dict = Field(default_factory=dict)  # v6.0: Agent A's diagnosis + iom_queries
    overall_assessment: str = ""
    matched_ioms: list[MatchedIOM] = Field(default_factory=list)
    design_strategies: list[DesignStrategy] = Field(default_factory=list)
    implementation_sequence: str = ""
    synergies: str = ""


class DesignStrategyRequest(BaseModel):
    """Request for Stage 3 design strategy generation."""
    zone_analysis: ZoneAnalysisResult
    project_context: ProjectContext = Field(default_factory=ProjectContext)
    allowed_indicator_ids: list[str] = Field(default_factory=list)
    use_llm: bool = True
    max_ioms_per_query: int = Field(default=6, ge=1, le=20)
    max_strategies_per_zone: int = Field(default=5, ge=1, le=10)
    # #3 — minimum strategies per grouping unit. DesignEngine retries the
    # LLM once when the first response is short, then pads with rule-based
    # fallbacks (marked fallback=true in the unit's diagnosis dict).
    min_strategies_per_zone: int = Field(default=3, ge=1, le=10)
    # 6.A — Stage 2 chart captions piped into Agent A's diagnosis prompt.
    # Shape: {zone_id: {chart_id: caption_text}}. zone_id "_global" carries
    # captions for charts that aren't per-zone (correlation, distribution, ...).
    analysis_narratives: dict[str, dict[str, str]] = Field(default_factory=dict)
    # When set, the resulting strategies are persisted onto the project so
    # they survive page reloads and project switches.
    project_id: Optional[str] = None
    # v4 / Module 14 — the grouping mode this request is being generated
    # against. Persisted into ``project.design_strategy_results[mode]`` so
    # the Strategies tab on the Reports page can swap between zones-derived
    # and clusters-derived strategies in Option C, parallel to the
    # per-view AI report behaviour.
    grouping_mode: GroupingMode = "zones"
    # v4 / Phase C — multi-view extension. When provided, this is the
    # full view id the request belongs to (e.g., "parent_zones",
    # "within_zone:zone_3"). The backend uses view_id (when set) as the
    # slot key in project.design_strategy_results; otherwise it falls
    # back to grouping_mode for backward compat with old clients. The
    # Stage 3 prompt itself still uses grouping_mode (which the frontend
    # collapses cluster-derived viewIds back to 'clusters' for) so the
    # LLM keeps its existing single-zone vs multi-zone branching logic.
    view_id: Optional[str] = None


class DesignStrategyResult(BaseModel):
    """Complete result of Stage 3 design strategy generation."""
    zones: dict[str, ZoneDesignOutput] = Field(default_factory=dict)
    metadata: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Agent C  --  Report Generation
# ---------------------------------------------------------------------------

class ReportRequest(BaseModel):
    """Request for comprehensive report generation (Agent C)."""
    zone_analysis: ZoneAnalysisResult
    design_strategies: Optional[DesignStrategyResult] = None
    stage1_recommendations: Optional[list[dict]] = None
    project_context: ProjectContext = Field(default_factory=ProjectContext)
    format: str = "markdown"  # markdown | pdf
    # When set, the generated report content + metadata are persisted onto
    # the project so they survive page reloads and project switches.
    project_id: Optional[str] = None
    # The grouping mode the request is being generated against. Persisted
    # into ai_report_meta so hydrateFromProject can drop a stale report
    # whose mode no longer matches the user's active view.
    grouping_mode: GroupingMode = "zones"
    # v4 / Phase C — full view id for multi-view persistence. Same role
    # as DesignStrategyRequest.view_id above: takes precedence over
    # grouping_mode for the slot key, falls back when absent.
    view_id: Optional[str] = None


class ReportResult(BaseModel):
    """Generated report output."""
    content: str = ""
    format: str = "markdown"
    metadata: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Full pipeline (chained)
# ---------------------------------------------------------------------------

class FullAnalysisRequest(BaseModel):
    """Request that chains Stage 2.5 + Stage 3."""
    indicator_definitions: dict[str, IndicatorDefinitionInput]
    zone_statistics: list[IndicatorLayerValue]
    project_context: ProjectContext = Field(default_factory=ProjectContext)
    allowed_indicator_ids: list[str] = Field(default_factory=list)
    use_llm: bool = True
    max_ioms_per_query: int = Field(default=6, ge=1, le=20)
    max_strategies_per_zone: int = Field(default=5, ge=1, le=10)


class FullAnalysisResult(BaseModel):
    """Combined result of Stage 2.5 + Stage 3."""
    zone_analysis: ZoneAnalysisResult
    design_strategies: DesignStrategyResult


# ---------------------------------------------------------------------------
# Project Pipeline (images → calculators → aggregation → analysis)
# ---------------------------------------------------------------------------

class ProjectPipelineRequest(BaseModel):
    """Request for the project pipeline endpoint."""
    project_id: str
    indicator_ids: list[str]
    run_stage3: bool = True
    use_llm: bool = False
    max_ioms_per_query: int = Field(default=6, ge=1, le=20)
    max_strategies_per_zone: int = Field(default=5, ge=1, le=10)
    # v4.x — Panorama per-view scoping. When set to one of
    # ("left", "front", "right"), the pipeline aliases each image's
    # `{view}_semantic_map` / `{view}_depth_map` keys back to the standard
    # `semantic_map` / `depth_map` slots that the existing calculators
    # consume, then persists results into `project.panorama_view_results
    # [panorama_view]` AND mirrors them into the legacy top-level slots
    # (with `project.active_panorama_view` updated to match). When left as
    # None, the legacy single-view path runs unchanged.
    panorama_view: Optional[str] = None


class ProjectPipelineProgress(BaseModel):
    """Progress step in the project pipeline."""
    step: str
    status: str  # completed | skipped | failed
    detail: str = ""


class SkippedImage(BaseModel):
    """An image that was skipped during pipeline calculation."""
    image_id: str
    filename: str
    reason: str  # "no_semantic_map" | "invalid_semantic_map"


class ProjectPipelineResult(BaseModel):
    """Complete result of the project pipeline."""
    project_id: str
    project_name: str
    total_images: int = 0
    zone_assigned_images: int = 0
    calculations_run: int = 0
    calculations_succeeded: int = 0
    calculations_failed: int = 0
    calculations_cached: int = 0
    zone_statistics_count: int = 0
    skipped_images: list[SkippedImage] = Field(default_factory=list)
    zone_analysis: Optional[ZoneAnalysisResult] = None
    design_strategies: Optional[DesignStrategyResult] = None
    steps: list[ProjectPipelineProgress] = Field(default_factory=list)
