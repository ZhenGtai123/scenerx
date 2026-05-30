// ---------------------------------------------------------------------------
// #8.1 — single source of truth for the grouping mode literal. Imported by
// the store, hooks, api client, and any chart/export utility that has to
// decide which dataset (zone-level vs. cluster-derived) to use.
// ---------------------------------------------------------------------------
export type GroupingMode = 'zones' | 'clusters';
export const GROUPING_MODES: readonly GroupingMode[] = ['zones', 'clusters'];

// Project types
export interface SpatialZone {
  zone_id: string;
  zone_name: string;
  zone_types: string[];
  area?: number;
  status?: string;
  description: string;
}

export interface SpatialRelation {
  from_zone: string;
  to_zone: string;
  relation_type: string;
  direction?: string;
}

export interface UploadedImage {
  image_id: string;
  filename: string;
  filepath: string;
  zone_id: string | null;
  has_gps: boolean;
  latitude: number | null;
  longitude: number | null;
  metrics_results: Record<string, number | null>;
  mask_filepaths: Record<string, string>;
}

export interface Project {
  id: string;
  project_name: string;
  project_location: string;
  site_scale: string;
  project_phase: string;
  koppen_zone_id: string;
  country_id: string;
  space_type_id: string;
  lcz_type_id: string;
  age_group_id: string;
  design_brief: string;
  performance_dimensions: string[];
  subdimensions: string[];
  created_at: string;
  updated_at?: string;
  spatial_zones: SpatialZone[];
  spatial_relations: SpatialRelation[];
  uploaded_images: UploadedImage[];

  // Persisted analysis artefacts (server-side source of truth — survive
  // reloads and project switches). Frontend hydrates the Zustand store from
  // these on project mount; localStorage no longer holds them.
  stage1_recommendations?: IndicatorRecommendation[];
  stage1_relationships?: IndicatorRelationship[];
  stage1_summary?: RecommendationSummary | null;
  selected_indicators?: IndicatorRecommendation[];
  zone_analysis_result?: ZoneAnalysisResult | null;
  /** Legacy single-slot design strategies (last view written). Read at
   *  hydration as fallback if `design_strategy_results` is empty. */
  design_strategy_result?: DesignStrategyResult | null;
  /** v4 / Module 14 — per-view design strategies. Keys are 'zones' or
   *  'clusters'; mirrors `ai_reports` so toggling the segmented control
   *  on the Reports page swaps both consistently. */
  design_strategy_results?: Record<string, DesignStrategyResult | null>;
  /** Legacy single-slot AI report (last view written). Read at hydration as
   *  fallback if `ai_reports` doesn't have a 'zones' key. */
  ai_report?: string | null;
  ai_report_meta?: Record<string, unknown> | null;
  /** v4 / Module 12 — per-view AI reports. Keys are 'zones' or 'clusters';
   *  each can be independently generated and persists across sessions. */
  ai_reports?: Record<string, string | null>;
  ai_report_metas?: Record<string, Record<string, unknown> | null>;
  analysis_results_updated_at?: string | null;

  /** v4.x — Panorama per-view scoping. Subset of ["left", "front", "right"]
   *  the user has enabled in Vision Analysis. Empty = project is not in
   *  panorama mode and runs the legacy single-view path unchanged. */
  active_panorama_views?: string[];
  /** v4.x — The panorama view the user is currently viewing on the Reports
   *  page. Backend mirrors `panorama_view_results[active_panorama_view]`
   *  into the legacy top-level slots so existing components work unchanged
   *  per-view; switching this field causes the mirror to flip. */
  active_panorama_view?: string | null;
  /** v4.x — Per-view full result bucket. Each entry mirrors the legacy
   *  top-level slot shape ({ zone_analysis_result, ai_reports,
   *  ai_report_metas, design_strategy_results, analysis_results_updated_at })
   *  so the Reports segmented control can swap views without recomputing. */
  panorama_view_results?: Record<string, Record<string, unknown>>;
}

