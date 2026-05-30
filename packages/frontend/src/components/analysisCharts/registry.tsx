import type { ReactNode } from 'react';
import {
  Box,
  HStack,
  Text,
  VStack,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Tooltip,
} from '@chakra-ui/react';
import {
  RadarProfileChart,
  radarProfileColor,
  ZonePriorityChart,
  CorrelationHeatmap,
  PriorityHeatmap,
  ArchetypeRadarChart,
  ClusterSizeChart,
  SilhouetteCurve,
  IndicatorDeepDive,
  CrossIndicatorSpatialMaps,
  Dendrogram,
  ClusterSpatialBeforeAfter,
  // v7.0
  ViolinGrid,
  GlobalStatsTable,
  DataQualityTable,
  // v4 / Phase 2
  WithinZoneImageDistribution,
  IndicatorValueMapWithToggle,
  // v6.1 — cluster diagnostic charts
  ClusterCentroidHeatmap,
  SilhouettePerPointPlot,
} from '../AnalysisCharts';
import { ResponsiveSmallMultiples } from './ResponsiveSmallMultiples';
import type { ChartContext } from './ChartContext';
import { LAYER_LABELS } from './ChartContext';

export type ChartTab = 'diagnostics' | 'statistics' | 'analysis';

// ---------------------------------------------------------------------------
// v4 / Module 1: viable display modes for each chart
// ---------------------------------------------------------------------------
// `viableInModes` declares in which entry-paths the chart should be rendered.
// Reports.tsx filters CHART_REGISTRY by this when the user picks Single View
// (single_zone) vs Dual View (cluster + multi_zone). This replaces the
// previous "single hard gate" approach (SingleZoneEntryGate) which hid every
// chart for single-zone projects.
//
// Phase 1 introduces the field; Phase 3 wires it into the entry-card logic.
export type ChartViabilityMode = 'single_zone' | 'multi_zone' | 'cluster';

/**
 * Sections drive the narrative on the Analysis tab. The five-panel layout
 * (PDF #7) takes the user from setup → "where do zones differ" → "what does
 * each indicator look like" → "raw values + cross-cutting" → optional
 * cluster diagnostics.
 *
 * v4 / Module 4 alignment:
 *   A setup        — Project metadata + data quality
 *   B zone         — Cross-zone z-score findings
 *   C indicator    — From global to within-zone, per indicator
 *   D reference    — Reference & Cross-Cutting (raw tables + correlations)
 *   E clustering   — Cluster Diagnostics (visible after clustering ran)
 */
export type ChartSection =
  | 'setup'      // A
  | 'zone'       // B — expanded by default
  | 'indicator'  // C — expanded by default
  | 'reference'  // D — folded by default; v4: now also hosts D3 correlation
  | 'clustering'; // E — visible only after clustering has been run

export const SECTION_ORDER: ChartSection[] = [
  'setup',
  'zone',
  'indicator',
  'reference',
  'clustering',
];

// ---------------------------------------------------------------------------
// Section meta (v4 / Module 4 — chapter questions visible to users)
// ---------------------------------------------------------------------------
//
// Each section now has:
//   - title        : short label shown on the heading
//   - subtitle     : starts with the chapter question in bold-style brackets
//                    so users see the analytical framing
//   - defaultCollapsed
//   - dataLevelByMode : shown as a Badge next to the heading, dependent on
//     the active groupingMode (zones | clusters). SectionHeading reads this.
//
// Phase 1 (this commit): subtitle + dataLevelByMode landed.
// Phase 1 setup section is now defaultCollapsed: false on first visit; the
// first-visit unlock is handled in Reports.tsx via localStorage.
export interface SectionMeta {
  title: string;
  subtitle: string;
  defaultCollapsed?: boolean;
  /** v4 / Module 4: dynamic data-level badge shown next to the section title.
   * Returns the badge text given the current grouping mode. */
  dataLevelByMode?: (mode: 'zones' | 'clusters') => string;
  /** v4.x — Dynamic section title that adapts to grouping mode. When the
   * active view shows clusters (clusters / all_sub_clusters / within_zone:*),
   * a section labelled "Zone-Level Findings" misleads the user into thinking
   * the rows are zones. Sections that overload "zone" semantics provide a
   * mode-aware title here; SectionHeading + Reports.tsx prefer this over
   * `title` when present. */
  titleByMode?: (mode: 'zones' | 'clusters') => string;
  /** v4.x — Dynamic subtitle that mirrors titleByMode. Same rationale: the
   * literal word "zone" in the subtitle is misleading on cluster-derived
   * views. */
  subtitleByMode?: (mode: 'zones' | 'clusters') => string;
}

export const SECTION_META: Record<ChartSection, SectionMeta> = {
  setup: {
    title: 'Setup & Data Quality',
    subtitle:
      'What did we measure and how trustworthy is it? Indicator metadata + per-indicator coverage and normality.',
    defaultCollapsed: false,
    dataLevelByMode: () => 'Project metadata',
  },
  zone: {
    title: 'Zone-Level Findings',
    subtitle:
      'Where do zones differ? Cross-zone z-score ranking, indicator decomposition, layer profile, and geographic deviation.',
    titleByMode: (mode) =>
      mode === 'clusters'
        ? 'Cluster-Level Findings'
        : 'Zone-Level Findings',
    subtitleByMode: (mode) =>
      mode === 'clusters'
        ? 'Where do clusters differ? Cross-cluster z-score ranking, indicator decomposition, layer profile, and geographic deviation.'
        : 'Where do zones differ? Cross-zone z-score ranking, indicator decomposition, layer profile, and geographic deviation.',
    dataLevelByMode: (mode) =>
      mode === 'clusters'
        ? 'Cluster-as-zone (N = K clusters)'
        : 'Zone-level (N = K user zones)',
  },
  indicator: {
    title: 'Indicator Drill-Down',
    subtitle:
      'From global to within-zone — what does each indicator look like at each scale? Four progressive stages: global baseline → zone means → image-level per zone × layer → geographic.',
    dataLevelByMode: (mode) =>
      mode === 'clusters'
        ? 'Mixed: cluster-level + image-level'
        : 'Mixed: zone-level + image-level',
  },
  reference: {
    title: 'Reference & Cross-Cutting',
    subtitle:
      'Raw values and indicator-to-indicator relationships. Use these for citation, export, or further statistical work.',
    defaultCollapsed: true,
    dataLevelByMode: (mode) =>
      mode === 'clusters' ? 'Cluster-level tables' : 'Zone-level tables',
  },
  clustering: {
    title: 'Cluster Diagnostics',
    subtitle:
      'How the clusters used in Dual View were formed: K selection, cluster profiles, spatial smoothing.',
    defaultCollapsed: false,
    dataLevelByMode: () =>
      'Cluster diagnostics — explains the K clusters used in Dual View',
  },
};