export interface SpatialZoneCreate {
  zone_id?: string;
  zone_name: string;
  zone_types?: string[];
  area?: number;
  status?: string;
  description?: string;
}

export interface ProjectCreate {
  project_name: string;
  project_location?: string;
  site_scale?: string;
  project_phase?: string;
  koppen_zone_id?: string;
  country_id?: string;
  space_type_id?: string;
  lcz_type_id?: string;
  age_group_id?: string;
  design_brief?: string;
  performance_dimensions?: string[];
  subdimensions?: string[];
  spatial_zones?: SpatialZoneCreate[];
  spatial_relations?: SpatialRelation[];
}

export interface ProjectUpdate {
  project_name?: string;
  project_location?: string;
  site_scale?: string;
  project_phase?: string;
  koppen_zone_id?: string;
  country_id?: string;
  space_type_id?: string;
  lcz_type_id?: string;
  age_group_id?: string;
  design_brief?: string;
  performance_dimensions?: string[];
  subdimensions?: string[];
  spatial_zones?: SpatialZoneCreate[];
  spatial_relations?: SpatialRelation[];
  /** Panorama per-view scoping — see Project for full semantics. */
  active_panorama_views?: string[];
  active_panorama_view?: string | null;
}

// Calculator types
export interface CalculatorInfo {
  id: string;
  name: string;
  unit: string;
  formula: string;
  target_direction: string;
  definition: string;
  category: string;
  calc_type: string;
  target_classes: string[];
  filepath: string;
  filename: string;
}

export interface CalculationResult {
  success: boolean;
  indicator_id: string;
  indicator_name: string;
  value: number | null;
  unit: string;
  target_pixels: number | null;
  total_pixels: number | null;
  class_breakdown: Record<string, number>;
  error: string | null;
  image_path: string;
}

// Indicator types
export interface EvidenceCitation {
  evidence_id: string;
  citation: string;
  year: number | null;
  doi: string;
  direction: string;
  effect_size: string;
  confidence: string;
}

export interface IndicatorRelationship {
  indicator_a: string;
  indicator_b: string;
  relationship_type: string;
  explanation: string;
}

export interface RecommendationSummary {
  key_findings: string[];
  evidence_gaps: string[];
  transferability_caveats?: string[];
  dimension_coverage?: { dimension_id: string; indicator_count: number; evidence_count: number }[];
}

export interface TransferabilitySummary {
  high_count: number;
  moderate_count: number;
  low_count: number;
  unknown_count: number;
}

export interface EvidenceSummary {
  evidence_ids: string[];
  inferential_count: number;
  descriptive_count: number;
  strength_score: string;
  strongest_tier: string;
  best_significance: string;
  dominant_direction: string;
}

export interface IndicatorRecommendation {
  indicator_id: string;
  indicator_name: string;
  relevance_score: number;
  rationale: string;
  evidence_ids: string[];
  evidence_citations: EvidenceCitation[];
  rank: number;
  relationship_direction: string;
  confidence: string;
  strength_score?: string;
  evidence_summary?: EvidenceSummary;
  transferability_summary?: TransferabilitySummary;
  dimension_id?: string;
  subdimension_id?: string;
}

export interface RecommendationResponse {
  success: boolean;
  recommendations: IndicatorRecommendation[];
  indicator_relationships: IndicatorRelationship[];
  summary: RecommendationSummary | null;
  total_evidence_reviewed: number;
  model_used: string;
  error?: string;
}

// Task types
export interface TaskStatus {
  task_id: string;
  status: 'PENDING' | 'STARTED' | 'PROGRESS' | 'SUCCESS' | 'FAILURE' | 'REVOKED';
  progress?: {
    current: number;
    total: number;
    status: string;
  };
  result?: Record<string, unknown>;
  error?: string;
}

// Vision types
export interface SemanticClass {
  name: string;
  color: string;
  countable: number;
  openness: number;
}

export interface VisionAnalysisResponse {
  status: string;
  image_path: string;
  processing_time: number;
  statistics: Record<string, unknown>;
  mask_paths: Record<string, string>;
  instances: Record<string, unknown>[];
  error?: string;
}

// Config types
export interface AppConfig {
  vision_api_url: string;
  llm_provider: string;
  gemini_model: string;
  openai_model: string;
  anthropic_model: string;
  deepseek_model: string;
  data_dir: string;
  metrics_code_dir: string;
  knowledge_base_dir: string;
}

export interface LLMProviderInfo {
  id: string;
  name: string;
  default_model: string;
  configured: boolean;
  active: boolean;
  current_model: string;
}

// Knowledge base types
export interface KnowledgeBaseSummary {
  loaded: boolean;
  total_evidence: number;
  indicators_with_evidence: number;
  dimensions_with_evidence: number;
  appendix_sections: string[];
  iom_records: number;
}

// Auth types
export interface User {
  id: string;
  email: string;
  username: string;
  full_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface UserCreate {
  email: string;
  username: string;
  password: string;
  full_name?: string;
}

export interface UserLogin {
  username: string;
  password: string;
}

export interface AuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// Analysis types (Stage 2.5 + Stage 3)
export interface IndicatorDefinitionInput {
  id: string;
  name: string;
  unit?: string;
  target_direction?: string;
  definition?: string;
  category?: string;
}

export interface IndicatorLayerValue {
  zone_id: string;
  zone_name: string;
  indicator_id: string;
  layer: string;
  n_images?: number;
  mean?: number | null;
  std?: number | null;
  min?: number | null;
  max?: number | null;
  unit?: string;
  area_sqm?: number;
}

export interface EnrichedZoneStat extends IndicatorLayerValue {
  z_score?: number | null;
  percentile?: number | null;
}

export interface ZoneDiagnostic {
  zone_id: string;
  zone_name: string;
  area_sqm: number;
  mean_abs_z: number;
  rank: number;
  point_count: number;
  indicator_status: Record<string, Record<string, unknown>>;
}

export interface ComputationMetadata {
  version: string;
  generated_at: string;
  n_indicators: number;
  n_zones: number;
  layers: string[];
  warnings?: string[];
  system?: string;
  n_segments?: number;
  has_spatial_data?: boolean;
  has_clustering?: boolean;
}

// v7.0: image-level record (long-format)
export interface ImageRecord {
  image_id: string;
  zone_id: string;
  zone_name: string;
  indicator_id: string;
  layer: string;
  value: number;
  lat?: number | null;
  lng?: number | null;
}

// v7.0: per-indicator global stats (Table M2)
export interface GlobalIndicatorStats {
  indicator_id: string;
  indicator_name: string;
  unit: string;
  target_direction: string;
  by_layer: Record<string, { N: number | null; Mean: number | null; Std: number | null; Min: number | null; Max: number | null }>;
  cv_full?: number | null;
  shapiro_w?: number | null;
  shapiro_p?: number | null;
  kruskal_h?: number | null;
  kruskal_p?: number | null;
}

// v7.0: data quality diagnostics (Table M4)
export interface DataQualityRow {
  indicator_id: string;
  total_images: number;
  fg_coverage_pct?: number | null;
  mg_coverage_pct?: number | null;
  bg_coverage_pct?: number | null;
  is_normal?: boolean | null;
  correlation_method: string;
}

export interface ZoneAnalysisResult {
  zone_statistics: EnrichedZoneStat[];
  zone_diagnostics: ZoneDiagnostic[];
  correlation_by_layer: Record<string, Record<string, Record<string, number>>>;
  pvalue_by_layer: Record<string, Record<string, Record<string, number>>>;
  indicator_definitions: Record<string, IndicatorDefinitionInput>;
  layer_statistics: Record<string, Record<string, { N: number; Mean: number | null; Std: number | null; Min: number | null; Max: number | null }>>;
  radar_profiles: Record<string, Record<string, number>>;
  radar_profiles_by_layer?: Record<string, Record<string, Record<string, number>>>;
  computation_metadata: ComputationMetadata;
  segment_diagnostics?: ZoneDiagnostic[];
  clustering?: ClusteringResult | null;
  // v7.0 additions
  image_records?: ImageRecord[];
  global_indicator_stats?: GlobalIndicatorStats[];
  data_quality?: DataQualityRow[];
  analysis_mode?: 'zone_level' | 'image_level';
  zone_source?: 'user' | 'cluster' | null;
}

// Clustering types
export interface ArchetypeProfile {
  archetype_id: number;
  archetype_label: string;
  point_count: number;
  centroid_values: Record<string, number>;
  centroid_z_scores: Record<string, number>;
}

export interface SpatialSegment {
  segment_id: string;
  archetype_id: number;
  archetype_label: string;
  point_count: number;
  point_ids: string[];
  lat_range: number[];
  lng_range: number[];
  centroid_indicators: Record<string, number>;
  centroid_z_scores: Record<string, number>;
  silhouette_score: number;
}

export interface ClusteringResult {
  method: string;
  k: number;
  silhouette_score: number;
  silhouette_scores: { k: number; silhouette: number }[];
  spatial_smooth_k: number;
  layer_used: string;
  archetype_profiles: ArchetypeProfile[];
  spatial_segments: SpatialSegment[];
  // Per-point data (for before/after-smoothing scatter)
  point_ids_ordered: string[];
  point_lats: number[];
  point_lngs: number[];
  labels_raw: number[];
  labels_smoothed: number[];
  // Ward hierarchical linkage (for dendrogram): [id1, id2, dist, count]
  dendrogram_linkage: number[][];
  // ── Legacy density-clustering fields (v6.1, deprecated; empty since v6.2 GMM) ──
  /** Persistence per cluster (legacy density-stability score). Higher = more
   *  robust. Map: cluster_id (string) → score. */
  cluster_persistence?: Record<string, number>;
  /** Per-point silhouette coefficient (against final labels). null = noise. */
  silhouette_per_point?: (number | null)[];
  /** Number of points formerly labelled as noise before reassignment (legacy). */
  noise_count?: number;
  /** Original IDs of noise points (for highlighting in spatial map). */
  noise_point_ids?: string[];
  /** Legacy condensed-tree edges (former density-clustering tree visual; unused). */
  condensed_tree?: { parent: number; child: number; lambda_val: number; child_size: number }[];
}

export interface ClusteringRequest {
  point_metrics: Record<string, unknown>[];
  indicator_definitions: Record<string, IndicatorDefinitionInput>;
  layer?: string;
  max_k?: number;
  knn_k?: number;
  min_points?: number;
}

export interface ClusteringByProjectRequest {
  project_id: string;
  indicator_ids: string[];
  layer?: string;
  max_k?: number;
  knn_k?: number;
  min_points?: number;
}

export interface ClusteringResponse {
  clustering: ClusteringResult | null;
  segment_diagnostics: ZoneDiagnostic[];
  /** #1 — full Stage 2.5 result computed with each cluster acting as a
   * virtual zone. Drop this into setZoneAnalysisResult to make all charts
   * (z-score, correlation, radar, layer stats) reflect cluster membership.
   * For within-zone clustering this is the 'all_sub_clusters' view (mirror
   * of analysis_views['all_sub_clusters'] for backward compat). */
  zone_analysis?: ZoneAnalysisResult | null;
  /** v4 / Phase A — multi-view payload from /clustering/within-zones.
   * Empty for /clustering/by-project (single-zone) which has no notion of
   * parent zones. Standard keys:
   *   'parent_zones'          — N parent zones aggregated
   *   'all_sub_clusters'      — flat NK sub-clusters (legacy default)
   *   'within_zone:<zone_id>' — K sub-clusters of one parent zone
   * The frontend's segmented control reads this dict to populate the
   * available views in one round-trip. */
  analysis_views?: Record<string, ZoneAnalysisResult>;
  skipped: boolean;
  reason: string;
  n_points_used?: number;
  n_points_with_gps?: number;
}

export interface MergedExportRequest {
  zone_analysis: ZoneAnalysisResult;
  clustering?: ClusteringResult | null;
  segment_diagnostics?: ZoneDiagnostic[];
}

export interface SignatureExpanded {
  sig_id: string;
  role: string;
  subtype?: string;
  mechanism?: string;
  operation: { id: string; name: string; description?: string };
  semantic_layer: { id: string; name: string; description?: string };
  spatial_layer: { id: string; name: string; description?: string };
  morphological_layer: { id: string; name: string; description?: string };
}

export interface DesignStrategy {
  priority: number;
  strategy_name: string;
  target_indicators: string[];
  spatial_location: string;
  intervention: {
    object: string;
    action: string;
    variable: string;
    specific_guidance: string;
  };
  expected_effects: { indicator: string; direction: string; magnitude: string }[];
  confidence: string;
  potential_tradeoffs: string;
  supporting_ioms: string[];
  // v5.0 — signature & evidence detail
  signatures?: SignatureExpanded[];
  pathway?: { pathway_type?: { id: string; name: string }; mechanism_description?: string };
  boundary_effects?: string | null;
  transferability_note?: string | null;
  implementation_guidance?: string | null;
}

export interface MatchedIOM {
  iom_id: string | null;
  indicator_id: string;
  indicator_name: string;
  direction: string;
  score: number;
  operation: Record<string, unknown>;
  confidence_expanded: Record<string, unknown>;
  // v5.0
  signatures?: SignatureExpanded[];
  scope?: { pattern?: { code: string; name: string }; signature_count?: number };
  transferability?: { overall: string; climate_match: string; lcz_match: string; setting_match: string; user_group_match: string };
  is_descriptive?: boolean;
  source_citation?: string | null;
}

export interface ZoneDesignOutput {
  zone_id: string;
  zone_name: string;
  mean_abs_z: number;
  diagnosis: { integrated_diagnosis?: string; cross_zone_notes?: string | null; iom_queries?: { indicator_id: string; direction: string; direction_rationale: string; priority: number }[]; strategies_fallback_used?: boolean; strategies_retry_used?: boolean };
  overall_assessment: string;
  matched_ioms: MatchedIOM[];
  design_strategies: DesignStrategy[];
  implementation_sequence: string;
  synergies: string;
}

export interface DesignStrategyResult {
  zones: Record<string, ZoneDesignOutput>;
  metadata: { diagnosis_mode: string; total_zones: number; total_strategies: number; total_iom_matches?: number };
}

export interface ReportRequest {
  zone_analysis: ZoneAnalysisResult;
  design_strategies?: DesignStrategyResult | null;
  stage1_recommendations?: Record<string, unknown>[] | null;
  project_context?: { project?: Record<string, unknown>; context?: Record<string, unknown>; performance_query?: Record<string, unknown> };
  format?: 'markdown' | 'pdf';
  project_id?: string;
  /** Grouping mode the request is generated under. Persisted into the
   * project's ai_report_meta so a later mode switch can detect staleness
   * during hydrateFromProject. */
  grouping_mode?: GroupingMode;
}

export interface ReportResult {
  content: string;
  format: string;
  metadata: Record<string, unknown>;
}

export interface FullAnalysisResult {
  zone_analysis: ZoneAnalysisResult;
  design_strategies: DesignStrategyResult;
}

export interface ZoneAnalysisRequest {
  indicator_definitions: Record<string, IndicatorDefinitionInput>;
  zone_statistics: IndicatorLayerValue[];
}

export interface FullAnalysisRequest extends ZoneAnalysisRequest {
  project_context?: { project?: Record<string, unknown>; context?: Record<string, unknown>; performance_query?: Record<string, unknown> };
  allowed_indicator_ids?: string[];
  use_llm?: boolean;
  max_ioms_per_query?: number;
  max_strategies_per_zone?: number;
}

// Project Pipeline types
export interface ProjectPipelineRequest {
  project_id: string;
  indicator_ids: string[];
  run_stage3?: boolean;
  use_llm?: boolean;
  max_ioms_per_query?: number;
  max_strategies_per_zone?: number;
  /** v4.x — Panorama view scoping. One of "left" / "front" / "right" when
   *  set; backend aliases that view's prefixed masks to the standard slots
   *  and writes results into the view's bucket. Omit for non-panorama runs. */
  panorama_view?: string;
}

export interface ProjectPipelineProgress {
  step: string;
  status: string;
  detail: string;
}

export interface SkippedImage {
  image_id: string;
  filename: string;
  reason: 'no_semantic_map' | 'invalid_semantic_map';
}

export interface ProjectPipelineResult {
  project_id: string;
  project_name: string;
  total_images: number;
  zone_assigned_images: number;
  calculations_run: number;
  calculations_succeeded: number;
  calculations_failed: number;
  calculations_cached: number;
  zone_statistics_count: number;
  skipped_images: SkippedImage[];
  zone_analysis: ZoneAnalysisResult | null;
  design_strategies: DesignStrategyResult | null;
  steps: ProjectPipelineProgress[];
}

export type ProjectPipelineStreamEvent =
  | {
      type: 'status';
      step: string;
      status: 'completed' | 'failed' | 'skipped' | 'running';
      detail: string;
    }
  | {
      type: 'progress';
      step: 'run_calculations';
      current: number;
      total: number;
      image_id: string;
      image_filename: string;
      succeeded: number;
      failed: number;
      cached: number;
    }
  | { type: 'result'; data: ProjectPipelineResult }
  | { type: 'error'; message: string };

/**
 * SSE events emitted by /api/analysis/design-strategies/stream.
 *
 * Flow: ``started`` → repeated ``progress`` events (one per
 * ``diagnosis``/``strategies``/``unit_done`` sub-step inside the per-zone loop)
 * → ``result`` (final DesignStrategyResult) → connection closes.
 * On failure: a single ``error`` event before the connection closes.
 */
export type DesignStrategiesStreamEvent =
  | { type: 'started'; unit_total: number }
  | {
      type: 'progress';
      stage: 'diagnosis' | 'strategies' | 'unit_done';
      unit_index: number;
      unit_total: number;
      unit_id: string;
      unit_label: string;
    }
  | { type: 'result'; data: DesignStrategyResult }
  | { type: 'error'; message: string };

/**
 * SSE events emitted by /api/analysis/generate-report/stream.
 *
 * Phases: ``started`` → ``progress`` (preparing) → ``progress`` (awaiting LLM)
 * → ``progress`` (rendering) → ``result``. The LLM call itself is the long
 * blocking phase and currently isn't token-streamed, so the bar transitions
 * from "Calling LLM" (indeterminate) to "Finalizing" (determinate done) at
 * the moment Gemini returns.
 */
export type GenerateReportStreamEvent =
  | { type: 'started' }
  | {
      type: 'progress';
      phase: 'preparing' | 'awaiting_llm' | 'rendering';
      label: string;
    }
  | { type: 'result'; data: ReportResult }
  | { type: 'error'; message: string };

// Encoding dictionary (knowledge-base codebook) types
export interface SupportingPaper {
  paper_file?: string;
  doi?: string;
  citation?: string;
}

export interface EncodingEntry {
  code: string;
  name: string;
  definition: string;
  supporting_papers: SupportingPaper[];
  parent_dim?: string | null;
  evidence_count?: number | null;
}

export type EncodingSectionKey =
  | 'K_climate'
  | 'E_countries'
  | 'E_settings'
  | 'L_lcz'
  | 'M_age_groups'
  | 'C_performance'
  | 'C_subdimensions';

export type EncodingSections = Record<EncodingSectionKey, EncodingEntry[]>;