export interface ChartDescriptor {
  /** Stable unique identifier, used as persistence key */
  id: string;
  /** Human-readable title shown in Card header + picker checkbox */
  title: string;
  /** Optional registry code rendered as a Badge next to the title.
   * v4: unified scheme A1/A2 · B1–B4 · C1–C4 · D1–D3 plus E1–E7
   * when cluster diagnostics are available (legacy M1–M4 retired). */
  refCode?: string;
  /** Which tab this chart renders in */
  tab: ChartTab;
  /** Narrative section — drives ordering and subheadings on the Analysis tab. */
  section: ChartSection;
  /** Short caption rendered below the Card header (also used in picker tooltip). */
  description?: string;
  /** v4 / Module 1: which entry-paths the chart is visible in.
   * If absent, defaults to all three modes (backward compatible). */
  viableInModes?: ChartViabilityMode[];
  /** Returns false when required data isn't available — chart is skipped */
  isAvailable: (ctx: ChartContext) => boolean;
  /** Renders the chart body (ChartHost provides the Card wrapper) */
  render: (ctx: ChartContext) => ReactNode;
  /** Whether the chart reacts to the layer selector (re-rendered on layer change) */
  layerAware?: boolean;
  /**
   * Returns a small JSON-serialisable slice of context for the LLM summary
   * (5.10.4). Keep it under ~6KB — the backend truncates anything bigger.
   * If absent, ChartHost sends a minimal placeholder.
   *
   * Convention: include `analysis_mode`, `zone_count`, and either compact
   * `rows: [...]` (≤30 entries) or `by_layer:{full,foreground,middleground,background}`
   * for layerAware charts so the LLM has enough grounding for cross-layer
   * comparison.
   */
  summaryPayload?: (ctx: ChartContext) => Record<string, unknown> | null;
  /**
   * 6.B(1) — when true, the chart is included in the embedded report by
   * default. Other charts can still be opted in via the Customize panel.
   */
  exportByDefault?: boolean;
  /**
   * #7-A — return tabular rows for CSV / XLSX export. Charts without an
   * `exportRows` only expose SVG and PNG export. Keep rows flat (one record
   * per row) and keep column keys stable; XLSX column auto-fit reads
   * `String(value).length` so prefer numbers and short strings over JSON
   * blobs.
   */
  exportRows?: (ctx: ChartContext) => {
    columns: { key: string; label: string }[];
    rows: Record<string, unknown>[];
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers for compact summaryPayloads (≤6KB target per chart)
// ---------------------------------------------------------------------------

function compactZoneStats(ctx: ChartContext, layer: string) {
  const rows = ctx.zoneAnalysisResult?.zone_statistics
    ?.filter((s) => s.layer === layer)
    .slice(0, 60) // ~30 zone × 30 ind upper bound; trimmed below
    .map((s) => ({
      zone: s.zone_name,
      indicator: s.indicator_id,
      mean: s.mean,
      std: s.std,
      n: s.n_images ?? 0,
    })) ?? [];
  // Keep the 30 highest-magnitude rows so the LLM sees the salient signal
  // when there are too many cells to fit.
  if (rows.length > 30) {
    rows.sort((a, b) => Math.abs(b.mean ?? 0) - Math.abs(a.mean ?? 0));
    return rows.slice(0, 30);
  }
  return rows;
}

function correlationByLayer(ctx: ChartContext) {
  const za = ctx.zoneAnalysisResult;
  if (!za?.correlation_by_layer) return {};
  const out: Record<string, { a: string; b: string; r: number }[]> = {};
  for (const layer of LAYERS_FOR_PAYLOAD) {
    const corr = za.correlation_by_layer[layer];
    if (!corr) continue;
    const inds = Object.keys(corr);
    const pairs: { a: string; b: string; r: number }[] = [];
    for (let i = 0; i < inds.length; i++) {
      for (let j = i + 1; j < inds.length; j++) {
        const r = corr[inds[i]]?.[inds[j]];
        if (r != null) pairs.push({ a: inds[i], b: inds[j], r });
      }
    }
    pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
    out[layer] = pairs.slice(0, 8);
  }
  return out;
}

const LAYERS_FOR_PAYLOAD = ['full', 'foreground', 'middleground', 'background'];

// ---------------------------------------------------------------------------
// Registry (v4 / Module 5 — order = render order; refCodes A1/A2 · B1–B4 · C1–C4 · D1–D3 · E1–E7)
// ---------------------------------------------------------------------------
//
// v4 changes (Phase 1):
//   - Renamed every chart to "Subject — Decoration dimension" form
//   - Renumbered refCode (legacy M1/M2/M3/M4/Fig M1 retired)
//   - Section B 4-chart order now: B1 ranking, B2 zone × ind, B3 radar, B4 spatial map
//   - Section C order now: C1 distribution, C2 drill-down, C4 value map (C3 added in
//     Phase 2; correlation-heatmap moves to D3)
//   - Section D 3-chart order: D1 global stats, D2 zone × ind matrix, D3 correlation
//   - viableInModes added per chart (drives Single View / Dual View filter)
//
// Note: Phase 1 keeps existing render/isAvailable/exportRows/summaryPayload
// implementations untouched. Phase 2 will rewire C2's sub-panels and add C3.

export const CHART_REGISTRY: ChartDescriptor[] = [
  // ── Section A · Setup & Data Quality ─────────────────────────────────
  {
    id: 'indicator-registry-table',
    title: 'Indicator Registry — what each indicator measures',
    refCode: 'A1',
    tab: 'analysis',
    section: 'setup',
    description: 'What indicators are we analyzing? Metadata-only list — id, name, unit, target direction, category.',
    viableInModes: ['single_zone', 'multi_zone', 'cluster'],
    isAvailable: (ctx) => Object.keys(ctx.indicatorDefs).length > 0,
    exportRows: (ctx) => ({
      columns: [
        { key: 'id', label: 'ID' },
        { key: 'name', label: 'Full Name' },
        { key: 'unit', label: 'Unit' },
        { key: 'target_direction', label: 'Target' },
        { key: 'category', label: 'Category' },
        { key: 'n_full', label: 'N (Full)' },
      ],
      rows: Object.values(ctx.indicatorDefs).map((d) => ({
        id: d.id,
        name: d.name,
        unit: d.unit,
        target_direction: d.target_direction,
        category: d.category,
        n_full:
          ctx.globalIndicatorStats.find((s) => s.indicator_id === d.id)?.by_layer?.full?.N ?? '',
      })),
    }),
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zone_count: ctx.sortedDiagnostics.length,
      indicators: Object.values(ctx.indicatorDefs).slice(0, 30).map((d) => ({
        id: d.id,
        name: d.name,
        unit: d.unit,
        target: d.target_direction,
        category: d.category,
        n_full: ctx.globalIndicatorStats.find((s) => s.indicator_id === d.id)
          ?.by_layer?.full?.N ?? null,
      })),
    }),
    render: (ctx) => {
      const defs = Object.values(ctx.indicatorDefs);
      return (
        <Box overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>ID</Th>
                <Th>Full Name</Th>
                <Th>Unit</Th>
                <Th>Target</Th>
                <Th>Category</Th>
                <Th isNumeric>N (Full)</Th>
              </Tr>
            </Thead>
            <Tbody>
              {defs.map((d) => {
                const gs = ctx.globalIndicatorStats.find((s) => s.indicator_id === d.id);
                const fullN = gs?.by_layer?.full?.N ?? '—';
                return (
                  <Tr key={d.id}>
                    <Td fontSize="xs" fontWeight="bold">{d.id}</Td>
                    <Td fontSize="xs">{d.name}</Td>
                    <Td fontSize="xs">{d.unit}</Td>
                    <Td fontSize="xs">{d.target_direction}</Td>
                    <Td fontSize="xs">{d.category}</Td>
                    <Td fontSize="xs" isNumeric>{fullN}</Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </Box>
      );
    },
  },
  {
    id: 'data-quality-table',
    title: 'Data Quality — coverage, normality, correlation method per indicator',
    refCode: 'A2',
    tab: 'analysis',
    section: 'setup',
    description: 'Images per indicator, FMB layer coverage, Shapiro-Wilk normality, correlation method (Pearson vs Spearman).',
    viableInModes: ['single_zone', 'multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.dataQuality.length > 0,
    exportRows: (ctx) => ({
      columns: [
        { key: 'indicator_id', label: 'Indicator' },
        { key: 'total_images', label: 'Total Images' },
        { key: 'fg_coverage_pct', label: 'FG %' },
        { key: 'mg_coverage_pct', label: 'MG %' },
        { key: 'bg_coverage_pct', label: 'BG %' },
        { key: 'is_normal', label: 'Normality' },
        { key: 'correlation_method', label: 'Corr. Method' },
      ],
      rows: ctx.dataQuality.map((r) => ({
        indicator_id: r.indicator_id,
        total_images: r.total_images,
        fg_coverage_pct: r.fg_coverage_pct,
        mg_coverage_pct: r.mg_coverage_pct,
        bg_coverage_pct: r.bg_coverage_pct,
        is_normal: r.is_normal,
        correlation_method: r.correlation_method,
      })),
    }),
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zone_count: ctx.sortedDiagnostics.length,
      rows: ctx.dataQuality.slice(0, 30).map((r) => ({
        indicator: r.indicator_id,
        total_images: r.total_images,
        fg_pct: r.fg_coverage_pct,
        mg_pct: r.mg_coverage_pct,
        bg_pct: r.bg_coverage_pct,
        normal: r.is_normal,
        corr_method: r.correlation_method,
      })),
    }),
    render: (ctx) => <DataQualityTable rows={ctx.dataQuality} />,
  },

  // ── Section B · Zone-Level Findings (cross-zone z-score) ─────────────
  // v4: indicator unified to z-score (B1 / B2 already z-score; B3 radar is
  // currently percentile-based — backend migration to z-score scheduled for
  // a follow-up phase, then radar description below will drop the legacy
  // wording).
  {
    id: 'zone-deviation-overview',
    title: 'Zone Ranking — overall deviation',
    refCode: 'B1',
    tab: 'analysis',
    section: 'zone',
    description:
      'Horizontal bar of each zone ranked by mean |z-score| across indicators (full layer). z-score reference: full-layer mean across all zones (or clusters in Dual View).',
    viableInModes: ['multi_zone', 'cluster'],
    exportByDefault: true,
    isAvailable: (ctx) => ctx.sortedDiagnostics.length > 0,
    render: (ctx) => <ZonePriorityChart diagnostics={ctx.sortedDiagnostics} />,
    exportRows: (ctx) => ({
      columns: [
        { key: 'rank', label: 'Rank' },
        { key: 'zone_name', label: 'Zone' },
        { key: 'mean_abs_z', label: 'Mean |z|' },
        { key: 'point_count', label: 'Points' },
      ],
      rows: ctx.sortedDiagnostics.map((d) => ({
        rank: d.rank,
        zone_name: d.zone_name,
        mean_abs_z: d.mean_abs_z != null ? Number(d.mean_abs_z.toFixed(3)) : '',
        point_count: d.point_count,
      })),
    }),
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zones: ctx.sortedDiagnostics.map((d) => ({
        zone: d.zone_name,
        mean_abs_z: d.mean_abs_z,
        rank: d.rank,
        points: d.point_count,
      })),
    }),
  },
  {
    id: 'priority-heatmap',
    title: "Zone × Indicator — which indicators drive each zone's deviation",
    refCode: 'B2',
    tab: 'analysis',
    section: 'zone',
    description:
      'z-score grid: rows = zones, columns = indicators (full layer). Red = above mean, blue = below. z-score reference: full-layer mean across all zones (or clusters in Dual View).',
    viableInModes: ['multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.sortedDiagnostics.length > 0,
    summaryPayload: (ctx) => {
      // For each zone, list the top-3 most-deviating indicators by |z| on the
      // full layer. Keeps payload bounded by 3 × zones rather than full grid.
      const fullStats = ctx.zoneAnalysisResult?.zone_statistics?.filter(
        (s) => s.layer === 'full',
      ) ?? [];
      const byZone = new Map<string, { indicator: string; z: number }[]>();
      for (const s of fullStats) {
        if (s.z_score == null) continue;
        const list = byZone.get(s.zone_name) ?? [];
        list.push({ indicator: s.indicator_id, z: s.z_score });
        byZone.set(s.zone_name, list);
      }
      const rows: { zone: string; mean_abs_z: number; top_deviations: { indicator: string; z: number }[] }[] = [];
      for (const d of ctx.sortedDiagnostics.slice(0, 12)) {
        const zScores = (byZone.get(d.zone_name) ?? [])
          .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
          .slice(0, 3);
        rows.push({ zone: d.zone_name, mean_abs_z: d.mean_abs_z, top_deviations: zScores });
      }
      return { analysis_mode: ctx.analysisMode, zone_count: ctx.sortedDiagnostics.length, rows };
    },
    render: (ctx) => (
      <PriorityHeatmap
        diagnostics={ctx.sortedDiagnostics}
        layer="full"
        colorblindMode={ctx.colorblindMode}
      />
    ),
    exportRows: (ctx) => {
      // Long-form (zone, indicator, z) — easier for re-analysis than a wide grid
      // and still maps 1:1 onto the heatmap cells.
      const indicators = new Set<string>();
      const longRows: Record<string, unknown>[] = [];
      for (const diag of ctx.sortedDiagnostics) {
        const status = diag.indicator_status || {};
        for (const [indId, layerData] of Object.entries(status)) {
          indicators.add(indId);
          const ld = (layerData as Record<string, { value?: number | null; z_score?: number }>).full;
          if (!ld) continue;
          longRows.push({
            zone_name: diag.zone_name,
            indicator: indId,
            value: ld.value ?? '',
            z_score: ld.z_score != null ? Number(ld.z_score.toFixed(3)) : '',
          });
        }
      }
      return {
        columns: [
          { key: 'zone_name', label: 'Zone' },
          { key: 'indicator', label: 'Indicator' },
          { key: 'value', label: 'Value' },
          { key: 'z_score', label: 'Z-Score' },
        ],
        rows: longRows,
      };
    },
  },
  {
    id: 'radar-profiles',
    title: 'Zone Profile Radar — by layer',
    refCode: 'B3',
    tab: 'analysis',
    section: 'zone',
    description:
      'All zones overlaid on a per-layer radar. Four small multiples let you compare cross-zone differences across foreground, middleground, and background simultaneously. Note: indicator scores are currently percentile-based; planned migration to z-score for v4 metric unification.',
    viableInModes: ['multi_zone', 'cluster'],
    exportByDefault: true,
    isAvailable: (ctx) => {
      const za = ctx.zoneAnalysisResult;
      if (!za) return false;
      if (za.radar_profiles_by_layer && Object.keys(za.radar_profiles_by_layer).length > 0) return true;
      return !!za.radar_profiles && Object.keys(za.radar_profiles).length > 0;
    },
    render: (ctx) => {
      const za = ctx.zoneAnalysisResult!;
      const profilesByLayer = za.radar_profiles_by_layer ?? {};
      // v4 / Phase Issue-4 polish — radar layout improvements:
      //   1. Per-panel <Legend> dropped (it duplicated the same K names
      //      4 times, taking ~280px of vertical space).
      //   2. ONE shared legend rendered below all four panels.
      //   3. Panels themselves get larger because each one no longer
      //      needs to budget legend space.
      // ResponsiveSmallMultiples still picks 1×4 / 2×2 / 4×1 by container
      // width, so on narrow viewports it falls into a 2×2 grid that's
      // much easier to read than the 1×4 sliver-each layout.
      // Collect all zone names from any layer (they should be identical
      // across layers, but union-of-zones guards against partial data).
      const allZones = Array.from(
        new Set(
          Object.values(profilesByLayer)
            .flatMap((p) => Object.keys(p ?? {}))
            .concat(Object.keys(za.radar_profiles ?? {})),
        ),
      ).sort();
      return (
        <Box>
          <ResponsiveSmallMultiples minPanelWidth={320}>
            {LAYERS_FOR_PAYLOAD.map((layer) => {
              const profiles = profilesByLayer[layer]
                ?? (layer === 'full' ? za.radar_profiles : null);
              if (!profiles || Object.keys(profiles).length === 0) {
                return (
                  <Box key={layer}>
                    <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center">{LAYER_LABELS[layer]}</Text>
                    <Text fontSize="xs" color="gray.400" textAlign="center">No data</Text>
                  </Box>
                );
              }
              return (
                <RadarProfileChart
                  key={layer}
                  radarProfiles={profiles}
                  showLegend={false}
                  /* Issue 3 v3 — disable the default Recharts angle-level
                     tooltip (which dumps all K cluster values at once and
                     blocks the chart). The component renders per-vertex
                     hover dots internally; each dot drives its own small
                     "(zone) (indicator) value" tooltip beside the cursor
                     so the user can pick out a specific point's value
                     without obstructing the radar. */
                  showTooltip={false}
                  panelTitle={LAYER_LABELS[layer]}
                />
              );
            })}
          </ResponsiveSmallMultiples>
          {/* Shared legend below all four panels. Same color mapping
              radar-internal `getZoneColor(i)` uses, so chip color matches
              polygon color across every panel. Tooltip on each chip
              shows the full zone name when truncated. */}
          {allZones.length > 0 && (
            <HStack
              flexWrap="wrap"
              spacing={3}
              rowGap={1}
              justify="center"
              mt={3}
              pt={2}
              borderTop="1px dashed"
              borderColor="gray.200"
            >
              {allZones.map((zoneName, i) => (
                <Tooltip key={zoneName} label={zoneName} placement="top" hasArrow openDelay={300}>
                  <HStack spacing={1} cursor="default">
                    <Box w="14px" h="3px" bg={radarProfileColor(i)} borderRadius="sm" />
                    <Text fontSize="2xs" color="gray.700" maxW="160px" noOfLines={1}>
                      {zoneName}
                    </Text>
                  </HStack>
                </Tooltip>
              ))}
            </HStack>
          )}
        </Box>
      );
    },
    summaryPayload: (ctx) => {
      const za = ctx.zoneAnalysisResult;
      const byLayer: Record<string, Record<string, Record<string, number>>> = {};
      if (za?.radar_profiles_by_layer) {
        for (const layer of LAYERS_FOR_PAYLOAD) {
          if (za.radar_profiles_by_layer[layer]) {
            byLayer[layer] = za.radar_profiles_by_layer[layer];
          }
        }
      }
      if (Object.keys(byLayer).length === 0 && za?.radar_profiles) {
        byLayer.full = za.radar_profiles;
      }
      return {
        analysis_mode: ctx.analysisMode,
        zone_count: ctx.sortedDiagnostics.length,
        by_layer: byLayer,
      };
    },
  },
  {
    id: 'spatial-z-deviation',
    title: 'Zone Deviation Map — geographic, by layer',
    refCode: 'B4',
    tab: 'analysis',
    section: 'zone',
    exportByDefault: true,
    description:
      'Mean |z| deviation across indicators per depth layer (Full / Foreground / Middleground / Background). Each panel shows the same GPS map coloured by how strongly that point deviates from the project average IN THAT LAYER — comparing panels reveals at which depth the spatial heterogeneity is concentrated.',
    viableInModes: ['multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.gpsImages.length > 0 && ctx.gpsIndicatorIds.length > 0,
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zone_count: ctx.sortedDiagnostics.length,
      n_gps_points: ctx.gpsImages.length,
      indicators: ctx.gpsIndicatorIds.slice(0, 20),
    }),
    render: (ctx) => (
      <ResponsiveSmallMultiples minPanelWidth={300}>
        {(['full', 'foreground', 'middleground', 'background'] as const).map((layer) => (
          <Box key={layer}>
            <Text fontSize="xs" textAlign="center" mb={1} color="gray.600" fontWeight="bold">
              {LAYER_LABELS[layer] ?? layer}
            </Text>
            <CrossIndicatorSpatialMaps
              gpsImages={ctx.gpsImages}
              indicatorIds={ctx.gpsIndicatorIds}
              colorblindMode={ctx.colorblindMode}
              panel="mean_abs_z"
              layer={layer}
            />
          </Box>
        ))}
      </ResponsiveSmallMultiples>
    ),
  },

  // ── Section C · Indicator Drill-Down (v4: From global to within-zone, 4 stages) ──
  {
    id: 'distribution-violin',
    title: 'Indicator Distribution — image-level, all images pooled',
    refCode: 'C1',
    tab: 'analysis',
    section: 'indicator',
    description:
      'Stage 1/4 · Global baseline — image-level box-whisker per layer for each indicator. N = total images. For zone-by-zone breakdown of this distribution see C2 (per-zone means) and C3 (per-zone image distributions, available in Phase 2).',
    viableInModes: ['single_zone', 'multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.imageRecords.length > 0,
    summaryPayload: (ctx) => {
      // Per indicator × layer: n, min, max, mean. Capped at 10 indicators × 4
      // layers = 40 rows ≈ <2KB.
      const buckets = new Map<string, number[]>();
      for (const r of ctx.imageRecords) {
        if (typeof r.value !== 'number') continue;
        const key = `${r.indicator_id}|${r.layer}`;
        const list = buckets.get(key) ?? [];
        list.push(r.value);
        buckets.set(key, list);
      }
      const indSet = Array.from(new Set(ctx.imageRecords.map((r) => r.indicator_id))).slice(0, 10);
      const rows: { indicator: string; layer: string; n: number; min: number; max: number; mean: number }[] = [];
      for (const ind of indSet) {
        for (const layer of LAYERS_FOR_PAYLOAD) {
          const vals = buckets.get(`${ind}|${layer}`);
          if (!vals || vals.length === 0) continue;
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          rows.push({ indicator: ind, layer, n: vals.length, min, max, mean });
        }
      }
      return { analysis_mode: ctx.analysisMode, zone_count: ctx.sortedDiagnostics.length, rows };
    },
    render: (ctx) => (
      <ViolinGrid imageRecords={ctx.imageRecords} indicatorDefs={ctx.indicatorDefs} />
    ),
  },
  {
    id: 'indicator-deep-dive',
    title: 'Per-Indicator Drill-Down — by zone',
    refCode: 'C2',
    tab: 'analysis',
    section: 'indicator',
    description:
      'Stage 2/4 · Zone means — for each indicator: zone ranking on the full layer, layer statistics (across zones, N = K zones), and zone-mean distribution by layer. Means shown here aggregate the per-zone image distributions in C3 (Phase 2).',
    // v4 polish — also viable in Single View. With one zone the chart
    // gracefully degrades to per-indicator within-zone stats (the
    // IndicatorDeepDive component already accepts analysisMode='image_level'
    // and adapts its rendering — there's just nothing to rank, so the
    // ranking row collapses to a single bar per layer).
    viableInModes: ['single_zone', 'multi_zone', 'cluster'],
    isAvailable: (ctx) =>
      !!ctx.zoneAnalysisResult && ctx.zoneAnalysisResult.zone_statistics.length > 0,
    summaryPayload: (ctx) => {
      // Defensive null-check — ChartHost's isAvailable gate (Task #113)
      // normally prevents this from running when zoneAnalysisResult is
      // null, but HMR or transient render-state can briefly bypass the
      // gate. Returning null here lets ChartHost's `?? { chart_id, title }`
      // fallback fire instead of throwing a TypeError that crashes the
      // whole React tree.
      if (!ctx.zoneAnalysisResult) return null;
      const za = ctx.zoneAnalysisResult;
      const indIds = Array.from(new Set(za.zone_statistics.map((s) => s.indicator_id))).slice(0, 10);
      const rows = indIds.map((ind) => {
        const stats = za.zone_statistics.filter((s) => s.indicator_id === ind && s.layer === 'full');
        const ranked = stats
          .map((s) => ({ zone: s.zone_name, mean: s.mean, z: s.z_score }))
          .sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0))
          .slice(0, 5);
        const def = za.indicator_definitions[ind];
        return {
          indicator: ind,
          target_direction: def?.target_direction,
          top_zones: ranked,
        };
      });
      return { analysis_mode: ctx.analysisMode, zone_count: ctx.sortedDiagnostics.length, indicators: rows };
    },
    render: (ctx) => {
      const za = ctx.zoneAnalysisResult!;
      const indIds = Array.from(new Set(za.zone_statistics.map((s) => s.indicator_id))).sort();
      const indDefs = za.indicator_definitions || {};
      const globalStatsByInd = new Map(
        ctx.globalIndicatorStats.map((s) => [s.indicator_id, s]),
      );
      return (
        <VStack
          align="stretch"
          spacing={8}
          divider={<Box borderTopWidth="1px" borderColor="gray.200" />}
        >
          {indIds.map((ind) => {
            const def = indDefs[ind];
            return (
              <IndicatorDeepDive
                key={ind}
                stats={za.zone_statistics}
                indicatorId={ind}
                indicatorName={def?.name}
                unit={def?.unit}
                targetDirection={def?.target_direction}
                analysisMode={ctx.analysisMode}
                globalStats={globalStatsByInd.get(ind)}
              />
            );
          })}
        </VStack>
      );
    },
  },
  {
    // v4 / Module 6.3.2 — fills the data-tier gap between C1 (image-level
    // pooled) and C2 (zone-level means): per-zone × per-layer image-level
    // distribution as a box-whisker grid. Built on top of imageRecords (the
    // per-image rows already attached to ChartContext) so it works in both
    // zone and cluster modes without extra plumbing.
    id: 'within-zone-image-distribution',
    title: 'Within-Zone Image Distribution — image-level, by zone × layer',
    refCode: 'C3',
    tab: 'analysis',
    section: 'indicator',
    description:
      'Stage 3/4 · Image-level per zone × layer — for each indicator, four panels (Full / FG / MG / BG) each with K side-by-side box-whiskers (one per zone or cluster). N per box = images in that zone × layer. The pooled view is in C1; the zone-mean view is in C2.',
    viableInModes: ['single_zone', 'multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.imageRecords.length > 0,
    summaryPayload: (ctx) => {
      const buckets = new Map<string, { zone: string; values: number[] }>();
      for (const r of ctx.imageRecords) {
        if (typeof r.value !== 'number') continue;
        const key = `${r.indicator_id}|${r.layer}|${r.zone_id}`;
        const entry = buckets.get(key) ?? { zone: r.zone_name, values: [] };
        entry.values.push(r.value);
        buckets.set(key, entry);
      }
      const indSet = Array.from(new Set(ctx.imageRecords.map((r) => r.indicator_id))).slice(0, 6);
      const layers = ['full', 'foreground', 'middleground', 'background'];
      const rows: { indicator: string; layer: string; zone: string; n: number; median: number; iqr: number }[] = [];
      for (const ind of indSet) {
        for (const layer of layers) {
          for (const [key, entry] of buckets) {
            if (!key.startsWith(`${ind}|${layer}|`)) continue;
            if (entry.values.length === 0) continue;
            const sorted = [...entry.values].sort((a, b) => a - b);
            const q = (p: number) => {
              const i = p * (sorted.length - 1);
              const lo = Math.floor(i);
              const hi = Math.ceil(i);
              return lo === hi ? sorted[lo] : sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
            };
            rows.push({
              indicator: ind,
              layer,
              zone: entry.zone,
              n: entry.values.length,
              median: q(0.5),
              iqr: q(0.75) - q(0.25),
            });
          }
        }
      }
      return { analysis_mode: ctx.analysisMode, zone_count: ctx.sortedDiagnostics.length, rows };
    },
    exportRows: (ctx) => {
      const buckets = new Map<string, { zone_id: string; zone_name: string; indicator_id: string; layer: string; values: number[] }>();
      for (const r of ctx.imageRecords) {
        if (typeof r.value !== 'number') continue;
        const key = `${r.indicator_id}|${r.layer}|${r.zone_id}`;
        const entry = buckets.get(key) ?? {
          zone_id: r.zone_id, zone_name: r.zone_name,
          indicator_id: r.indicator_id, layer: r.layer, values: [],
        };
        entry.values.push(r.value);
        buckets.set(key, entry);
      }
      const rows: Record<string, unknown>[] = [];
      for (const entry of buckets.values()) {
        const sorted = [...entry.values].sort((a, b) => a - b);
        const q = (p: number) => {
          const i = p * (sorted.length - 1);
          const lo = Math.floor(i);
          const hi = Math.ceil(i);
          return lo === hi ? sorted[lo] : sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
        };
        const mean = entry.values.reduce((a, b) => a + b, 0) / entry.values.length;
        const variance = entry.values.length > 1
          ? entry.values.reduce((a, b) => a + (b - mean) ** 2, 0) / (entry.values.length - 1)
          : 0;
        rows.push({
          zone_id: entry.zone_id,
          zone_name: entry.zone_name,
          indicator_id: entry.indicator_id,
          layer: entry.layer,
          n_images: entry.values.length,
          min: Number(sorted[0].toFixed(4)),
          q1: Number(q(0.25).toFixed(4)),
          median: Number(q(0.5).toFixed(4)),
          q3: Number(q(0.75).toFixed(4)),
          max: Number(sorted[sorted.length - 1].toFixed(4)),
          mean: Number(mean.toFixed(4)),
          std: Number(Math.sqrt(variance).toFixed(4)),
        });
      }
      return {
        columns: [
          { key: 'zone_id', label: 'Zone ID' },
          { key: 'zone_name', label: 'Zone' },
          { key: 'indicator_id', label: 'Indicator' },
          { key: 'layer', label: 'Layer' },
          { key: 'n_images', label: 'N images' },
          { key: 'min', label: 'Min' },
          { key: 'q1', label: 'Q1' },
          { key: 'median', label: 'Median' },
          { key: 'q3', label: 'Q3' },
          { key: 'max', label: 'Max' },
          { key: 'mean', label: 'Mean' },
          { key: 'std', label: 'Std' },
        ],
        rows,
      };
    },
    render: (ctx) => (
      <WithinZoneImageDistribution
        imageRecords={ctx.imageRecords}
        indicatorDefs={ctx.indicatorDefs}
      />
    ),
  },
  {
    // v4 / Module 6.3.3 — adds a "Dominant indicator per point" toggle
    // panel migrated from B4. Default view is unchanged: per-indicator
    // 4-layer value heatmap.
    id: 'value-spatial-grid',
    title: 'Indicator Value Map — geographic, by layer',
    refCode: 'C4',
    tab: 'analysis',
    section: 'indicator',
    exportByDefault: true,
    description:
      'Stage 4/4 · Geographic — per indicator, four small maps coloured by raw value across Full / Foreground / Middleground / Background layers. Toggle to "Dominant indicator per point" for the cross-indicator dominant-signal map (migrated from B4 right-half). INCREASE indicators darken when higher; DECREASE indicators darken when lower.',
    viableInModes: ['single_zone', 'multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.gpsImages.length > 0 && ctx.gpsIndicatorIds.length > 0,
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zone_count: ctx.sortedDiagnostics.length,
      n_gps_points: ctx.gpsImages.length,
      indicator_ranges: ctx.gpsIndicatorIds.slice(0, 20).map((ind) => {
        const vals: number[] = [];
        for (const img of ctx.gpsImages) {
          const v = img.metrics_results?.[ind] ?? img.metrics_results?.[`${ind}__full`];
          if (typeof v === 'number') vals.push(v);
        }
        if (vals.length === 0) return { indicator: ind, n: 0 };
        return {
          indicator: ind,
          n: vals.length,
          min: Math.min(...vals),
          max: Math.max(...vals),
          mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        };
      }),
    }),
    render: (ctx) => {
      const defs = ctx.zoneAnalysisResult?.indicator_definitions || {};
      return (
        <IndicatorValueMapWithToggle
          gpsImages={ctx.gpsImages}
          indicatorIds={ctx.gpsIndicatorIds}
          indicatorDefs={defs}
          colorblindMode={ctx.colorblindMode}
        />
      );
    },
  },

  // ── Section D · Reference & Cross-Cutting ────────────────────────────
  {
    id: 'global-stats-table',
    title: 'Global Descriptive Statistics — per indicator × layer',
    refCode: 'D1',
    tab: 'analysis',
    section: 'reference',
    description: 'Image-level pooled per indicator × layer. Per-indicator Mean ± Std by layer, CV, Shapiro-Wilk, Kruskal-Wallis.',
    viableInModes: ['single_zone', 'multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.globalIndicatorStats.length > 0,
    exportRows: (ctx) => {
      const cols = [
        { key: 'indicator_id', label: 'Indicator' },
        { key: 'cv_full', label: 'CV (Full)' },
        { key: 'shapiro_p', label: 'Shapiro-Wilk p' },
        { key: 'kruskal_p', label: 'Kruskal-Wallis p' },
        ...LAYERS_FOR_PAYLOAD.flatMap((layer) => [
          { key: `${layer}_n`, label: `${layer} N` },
          { key: `${layer}_mean`, label: `${layer} Mean` },
          { key: `${layer}_std`, label: `${layer} Std` },
        ]),
      ];
      const rows = ctx.globalIndicatorStats.map((s) => {
        const row: Record<string, unknown> = {
          indicator_id: s.indicator_id,
          cv_full: s.cv_full ?? '',
          shapiro_p: s.shapiro_p ?? '',
          kruskal_p: s.kruskal_p ?? '',
        };
        for (const layer of LAYERS_FOR_PAYLOAD) {
          const v = s.by_layer?.[layer];
          row[`${layer}_n`] = v?.N ?? '';
          row[`${layer}_mean`] = v?.Mean ?? '';
          row[`${layer}_std`] = v?.Std ?? '';
        }
        return row;
      });
      return { columns: cols, rows };
    },
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zone_count: ctx.sortedDiagnostics.length,
      // Per indicator × layer: trimmed to 10 indicators × 4 layers.
      rows: ctx.globalIndicatorStats.slice(0, 10).map((s) => ({
        indicator: s.indicator_id,
        cv_full: s.cv_full ?? null,
        shapiro_p: s.shapiro_p ?? null,
        kruskal_p: s.kruskal_p ?? null,
        by_layer: Object.fromEntries(
          LAYERS_FOR_PAYLOAD.map((layer) => {
            const v = s.by_layer?.[layer];
            return v
              ? [layer, { n: v.N, mean: v.Mean, std: v.Std }]
              : [layer, null];
          }).filter(([, v]) => v != null),
        ),
      })),
    }),
    render: (ctx) => <GlobalStatsTable stats={ctx.globalIndicatorStats} />,
  },
  {
    id: 'zone-indicator-matrix',
    title: 'Zone × Indicator Mean Matrix',
    refCode: 'D2',
    tab: 'analysis',
    section: 'reference',
    description:
      'Absolute mean values per zone per indicator (full layer) plus a global-mean reference row.',
    viableInModes: ['multi_zone', 'cluster'],
    isAvailable: (ctx) => ctx.filteredStats.length > 0,
    exportRows: (ctx) => ({
      columns: [
        { key: 'zone_name', label: 'Zone' },
        { key: 'indicator_id', label: 'Indicator' },
        { key: 'mean', label: 'Mean' },
        { key: 'std', label: 'Std' },
        { key: 'N', label: 'N' },
        { key: 'layer', label: 'Layer' },
      ],
      rows: ctx.filteredStats.map((s) => ({
        zone_name: s.zone_name,
        indicator_id: s.indicator_id,
        mean: s.mean != null ? Number(s.mean.toFixed(3)) : '',
        std: s.std != null ? Number(s.std.toFixed(3)) : '',
        N: s.n_images ?? 0,
        layer: s.layer,
      })),
    }),
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zone_count: ctx.sortedDiagnostics.length,
      layer: ctx.selectedLayer,
      rows: compactZoneStats(ctx, ctx.selectedLayer),
    }),
    render: (ctx) => {
      const stats = ctx.filteredStats;
      const zones = Array.from(new Set(stats.map((s) => s.zone_name))).sort();
      const indicators = Array.from(new Set(stats.map((s) => s.indicator_id))).sort();
      const grid: Record<string, Record<string, number | null>> = {};
      for (const s of stats) {
        if (!grid[s.zone_name]) grid[s.zone_name] = {};
        grid[s.zone_name][s.indicator_id] = s.mean ?? null;
      }
      const globalMean: Record<string, number | null> = {};
      for (const ind of indicators) {
        const vals = stats
          .filter((s) => s.indicator_id === ind && s.mean != null)
          .map((s) => s.mean!);
        globalMean[ind] = vals.length > 0
          ? vals.reduce((a, b) => a + b, 0) / vals.length
          : null;
      }
      return (
        <Box overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>Zone</Th>
                {indicators.map((ind) => (
                  <Th key={ind} isNumeric>
                    <Tooltip label={ind}>
                      <Text noOfLines={1} maxW="70px">{ind}</Text>
                    </Tooltip>
                  </Th>
                ))}
              </Tr>
            </Thead>
            <Tbody>
              {zones.map((zone) => (
                <Tr key={zone}>
                  <Td fontSize="xs" fontWeight="medium">{zone}</Td>
                  {indicators.map((ind) => (
                    <Td key={ind} isNumeric fontSize="xs">
                      {grid[zone]?.[ind] != null ? grid[zone][ind]!.toFixed(2) : '—'}
                    </Td>
                  ))}
                </Tr>
              ))}
              <Tr bg="gray.50" fontWeight="bold">
                <Td fontSize="xs">Global Mean</Td>
                {indicators.map((ind) => (
                  <Td key={ind} isNumeric fontSize="xs">
                    {globalMean[ind] != null ? globalMean[ind]!.toFixed(2) : '—'}
                  </Td>
                ))}
              </Tr>
            </Tbody>
          </Table>
        </Box>
      );
    },
  },
  {
    id: 'correlation-heatmap',
    title: 'Indicator Correlation — pairwise, by layer',
    refCode: 'D3',
    tab: 'analysis',
    section: 'reference',
    exportByDefault: true,
    description:
      'Pairwise correlation between indicators across the four layers. Compare which couplings are layer-specific vs. consistent.',
    viableInModes: ['multi_zone', 'cluster'],
    isAvailable: (ctx) => {
      const za = ctx.zoneAnalysisResult;
      if (!za?.correlation_by_layer) return false;
      return LAYERS_FOR_PAYLOAD.some(
        (l) => za.correlation_by_layer[l] && Object.keys(za.correlation_by_layer[l]).length > 0,
      );
    },
    render: (ctx) => {
      const za = ctx.zoneAnalysisResult!;
      return (
        <ResponsiveSmallMultiples minPanelWidth={360}>
          {LAYERS_FOR_PAYLOAD.map((layer) => {
            const corr = za.correlation_by_layer?.[layer];
            const pval = za.pvalue_by_layer?.[layer];
            const indicators = corr ? Object.keys(corr) : [];
            return (
              <Box key={layer}>
                <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center">
                  {LAYER_LABELS[layer]}
                </Text>
                {indicators.length > 0 ? (
                  <CorrelationHeatmap
                    corr={corr!}
                    pval={pval}
                    indicators={indicators}
                    colorblindMode={ctx.colorblindMode}
                  />
                ) : (
                  <Text fontSize="xs" color="gray.400" textAlign="center">No data</Text>
                )}
              </Box>
            );
          })}
        </ResponsiveSmallMultiples>
      );
    },
    summaryPayload: (ctx) => ({
      analysis_mode: ctx.analysisMode,
      zone_count: ctx.sortedDiagnostics.length,
      by_layer: correlationByLayer(ctx),
    }),
    exportRows: (ctx) => {
      const za = ctx.zoneAnalysisResult;
      const rows: Record<string, unknown>[] = [];
      if (za?.correlation_by_layer) {
        for (const layer of LAYERS_FOR_PAYLOAD) {
          const corr: Record<string, Record<string, number>> | undefined = za.correlation_by_layer[layer];
          const pval: Record<string, Record<string, number>> | undefined = za.pvalue_by_layer?.[layer];
          if (!corr) continue;
          const inds: string[] = Object.keys(corr);
          for (let i = 0; i < inds.length; i++) {
            for (let j = i + 1; j < inds.length; j++) {
              const a = inds[i];
              const b = inds[j];
              const r = corr[a]?.[b];
              if (r == null) continue;
              rows.push({
                layer,
                indicator_a: a,
                indicator_b: b,
                correlation: Number(r.toFixed(3)),
                p_value: pval?.[a]?.[b] != null ? Number(pval[a][b]!.toFixed(4)) : '',
              });
            }
          }
        }
      }
      return {
        columns: [
          { key: 'layer', label: 'Layer' },
          { key: 'indicator_a', label: 'Indicator A' },
          { key: 'indicator_b', label: 'Indicator B' },
          { key: 'correlation', label: 'Correlation (r)' },
          { key: 'p_value', label: 'p-value' },
        ],
        rows,
      };
    },
  },

  // ── Section E · Cluster Diagnostics ──────────────────────────────────
  // v6.2 — GMM-BIC clustering (replaced the earlier KMeans+silhouette-K and
  // density-based approaches). The charts below cover algorithm interpretation
  // (centroid heatmap), geographic validation (spatial map — already exists
  // as ClusterSpatialBeforeAfter), and quality assessment (per-point
  // silhouette + silhouette-score curve).
  {
    id: 'cluster-centroid-heatmap',
    title: 'Cluster Centroid Heatmap',
    refCode: 'E1',
    tab: 'analysis',
    section: 'clustering',
    description:
      'Mean z-score per cluster × indicator. Read each row to interpret the cluster (e.g. "high green / low artificial").',
    viableInModes: ['cluster'],
    isAvailable: (ctx) =>
      !!ctx.effectiveClustering &&
      ctx.effectiveClustering.archetype_profiles.length > 0,
    summaryPayload: (ctx) => {
      const cl = ctx.effectiveClustering;
      if (!cl) return null;
      // Per cluster: top-3 most positive z indicators + top-3 most negative.
      const profiles = cl.archetype_profiles.map((a) => {
        const entries = Object.entries(a.centroid_z_scores ?? {});
        const sorted = [...entries].sort((x, y) => y[1] - x[1]);
        return {
          archetype_id: a.archetype_id,
          archetype_label: a.archetype_label,
          point_count: a.point_count,
          top3_high: sorted.slice(0, 3).map(([k, v]) => ({ indicator: k, z: Number(v.toFixed(2)) })),
          top3_low:  sorted.slice(-3).map(([k, v]) => ({ indicator: k, z: Number(v.toFixed(2)) })),
        };
      });
      return {
        analysis_mode: ctx.analysisMode,
        n_clusters: cl.archetype_profiles.length,
        profiles,
      };
    },
    render: (ctx) => (
      <ClusterCentroidHeatmap archetypes={ctx.effectiveClustering!.archetype_profiles} />
    ),
  },
  {
    id: 'silhouette-per-point',
    title: 'Per-Point Silhouette Plot',
    refCode: 'E2',
    tab: 'analysis',
    section: 'clustering',
    description:
      'Silhouette coefficient per point, grouped and sorted within cluster. Negative bars indicate boundary/misclassified points.',
    viableInModes: ['cluster'],
    isAvailable: (ctx) =>
      !!ctx.effectiveClustering?.silhouette_per_point &&
      ctx.effectiveClustering.silhouette_per_point.length > 0,
    summaryPayload: (ctx) => {
      const cl = ctx.effectiveClustering;
      if (!cl?.silhouette_per_point) return null;
      const sils = cl.silhouette_per_point;
      const labels = cl.labels_smoothed ?? [];
      const byCluster = new Map<number, number[]>();
      for (let i = 0; i < sils.length; i++) {
        const s = sils[i];
        if (s == null) continue;
        const c = labels[i] ?? -1;
        if (c < 0) continue;
        const list = byCluster.get(c) ?? [];
        list.push(s);
        byCluster.set(c, list);
      }
      const perCluster = Array.from(byCluster.entries()).map(([cid, vals]) => {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const nNeg = vals.filter((v) => v < 0).length;
        return {
          cluster_id: cid,
          n: vals.length,
          mean_silhouette: Number(mean.toFixed(3)),
          pct_negative: Number((100 * nNeg / vals.length).toFixed(1)),
        };
      }).sort((a, b) => a.cluster_id - b.cluster_id);
      const finiteSils = sils.filter((v): v is number => v != null);
      const overall = finiteSils.length
        ? Number((finiteSils.reduce((a, b) => a + b, 0) / finiteSils.length).toFixed(3))
        : 0;
      return {
        analysis_mode: ctx.analysisMode,
        n_points: sils.length,
        overall_mean_silhouette: overall,
        per_cluster: perCluster,
      };
    },
    render: (ctx) => {
      const cl = ctx.effectiveClustering!;
      return (
        <SilhouettePerPointPlot
          silhouettePerPoint={cl.silhouette_per_point ?? []}
          labelsSmoothed={cl.labels_smoothed}
          archetypes={cl.archetype_profiles}
          noisePointIds={cl.noise_point_ids ?? []}
          pointIdsOrdered={cl.point_ids_ordered}
        />
      );
    },
  },
  {
    id: 'silhouette-curve',
    title: 'Silhouette Score Curve (KMeans last-resort fallback)',
    refCode: 'E3',
    tab: 'analysis',
    section: 'clustering',
    description:
      'Per-K silhouette curve from the KMeans last-resort fallback. The presence of this chart means GMM (BIC-selected K) failed to find ≥2 clusters on this data, so the service swept K=2..max_k with KMeans. The selected K uses a multi-criterion vote across silhouette + Davies-Bouldin + Calinski-Harabasz — NOT just the silhouette peak — so a low-K silhouette winner can be overridden by other criteria. Silhouette interpretation: ≥0.5 strong cluster separation, 0.25-0.5 weak/overlapping, ≤0.25 essentially no structure. If silhouette is ≤0.25 across all K, the data genuinely has no rich cluster structure and K=2 (or even reporting "no clustering applicable") is the honest answer.',
    viableInModes: ['cluster'],
    isAvailable: (ctx) =>
      !!ctx.effectiveClustering?.silhouette_scores &&
      ctx.effectiveClustering.silhouette_scores.length > 1,
    summaryPayload: (ctx) => {
      const cl = ctx.effectiveClustering;
      if (!cl?.silhouette_scores) return null;
      const scores = cl.silhouette_scores.map((s) => ({
        k: s.k,
        silhouette: Number((s.silhouette ?? 0).toFixed(3)),
      }));
      const sorted = [...scores].sort((a, b) => b.silhouette - a.silhouette);
      return {
        analysis_mode: ctx.analysisMode,
        selected_k: cl.k,
        peak_k: sorted[0]?.k ?? null,
        peak_silhouette: sorted[0]?.silhouette ?? null,
        scores,
      };
    },
    render: (ctx) => (
      <SilhouetteCurve
        scores={ctx.effectiveClustering!.silhouette_scores}
        bestK={ctx.effectiveClustering!.k}
      />
    ),
  },
  {
    id: 'dendrogram',
    title: 'Ward Hierarchical Clustering',
    refCode: 'E4',
    tab: 'analysis',
    section: 'clustering',
    description: 'Dendrogram from Ward linkage.',
    viableInModes: ['cluster'],
    isAvailable: (ctx) =>
      !!ctx.effectiveClustering?.dendrogram_linkage &&
      ctx.effectiveClustering.dendrogram_linkage.length > 0,
    summaryPayload: (ctx) => {
      const cl = ctx.effectiveClustering;
      if (!cl?.dendrogram_linkage) return null;
      const linkage = cl.dendrogram_linkage;
      const distances = linkage.map((row) => row[2]);
      const maxD = distances.length ? Math.max(...distances) : 0;
      const cutD = 0.7 * maxD;
      return {
        analysis_mode: ctx.analysisMode,
        n_leaves: linkage.length + 1,
        max_linkage_distance: Number(maxD.toFixed(2)),
        cut_threshold: Number(cutD.toFixed(2)),
        n_clusters_at_cut: cl.archetype_profiles.length,
      };
    },
    render: (ctx) => <Dendrogram linkage={ctx.effectiveClustering!.dendrogram_linkage} />,
  },
  {
    id: 'cluster-spatial-smoothing',
    title: 'Cluster Spatial Smoothing',
    refCode: 'E5',
    tab: 'analysis',
    section: 'clustering',
    description: 'Before/after KNN spatial smoothing comparison (needs GPS).',
    viableInModes: ['cluster'],
    isAvailable: (ctx) =>
      !!ctx.effectiveClustering?.point_lats &&
      ctx.effectiveClustering.point_lats.length > 0 &&
      !!ctx.effectiveClustering.labels_raw &&
      ctx.effectiveClustering.labels_raw.length > 0,
    summaryPayload: (ctx) => {
      const cl = ctx.effectiveClustering;
      if (!cl?.labels_raw || !cl.labels_smoothed) return null;
      const raw = cl.labels_raw;
      const sm  = cl.labels_smoothed;
      const n = Math.min(raw.length, sm.length);
      let changed = 0;
      for (let i = 0; i < n; i++) if (raw[i] !== sm[i]) changed++;
      return {
        analysis_mode: ctx.analysisMode,
        n_points: n,
        n_changed: changed,
        pct_changed: Number((100 * changed / Math.max(1, n)).toFixed(1)),
        has_gps: (cl.point_lats?.length ?? 0) > 0,
      };
    },
    render: (ctx) => {
      const cl = ctx.effectiveClustering!;
      return (
        <ClusterSpatialBeforeAfter
          lats={cl.point_lats}
          lngs={cl.point_lngs}
          labelsRaw={cl.labels_raw}
          labelsSmoothed={cl.labels_smoothed}
          archetypeLabels={Object.fromEntries(
            cl.archetype_profiles.map((a) => [a.archetype_id, a.archetype_label]),
          )}
        />
      );
    },
  },
  {
    id: 'archetype-radar',
    title: 'Cluster Radar Profiles',
    refCode: 'E6',
    tab: 'analysis',
    section: 'clustering',
    description: 'z-score radar for each discovered cluster.',
    viableInModes: ['cluster'],
    isAvailable: (ctx) =>
      !!ctx.effectiveClustering && ctx.effectiveClustering.archetype_profiles.length > 0,
    summaryPayload: (ctx) => {
      const cl = ctx.effectiveClustering;
      if (!cl) return null;
      const profiles = cl.archetype_profiles.map((a) => {
        const entries = Object.entries(a.centroid_values ?? {});
        const sorted = [...entries].sort((x, y) => (y[1] as number) - (x[1] as number));
        return {
          archetype_id: a.archetype_id,
          archetype_label: a.archetype_label,
          point_count: a.point_count,
          peak_indicators: sorted.slice(0, 3).map(([k, v]) => ({ indicator: k, value: Number((v as number).toFixed(3)) })),
        };
      });
      return {
        analysis_mode: ctx.analysisMode,
        n_clusters: cl.archetype_profiles.length,
        profiles,
      };
    },
    render: (ctx) => (
      <ArchetypeRadarChart archetypes={ctx.effectiveClustering!.archetype_profiles} />
    ),
  },
  {
    id: 'cluster-size-distribution',
    title: 'Cluster Size Distribution',
    refCode: 'E7',
    tab: 'analysis',
    section: 'clustering',
    description: 'Point count per cluster.',
    viableInModes: ['cluster'],
    isAvailable: (ctx) =>
      !!ctx.effectiveClustering && ctx.effectiveClustering.archetype_profiles.length > 0,
    summaryPayload: (ctx) => {
      const cl = ctx.effectiveClustering;
      if (!cl) return null;
      const total = cl.archetype_profiles.reduce((s, a) => s + a.point_count, 0) || 1;
      const sizes = cl.archetype_profiles.map((a) => ({
        archetype_id: a.archetype_id,
        archetype_label: a.archetype_label,
        count: a.point_count,
        share_pct: Number((100 * a.point_count / total).toFixed(1)),
      }));
      return {
        analysis_mode: ctx.analysisMode,
        n_clusters: cl.archetype_profiles.length,
        total_points: total,
        sizes,
      };
    },
    render: (ctx) => <ClusterSizeChart archetypes={ctx.effectiveClustering!.archetype_profiles} />,
  },
];

// Re-export so consumers can render the section heading next to chart groups.
export function getDescriptorBySection(
  section: ChartSection,
): ChartDescriptor[] {
  return CHART_REGISTRY.filter((c) => c.section === section);
}
