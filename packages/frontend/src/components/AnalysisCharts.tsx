import { useMemo, useState } from 'react';
import { Box, Button, ButtonGroup, HStack, SimpleGrid, Text, Tooltip as ChakraTooltip, VStack } from '@chakra-ui/react';
import { robustGpsBbox } from '../utils/chartLayout';
import { ResponsiveSmallMultiples } from './analysisCharts/ResponsiveSmallMultiples';
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
  ErrorBar,
  LabelList,
  LineChart,
  Line,
  ReferenceLine,
} from 'recharts';
import type { EnrichedZoneStat, ZoneDiagnostic, ArchetypeProfile, UploadedImage, ImageRecord, GlobalIndicatorStats, DataQualityRow, IndicatorDefinitionInput } from '../types';
import { divergingColor, directionalColor, magnitudeColor, parulaColor } from '../utils/palette';

// Shared color palette for zones
const ZONE_COLORS = [
  '#3182CE', '#38A169', '#D69E2E', '#E53E3E', '#805AD5',
  '#DD6B20', '#319795', '#D53F8C', '#2B6CB0', '#276749',
];

function getZoneColor(index: number): string {
  return ZONE_COLORS[index % ZONE_COLORS.length];
}

// v6.0: color by mean_abs_z deviation level (purely descriptive)
function deviationBarColor(meanAbsZ: number): string {
  if (meanAbsZ >= 1.5) return '#E53E3E';
  if (meanAbsZ >= 1.0) return '#DD6B20';
  if (meanAbsZ >= 0.5) return '#D69E2E';
  return '#38A169';
}

// ─── Radar Profile Chart ────────────────────────────────────────────────────

interface RadarProfileChartProps {
  radarProfiles: Record<string, Record<string, number>>;
  /** v4 polish — when rendered as part of the 4-up "by-layer" small
   *  multiples, the parent renders ONE shared legend below all panels
   *  (avoids 4 redundant copies of the same K-cluster legend chewing
   *  up vertical space). Default true keeps the standalone (non-small-
   *  multiples) usage backward-compatible. */
  showLegend?: boolean;
  /** When false, suppresses the per-panel hover Tooltip too — the
   *  caller probably wants pixel-perfect parity across panels. */
  showTooltip?: boolean;
  /** Optional title above the radar (e.g. "Full" / "FG"). When omitted
   *  the caller is responsible for labeling. */
  panelTitle?: string;
  /** Issue 3 v3 — when set, the custom tooltip renders only the top N
   *  series (by value, descending) instead of all K, plus a "+M more"
   *  affordance. Keeps the tooltip a small floating box (~140px tall)
   *  that doesn't block the radar even with K=11+ clusters. Default 5
   *  hits a sweet spot between info density and footprint. */
  tooltipTopN?: number;
}

/** v4 polish — exposed so parents (e.g. registry.tsx B3) can render a
 *  single shared legend using the same color mapping the small-multiples
 *  panels use. Stable across renders for a given zone index. */
export function radarProfileColor(index: number): string {
  return getZoneColor(index);
}

/** Issue 3 v3 — per-vertex hover state for RadarProfileChart. The
 *  default Recharts <Tooltip /> shows ALL series' values at a hovered
 *  indicator angle, which with K=11 clusters becomes a giant box that
 *  blocks the chart. Instead we render visible dots at every (zone,
 *  indicator) vertex and capture mouseEnter/Leave on each one to drive
 *  a small floating value display.
 *
 *  Pattern: lift `hoveredVertex` into RadarProfileChart's own state, pass
 *  it to a custom dot component that updates it on mouse events, and
 *  render a single floating tooltip absolutely-positioned next to the
 *  cursor.
 */
type HoveredVertex = {
  zone: string;
  indicator: string;
  value: number;
  cx: number;
  cy: number;
  color: string;
} | null;

interface RadarHoverDotProps {
  cx?: number;
  cy?: number;
  payload?: { indicator?: string; [k: string]: unknown };
  dataKey?: string;
  fill?: string;
  // Closures we inject:
  onHover?: (v: NonNullable<HoveredVertex>) => void;
  onLeave?: () => void;
}

function RadarHoverDot(props: RadarHoverDotProps) {
  const { cx, cy, payload, dataKey, fill, onHover, onLeave } = props;
  if (cx == null || cy == null || !dataKey) return null;
  const value = (payload?.[dataKey] as number | undefined) ?? 0;
  const indicator = (payload?.indicator as string | undefined) ?? '';
  return (
    <circle
      cx={cx}
      cy={cy}
      r={3.5}
      fill={fill ?? '#999'}
      stroke="#fff"
      strokeWidth={1}
      style={{ cursor: 'pointer' }}
      onMouseEnter={() =>
        onHover?.({
          zone: dataKey,
          indicator,
          value,
          cx,
          cy,
          color: fill ?? '#999',
        })
      }
      onMouseLeave={() => onLeave?.()}
    />
  );
}

function VertexValueTooltip({ vertex }: { vertex: NonNullable<HoveredVertex> }) {
  return (
    <Box
      position="absolute"
      // 14px offset so the cursor doesn't sit on top of the tooltip and
      // re-trigger an mouseLeave on the dot. pointerEvents:none belt-and-
      // suspenders so the tooltip itself never intercepts mouse events.
      left={`${vertex.cx + 14}px`}
      top={`${vertex.cy - 4}px`}
      bg="white"
      px={2}
      py={1}
      borderRadius="md"
      shadow="md"
      borderWidth={1}
      borderColor="gray.200"
      pointerEvents="none"
      fontSize="2xs"
      whiteSpace="nowrap"
      zIndex={10}
    >
      <HStack spacing={1.5} align="center">
        <Box w="8px" h="8px" borderRadius="full" bg={vertex.color} flexShrink={0} />
        <Text fontSize="2xs" fontWeight="semibold" color="gray.700" maxW="160px" noOfLines={1}>
          {vertex.zone}
        </Text>
      </HStack>
      <HStack spacing={1.5} mt={0.5} justify="space-between">
        <Text fontSize="2xs" color="gray.500">{vertex.indicator}</Text>
        <Text fontSize="xs" fontWeight="bold" color="gray.900">
          {Number.isFinite(vertex.value) ? vertex.value.toFixed(1) : '—'}
        </Text>
      </HStack>
    </Box>
  );
}

export function RadarProfileChart({
  radarProfiles,
  showLegend = true,
  showTooltip = true,
  panelTitle,
}: RadarProfileChartProps) {
  const { data, zones } = useMemo(() => {
    const zoneNames = Object.keys(radarProfiles);
    const allIndicators = Array.from(
      new Set(zoneNames.flatMap(z => Object.keys(radarProfiles[z]))),
    ).sort();

    const chartData = allIndicators.map(ind => {
      const row: Record<string, string | number> = { indicator: ind };
      for (const zone of zoneNames) {
        row[zone] = radarProfiles[zone]?.[ind] ?? 0;
      }
      return row;
    });

    return { data: chartData, zones: zoneNames };
  }, [radarProfiles]);

  // Issue 3 v3 — per-vertex hover state. Stored at component level so a
  // single absolute-positioned <VertexValueTooltip> can render above the
  // chart whenever the user hovers a specific dot. Replaces the default
  // Recharts <Tooltip /> which would dump all K series' values at once.
  const [hoveredVertex, setHoveredVertex] = useState<HoveredVertex>(null);

  if (zones.length === 0 || data.length === 0) return null;

  // v4 polish — when no legend is shown, drop the panel height a bit
  // (legends previously ate ~80px of the 400px). The radar itself stays
  // at outerRadius 75%, just the container gets shorter.
  const chartHeight = showLegend ? 400 : 320;

  return (
    <Box position="relative">
      {panelTitle && (
        <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center">
          {panelTitle}
        </Text>
      )}
      <ResponsiveContainer width="100%" height={chartHeight}>
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="80%">
          <PolarGrid />
          <PolarAngleAxis
            dataKey="indicator"
            tick={{ fontSize: 9 }}
            tickLine={false}
            tickFormatter={(v: string) => v.length > 10 ? v.slice(0, 10) + '…' : v}
          />
          <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 10 }} />
          {zones.map((zone, i) => (
            <Radar
              key={zone}
              name={zone}
              dataKey={zone}
              stroke={getZoneColor(i)}
              fill={getZoneColor(i)}
              fillOpacity={0.15}
              // Issue 3 v3 — per-vertex dot with hover capture. When the
              // user hovers a specific dot, lift the (zone, indicator,
              // value) up to component state and render a small tooltip
              // beside it. Each polygon's dots are rendered in its own
              // colour so the user can pick out a specific cluster
              // visually before hovering.
              dot={
                <RadarHoverDot
                  onHover={setHoveredVertex}
                  onLeave={() => setHoveredVertex(null)}
                />
              }
              activeDot={false}
            />
          ))}
          {showLegend && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {/* The default per-angle Recharts tooltip is replaced by the
              per-vertex one below. showTooltip prop is honoured for the
              standalone single-RadarProfileChart cases (legacy) where
              the default tooltip is fine for K<=4. For the small-multiples
              path the parent passes showTooltip={false}. */}
          {showTooltip && <Tooltip />}
        </RadarChart>
      </ResponsiveContainer>
      {/* Per-vertex floating value display. Renders only while hovering
          a dot; absolute-positioned at the dot's screen coordinates so
          it sits next to (not over) the cursor. pointerEvents:none on
          the tooltip box prevents recursive mouseLeave events. */}
      {hoveredVertex && <VertexValueTooltip vertex={hoveredVertex} />}
    </Box>
  );
}

// ─── Radar Profile By Layer (matches notebook Fig 4) ──────────────────────
// Shows one small radar per zone with 4 overlaid polygons (full/FG/MG/BG).

const RBL_LAYER_ORDER = ['full', 'foreground', 'middleground', 'background'];
const RBL_LAYER_LABELS: Record<string, string> = {
  full: 'Full',
  foreground: 'FG',
  middleground: 'MG',
  background: 'BG',
};
const RBL_LAYER_COLORS: Record<string, string> = {
  full: '#3498db',
  foreground: '#e74c3c',
  middleground: '#2ecc71',
  background: '#9b59b6',
};

interface RadarProfileByLayerProps {
  radarProfilesByLayer: Record<string, Record<string, Record<string, number>>>;
}

export function RadarProfileByLayer({ radarProfilesByLayer }: RadarProfileByLayerProps) {
  const { zones, perZoneData } = useMemo(() => {
    // Union of zones across all layers
    const zoneSet = new Set<string>();
    const indSet = new Set<string>();
    for (const layer of Object.keys(radarProfilesByLayer)) {
      const zd = radarProfilesByLayer[layer];
      for (const zone of Object.keys(zd)) {
        zoneSet.add(zone);
        for (const ind of Object.keys(zd[zone])) indSet.add(ind);
      }
    }
    const zoneList = Array.from(zoneSet).sort();
    const indList = Array.from(indSet).sort();

    // Per-zone chart rows: [{ indicator, full, foreground, middleground, background }, ...]
    const data: Record<string, { indicator: string; [layer: string]: string | number }[]> = {};
    for (const zone of zoneList) {
      data[zone] = indList.map(ind => {
        const row: { indicator: string; [layer: string]: string | number } = { indicator: ind };
        for (const layer of RBL_LAYER_ORDER) {
          const v = radarProfilesByLayer[layer]?.[zone]?.[ind];
          row[layer] = v ?? 0;
        }
        return row;
      });
    }
    return { zones: zoneList, perZoneData: data };
  }, [radarProfilesByLayer]);

  if (zones.length === 0) return null;

  return (
    <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} spacing={4}>
      {zones.map(zone => (
        <Box key={zone}>
          <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center" noOfLines={1}>
            {zone}
          </Text>
          <ResponsiveContainer width="100%" height={260}>
            <RadarChart data={perZoneData[zone]} cx="50%" cy="50%" outerRadius="70%">
              <PolarGrid />
              <PolarAngleAxis
                dataKey="indicator"
                tick={{ fontSize: 9 }}
                tickLine={false}
                tickFormatter={(v: string) => (v.length > 8 ? v.slice(0, 8) + '…' : v)}
              />
              <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 8 }} />
              {RBL_LAYER_ORDER.map(layer => (
                <Radar
                  key={layer}
                  name={RBL_LAYER_LABELS[layer]}
                  dataKey={layer}
                  stroke={RBL_LAYER_COLORS[layer]}
                  fill={RBL_LAYER_COLORS[layer]}
                  fillOpacity={layer === 'full' ? 0.15 : 0}
                  strokeWidth={layer === 'full' ? 2 : 1.5}
                />
              ))}
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Tooltip />
            </RadarChart>
          </ResponsiveContainer>
        </Box>
      ))}
    </SimpleGrid>
  );
}

// ─── Zone Deviation Chart (v6.0 descriptive) ──────────────────────────────

interface ZonePriorityChartProps {
  diagnostics: ZoneDiagnostic[];
}

export function ZonePriorityChart({ diagnostics }: ZonePriorityChartProps) {
  const data = useMemo(() => {
    return [...diagnostics]
      .sort((a, b) => b.mean_abs_z - a.mean_abs_z)
      .map(d => ({
        zone: d.zone_name,
        mean_abs_z: Number(d.mean_abs_z?.toFixed(2) ?? 0),
        point_count: d.point_count,
      }));
  }, [diagnostics]);

  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={Math.max(250, data.length * 50)}>
      <BarChart data={data} layout="vertical" margin={{ left: 20, right: 30, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis type="number" tick={{ fontSize: 11 }} />
        <YAxis
          type="category"
          dataKey="zone"
          tick={{ fontSize: 11 }}
          width={120}
        />
        <Tooltip
          formatter={(value, name) => [
            (typeof value === 'number' ? value : 0) as number,
            name === 'mean_abs_z' ? 'Mean |z|' : 'Points',
          ]}
        />
        <Bar dataKey="mean_abs_z" name="Mean |z|" barSize={20}>
          {data.map((entry, i) => (
            <Cell key={i} fill={deviationBarColor(entry.mean_abs_z)} />
          ))}
          {/* v4.1 — value + n on each bar tip so the chart reads without
             requiring tooltip interaction. */}
          <LabelList
            dataKey="mean_abs_z"
            position="right"
            content={(props: { x?: number | string; y?: number | string;
                               width?: number | string; height?: number | string;
                               value?: number | string; index?: number }) => {
              const x = Number(props.x); const y = Number(props.y);
              const w = Number(props.width); const h = Number(props.height);
              const i = props.index;
              if (Number.isNaN(x) || Number.isNaN(y) || i == null) return null;
              const d = data[i];
              // v4.x — Defensive guard against white-screen: Recharts can call
              // this label renderer with stale indices during data transitions
              // (e.g. when the panorama view switch swaps the diagnostics
              // array mid-render). Without this guard `d.mean_abs_z` throws
              // and crashes the whole React tree.
              if (!d || typeof d.mean_abs_z !== 'number') return null;
              return (
                <text x={x + w + 6} y={y + h / 2}
                      dominantBaseline="central"
                      fontSize={11} fill="#1a202c" fontWeight={600}>
                  {d.mean_abs_z.toFixed(2)} · n={d.point_count ?? 0}
                </text>
              );
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Correlation Heatmap (SVG) ──────────────────────────────────────────────

interface CorrelationHeatmapProps {
  corr: Record<string, Record<string, number>>;
  pval?: Record<string, Record<string, number>>;
  indicators: string[];
  /** 5.10.8 — switch to Cividis when set, default red-blue otherwise. */
  colorblindMode?: boolean;
}

function corrColor(val: number, colorblindMode = false): string {
  if (colorblindMode) {
    return divergingColor(val, true);
  }
  const intensity = Math.min(Math.abs(val), 1);
  const alpha = 0.15 + intensity * 0.85;
  if (val > 0) return `rgba(49, 130, 206, ${alpha})`;   // blue
  if (val < 0) return `rgba(229, 62, 62, ${alpha})`;    // red
  return 'rgba(160, 174, 192, 0.2)';                     // gray
}

function significanceStars(p: number | undefined): string {
  if (p === undefined || p === null) return '';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return '';
}

// Margin helpers shared by both heatmaps. SVG <text> width is browser-dependent
// at runtime, so we approximate from char count: at fontSize px, a regular
// system font averages ~0.6 px per character. The rotated label's vertical
// projection is `length * sin(angle)`; we add padding for the diagonal stub
// that hangs below the rotation pivot and a top breathing gap.
const CHAR_WIDTH_RATIO = 0.6;

function rotatedLabelTopMargin(maxLabelChars: number, fontSize: number): number {
  // Required header zone above the column line for the rotated +45° labels
  // (textAnchor="end" pivoted at the column position; text body extends
  // UP-LEFT from there).
  //
  // Vertical extent of the text body above the pivot is the labelPx-long
  // diagonal projected onto the y-axis: labelPx * sin(45°) = labelPx * 0.707.
  // Add the cap height projection (fontSize * 0.707) for the part of the
  // text bbox above the baseline, plus a small breathing buffer.
  //
  //   labelPx       = maxLabelChars * fontSize * charWidthRatio
  //   verticalExtent= (labelPx + fontSize) * 0.707
  //   labelH        = verticalExtent + 6 (pivot offset) + 8 (top breathing pad)
  //
  // charWidthRatio = 0.75 absorbs system-ui's caps + underscore + digit
  // mix (real glyphs sit a bit wider than 0.6 but narrower than 0.9). The
  // 0.707 factor is exact for 45° rotation. The 14px total padding is
  // enough to prevent visual touching of the SVG top edge without leaving
  // a noticeable empty band.
  const charWidthRatio = 0.75;
  const labelPx = maxLabelChars * fontSize * charWidthRatio;
  const verticalExtent = (labelPx + fontSize) * 0.707;
  return Math.ceil(verticalExtent) + 14;
}

export function CorrelationHeatmap({ corr, pval, indicators, colorblindMode }: CorrelationHeatmapProps) {
  const n = indicators.length;
  const cellSize = Math.max(36, Math.min(48, 400 / Math.max(n, 1)));
  const colLabelFontSize = 10;
  const rowLabelFontSize = 10;
  const colLabelMaxChars = 10; // truncation threshold below
  const rowLabelMaxChars = 10;
  const labelHeight = rotatedLabelTopMargin(colLabelMaxChars, colLabelFontSize);
  // Left margin: longest row label (un-rotated) + breathing gap
  const labelWidth = Math.ceil(rowLabelMaxChars * rowLabelFontSize * CHAR_WIDTH_RATIO) + 14;
  // Bottom legend block (rect 12px high + 8px above + 8px below the cells)
  const legendHeight = 12;
  const legendGap = 8;
  const legendBottomPad = 8;

  if (n === 0) return null;

  const svgWidth = labelWidth + n * cellSize;
  const svgHeight = labelHeight + n * cellSize + legendGap + legendHeight + legendBottomPad;
  const legendY = labelHeight + n * cellSize + legendGap;

  return (
    <Box overflow="visible">
      <svg width={svgWidth} height={svgHeight} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {/* Column labels (top) */}
        {indicators.map((ind, col) => (
          <text
            key={`col-${ind}`}
            x={labelWidth + col * cellSize + cellSize / 2}
            y={labelHeight - 6}
            textAnchor="end"
            fontSize={colLabelFontSize}
            transform={`rotate(45, ${labelWidth + col * cellSize + cellSize / 2}, ${labelHeight - 6})`}
          >
            {ind.length > colLabelMaxChars ? ind.slice(0, colLabelMaxChars) + '…' : ind}
          </text>
        ))}

        {/* Row labels (left) + cells */}
        {indicators.map((row, ri) => (
          <g key={`row-${row}`}>
            <text
              x={labelWidth - 6}
              y={labelHeight + ri * cellSize + cellSize / 2 + 4}
              textAnchor="end"
              fontSize={rowLabelFontSize}
            >
              {row.length > rowLabelMaxChars ? row.slice(0, rowLabelMaxChars) + '…' : row}
            </text>
            {indicators.map((col, ci) => {
              const val = corr[row]?.[col];
              const p = pval?.[row]?.[col];
              const stars = significanceStars(p);
              return (
                <g key={`${row}-${col}`}>
                  <rect
                    x={labelWidth + ci * cellSize}
                    y={labelHeight + ri * cellSize}
                    width={cellSize - 2}
                    height={cellSize - 2}
                    rx={3}
                    fill={val != null ? corrColor(val, colorblindMode) : '#EDF2F7'}
                    stroke="#E2E8F0"
                    strokeWidth={0.5}
                  >
                    <title>{`${row} × ${col}: ${val != null ? val.toFixed(3) : '—'}${stars ? ` (p${stars})` : ''}`}</title>
                  </rect>
                  <text
                    x={labelWidth + ci * cellSize + (cellSize - 2) / 2}
                    y={labelHeight + ri * cellSize + (cellSize - 2) / 2 + 4}
                    textAnchor="middle"
                    fontSize={9}
                    fill={val != null && Math.abs(val) > 0.6 ? '#fff' : '#2D3748'}
                    pointerEvents="none"
                  >
                    {val != null ? val.toFixed(2) : '—'}
                  </text>
                  {stars && (
                    <text
                      x={labelWidth + ci * cellSize + (cellSize - 2) / 2}
                      y={labelHeight + ri * cellSize + (cellSize - 2) / 2 + 14}
                      textAnchor="middle"
                      fontSize={8}
                      fill={val != null && Math.abs(val) > 0.6 ? '#fff' : '#718096'}
                      pointerEvents="none"
                    >
                      {stars}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        ))}

        {/* Color legend (positioned below the last row with a fixed 8px gap) */}
        <g transform={`translate(${labelWidth}, ${legendY})`}>
          <rect width={12} height={12} fill={corrColor(-1, colorblindMode)} rx={2} />
          <text x={16} y={10} fontSize={9} fill="#4A5568">-1</text>
          <rect x={40} width={12} height={12} fill={corrColor(0, colorblindMode)} rx={2} />
          <text x={56} y={10} fontSize={9} fill="#4A5568">0</text>
          <rect x={72} width={12} height={12} fill={corrColor(1, colorblindMode)} rx={2} />
          <text x={88} y={10} fontSize={9} fill="#4A5568">+1</text>
        </g>
      </svg>
    </Box>
  );
}

// ─── Z-Score Heatmap (Zone × Indicator) — v6.0 descriptive ─────────────────

function zScoreCellColor(z: number, colorblindMode = false): string {
  if (colorblindMode) {
    // Map z to [-1, 1] (clip at ±2 for legibility), then run through Cividis.
    const t = Math.max(-1, Math.min(1, z / 2));
    return divergingColor(t, true);
  }
  // coolwarm-style: neutral center, blue for negative, red for positive
  const absZ = Math.abs(z);
  if (absZ < 0.25) return '#E2E8F0';     // near zero = gray
  if (z > 0) {
    if (absZ > 1.5) return '#C53030';
    if (absZ > 1.0) return '#E53E3E';
    if (absZ > 0.5) return '#FC8181';
    return '#FEB2B2';
  }
  if (absZ > 1.5) return '#2B6CB0';
  if (absZ > 1.0) return '#3182CE';
  if (absZ > 0.5) return '#63B3ED';
  return '#BEE3F8';
}

interface PriorityHeatmapProps {
  diagnostics: ZoneDiagnostic[];
  layer?: string;
  colorblindMode?: boolean;
}

export function PriorityHeatmap({ diagnostics, layer = 'full', colorblindMode }: PriorityHeatmapProps) {
  const { zones, indicators, grid } = useMemo(() => {
    const zoneList = diagnostics.map(d => d.zone_name);
    const indSet = new Set<string>();
    const gridMap: Record<string, Record<string, { value: number | null; z_score: number }>> = {};

    for (const diag of diagnostics) {
      gridMap[diag.zone_name] = {};
      const status = diag.indicator_status || {};
      for (const [indId, layerData] of Object.entries(status)) {
        indSet.add(indId);
        const ld = (layerData as Record<string, { value?: number | null; z_score?: number }>)[layer];
        if (ld) {
          gridMap[diag.zone_name][indId] = {
            value: ld.value ?? null,
            z_score: ld.z_score || 0,
          };
        }
      }
    }
    return { zones: zoneList, indicators: Array.from(indSet).sort(), grid: gridMap };
  }, [diagnostics, layer]);

  if (zones.length === 0 || indicators.length === 0) return null;

  const cellW = Math.max(44, Math.min(56, 600 / Math.max(indicators.length, 1)));
  const cellH = 36;
  const colLabelFontSize = 9;
  const rowLabelFontSize = 10;
  const colLabelMaxChars = 12; // truncation threshold below
  const rowLabelMaxChars = 14;
  const labelH = rotatedLabelTopMargin(colLabelMaxChars, colLabelFontSize);
  const labelW = Math.ceil(rowLabelMaxChars * rowLabelFontSize * CHAR_WIDTH_RATIO) + 14;
  // Legend: 5 swatches × 80px wide, 12px tall + 8px gap above + 8px below.
  const legendHeight = 12;
  const legendGap = 8;
  const legendBottomPad = 8;
  const svgW = labelW + indicators.length * cellW;
  const svgH = labelH + zones.length * cellH + legendGap + legendHeight + legendBottomPad;
  const legendY = labelH + zones.length * cellH + legendGap;

  const legendItems = [
    { label: 'z<-1.5', color: '#2B6CB0' },
    { label: 'z<-0.5', color: '#63B3ED' },
    { label: 'z~0', color: '#E2E8F0' },
    { label: 'z>0.5', color: '#FC8181' },
    { label: 'z>1.5', color: '#C53030' },
  ];

  return (
    <Box overflow="visible">
      <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {/* Column labels */}
        {indicators.map((ind, ci) => (
          <text
            key={`col-${ind}`}
            x={labelW + ci * cellW + cellW / 2}
            y={labelH - 6}
            textAnchor="end"
            fontSize={colLabelFontSize}
            transform={`rotate(45, ${labelW + ci * cellW + cellW / 2}, ${labelH - 6})`}
          >
            {ind.length > colLabelMaxChars ? ind.slice(0, colLabelMaxChars) + '...' : ind}
          </text>
        ))}
        {/* Rows */}
        {zones.map((zone, ri) => (
          <g key={zone}>
            <text x={labelW - 6} y={labelH + ri * cellH + cellH / 2 + 4} textAnchor="end" fontSize={rowLabelFontSize}>
              {zone.length > rowLabelMaxChars ? zone.slice(0, rowLabelMaxChars) + '...' : zone}
            </text>
            {indicators.map((ind, ci) => {
              const cell = grid[zone]?.[ind];
              const zs = cell?.z_score ?? 0;
              return (
                <g key={`${zone}-${ind}`}>
                  <rect
                    x={labelW + ci * cellW}
                    y={labelH + ri * cellH}
                    width={cellW - 2}
                    height={cellH - 2}
                    rx={3}
                    fill={zScoreCellColor(zs, colorblindMode)}
                    opacity={0.85}
                  >
                    <title>{`${zone} x ${ind}: z=${zs.toFixed(2)}`}</title>
                  </rect>
                  <text
                    x={labelW + ci * cellW + (cellW - 2) / 2}
                    y={labelH + ri * cellH + (cellH - 2) / 2 + 4}
                    textAnchor="middle"
                    fontSize={9}
                    fill={Math.abs(zs) > 0.8 ? '#fff' : '#2D3748'}
                    fontWeight="bold"
                    pointerEvents="none"
                  >
                    {zs.toFixed(1)}
                  </text>
                </g>
              );
            })}
          </g>
        ))}
        {/* Legend (positioned below the last row with a fixed 8px gap) */}
        <g transform={`translate(${labelW}, ${legendY})`}>
          {legendItems.map((item, i) => (
            <g key={item.label} transform={`translate(${i * 80}, 0)`}>
              <rect width={12} height={12} fill={item.color} rx={2} opacity={0.85} />
              <text x={16} y={10} fontSize={8} fill="#4A5568">{item.label}</text>
            </g>
          ))}
        </g>
      </svg>
    </Box>
  );
}

// ─── Indicator Comparison Grouped Bar ───────────────────────────────────────

interface IndicatorComparisonChartProps {
  stats: EnrichedZoneStat[];
  layer: string;
}

export function IndicatorComparisonChart({ stats, layer }: IndicatorComparisonChartProps) {
  const { data, zones } = useMemo(() => {
    const filtered = stats.filter(s => s.layer === layer);
    const zoneNames = Array.from(new Set(filtered.map(s => s.zone_name))).sort();
    const indicatorIds = Array.from(new Set(filtered.map(s => s.indicator_id))).sort();

    const chartData = indicatorIds.map(ind => {
      const row: Record<string, string | number | null> = { indicator: ind };
      for (const zone of zoneNames) {
        const stat = filtered.find(s => s.indicator_id === ind && s.zone_name === zone);
        row[zone] = stat?.mean ?? null;
      }
      return row;
    });

    return { data: chartData, zones: zoneNames };
  }, [stats, layer]);

  if (zones.length === 0 || data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={Math.max(250, data.length * 35 + 60)}>
      <BarChart data={data} margin={{ left: 20, right: 20, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="indicator" tick={{ fontSize: 9 }} interval={0} angle={-45} textAnchor="end" height={80} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {zones.map((zone, i) => (
          <Bar key={zone} dataKey={zone} fill={getZoneColor(i)} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}


// ─── Descriptive Statistics Chart (Mean ± Std with Min/Max) ─────────────────

interface DescriptiveStatsChartProps {
  stats: EnrichedZoneStat[];
  layer: string;
}

export function DescriptiveStatsChart({ stats, layer }: DescriptiveStatsChartProps) {
  const data = useMemo(() => {
    const filtered = stats.filter(s => s.layer === layer);
    const indicators = Array.from(new Set(filtered.map(s => s.indicator_id))).sort();
    return indicators.map(ind => {
      const rows = filtered.filter(s => s.indicator_id === ind);
      const means = rows.map(r => r.mean ?? 0);
      const stds = rows.map(r => r.std ?? 0);
      const mins = rows.map(r => r.min ?? 0);
      const maxs = rows.map(r => r.max ?? 0);
      const avgMean = means.reduce((a, b) => a + b, 0) / (means.length || 1);
      const avgStd = stds.reduce((a, b) => a + b, 0) / (stds.length || 1);
      return {
        indicator: ind,
        mean: Number(avgMean.toFixed(3)),
        std: Number(avgStd.toFixed(3)),
        min: Number(Math.min(...mins).toFixed(3)),
        max: Number(Math.max(...maxs).toFixed(3)),
      };
    });
  }, [stats, layer]);

  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={Math.max(250, data.length * 40 + 60)}>
      <BarChart data={data} layout="vertical" margin={{ left: 20, right: 30, top: 5, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis type="number" tick={{ fontSize: 10 }} />
        <YAxis type="category" dataKey="indicator" tick={{ fontSize: 9 }} width={100} />
        <Tooltip formatter={(v, name) => [typeof v === 'number' ? v.toFixed(3) : '—', name ?? '']} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="mean" fill="#3182CE" name="Mean" barSize={14}>
          <ErrorBar dataKey="std" direction="x" stroke="#2D3748" strokeWidth={1} />
        </Bar>
        <Bar dataKey="min" fill="#E53E3E" name="Min" barSize={6} />
        <Bar dataKey="max" fill="#38A169" name="Max" barSize={6} />
      </BarChart>
    </ResponsiveContainer>
  );
}


// ─── Z-Score Heatmap (Zone × Indicator, colored by z-score) ─────────────────

interface ZScoreHeatmapProps {
  stats: EnrichedZoneStat[];
  layer: string;
}

export function ZScoreHeatmap({ stats, layer }: ZScoreHeatmapProps) {
  const { zones, indicators, grid } = useMemo(() => {
    const filtered = stats.filter(s => s.layer === layer);
    const zoneList = Array.from(new Set(filtered.map(s => s.zone_name))).sort();
    const indList = Array.from(new Set(filtered.map(s => s.indicator_id))).sort();
    const g: Record<string, Record<string, { z: number; val: number }>> = {};
    for (const s of filtered) {
      if (!g[s.zone_name]) g[s.zone_name] = {};
      g[s.zone_name][s.indicator_id] = { z: s.z_score ?? 0, val: s.mean ?? 0 };
    }
    return { zones: zoneList, indicators: indList, grid: g };
  }, [stats, layer]);

  if (zones.length === 0 || indicators.length === 0) return null;

  const cellW = Math.max(44, Math.min(56, 600 / Math.max(indicators.length, 1)));
  const cellH = 36;
  const labelW = 120;
  // v4 polish — switch from hardcoded labelH=90 to the shared formula
  // (was clipping the leading "IND_" of long indicator IDs in tall fonts).
  const labelH = rotatedLabelTopMargin(12, 9);
  const svgW = labelW + indicators.length * cellW;
  const svgH = labelH + zones.length * cellH + 30;

  function zColor(z: number): string {
    const clamped = Math.max(-2, Math.min(2, z));
    const t = (clamped + 2) / 4; // 0..1
    // Red (low) → Yellow (mid) → Green (high)
    if (t < 0.5) {
      const r = 229, g = Math.round(62 + (204 - 62) * t * 2), b = 62;
      return `rgb(${r},${g},${b})`;
    }
    const r = Math.round(204 - (204 - 56) * (t - 0.5) * 2), g = Math.round(204 - (204 - 161) * (t - 0.5) * 2), b = Math.round(62 - (62 - 56) * (t - 0.5) * 2);
    return `rgb(${r},${g},${b})`;
  }

  return (
    <Box overflow="visible">
      <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {indicators.map((ind, ci) => (
          <text key={`col-${ind}`} x={labelW + ci * cellW + cellW / 2} y={labelH - 6} textAnchor="end" fontSize={9}
            transform={`rotate(45, ${labelW + ci * cellW + cellW / 2}, ${labelH - 6})`}
          >
            <title>{ind}</title>
            {ind.length > 12 ? ind.slice(0, 12) + '…' : ind}
          </text>
        ))}
        {zones.map((zone, ri) => (
          <g key={zone}>
            <text x={labelW - 6} y={labelH + ri * cellH + cellH / 2 + 4} textAnchor="end" fontSize={10}>
              <title>{zone}</title>
              {zone.length > 14 ? zone.slice(0, 14) + '…' : zone}
            </text>
            {indicators.map((ind, ci) => {
              const cell = grid[zone]?.[ind];
              const z = cell?.z ?? 0;
              const val = cell?.val ?? 0;
              return (
                <g key={`${zone}-${ind}`}>
                  <rect x={labelW + ci * cellW} y={labelH + ri * cellH} width={cellW - 2} height={cellH - 2} rx={3}
                    fill={cell ? zColor(z) : '#EDF2F7'} opacity={0.85}
                  ><title>{`${zone} × ${ind}: val=${val.toFixed(2)}, z=${z.toFixed(2)}`}</title></rect>
                  <text x={labelW + ci * cellW + (cellW - 2) / 2} y={labelH + ri * cellH + (cellH - 2) / 2 + 4}
                    textAnchor="middle" fontSize={9} fill="#fff" fontWeight="bold" pointerEvents="none"
                  >{val.toFixed(1)}</text>
                </g>
              );
            })}
          </g>
        ))}
        <g transform={`translate(${labelW}, ${svgH - 18})`}>
          {[{l: '-2 (low)', c: zColor(-2)}, {l: '-1', c: zColor(-1)}, {l: '0', c: zColor(0)}, {l: '+1', c: zColor(1)}, {l: '+2 (high)', c: zColor(2)}].map((item, i) => (
            <g key={i} transform={`translate(${i * 80}, 0)`}>
              <rect width={12} height={12} fill={item.c} rx={2} opacity={0.85} />
              <text x={16} y={10} fontSize={8} fill="#4A5568">{item.l}</text>
            </g>
          ))}
        </g>
      </svg>
    </Box>
  );
}


// ─── Per-Indicator Deep Dive — v4 / Module 6.3.1 ───────────────────────────
//
// The original three-panel layout (Zone Ranking + Layer Statistics table +
// "Distribution by Layer" box-whisker) had two problems:
//   1. The box-whisker degenerated when N=zones was small (typical 2-zone
//      project ⇒ a 2-point "box" that was meaningless).
//   2. It looked visually identical to C1 / Distribution Shape but used a
//      different data layer (zone-level vs image-level), confusing users.
//
// New layout (still 3 columns):
//   1. Zone Ranking — bar chart, unchanged.
//   2. Zone × Layer Profile — line chart (one line per zone) showing how
//      the zone's mean shifts across Full / FG / MG / BG. Reveals rank flips
//      and trend differences without pretending to be a distribution.
//   3. Combined Zone × Layer Mean Matrix — rows = zones, cols = 4 layers,
//      cells = mean. Bottom row = across-zones summary (N / Mean / Std / CV)
//      replacing the old "Layer Statistics" table.

interface IndicatorDeepDiveProps {
  stats: EnrichedZoneStat[];
  indicatorId: string;
  indicatorName?: string;
  unit?: string;
  targetDirection?: string;
  /** When `image_level`, fall back to image-level Std/CV from globalStats. */
  analysisMode?: 'zone_level' | 'image_level';
  /** Per-indicator image-level stats (n=images, has by_layer.{N,Mean,Std}). */
  globalStats?: GlobalIndicatorStats;
}

const DD_LAYERS = ['full', 'foreground', 'middleground', 'background'] as const;
const DD_LAYER_LABELS: Record<string, string> = { full: 'Full', foreground: 'FG', middleground: 'MG', background: 'BG' };
const DD_LAYER_COLORS: Record<string, string> = { full: '#3182CE', foreground: '#E53E3E', middleground: '#38A169', background: '#805AD5' };

/** Below this threshold a zone × layer box-whisker is replaced by a strip
 * plot (scatter + mean line) — see Module 8.3.1. */
const STRIP_PLOT_THRESHOLD = 5;

function viridisColor(t: number): string {
  // Linear approximation of the viridis colormap in 4 stops
  const stops = [
    [68, 1, 84],     // 0.0 dark purple
    [59, 82, 139],   // 0.33 blue
    [33, 145, 140],  // 0.66 teal
    [253, 231, 37],  // 1.0 yellow
  ];
  const clamped = Math.max(0, Math.min(1, t));
  const seg = clamped * (stops.length - 1);
  const i0 = Math.floor(seg);
  const i1 = Math.min(stops.length - 1, i0 + 1);
  const f = seg - i0;
  const r = Math.round(stops[i0][0] * (1 - f) + stops[i1][0] * f);
  const g = Math.round(stops[i0][1] * (1 - f) + stops[i1][1] * f);
  const b = Math.round(stops[i0][2] * (1 - f) + stops[i1][2] * f);
  return `rgb(${r},${g},${b})`;
}

interface ZoneInfo { id: string; name: string; color: string }

/** Line chart: each zone is a line connecting its mean across the 4 layers.
 * Replaces the old "Distribution by Layer" box-whisker. */
function ZoneLayerProfileChart({
  zones,
  layerMeans,
}: {
  zones: ZoneInfo[];
  layerMeans: Record<string, Record<string, number | null>>;
}) {
  const allVals: number[] = [];
  for (const z of zones) {
    for (const layer of DD_LAYERS) {
      const v = layerMeans[z.id]?.[layer];
      if (v != null) allVals.push(v);
    }
  }
  if (allVals.length === 0) {
    return <Text fontSize="xs" color="gray.400">No data</Text>;
  }
  const yMin = Math.min(...allVals);
  const yMax = Math.max(...allVals);
  const yRange = yMax - yMin || 1;

  const svgW = 260;
  const svgH = 200;
  const margin = { l: 44, r: 12, t: 12, b: 28 };
  const plotW = svgW - margin.l - margin.r;
  const plotH = svgH - margin.t - margin.b;
  const xStep = plotW / (DD_LAYERS.length - 1);
  const toX = (i: number) => margin.l + i * xStep;
  const toY = (v: number) => margin.t + plotH - ((v - yMin) / yRange) * plotH;

  return (
    <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
      {[0, 0.25, 0.5, 0.75, 1].map(t => {
        const v = yMin + t * yRange;
        const y = toY(v);
        return (
          <g key={t}>
            <line x1={margin.l} y1={y} x2={margin.l + plotW} y2={y} stroke="#E2E8F0" />
            <text x={margin.l - 4} y={y + 3} textAnchor="end" fontSize={9} fill="#718096">
              {v.toFixed(2)}
            </text>
          </g>
        );
      })}
      {DD_LAYERS.map((layer, i) => (
        <text key={layer} x={toX(i)} y={margin.t + plotH + 16} textAnchor="middle" fontSize={9} fill="#4A5568">
          {DD_LAYER_LABELS[layer]}
        </text>
      ))}
      {zones.map(z => {
        const points: { x: number; y: number; v: number; layer: string }[] = [];
        DD_LAYERS.forEach((layer, i) => {
          const v = layerMeans[z.id]?.[layer];
          if (v != null) points.push({ x: toX(i), y: toY(v), v, layer });
        });
        if (points.length === 0) return null;
        const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
        return (
          <g key={z.id}>
            <path d={path} fill="none" stroke={z.color} strokeWidth={1.5} opacity={0.85} />
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={3} fill={z.color} stroke="#fff" strokeWidth={0.5}>
                <title>{`${z.name} · ${DD_LAYER_LABELS[p.layer]}: ${p.v.toFixed(3)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/** Combined Zone × Layer Mean Matrix: rows = zones, cols = 4 layers, cells
 * = mean. Bottom row aggregates across zones (replaces old Layer Statistics). */
function ZoneLayerMatrixTable({
  zones,
  layerMeans,
  layerSummary,
  useImageLevel,
}: {
  zones: ZoneInfo[];
  layerMeans: Record<string, Record<string, number | null>>;
  layerSummary: { layer: string; n: number; mean: number; std: number; cv: number }[];
  useImageLevel: boolean;
}) {
  const fmt = (v: number, digits: number) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  return (
    <Box>
      <HStack justify="space-between" mb={1}>
        <Text fontSize="xs" fontWeight="bold">Zone × Layer Mean Matrix</Text>
        {useImageLevel && (
          <Text fontSize="2xs" color="gray.500">
            (image-level summary, n = {layerSummary.find(l => l.layer === 'full')?.n ?? '?'})
          </Text>
        )}
      </HStack>
      <Box as="table" fontSize="10px" width="100%" sx={{ borderCollapse: 'collapse' }}>
        <Box as="thead">
          <Box as="tr" bg="gray.50" fontWeight="bold">
            <Box as="th" px={2} py={1} textAlign="left">Zone</Box>
            {DD_LAYERS.map(layer => (
              <Box key={layer} as="th" px={2} py={1} textAlign="right" color={DD_LAYER_COLORS[layer]}>
                {DD_LAYER_LABELS[layer]}
              </Box>
            ))}
          </Box>
        </Box>
        <Box as="tbody">
          {zones.map(z => (
            <Box as="tr" key={z.id} borderTop="1px solid" borderColor="gray.100">
              <Box as="td" px={2} py={1} fontWeight="medium">
                {/* Truncated to 14 chars; full name shown on hover so the
                    user can identify the zone without resizing the column. */}
                <ChakraTooltip label={z.name} placement="top" hasArrow openDelay={300}>
                  <Text as="span" cursor="default">
                    {z.name.length > 14 ? z.name.slice(0, 14) + '…' : z.name}
                  </Text>
                </ChakraTooltip>
              </Box>
              {DD_LAYERS.map(layer => {
                const v = layerMeans[z.id]?.[layer];
                return (
                  <Box key={layer} as="td" px={2} py={1} textAlign="right">
                    {v != null ? v.toFixed(2) : '—'}
                  </Box>
                );
              })}
            </Box>
          ))}
          {/* Across-zones summary row (replaces old "Layer Statistics" panel) */}
          <Box as="tr" bg="gray.50" borderTop="2px solid" borderColor="gray.300" fontWeight="bold">
            <Box as="td" px={2} py={1}>
              <Text as="span" fontSize="2xs">Across-zones</Text>
              <Text as="span" fontSize="2xs" color="gray.500" ml={1}>(N · Mean · Std · CV%)</Text>
            </Box>
            {DD_LAYERS.map(layer => {
              const s = layerSummary.find(ls => ls.layer === layer);
              if (!s || s.n === 0) {
                return <Box key={layer} as="td" px={2} py={1} textAlign="right">—</Box>;
              }
              return (
                <Box key={layer} as="td" px={2} py={1} textAlign="right" lineHeight="1.2">
                  <Text fontSize="2xs">N={s.n}</Text>
                  <Text fontSize="2xs">{fmt(s.mean, 2)} ± {fmt(s.std, 2)}</Text>
                  <Text fontSize="2xs" color="gray.500">{fmt(s.cv, 1)}%</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export function IndicatorDeepDive({ stats, indicatorId, indicatorName, unit, targetDirection, analysisMode, globalStats }: IndicatorDeepDiveProps) {
  const derived = useMemo(() => {
    const indStats = stats.filter(s => s.indicator_id === indicatorId);
    if (indStats.length === 0) return null;

    // Unique zones, ordered by full-layer mean descending so Zone Ranking and
    // the matrix share a consistent zone order (no "row 1 in chart, row 3 in
    // table" disorientation).
    const seen = new Map<string, { id: string; name: string; fullMean: number | null }>();
    for (const s of indStats) {
      if (!seen.has(s.zone_id)) {
        seen.set(s.zone_id, { id: s.zone_id, name: s.zone_name, fullMean: null });
      }
    }
    for (const s of indStats) {
      if (s.layer === 'full' && s.mean != null) {
        const z = seen.get(s.zone_id);
        if (z) z.fullMean = s.mean;
      }
    }
    const zoneList = Array.from(seen.values())
      .sort((a, b) => (b.fullMean ?? -Infinity) - (a.fullMean ?? -Infinity));

    const layerMeans: Record<string, Record<string, number | null>> = {};
    for (const z of zoneList) layerMeans[z.id] = {};
    for (const s of indStats) {
      if (!layerMeans[s.zone_id]) layerMeans[s.zone_id] = {};
      layerMeans[s.zone_id][s.layer] = s.mean ?? null;
    }

    const fullEntries = zoneList
      .filter(z => z.fullMean != null)
      .map(z => ({ name: z.name, value: z.fullMean as number }));
    const maxV = fullEntries.length > 0 ? Math.max(...fullEntries.map(e => e.value)) : 0;
    const minV = fullEntries.length > 0 ? Math.min(...fullEntries.map(e => e.value)) : 0;

    // Across-zones summary per layer. With < 2 zones, cross-zone std/cv
    // collapse to 0 mathematically — fall back to image-level Std/CV from
    // globalStats which captures the meaningful within-zone dispersion.
    const useImageLevel = analysisMode === 'image_level' || zoneList.length < 2;
    const layerSummary = DD_LAYERS.map(layer => {
      if (useImageLevel && globalStats) {
        const layerEntry = globalStats.by_layer?.[layer];
        if (layerEntry?.N != null && layerEntry.N > 0) {
          const mean = layerEntry.Mean ?? 0;
          const std = layerEntry.Std ?? 0;
          const cv = layer === 'full' && globalStats.cv_full != null
            ? globalStats.cv_full
            : (mean !== 0 ? (std / Math.abs(mean)) * 100 : 0);
          return { layer, n: layerEntry.N, mean, std, cv };
        }
      }
      const vals = zoneList.map(z => layerMeans[z.id]?.[layer]).filter((v): v is number => v != null);
      if (vals.length === 0) return { layer, n: 0, mean: 0, std: 0, cv: 0 };
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (vals.length < 2) return { layer, n: vals.length, mean, std: NaN, cv: NaN };
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1);
      const std = Math.sqrt(variance);
      const cv = mean !== 0 ? (std / Math.abs(mean)) * 100 : 0;
      return { layer, n: vals.length, mean, std, cv };
    });

    const zonesWithColor: ZoneInfo[] = zoneList.map((z, i) => ({
      id: z.id,
      name: z.name,
      color: ZONE_COLORS[i % ZONE_COLORS.length],
    }));

    return { fullEntries, maxV, minV, layerMeans, layerSummary, useImageLevel, zonesWithColor };
  }, [stats, indicatorId, analysisMode, globalStats]);

  if (!derived) return null;
  const { fullEntries, maxV, minV, layerMeans, layerSummary, useImageLevel, zonesWithColor } = derived;
  const range = maxV - minV || 1;

  return (
    <Box>
      <Box mb={2}>
        <Text fontSize="sm" fontWeight="bold">
          {indicatorId}{indicatorName ? `: ${indicatorName}` : ''}
        </Text>
        {(unit || targetDirection) && (
          <Text fontSize="xs" color="gray.500">
            {unit ? `Unit: ${unit}` : ''}
            {unit && targetDirection ? ' | ' : ''}
            {targetDirection ? `Direction: ${targetDirection}` : ''}
          </Text>
        )}
      </Box>

      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4}>
        {/* Zone Ranking — full-layer bar chart */}
        <Box>
          <Text fontSize="xs" fontWeight="bold" mb={1} color={DD_LAYER_COLORS.full}>
            Zone Ranking — full layer mean per zone
          </Text>
          {fullEntries.length === 0 ? (
            <Text fontSize="xs" color="gray.400">No data</Text>
          ) : (() => {
            const svgW = 260;
            const rowH = 18;
            const svgH = fullEntries.length * rowH + 6;
            const labelW = 80;
            const barAreaW = svgW - labelW - 50;
            return (
              <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
                {fullEntries.map((e, i) => {
                  const w = ((e.value - minV) / range) * barAreaW;
                  const y = i * rowH + 2;
                  const t = range > 0 ? (e.value - minV) / range : 0.5;
                  return (
                    <g key={i}>
                      {/* SVG <title> gives native browser tooltip on hover —
                          full zone name appears even when the visible label
                          is truncated to 12 chars. Same pattern used on
                          every other truncated chart label below. */}
                      <text x={labelW - 4} y={y + rowH * 0.7} fontSize={9} textAnchor="end" fill="#4A5568">
                        <title>{`${e.name}: ${e.value.toFixed(2)}`}</title>
                        {e.name.length > 12 ? e.name.slice(0, 12) + '...' : e.name}
                      </text>
                      <rect x={labelW} y={y + 1} width={Math.max(w, 2)} height={rowH - 4} fill={viridisColor(t)} rx={2}>
                        <title>{`${e.name}: ${e.value.toFixed(2)}`}</title>
                      </rect>
                      <text x={labelW + w + 4} y={y + rowH * 0.7} fontSize={8} fill="#718096">{e.value.toFixed(2)}</text>
                    </g>
                  );
                })}
              </svg>
            );
          })()}
        </Box>

        {/* Zone × Layer Profile — line chart (NEW v4 / M6.3.1) */}
        <Box>
          <Text fontSize="xs" fontWeight="bold" mb={1}>Zone × Layer Profile</Text>
          <Text fontSize="2xs" color="gray.500" mb={1}>
            Zone-level means (N = {zonesWithColor.length} zones)
          </Text>
          <ZoneLayerProfileChart zones={zonesWithColor} layerMeans={layerMeans} />
          <HStack flexWrap="wrap" spacing={2} mt={1}>
            {zonesWithColor.slice(0, 6).map(z => (
              <ChakraTooltip key={z.id} label={z.name} placement="top" hasArrow openDelay={300}>
                <HStack spacing={1} cursor="default">
                  <Box w="10px" h="2px" bg={z.color} />
                  <Text fontSize="2xs" color="gray.600">{z.name.length > 10 ? z.name.slice(0, 10) + '…' : z.name}</Text>
                </HStack>
              </ChakraTooltip>
            ))}
            {zonesWithColor.length > 6 && (
              <ChakraTooltip
                label={zonesWithColor.slice(6).map(z => z.name).join(', ')}
                placement="top"
                hasArrow
                openDelay={300}
              >
                <Text fontSize="2xs" color="gray.400" cursor="default">+{zonesWithColor.length - 6} more</Text>
              </ChakraTooltip>
            )}
          </HStack>
        </Box>

        {/* Combined Zone × Layer Mean Matrix (replaces old Layer Statistics panel) */}
        <ZoneLayerMatrixTable
          zones={zonesWithColor}
          layerMeans={layerMeans}
          layerSummary={layerSummary}
          useImageLevel={useImageLevel}
        />
      </SimpleGrid>
    </Box>
  );
}


// ─── Within-Zone Image Distribution — v4 / Module 6.3.2 / C3 ───────────────
//
// New chart that fills the data-tier gap: image-level distribution of each
// indicator broken down by zone × layer. Each row is one indicator; each
// row contains 4 panels (Full / FG / MG / BG); each panel has K box-whiskers
// (one per zone or cluster).
//
// Module 8.3.1: when a zone × layer cell has fewer than STRIP_PLOT_THRESHOLD
// images, the box-whisker degenerates into a strip plot (scatter + mean line)
// to avoid a misleading 2-point "box".
// Module 8.3.2: when every zone in a panel has identical values (e.g.
// IND_CEI = 0 across the project), we replace the panel with the literal
// message "All zones equal at {value}".

interface WithinZoneImageDistributionProps {
  imageRecords: ImageRecord[];
  indicatorDefs: Record<string, IndicatorDefinitionInput>;
}

interface ZoneBoxStat {
  zoneId: string;
  zoneName: string;
  color: string;
  n: number;
  values: number[];
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
}

function computeBoxStats(values: number[]): Pick<ZoneBoxStat, 'min'|'q1'|'median'|'q3'|'max'|'mean'> {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
  };
  return {
    min: sorted[0],
    q1: q(0.25),
    median: q(0.5),
    q3: q(0.75),
    max: sorted[sorted.length - 1],
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

function WithinZoneLayerPanel({
  layerLabel,
  zoneStats,
  yDomain,
  zoneIndexById,
}: {
  layerLabel: string;
  zoneStats: ZoneBoxStat[];
  yDomain: { min: number; max: number };
  /** Issue 5 polish — when provided, the per-column x-axis label uses
   *  the indexed number (1, 2, 3, ...) from this map instead of a 6-char
   *  truncated zone name. The shared legend below the 4 panels carries
   *  the index → full-name mapping. This fixes the overlapping
   *  "WeWesWesWesWes..." x-axis when zone count is high (~10+). */
  zoneIndexById?: Map<string, number>;
}) {
  if (zoneStats.length === 0) {
    return (
      <Box>
        <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center">{layerLabel}</Text>
        <Text fontSize="2xs" color="gray.400" textAlign="center">No data</Text>
      </Box>
    );
  }
  // Module 8.3.2 — all zones equal
  const firstMin = zoneStats[0].min;
  const allEqual = zoneStats.every(z => z.min === z.max && z.min === firstMin);
  if (allEqual) {
    return (
      <Box>
        <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center">{layerLabel}</Text>
        <Box border="1px dashed" borderColor="gray.200" borderRadius="md" p={3} textAlign="center">
          <Text fontSize="2xs" color="gray.500">All zones equal at {firstMin.toFixed(2)}</Text>
        </Box>
      </Box>
    );
  }

  const svgW = 200;
  const svgH = 180;
  const margin = { l: 36, r: 8, t: 12, b: 28 };
  const plotW = svgW - margin.l - margin.r;
  const plotH = svgH - margin.t - margin.b;
  const range = yDomain.max - yDomain.min || 1;
  const toY = (v: number) => margin.t + plotH - ((v - yDomain.min) / range) * plotH;
  const colW = plotW / zoneStats.length;
  const boxW = Math.min(28, colW * 0.6);

  return (
    <Box>
      <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center">{layerLabel}</Text>
      <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => {
          const v = yDomain.min + t * range;
          const y = toY(v);
          return (
            <g key={t}>
              <line x1={margin.l} y1={y} x2={margin.l + plotW} y2={y} stroke="#E2E8F0" />
              <text x={margin.l - 4} y={y + 3} textAnchor="end" fontSize={8} fill="#718096">
                {v.toFixed(1)}
              </text>
            </g>
          );
        })}
        {zoneStats.map((z, i) => {
          const cx = margin.l + (i + 0.5) * colW;
          // Issue 5 polish — use the numbered index from the shared-legend
          // map as the x-axis label. With K~12 zones at 200px panel width
          // each column is ~14px wide, way too narrow for a 6-char name —
          // hence the unreadable "WeWesWesWes…" overlap. Indices "1, 2,
          // 3" comfortably fit any column width; the full name is
          // available via SVG <title> hover AND in the shared legend
          // rendered below all four panels for this indicator.
          const idx = zoneIndexById?.get(z.zoneId);
          const xLabel = idx != null ? String(idx) : (z.zoneName.length > 6 ? z.zoneName.slice(0, 6) + '…' : z.zoneName);
          // Module 8.3.1 — small N → strip plot
          if (z.n < STRIP_PLOT_THRESHOLD) {
            return (
              <g key={z.zoneId}>
                {z.values.map((v, vi) => (
                  <circle
                    key={vi}
                    cx={cx + (vi - z.values.length / 2) * 1.5}
                    cy={toY(v)}
                    r={2.5}
                    fill={z.color}
                    opacity={0.65}
                  >
                    <title>{`${z.zoneName} · ${v.toFixed(3)}`}</title>
                  </circle>
                ))}
                <line
                  x1={cx - boxW / 2} x2={cx + boxW / 2}
                  y1={toY(z.mean)} y2={toY(z.mean)}
                  stroke={z.color} strokeWidth={2}
                />
                <text x={cx} y={margin.t + plotH + 12} textAnchor="middle" fontSize={9} fontWeight="bold" fill={z.color}>
                  <title>{`${z.zoneName} (n=${z.n}, strip plot due to small sample)`}</title>
                  {xLabel}
                </text>
                <text x={cx} y={margin.t + plotH + 22} textAnchor="middle" fontSize={7} fill="#A0AEC0">
                  n={z.n}*
                </text>
              </g>
            );
          }
          return (
            <g key={z.zoneId}>
              <line x1={cx} y1={toY(z.min)} x2={cx} y2={toY(z.max)} stroke={z.color} strokeWidth={1.5} />
              <line x1={cx - boxW / 4} y1={toY(z.min)} x2={cx + boxW / 4} y2={toY(z.min)} stroke={z.color} strokeWidth={1.5} />
              <line x1={cx - boxW / 4} y1={toY(z.max)} x2={cx + boxW / 4} y2={toY(z.max)} stroke={z.color} strokeWidth={1.5} />
              <rect
                x={cx - boxW / 2} y={toY(z.q3)}
                width={boxW} height={Math.max(1, toY(z.q1) - toY(z.q3))}
                fill={z.color} opacity={0.25} stroke={z.color} strokeWidth={1.5} rx={2}
              />
              <line x1={cx - boxW / 2} y1={toY(z.median)} x2={cx + boxW / 2} y2={toY(z.median)} stroke={z.color} strokeWidth={2.5} />
              <text x={cx} y={margin.t + plotH + 12} textAnchor="middle" fontSize={9} fontWeight="bold" fill={z.color}>
                <title>{`${z.zoneName} (n=${z.n})`}</title>
                {xLabel}
              </text>
              <text x={cx} y={margin.t + plotH + 22} textAnchor="middle" fontSize={7} fill="#A0AEC0">
                n={z.n}
              </text>
            </g>
          );
        })}
      </svg>
    </Box>
  );
}

export function WithinZoneImageDistribution({ imageRecords, indicatorDefs }: WithinZoneImageDistributionProps) {
  const indicatorIds = useMemo(() => {
    const ids = new Set(imageRecords.map(r => r.indicator_id));
    return Array.from(ids).sort();
  }, [imageRecords]);

  const zoneList = useMemo(() => {
    const zoneMap = new Map<string, string>();
    for (const r of imageRecords) {
      if (!zoneMap.has(r.zone_id)) zoneMap.set(r.zone_id, r.zone_name);
    }
    return Array.from(zoneMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [imageRecords]);

  if (indicatorIds.length === 0 || zoneList.length === 0) {
    return null;
  }

  const hasSmallSample = useMemo(() => {
    for (const ind of indicatorIds) {
      for (const layer of DD_LAYERS) {
        for (const z of zoneList) {
          const n = imageRecords.filter(r =>
            r.indicator_id === ind && r.layer === layer && r.zone_id === z.id,
          ).length;
          if (n > 0 && n < STRIP_PLOT_THRESHOLD) return true;
        }
      }
    }
    return false;
  }, [imageRecords, indicatorIds, zoneList]);

  return (
    <VStack align="stretch" spacing={6} divider={<Box borderTopWidth="1px" borderColor="gray.200" />}>
      {hasSmallSample && (
        <Text fontSize="2xs" color="gray.500">
          n={'<'}{STRIP_PLOT_THRESHOLD}* — panels with fewer than {STRIP_PLOT_THRESHOLD} images per
          (zone × layer) are drawn as strip plots; box statistics are not meaningful below that
          sample size.
        </Text>
      )}
      {indicatorIds.map(ind => {
        const perLayer: Record<string, ZoneBoxStat[]> = {};
        const allValuesForDomain: number[] = [];
        // Issue 5 polish — collect zones that actually have at least one
        // value in any layer for THIS indicator. Build the index map from
        // that subset so the shared legend below only lists zones the
        // panels actually display (other zones might have all-NaN for
        // this indicator).
        const zonesWithDataForInd: { id: string; name: string; color: string }[] = [];
        const zoneIndexById = new Map<string, number>();
        for (const layer of DD_LAYERS) {
          const stats: ZoneBoxStat[] = [];
          zoneList.forEach((z, i) => {
            const values = imageRecords
              .filter(r => r.indicator_id === ind && r.layer === layer && r.zone_id === z.id)
              .map(r => r.value);
            if (values.length === 0) return;
            const color = ZONE_COLORS[i % ZONE_COLORS.length];
            // First time we see this zone in any layer → assign the
            // index and remember its color.
            if (!zoneIndexById.has(z.id)) {
              zoneIndexById.set(z.id, zonesWithDataForInd.length + 1);
              zonesWithDataForInd.push({ id: z.id, name: z.name, color });
            }
            const box = computeBoxStats(values);
            stats.push({
              zoneId: z.id,
              zoneName: z.name,
              color,
              n: values.length,
              values,
              ...box,
            });
            allValuesForDomain.push(...values);
          });
          perLayer[layer] = stats;
        }

        if (allValuesForDomain.length === 0) return null;
        const yDomain = {
          min: Math.min(...allValuesForDomain),
          max: Math.max(...allValuesForDomain),
        };
        const def = indicatorDefs[ind];

        return (
          <Box key={ind}>
            <Text fontSize="sm" fontWeight="bold" mb={2}>
              {def?.name ?? ind}{' '}
              <Text as="span" color="gray.500" fontSize="xs">({ind})</Text>
            </Text>
            <ResponsiveSmallMultiples minPanelWidth={200}>
              {DD_LAYERS.map(layer => (
                <WithinZoneLayerPanel
                  key={layer}
                  layerLabel={DD_LAYER_LABELS[layer]}
                  zoneStats={perLayer[layer] ?? []}
                  yDomain={yDomain}
                  zoneIndexById={zoneIndexById}
                />
              ))}
            </ResponsiveSmallMultiples>
            {/* Issue 5 polish — shared legend below the indicator's 4
                panels. Maps each x-axis index (1, 2, 3, …) to its full
                zone name + color. Mirrors the pattern used for the radar
                chart's per-layer small multiples. */}
            {zonesWithDataForInd.length > 0 && (
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
                {zonesWithDataForInd.map((z) => {
                  const idx = zoneIndexById.get(z.id);
                  return (
                    <ChakraTooltip key={z.id} label={z.name} placement="top" hasArrow openDelay={300}>
                      <HStack spacing={1.5} cursor="default">
                        <Box
                          minW="18px"
                          h="18px"
                          px={1}
                          borderRadius="sm"
                          bg={z.color}
                          color="white"
                          fontWeight="bold"
                          fontSize="2xs"
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                        >
                          {idx}
                        </Box>
                        <Text fontSize="2xs" color="gray.700" maxW="180px" noOfLines={1}>
                          {z.name}
                        </Text>
                      </HStack>
                    </ChakraTooltip>
                  );
                })}
              </HStack>
            )}
          </Box>
        );
      })}
    </VStack>
  );
}


// ─── Archetype Radar Chart (Cluster Centroids) ─────────────────────────────

interface ArchetypeRadarChartProps {
  archetypes: ArchetypeProfile[];
}

export function ArchetypeRadarChart({ archetypes }: ArchetypeRadarChartProps) {
  const { data, names } = useMemo(() => {
    if (!archetypes || archetypes.length === 0) return { data: [], names: [] };
    const allInds = Array.from(new Set(archetypes.flatMap(a => Object.keys(a.centroid_values)))).sort();
    const chartData = allInds.map(ind => {
      const row: Record<string, string | number> = { indicator: ind };
      for (const a of archetypes) {
        row[a.archetype_label] = Number((a.centroid_values[ind] ?? 0).toFixed(3));
      }
      return row;
    });
    return { data: chartData, names: archetypes.map(a => a.archetype_label) };
  }, [archetypes]);

  if (data.length === 0 || names.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={400}>
      <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
        <PolarGrid />
        <PolarAngleAxis dataKey="indicator" tick={{ fontSize: 9 }} tickFormatter={(v: string) => v.length > 10 ? v.slice(0, 10) + '…' : v} />
        <PolarRadiusAxis tick={{ fontSize: 10 }} />
        {names.map((name, i) => (
          <Radar key={name} name={name} dataKey={name} stroke={getZoneColor(i)} fill={getZoneColor(i)} fillOpacity={0.15} />
        ))}
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Tooltip />
      </RadarChart>
    </ResponsiveContainer>
  );
}


// ─── Cluster Size Bar Chart ────────────────────────────────────────────────

interface ClusterSizeChartProps {
  archetypes: ArchetypeProfile[];
}

export function ClusterSizeChart({ archetypes }: ClusterSizeChartProps) {
  // v4.1 — vertical bars (already vertical) with always-visible per-bar
  // count + share% labels. The user previously had to hover to see the
  // value; the label is now baked into the chart so the bundle SVG export
  // shows the same numbers without requiring tooltip interaction.
  const data = useMemo(() => {
    const total = archetypes.reduce((s, a) => s + a.point_count, 0) || 1;
    return archetypes.map((a, idx) => ({
      // v4.x — Short x-axis tick label so all N clusters get a tick even
      // when N is large (Recharts auto-skips long labels to avoid overlap,
      // hiding clusters from view). Display "#<id>" on the axis; the full
      // descriptive label goes in the tooltip + the inside-bar annotation
      // below so nothing is lost.
      shortName: `#${a.archetype_id ?? idx}`,
      name: a.archetype_label,
      count: a.point_count,
      sharePct: (a.point_count / total) * 100,
      archetype_id: a.archetype_id,
    }));
  }, [archetypes]);

  if (data.length === 0) return null;

  // v4.x — Bottom margin scales with label count so even short "#N" ticks
  // get enough room when many clusters are present.
  const bottomMargin = data.length > 8 ? 50 : 30;

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data} margin={{ left: 10, right: 10, top: 30, bottom: bottomMargin }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="shortName"
          tick={{ fontSize: 11, fontWeight: 600 }}
          interval={0}  /* force every tick to render — no auto-skip */
          height={30}
        />
        <YAxis tick={{ fontSize: 10 }}
               label={{ value: 'Image count (points)', angle: -90,
                        position: 'insideLeft', fontSize: 10 }} />
        <Tooltip
          // v4.x — Tooltip now shows the FULL descriptive archetype label
          // (Cluster #N: <Road · features>) so users can still see what
          // each short "#N" tick represents.
          labelFormatter={(_label, payload) => {
            const p = (payload?.[0]?.payload ?? {}) as { name?: string; shortName?: string };
            return `${p.shortName ?? ''} — ${p.name ?? ''}`;
          }}
          formatter={(v: number, _n: string, ctx: { payload?: { sharePct?: number } }) =>
            [`${v} · ${(ctx.payload?.sharePct ?? 0).toFixed(1)}%`, 'Count']
          }
        />
        <Bar dataKey="count" name="Points" barSize={40}>
          {data.map((d, i) =>
            <Cell key={i} fill={getZoneColor(d.archetype_id ?? i)} />)}
          <LabelList
            dataKey="count"
            position="top"
            content={(props: { x?: number | string; y?: number | string;
                               width?: number | string; value?: number | string;
                               index?: number }) => {
              const x = Number(props.x);
              const y = Number(props.y);
              const w = Number(props.width);
              const i = props.index;
              if (Number.isNaN(x) || Number.isNaN(y) || i == null) return null;
              const d = data[i];
              // v4.x — Same defensive guard as the |z| LabelList above:
              // Recharts can call this with stale indices during data
              // transitions (panorama view switch swaps the cluster array
              // mid-render). Crash here white-screens the whole tree.
              if (!d || typeof d.count !== 'number' || typeof d.sharePct !== 'number') return null;
              return (
                <text x={x + w / 2} y={y - 8}
                      textAnchor="middle" fontSize={10}
                      fill="#1a202c" fontWeight={600}>
                  {d.count} · {d.sharePct.toFixed(1)}%
                </text>
              );
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}


// ===========================================================================
// SpatialMarkerLayer — shared rendering for all GPS scatter charts
// ===========================================================================
//
// All four spatial charts (B4 Zone Deviation, ValueSpatialMap,
// SpatialScatterByLayer, ClusterSpatialBeforeAfter, generic SpatialScatterMap)
// originally drew one fixed-radius <circle> per GPS image. For projects with
// hundreds-to-thousands of points along a continuous path (e.g. the 1254-image
// West Lake Inner Ring Road), r=3.5–5.5 px circles overlap so heavily that
// spatial variation is completely invisible — every panel looks like a
// uniform smear.
//
// This layer renders two modes:
//
//   path (default for ≥50 points with detectable order):
//     Sort points along their acquisition sequence, then draw short coloured
//     line segments between consecutive points. Each segment takes its
//     colour from the start-point's value. A grey under-stroke gives the
//     route shape; the coloured top layer encodes the indicator value.
//     Long gaps (> breakDistanceMeters) are broken to avoid drawing
//     diagonal "shortcuts" across the path.
//
//   dots (fallback for small datasets or when path order is unknown):
//     Adaptive-radius circles. Radius shrinks as n grows so 200-1000 point
//     datasets remain legible without manual tuning.
//
// Path order is determined from the leading integer in the filename
// (`<idx>_0_<lng>_<lat>_<name>_<date>_right.png` for the SceneRx
// street-view ingest). Callers can override via `pathOrderKey`.

interface SpatialPointMin {
  lat: number;
  lng: number;
  filename?: string;
}

/** Parse the leading numeric prefix of a filename, used as acquisition index.
 *  Matches "0_…", "1090_…", etc. Returns null if no leading integer is present
 *  (e.g. zone IDs or random hex names) — caller should then fall back to dots.
 */
function defaultPathOrderKey(p: SpatialPointMin): number | null {
  const fn = p.filename;
  if (!fn) return null;
  const m = fn.match(/^(\d+)_/);
  return m ? parseInt(m[1], 10) : null;
}

/** Haversine distance in metres between two GPS points. Used to break the
 *  rendered path across long gaps so the route doesn't visually jump
 *  between disjoint segments of the loop. */
function metersBetween(a: SpatialPointMin, b: SpatialPointMin): number {
  const R = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Adaptive radius for the dot-fallback path. Caps at baseR (caller's
 *  intent for small n) and shrinks proportional to 1/sqrt(n) so visual
 *  occupancy stays roughly constant across project sizes. */
function adaptiveDotRadius(n: number, baseR: number): number {
  if (n <= 50) return baseR;
  return Math.max(1.2, Math.min(baseR, 180 / Math.sqrt(n)));
}

interface SpatialMarkerLayerProps<P extends SpatialPointMin> {
  points: P[];
  toX: (lng: number) => number;
  toY: (lat: number) => number;
  getColor: (p: P) => string;
  /** Tooltip text shown on hover. */
  getTooltip?: (p: P) => string;
  /** Override the default filename → integer path-order extractor. Return null
   *  to mark a point as un-orderable; the layer then falls back to dots. */
  pathOrderKey?: (p: P) => number | null;
  /** Render as dots regardless of n (used when caller already knows order is
   *  not meaningful, e.g. before/after cluster comparison shows two arbitrary
   *  label colourings). */
  forceDotMode?: boolean;
  /** Below this count we render dots even if order is detectable — segments
   *  with very few points look like a sparse polyline rather than a heatmap. */
  minPointsForPath?: number;
  /** Break the path when two consecutive points are farther than this. */
  breakDistanceMeters?: number;
  /** Width of the coloured path segments (px). */
  segmentWidth?: number;
  /** Radius for the dot fallback when n is small. Caps adaptive shrinking. */
  baseDotRadius?: number;
  /** When true, draw a soft grey underlay tracing the full path before the
   *  coloured top layer. Helps reveal the road shape independently of the
   *  indicator values. Defaults to true in path mode. */
  drawRouteUnderlay?: boolean;
}

function SpatialMarkerLayer<P extends SpatialPointMin>({
  points,
  toX,
  toY,
  getColor,
  getTooltip,
  pathOrderKey = defaultPathOrderKey,
  forceDotMode = false,
  minPointsForPath = 50,
  breakDistanceMeters = 80,
  segmentWidth = 2.5,
  baseDotRadius = 4.5,
  drawRouteUnderlay = true,
}: SpatialMarkerLayerProps<P>) {
  // Try to compute path order. If any point lacks an order key, fall back.
  const orderedIndices: number[] | null = useMemo(() => {
    if (forceDotMode) return null;
    if (points.length < minPointsForPath) return null;
    const keys: (number | null)[] = points.map(pathOrderKey);
    if (keys.some((k) => k === null)) return null;
    return points
      .map((_, i) => i)
      .sort((a, b) => (keys[a] as number) - (keys[b] as number));
  }, [points, forceDotMode, minPointsForPath, pathOrderKey]);

  if (orderedIndices) {
    // Pre-compute which segments to draw, with an *adaptive* break threshold.
    //
    // Why adaptive: the original fixed-80m threshold misclassifies both
    // extremes — for a dense urban walk (median ~13m between samples) 80m
    // is generous and works; for a sparser drive (median ~150m) 80m would
    // erroneously break every single segment; for a hybrid project where
    // the collector walked one branch, drove to the next start point, and
    // walked the second branch, we need to catch the "drove" gap without
    // breaking the normal "walked" gaps.
    //
    // Approach: take the median distance between consecutive indexed
    // points (robust to outliers), and break wherever a gap exceeds
    // max(breakDistanceMeters, 4 × median). 4× is empirically the right
    // multiplier — typical walking-pace GPS noise gives a stable median
    // and real branch jumps almost always exceed 4× normal pace.
    //
    // This handles Y-shaped or multi-branch acquisitions cleanly:
    //   • Continuous loop / single path → no breaks, full coloured route.
    //   • Branch end → drive → next branch start → ONE break at the jump,
    //     each branch renders as its own continuous coloured path.
    //   • Doubling back along the same road → no break (small consecutive
    //     distance), the two passes overlap on screen. This is correct:
    //     the road was traversed twice; the last-drawn segment wins, and
    //     a darker hue or value difference is what the user will see.
    //   • Multiple disjoint sub-projects (e.g. east loop + west loop) →
    //     break at every jump, each loop renders independently.
    const consecutiveDistances: number[] = [];
    for (let i = 0; i < orderedIndices.length - 1; i++) {
      consecutiveDistances.push(
        metersBetween(points[orderedIndices[i]], points[orderedIndices[i + 1]])
      );
    }
    const sortedDists = [...consecutiveDistances].sort((a, b) => a - b);
    const medianDist = sortedDists.length
      ? sortedDists[Math.floor(sortedDists.length / 2)]
      : 0;
    const effectiveBreak = Math.max(breakDistanceMeters, medianDist * 4);

    const segments: Array<{ a: P; b: P; key: string }> = [];
    for (let i = 0; i < orderedIndices.length - 1; i++) {
      const a = points[orderedIndices[i]];
      const b = points[orderedIndices[i + 1]];
      if (consecutiveDistances[i] > effectiveBreak) continue;
      segments.push({ a, b, key: `seg-${orderedIndices[i]}-${orderedIndices[i + 1]}` });
    }

    // ── Rendering notes (don't change without re-reading) ──────────────
    //
    // 1) strokeLinecap is `butt`, not `round`. Round caps end every segment
    //    with a half-disc of radius=strokeWidth/2 centred on the segment
    //    endpoint. Adjacent coloured segments share endpoints, so every
    //    interior point ended up with TWO overlapping discs ≈ 1.25px wide;
    //    layered over the wider grey underlay's matching disc, this read
    //    as "a chain of beads" rather than a smooth ribbon. Butt caps end
    //    each segment exactly at its mathematical endpoint, so flush
    //    neighbours look continuous on dense paths (typical 13m sampling).
    //
    // 2) The grey underlay is barely thicker than the coloured top
    //    (+0.4px). The original +1.5px halo was meant to highlight the
    //    route shape, but in practice it just bled a grey edge around
    //    every coloured segment and made the result look fuzzy. With the
    //    smaller delta the underlay still fills in segments where the
    //    indicator value is missing (so you can still see the route
    //    geometry) without halo-ing every coloured pixel.
    //
    // 3) Tiny visual gaps at sharp turns (intersections) are an inherent
    //    trade-off of butt caps + per-segment colouring. They're sub-
    //    pixel for typical urban-walk smoothness (~1-2° per segment) and
    //    only become visible at near-90° corners — which look like
    //    intersections anyway, so the gap reads as "two roads meet".
    return (
      <g>
        {drawRouteUnderlay &&
          segments.map((s) => (
            <line
              key={`u-${s.key}`}
              x1={toX(s.a.lng)}
              y1={toY(s.a.lat)}
              x2={toX(s.b.lng)}
              y2={toY(s.b.lat)}
              stroke="#E2E8F0"
              strokeWidth={segmentWidth + 0.4}
              strokeLinecap="butt"
              pointerEvents="none"
            />
          ))}
        {segments.map((s) => (
          <line
            key={`c-${s.key}`}
            x1={toX(s.a.lng)}
            y1={toY(s.a.lat)}
            x2={toX(s.b.lng)}
            y2={toY(s.b.lat)}
            stroke={getColor(s.a)}
            strokeWidth={segmentWidth}
            strokeLinecap="butt"
            opacity={1}
          >
            {getTooltip && <title>{getTooltip(s.a)}</title>}
          </line>
        ))}
      </g>
    );
  }

  // Dot fallback (small N, or no detectable order)
  const r = adaptiveDotRadius(points.length, baseDotRadius);
  // Use stroke="none" + lower opacity so overlaps blend instead of stacking
  // outlines into a noisy mesh. Outline only kicks back in for small N.
  const showStroke = points.length <= 80;
  return (
    <g>
      {points.map((p, i) => (
        <circle
          key={i}
          cx={toX(p.lng)}
          cy={toY(p.lat)}
          r={r}
          fill={getColor(p)}
          stroke={showStroke ? '#fff' : 'none'}
          strokeWidth={showStroke ? 0.5 : 0}
          opacity={points.length > 200 ? 0.65 : 0.85}
        >
          {getTooltip && <title>{getTooltip(p)}</title>}
        </circle>
      ))}
    </g>
  );
}


// ─── Spatial Scatter Map (points colored by value) ─────────────────────────

interface SpatialScatterMapProps {
  points: { lat: number; lng: number; value: number; label?: string; filename?: string }[];
  indicatorId?: string;
  /** Shared min/max for color scaling across sibling maps (e.g., per-layer grid). */
  vMin?: number;
  vMax?: number;
  /** Compact mode: smaller dimensions for grid layouts. */
  compact?: boolean;
}

export function SpatialScatterMap({ points, indicatorId, vMin: vMinProp, vMax: vMaxProp, compact }: SpatialScatterMapProps) {
  if (!points || points.length === 0) return null;

  const vals = points.map(p => p.value);
  const vMin = vMinProp ?? Math.min(...vals);
  const vMax = vMaxProp ?? Math.max(...vals);
  const vRange = vMax - vMin || 1;

  const svgW = compact ? 340 : 500;
  const svgH = compact ? 260 : 400;
  const margin = compact ? { l: 50, r: 16, t: 16, b: 40 } : { l: 60, r: 20, t: 20, b: 50 };
  const plotW = svgW - margin.l - margin.r;
  const plotH = svgH - margin.t - margin.b;

  const lngs = points.map(p => p.lng);
  const lats = points.map(p => p.lat);
  const lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lngRange = lngMax - lngMin || 0.001;
  const latRange = latMax - latMin || 0.001;

  const toX = (lng: number) => margin.l + ((lng - lngMin) / lngRange) * plotW;
  const toYPos = (lat: number) => margin.t + plotH - ((lat - latMin) / latRange) * plotH;

  function valColor(v: number): string {
    const t = (v - vMin) / vRange;
    const r = Math.round(229 - t * 173);
    const g = Math.round(62 + t * 99);
    const b = Math.round(62 - t * 6);
    return `rgb(${r},${g},${b})`;
  }

  return (
    <Box overflow="visible">
      <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {/* Axes */}
        <line x1={margin.l} y1={margin.t} x2={margin.l} y2={margin.t + plotH} stroke="#CBD5E0" />
        <line x1={margin.l} y1={margin.t + plotH} x2={margin.l + plotW} y2={margin.t + plotH} stroke="#CBD5E0" />
        <text x={svgW / 2} y={svgH - 5} textAnchor="middle" fontSize={10} fill="#718096">Longitude</text>
        <text x={12} y={svgH / 2} textAnchor="middle" fontSize={10} fill="#718096" transform={`rotate(-90, 12, ${svgH / 2})`}>Latitude</text>
        {indicatorId && <text x={svgW / 2} y={14} textAnchor="middle" fontSize={11} fontWeight="bold" fill="#2D3748">{indicatorId}</text>}
        {/* Points — path heatmap for ≥50 GPS samples with detectable order,
            adaptive-radius dots otherwise. */}
        <SpatialMarkerLayer
          points={points}
          toX={toX}
          toY={toYPos}
          getColor={(p) => valColor(p.value)}
          getTooltip={(p) =>
            `${p.label || ''} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}): ${p.value.toFixed(3)}`
          }
          baseDotRadius={compact ? 3.5 : 5}
        />
        {/* Legend */}
        <defs>
          <linearGradient id={`spatialGrad-${indicatorId ?? 'default'}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor={valColor(vMin)} />
            <stop offset="100%" stopColor={valColor(vMax)} />
          </linearGradient>
        </defs>
        <rect x={margin.l + plotW - 120} y={margin.t + 5} width={100} height={10} fill={`url(#spatialGrad-${indicatorId ?? 'default'})`} rx={2} />
        <text x={margin.l + plotW - 122} y={margin.t + 14} textAnchor="end" fontSize={8} fill="#718096">{vMin.toFixed(2)}</text>
        <text x={margin.l + plotW - 18} y={margin.t + 14} textAnchor="start" fontSize={8} fill="#718096">{vMax.toFixed(2)}</text>
      </svg>
    </Box>
  );
}


// ─── Per-Indicator Spatial Scatter — All Layers Combined (Fig 7) ─────────

interface SpatialScatterByLayerProps {
  /** GPS-enabled images (has_gps && latitude != null && longitude != null). */
  gpsImages: UploadedImage[];
  indicatorId: string;
}

const LAYER_DEFS: { key: string; label: string; suffix: string }[] = [
  { key: 'full', label: 'Full', suffix: '' },
  { key: 'foreground', label: 'FG', suffix: '__foreground' },
  { key: 'middleground', label: 'MG', suffix: '__middleground' },
  { key: 'background', label: 'BG', suffix: '__background' },
];

const LAYER_SCATTER_COLORS: Record<string, string> = {
  full: '#718096',
  foreground: '#E53E3E',
  middleground: '#38A169',
  background: '#805AD5',
};

export function SpatialScatterByLayer({ gpsImages, indicatorId }: SpatialScatterByLayerProps) {
  // Per-layer point sets. With identical (lat,lng) across the 4 layers, an
  // overlaid single-canvas rendering hides every layer except the last drawn —
  // small multiples (one canvas per layer) removes the occlusion entirely.
  const layered = useMemo(() => {
    // Carry the original filename so SpatialMarkerLayer can detect the path
    // order. Label still defaults to zone_id when present (more meaningful
    // tooltip), but is overridden by filename if no zone is set.
    type Pt = { lat: number; lng: number; value: number; label: string; filename: string };
    const out: Record<string, Pt[]> = { full: [], foreground: [], middleground: [], background: [] };
    for (const l of LAYER_DEFS) {
      const key = l.suffix ? `${indicatorId}${l.suffix}` : indicatorId;
      for (const img of gpsImages) {
        const v = img.metrics_results[key];
        if (v != null && img.latitude != null && img.longitude != null) {
          out[l.key].push({
            lat: img.latitude, lng: img.longitude, value: v,
            label: `${img.zone_id || img.filename}`,
            filename: img.filename,
          });
        }
      }
    }
    return out;
  }, [gpsImages, indicatorId]);

  // Shared lat/lng extent so all 4 panels align.
  const allPts = useMemo(
    () => Object.values(layered).flat(),
    [layered],
  );
  if (allPts.length === 0) return null;

  const lngs = allPts.map(p => p.lng);
  const lats = allPts.map(p => p.lat);
  const lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lngRange = lngMax - lngMin || 0.001;
  const latRange = latMax - latMin || 0.001;

  const svgW = 280, svgH = 220;
  const margin = { l: 38, r: 10, t: 22, b: 28 };
  const plotW = svgW - margin.l - margin.r;
  const plotH = svgH - margin.t - margin.b;
  const toX = (lng: number) => margin.l + ((lng - lngMin) / lngRange) * plotW;
  const toY = (lat: number) => margin.t + plotH - ((lat - latMin) / latRange) * plotH;

  return (
    <Box>
      <Text fontSize="sm" fontWeight="bold" mb={2}>{indicatorId}</Text>
      <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} spacing={2}>
        {LAYER_DEFS.map(l => {
          const pts = layered[l.key];
          const color = LAYER_SCATTER_COLORS[l.key] || '#A0AEC0';
          return (
            <Box key={l.key} borderWidth={1} borderColor="gray.200" borderRadius="md" p={1}>
              <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
                <text x={svgW / 2} y={14} textAnchor="middle" fontSize={10} fontWeight="bold" fill={color}>
                  {l.label} (n={pts.length})
                </text>
                <line x1={margin.l} y1={margin.t} x2={margin.l} y2={margin.t + plotH} stroke="#CBD5E0" />
                <line x1={margin.l} y1={margin.t + plotH} x2={margin.l + plotW} y2={margin.t + plotH} stroke="#CBD5E0" />
                <SpatialMarkerLayer
                  points={pts}
                  toX={toX}
                  toY={toY}
                  getColor={() => color}
                  getTooltip={(p) => `${p.label}: ${p.value.toFixed(3)}`}
                  baseDotRadius={3.5}
                />
              </svg>
            </Box>
          );
        })}
      </SimpleGrid>
    </Box>
  );
}

// ─── Per-Indicator Value Spatial Distribution (Issue 4d) ───────────────────
// A heatmap over GPS points colored by indicator VALUE (not layer, not z).
// Complements:
//   • Fig 7 (Layer Coverage): "where does each layer have data?"
//   • Fig 8 (Z-Deviation):    "where does the indicator deviate from mean?"
//   • Value Heatmap:          "where is the indicator value high vs. low?"
// Especially useful for single-zone projects where the z-based views collapse.

interface ValueSpatialMapProps {
  gpsImages: UploadedImage[];
  indicatorId: string;
  /** Which layer's value to display (default 'full'). */
  layer?: 'full' | 'foreground' | 'middleground' | 'background';
  /** INCREASE = green-better, DECREASE = red-better, NEUTRAL = blue. */
  targetDirection?: string;
  colorblindMode?: boolean;
}

/** Default value-map gradient. We switched away from the direction-keyed
 * green / red / blue scheme to MATLAB's **parula** (R2014b+ default) so
 * the four-layer small-multiples for a single indicator (Full / FG / MG /
 * BG) all share the same perceptually-uniform sweep — the reader can
 * compare layers by eye without having to mentally rescale a different
 * hue range per panel. INCREASE / DECREASE semantics remain available
 * via the `targetDirection` prop and are surfaced in the legend caption;
 * the colorblind fallback uses viridis (same trajectory, CB-safe). */
function gradientForDirection(t: number, _dir: string, colorblindMode = false): string {
  return parulaColor(t, !!colorblindMode);
}

export function ValueSpatialMap({
  gpsImages, indicatorId, layer = 'full', targetDirection = 'NEUTRAL', colorblindMode,
}: ValueSpatialMapProps) {
  const points = useMemo(() => {
    const suffix = LAYER_DEFS.find(l => l.key === layer)?.suffix ?? '';
    const key = suffix ? `${indicatorId}${suffix}` : indicatorId;
    // Carry `filename` separately from `label` so SpatialMarkerLayer can
    // recover the acquisition-order path even when callers want to show a
    // different tooltip label.
    const pts: { lat: number; lng: number; value: number; label: string; filename: string }[] = [];
    for (const img of gpsImages) {
      const v = img.metrics_results[key];
      if (v != null && img.latitude != null && img.longitude != null) {
        pts.push({ lat: img.latitude, lng: img.longitude, value: v, label: img.filename, filename: img.filename });
      }
    }
    return pts;
  }, [gpsImages, indicatorId, layer]);

  if (points.length === 0) return null;

  // Robust value range using p5/p95 to avoid outliers compressing the gradient.
  const vals = [...points.map(p => p.value)].sort((a, b) => a - b);
  const p5 = vals[Math.floor(vals.length * 0.05)] ?? vals[0];
  const p95 = vals[Math.floor(vals.length * 0.95)] ?? vals[vals.length - 1];
  const valRange = p95 - p5 || 1;

  const svgW = 360, svgH = 260;
  const margin = { l: 50, r: 16, t: 28, b: 38 };
  const plotW = svgW - margin.l - margin.r;
  const plotH = svgH - margin.t - margin.b;

  // v4 / Module 7.3.2 — robust GPS bbox.
  // Drops IQR×3 outliers (e.g. stray (0,0) initialisations or GPS drift) so a
  // tight cluster doesn't get crushed into a corner. Outliers still render as
  // outline circles to mark them.
  const bbox = robustGpsBbox(points);
  const lngRange = bbox.bbox.lngMax - bbox.bbox.lngMin || 0.001;
  const latRange = bbox.bbox.latMax - bbox.bbox.latMin || 0.001;
  const toX = (lng: number) => margin.l + ((lng - bbox.bbox.lngMin) / lngRange) * plotW;
  const toY = (lat: number) => margin.t + plotH - ((lat - bbox.bbox.latMin) / latRange) * plotH;
  const renderable = bbox.inliers.length > 0 ? bbox.inliers : points;

  return (
    <Box>
      <Text fontSize="sm" fontWeight="bold" mb={1}>{indicatorId}</Text>
      <Text fontSize="xs" color="gray.500" mb={1}>
        Color = indicator value · MATLAB parula colormap · {layer} layer ·{' '}
        {targetDirection.toLowerCase()} target · p5–p95 range
      </Text>
      <Box overflowX="auto" bg="gray.50" borderRadius="md" p={1}>
        <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
          <line x1={margin.l} y1={margin.t} x2={margin.l} y2={margin.t + plotH} stroke="#CBD5E0" />
          <line x1={margin.l} y1={margin.t + plotH} x2={margin.l + plotW} y2={margin.t + plotH} stroke="#CBD5E0" />
          {/* Inlier points — path heatmap for ≥50 points, adaptive dots for less */}
          <SpatialMarkerLayer
            points={renderable}
            toX={toX}
            toY={toY}
            getColor={(p) => gradientForDirection((p.value - p5) / valRange, targetDirection, colorblindMode)}
            getTooltip={(p) => `${p.label}: ${p.value.toFixed(3)}`}
            baseDotRadius={4.5}
          />
          {/* Outlier points (outline only — flagged for inspection) */}
          {bbox.inliers.length > 0 && bbox.outliers.map((p, i) => {
            // Clip outliers to the bbox edges so they still render as a dot,
            // just on the perimeter rather than far off-canvas.
            const cx = Math.max(margin.l, Math.min(margin.l + plotW, toX(p.lng)));
            const cy = Math.max(margin.t, Math.min(margin.t + plotH, toY(p.lat)));
            return (
              <circle key={`out-${i}`} cx={cx} cy={cy} r={4} fill="none"
                stroke="#A0AEC0" strokeWidth={1} strokeDasharray="2 2" opacity={0.7}>
                <title>{`${p.label}: ${p.value.toFixed(3)} · GPS outlier (clipped to bbox edge)`}</title>
              </circle>
            );
          })}
          {/* Gradient legend */}
          <defs>
            <linearGradient id={`val-${indicatorId}-${layer}`} x1="0" x2="1">
              <stop offset="0%" stopColor={gradientForDirection(0, targetDirection, colorblindMode)} />
              <stop offset="50%" stopColor={gradientForDirection(0.5, targetDirection, colorblindMode)} />
              <stop offset="100%" stopColor={gradientForDirection(1, targetDirection, colorblindMode)} />
            </linearGradient>
          </defs>
          <rect x={margin.l + 4} y={6} width={120} height={8}
            fill={`url(#val-${indicatorId}-${layer})`} rx={2} />
          <text x={margin.l + 2} y={20} fontSize={8} fill="#718096">{p5.toFixed(2)}</text>
          <text x={margin.l + 124} y={20} textAnchor="end" fontSize={8} fill="#718096">{p95.toFixed(2)}</text>
          {/* Scale bar caption */}
          <text x={svgW - 4} y={svgH - 4} textAnchor="end" fontSize={7} fill="#A0AEC0">
            ≈ {bbox.horizontalMeters}m × {bbox.verticalMeters}m
          </text>
        </svg>
      </Box>
    </Box>
  );
}


// ─── Cross-Indicator Spatial Maps (Fig 8) ──────────────────────────────────

interface CrossIndicatorSpatialMapsProps {
  gpsImages: UploadedImage[];
  indicatorIds: string[];
  colorblindMode?: boolean;
  /** v4 / Module 6.3.3: which panel(s) to render.
   *   'mean_abs_z'         — only the cross-indicator deviation map (B4 use)
   *   'dominant_indicator' — only the per-point dominant indicator map (C4 use)
   *   'both' (default)     — legacy two-panel layout, kept for backward compat */
  panel?: 'both' | 'mean_abs_z' | 'dominant_indicator';
  /** v4 polish — which depth layer's values to read for z-score / dominance
   *   computation. 'full' (default) uses img.metrics_results[ind]; 'foreground'
   *   / 'middleground' / 'background' use the `${ind}__${layer}` key.
   *   Used when the parent renders 4-up small multiples (one CrossIndicator-
   *   SpatialMaps per layer) to bring B4 / C4-dominant info density up to
   *   match siblings (C1 / C3 already 4-up). */
  layer?: 'full' | 'foreground' | 'middleground' | 'background';
}

/** YlOrRd → Viridis when colorblindMode is on. `t` in [0, 1]. */
function ylOrRdColor(t: number, colorblindMode = false): string {
  return magnitudeColor(t, colorblindMode);
}

const CATEGORICAL_PALETTE = [
  '#3182CE', '#E53E3E', '#38A169', '#D69E2E',
  '#805AD5', '#DD6B20', '#0BC5EA', '#ED64A6',
  '#4A5568', '#F56565', '#48BB78', '#ECC94B',
];

interface CrossPoint {
  lat: number;
  lng: number;
  label?: string;
  /** Original UploadedImage.filename — used by SpatialMarkerLayer to recover
   *  the acquisition order ("123_0_..._right.png" → index 123) so the chart
   *  can render as a path heatmap instead of overlapping dots. */
  filename?: string;
  meanAbsZ: number;
  mostDistinctive: string;
}

function renderCrossScatter(
  points: CrossPoint[],
  mode: 'gradient' | 'categorical',
  getColor: (p: CrossPoint) => string,
  valueFn: (p: CrossPoint) => string,
  colorblindMode = false,
) {
  if (points.length === 0) return null;
  const svgW = 340;
  const svgH = 260;
  // Issue 3 polish — bump top margin from 14 → 28 so the gradient
  // colorbar (rendered in this margin zone, above the plot) can never
  // overlap data points. Plot height shrinks by 14px in exchange for
  // a clean separation between legend and points.
  const margin = { l: 50, r: 16, t: 28, b: 38 };
  const plotW = svgW - margin.l - margin.r;
  const plotH = svgH - margin.t - margin.b;

  // v4 / Module 7.3.2 — robust GPS bbox to prevent stray points from
  // crushing the legitimate cluster into a corner.
  const bbox = robustGpsBbox(points);
  const lngRange = bbox.bbox.lngMax - bbox.bbox.lngMin || 0.001;
  const latRange = bbox.bbox.latMax - bbox.bbox.latMin || 0.001;
  const toX = (lng: number) => margin.l + ((lng - bbox.bbox.lngMin) / lngRange) * plotW;
  const toY = (lat: number) => margin.t + plotH - ((lat - bbox.bbox.latMin) / latRange) * plotH;
  const renderable = bbox.inliers.length > 0 ? bbox.inliers : points;

  return (
    <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
      <line x1={margin.l} y1={margin.t} x2={margin.l} y2={margin.t + plotH} stroke="#CBD5E0" />
      <line x1={margin.l} y1={margin.t + plotH} x2={margin.l + plotW} y2={margin.t + plotH} stroke="#CBD5E0" />
      <text x={svgW / 2} y={svgH - 4} textAnchor="middle" fontSize={9} fill="#718096">Longitude</text>
      <text x={12} y={svgH / 2} textAnchor="middle" fontSize={9} fill="#718096" transform={`rotate(-90, 12, ${svgH / 2})`}>Latitude</text>
      <SpatialMarkerLayer
        points={renderable}
        toX={toX}
        toY={toY}
        getColor={getColor}
        getTooltip={(p) => `${p.label || ''} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}): ${valueFn(p)}`}
        baseDotRadius={5.5}
        // Categorical mode (Dominant Indicator) renders as path too: the
        // colour of each segment is the dominant indicator at that point,
        // so contiguous runs of a single colour show stretches of road
        // where one indicator consistently leads. The hard colour
        // boundaries between adjacent segments are informative —
        // they pinpoint exactly where the dominant indicator switches.
      />

      {bbox.inliers.length > 0 && bbox.outliers.map((p, i) => {
        const cx = Math.max(margin.l, Math.min(margin.l + plotW, toX(p.lng)));
        const cy = Math.max(margin.t, Math.min(margin.t + plotH, toY(p.lat)));
        return (
          <circle key={`out-${i}`} cx={cx} cy={cy} r={4} fill="none"
            stroke="#A0AEC0" strokeWidth={1} strokeDasharray="2 2" opacity={0.7}>
            <title>{`${p.label || ''}: GPS outlier (clipped to bbox edge)`}</title>
          </circle>
        );
      })}
      {mode === 'gradient' && (
        <>
          <defs>
            <linearGradient id={`ylOrRd-${points.length}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor={ylOrRdColor(0, colorblindMode)} />
              <stop offset="50%" stopColor={ylOrRdColor(0.5, colorblindMode)} />
              <stop offset="100%" stopColor={ylOrRdColor(1, colorblindMode)} />
            </linearGradient>
          </defs>
          {/* Issue 3 polish — colorbar moved into the top margin (above
              the plot). Previously it sat inside the plot at y=margin.t+4,
              which on dense scatter maps would overlap with points
              clustered in the top-right corner. Now lives in the margin
              zone where there are no data points to obscure. */}
          <rect x={margin.l + plotW - 110} y={6} width={90} height={8} fill={`url(#ylOrRd-${points.length})`} rx={2} />
          <text x={margin.l + plotW - 112} y={13} textAnchor="end" fontSize={7} fill="#718096">0</text>
          <text x={margin.l + plotW - 16} y={13} textAnchor="start" fontSize={7} fill="#718096">2+</text>
        </>
      )}
      <text x={svgW - 4} y={svgH - 4} textAnchor="end" fontSize={7} fill="#A0AEC0">
        ≈ {bbox.horizontalMeters}m × {bbox.verticalMeters}m
      </text>
    </svg>
  );
}

export function CrossIndicatorSpatialMaps({ gpsImages, indicatorIds, colorblindMode, panel = 'both', layer = 'full' }: CrossIndicatorSpatialMapsProps) {
  const points = useMemo(() => {
    // For full layer use the bare indicator id; for layer-specific reads use
    // the `${ind}__${layer}` key the calculator uses when persisting layer
    // metrics (see backend MetricsAggregator).
    const keyOf = (ind: string) => layer === 'full' ? ind : `${ind}__${layer}`;
    const indStats: Record<string, { mean: number; std: number }> = {};
    for (const ind of indicatorIds) {
      const vals: number[] = [];
      const k = keyOf(ind);
      for (const img of gpsImages) {
        const v = img.metrics_results[k];
        if (v != null) vals.push(v);
      }
      if (vals.length < 3) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1);
      const std = Math.sqrt(variance);
      if (std > 0) indStats[ind] = { mean, std };
    }

    // Per point: z-scores, mean_abs_z, most_distinctive
    const pts: CrossPoint[] = [];
    for (const img of gpsImages) {
      if (img.latitude == null || img.longitude == null) continue;
      let sumAbsZ = 0;
      let count = 0;
      let bestInd = '';
      let bestAbsZ = -1;
      for (const ind of indicatorIds) {
        const stats = indStats[ind];
        if (!stats) continue;
        const val = img.metrics_results[keyOf(ind)];
        if (val == null) continue;
        const z = (val - stats.mean) / stats.std;
        const absZ = Math.abs(z);
        sumAbsZ += absZ;
        count++;
        if (absZ > bestAbsZ) { bestAbsZ = absZ; bestInd = ind; }
      }
      if (count === 0) continue;
      pts.push({
        lat: img.latitude,
        lng: img.longitude,
        label: img.zone_id || img.filename,
        filename: img.filename,
        meanAbsZ: sumAbsZ / count,
        mostDistinctive: bestInd,
      });
    }
    return pts;
  }, [gpsImages, indicatorIds, layer]);

  if (points.length === 0) {
    return (
      <Text fontSize="xs" color="gray.500">
        Cannot compute cross-indicator spatial maps: need at least 3 GPS images
        with indicator values that have non-zero variance.
      </Text>
    );
  }

  // Categorical color map for dominant indicators
  const allDominantInds = Array.from(
    new Set(points.map(p => p.mostDistinctive))
  ).sort();
  const indColor: Record<string, string> = {};
  allDominantInds.forEach((ind, i) => { indColor[ind] = CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length]; });

  const showMeanZ = panel === 'both' || panel === 'mean_abs_z';
  const showDominant = panel === 'both' || panel === 'dominant_indicator';

  return (
    <Box>
      {/* Legend for dominant indicators (only when that panel is rendered) */}
      {showDominant && (
        <Box mb={3} display="flex" flexWrap="wrap" gap={2}>
          <Text fontSize="xs" fontWeight="bold" color="gray.600" mr={1}>Dominant indicator:</Text>
          {allDominantInds.map(ind => (
            <Box key={ind} display="inline-flex" alignItems="center" gap={1}>
              <Box w="10px" h="10px" borderRadius="sm" bg={indColor[ind]} />
              <Text fontSize="xs" color="gray.600">{ind.replace('IND_', '')}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Text fontSize="xs" color="gray.500" mb={2}>n={points.length} GPS images</Text>
      <ResponsiveSmallMultiples minPanelWidth={300}>
        {showMeanZ ? (
          <Box>
            <Text fontSize="xs" textAlign="center" mb={1} color="gray.600">
              Deviation from Average (Mean |Z|)
            </Text>
            {renderCrossScatter(
              points,
              'gradient',
              p => ylOrRdColor(p.meanAbsZ / 2, colorblindMode),
              p => `Mean |Z| = ${p.meanAbsZ.toFixed(3)}`,
              colorblindMode,
            )}
          </Box>
        ) : null}
        {showDominant ? (
          <Box>
            <Text fontSize="xs" textAlign="center" mb={1} color="gray.600">
              Most Distinctive Indicator
            </Text>
            {renderCrossScatter(
              points,
              'categorical',
              p => indColor[p.mostDistinctive] || '#A0AEC0',
              p => `${p.mostDistinctive} (|Z| highest)`,
            )}
          </Box>
        ) : null}
      </ResponsiveSmallMultiples>
    </Box>
  );
}


// ─── Indicator Value Map (C4) with Toggle — v4 / Module 6.3.3 ──────────────
//
// Wraps the per-indicator × 4-layer value heatmap (ValueSpatialMap × layers)
// and the cross-indicator "dominant per-point" map. A small Button toggle at
// the top lets the user flip between the two views without leaving the card.
//
// "By indicator value" → existing 4-layer spatial map, one row per indicator
// "Dominant indicator per point" → migrated from B4 right-half: every GPS
//                                  point coloured by its highest-|z| indicator

interface IndicatorValueMapWithToggleProps {
  gpsImages: UploadedImage[];
  indicatorIds: string[];
  indicatorDefs: Record<string, IndicatorDefinitionInput>;
  colorblindMode?: boolean;
}

const VALUE_MAP_LAYERS = ['full', 'foreground', 'middleground', 'background'] as const;

export function IndicatorValueMapWithToggle({
  gpsImages, indicatorIds, indicatorDefs, colorblindMode,
}: IndicatorValueMapWithToggleProps) {
  const [view, setView] = useState<'by_value' | 'dominant'>('by_value');

  return (
    <Box>
      <HStack justify="space-between" align="center" mb={3} flexWrap="wrap" gap={2}>
        <ButtonGroup size="xs" isAttached variant="outline">
          <Button
            colorScheme={view === 'by_value' ? 'blue' : 'gray'}
            variant={view === 'by_value' ? 'solid' : 'outline'}
            onClick={() => setView('by_value')}
          >
            By indicator value
          </Button>
          <Button
            colorScheme={view === 'dominant' ? 'blue' : 'gray'}
            variant={view === 'dominant' ? 'solid' : 'outline'}
            onClick={() => setView('dominant')}
          >
            Dominant indicator per point
          </Button>
        </ButtonGroup>
        <Text fontSize="2xs" color="gray.500">
          {view === 'by_value'
            ? `${indicatorIds.length} indicators × 4 layers`
            : 'one map · most-distinctive indicator at each GPS point'}
        </Text>
      </HStack>

      {view === 'by_value' ? (
        <VStack align="stretch" spacing={6}>
          {indicatorIds.map(ind => (
            <Box key={ind}>
              <Text fontSize="sm" fontWeight="bold" mb={2}>
                {indicatorDefs[ind]?.name ?? ind}{' '}
                <Text as="span" color="gray.500" fontSize="xs">({ind})</Text>
              </Text>
              <ResponsiveSmallMultiples minPanelWidth={300}>
                {VALUE_MAP_LAYERS.map((layer) => (
                  <ValueSpatialMap
                    key={`${ind}-${layer}`}
                    gpsImages={gpsImages}
                    indicatorId={ind}
                    layer={layer}
                    targetDirection={indicatorDefs[ind]?.target_direction}
                    colorblindMode={colorblindMode}
                  />
                ))}
              </ResponsiveSmallMultiples>
            </Box>
          ))}
        </VStack>
      ) : (
        // v4 polish — render the dominant-indicator map as 4-up small
        // multiples (one per depth layer) so info density matches its
        // siblings C1 / C3 (also 4-up) instead of being a sparse single
        // map. Each panel shows the same GPS scatter coloured by which
        // indicator dominates in that layer at each point.
        <ResponsiveSmallMultiples minPanelWidth={300}>
          {(['full', 'foreground', 'middleground', 'background'] as const).map((layer) => (
            <Box key={layer}>
              <Text fontSize="xs" textAlign="center" mb={1} color="gray.600" fontWeight="bold">
                {layer === 'full' ? 'Full layer'
                  : layer === 'foreground' ? 'Foreground'
                  : layer === 'middleground' ? 'Middleground'
                  : 'Background'}
              </Text>
              <CrossIndicatorSpatialMaps
                gpsImages={gpsImages}
                indicatorIds={indicatorIds}
                colorblindMode={colorblindMode}
                panel="dominant_indicator"
                layer={layer}
              />
            </Box>
          ))}
        </ResponsiveSmallMultiples>
      )}
    </Box>
  );
}


// ─── Cluster Spatial Scatter (before vs after smoothing) ──────────────────

interface ClusterSpatialBeforeAfterProps {
  lats: number[];
  lngs: number[];
  labelsRaw: number[];
  labelsSmoothed: number[];
  archetypeLabels?: Record<number, string>;
}

export function ClusterSpatialBeforeAfter({
  lats, lngs, labelsRaw, labelsSmoothed, archetypeLabels = {},
}: ClusterSpatialBeforeAfterProps) {
  if (lats.length === 0 || lats.length !== lngs.length) return null;

  const uniqueLabels = Array.from(new Set([...labelsRaw, ...labelsSmoothed])).sort((a, b) => a - b);
  const colorMap: Record<number, string> = {};
  uniqueLabels.forEach((l, i) => { colorMap[l] = CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length]; });

  const nChanged = labelsRaw.reduce((acc, r, i) => acc + (r !== labelsSmoothed[i] ? 1 : 0), 0);
  const pctChanged = labelsRaw.length > 0 ? (nChanged / labelsRaw.length) * 100 : 0;

  // v4 polish — use robustGpsBbox (IQR × 3 outlier filtering) so a single
  // bad coordinate (e.g. an image with lat/lng=0 sneaking past pipeline
  // validation) doesn't compress every other point into a single column,
  // as the user reported (smoothing scatter showed ~5 visible dots while
  // C4 maps showed all 50). Also drop points that fall outside the bbox
  // entirely so they don't render at the edge.
  const bboxPoints = lats.map((lat, i) => ({ lat, lng: lngs[i] }));
  const { bbox } = robustGpsBbox(bboxPoints);

  function renderMap(labels: number[], title: string) {
    const svgW = 340;
    const svgH = 280;
    const margin = { l: 50, r: 16, t: 14, b: 38 };
    const plotW = svgW - margin.l - margin.r;
    const plotH = svgH - margin.t - margin.b;

    const lngMin = bbox.lngMin;
    const lngMax = bbox.lngMax;
    const latMin = bbox.latMin;
    const latMax = bbox.latMax;
    const lngRange = lngMax - lngMin || 0.001;
    const latRange = latMax - latMin || 0.001;
    const toX = (lng: number) => margin.l + ((lng - lngMin) / lngRange) * plotW;
    const toY = (lat: number) => margin.t + plotH - ((lat - latMin) / latRange) * plotH;
    const inBbox = (lat: number, lng: number) =>
      lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax;

    return (
      <Box>
        <Text fontSize="xs" textAlign="center" mb={1} color="gray.600" fontWeight="bold">{title}</Text>
        <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
          <line x1={margin.l} y1={margin.t} x2={margin.l} y2={margin.t + plotH} stroke="#CBD5E0" />
          <line x1={margin.l} y1={margin.t + plotH} x2={margin.l + plotW} y2={margin.t + plotH} stroke="#CBD5E0" />
          <text x={svgW / 2} y={svgH - 4} textAnchor="middle" fontSize={9} fill="#718096">Longitude</text>
          <text x={12} y={svgH / 2} textAnchor="middle" fontSize={9} fill="#718096" transform={`rotate(-90, 12, ${svgH / 2})`}>Latitude</text>
          {/* Cluster labels are categorical, not a continuous value sweep, so
              we deliberately stay in dot mode (path segments would imply a
              sequential transition between clusters). The dot radius is
              adaptive on n so the West Lake 1254-point project doesn't
              produce an opaque smear like the original r=3 rendering did.
              TODO(if path mode wanted here): pipe `point_filenames` from
              ClusteringResult so we can do segment rendering coloured by
              cluster label instead of by index. */}
          <SpatialMarkerLayer
            points={lats
              .map((lat, i) => ({ lat, lng: lngs[i], label: labels[i] }))
              .filter((p) => inBbox(p.lat, p.lng))}
            toX={toX}
            toY={toY}
            getColor={(p) => colorMap[p.label] || '#A0AEC0'}
            getTooltip={(p) =>
              `Cluster ${p.label}${archetypeLabels[p.label] ? ': ' + archetypeLabels[p.label] : ''}`
            }
            forceDotMode
            baseDotRadius={3}
          />
        </svg>
      </Box>
    );
  }

  return (
    <Box>
      <Text fontSize="xs" color="gray.600" mb={2}>
        Spatial smoothing changed <strong>{nChanged}</strong> labels ({pctChanged.toFixed(1)}% of {labelsRaw.length} points)
      </Text>
      {/* Legend */}
      <Box mb={3} display="flex" flexWrap="wrap" gap={2}>
        {uniqueLabels.map(l => (
          <Box key={l} display="inline-flex" alignItems="center" gap={1}>
            <Box w="10px" h="10px" borderRadius="sm" bg={colorMap[l]} />
            <Text fontSize="xs" color="gray.600">
              {archetypeLabels[l] || `Cluster ${l}`}
            </Text>
          </Box>
        ))}
      </Box>
      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3}>
        {renderMap(labelsRaw, '(a) Before Smoothing')}
        {renderMap(labelsSmoothed, '(b) After Spatial Smoothing')}
      </SimpleGrid>
    </Box>
  );
}


// ─── Dendrogram (Ward hierarchical clustering tree) ───────────────────────

interface DendrogramProps {
  /** scipy linkage matrix: each row = [id1, id2, distance, count] */
  linkage: number[][];
  /** Show cut line at 85th percentile of merge distances (matches notebook Cell 23) */
  showCutLine?: boolean;
}

export function Dendrogram({ linkage, showCutLine = true }: DendrogramProps) {
  if (!linkage || linkage.length === 0) {
    return <Text fontSize="sm" color="gray.400">No dendrogram data</Text>;
  }

  const n = linkage.length + 1; // number of original samples
  const maxDist = Math.max(...linkage.map(row => row[2]));

  // Compute leaf display order via DFS (left-first)
  const leafOrder: number[] = [];
  function collect(nodeId: number) {
    if (nodeId < n) { leafOrder.push(nodeId); return; }
    const row = linkage[nodeId - n];
    collect(Math.round(row[0]));
    collect(Math.round(row[1]));
  }
  collect(n + linkage.length - 1);

  const leafX: Record<number, number> = {};
  leafOrder.forEach((leafId, idx) => { leafX[leafId] = idx; });

  // Compute position (x, y) for every node (leaves + internal)
  const nodes: { x: number; y: number }[] = new Array(n + linkage.length);
  for (let i = 0; i < n; i++) nodes[i] = { x: leafX[i], y: 0 };
  for (let i = 0; i < linkage.length; i++) {
    const [left, right, dist] = linkage[i];
    const ln = nodes[Math.round(left)];
    const rn = nodes[Math.round(right)];
    nodes[n + i] = { x: (ln.x + rn.x) / 2, y: dist };
  }

  const width = Math.min(1000, Math.max(400, n * 6));
  const height = 280;
  const marginL = 50, marginR = 16, marginT = 14, marginB = 28;
  const plotW = width - marginL - marginR;
  const plotH = height - marginT - marginB;

  const toX = (x: number) => marginL + (n > 1 ? (x / (n - 1)) * plotW : plotW / 2);
  const toY = (y: number) => marginT + plotH - (y / (maxDist || 1)) * plotH;

  // 85th percentile cut line
  const distances = linkage.map(r => r[2]).sort((a, b) => a - b);
  const cut = distances[Math.floor(distances.length * 0.85)];

  return (
    <Box overflow="visible">
      <svg width={width} height={height} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {/* Y-axis */}
        <line x1={marginL} y1={marginT} x2={marginL} y2={marginT + plotH} stroke="#CBD5E0" />
        {[0, 0.25, 0.5, 0.75, 1].map(t => {
          const v = t * maxDist;
          const y = toY(v);
          return (
            <g key={t}>
              <line x1={marginL - 3} y1={y} x2={marginL} y2={y} stroke="#CBD5E0" />
              <text x={marginL - 5} y={y + 3} textAnchor="end" fontSize={9} fill="#718096">{v.toFixed(1)}</text>
            </g>
          );
        })}
        <text x={12} y={marginT + plotH / 2} textAnchor="middle" fontSize={9} fill="#718096" transform={`rotate(-90, 12, ${marginT + plotH / 2})`}>
          Distance (Ward)
        </text>
        <text x={width / 2} y={height - 4} textAnchor="middle" fontSize={9} fill="#718096">
          Sample ({n} points)
        </text>
        {/* Cut line */}
        {showCutLine && (
          <>
            <line
              x1={marginL} y1={toY(cut)} x2={marginL + plotW} y2={toY(cut)}
              stroke="#E53E3E" strokeWidth={1} strokeDasharray="4 3" opacity={0.7}
            />
            <text x={marginL + plotW - 2} y={toY(cut) - 3} textAnchor="end" fontSize={8} fill="#E53E3E">
              85th pctl cut ({cut.toFixed(2)})
            </text>
          </>
        )}
        {/* Merge lines */}
        {linkage.map((row, i) => {
          const [left, right, dist] = row;
          const leftNode = nodes[Math.round(left)];
          const rightNode = nodes[Math.round(right)];
          const yTop = toY(dist);
          const xLeft = toX(leftNode.x);
          const xRight = toX(rightNode.x);
          const yLeft = toY(leftNode.y);
          const yRight = toY(rightNode.y);
          return (
            <g key={i}>
              <line x1={xLeft} y1={yLeft} x2={xLeft} y2={yTop} stroke="#4A5568" strokeWidth={0.8} />
              <line x1={xRight} y1={yRight} x2={xRight} y2={yTop} stroke="#4A5568" strokeWidth={0.8} />
              <line x1={xLeft} y1={yTop} x2={xRight} y2={yTop} stroke="#4A5568" strokeWidth={0.8} />
            </g>
          );
        })}
      </svg>
    </Box>
  );
}


// ─── Silhouette Score Curve ────────────────────────────────────────────────

interface SilhouetteCurveProps {
  scores: { k: number; silhouette: number }[];
  bestK: number;
}

export function SilhouetteCurve({ scores, bestK }: SilhouetteCurveProps) {
  if (!scores || scores.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={250}>
      <LineChart data={scores} margin={{ left: 10, right: 20, top: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="k" tick={{ fontSize: 11 }} label={{ value: 'Number of Clusters (K)', position: 'insideBottom', offset: -2, fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} label={{ value: 'Silhouette Score', angle: -90, position: 'insideLeft', fontSize: 11 }} domain={[0, 'auto']} />
        <Tooltip formatter={(v: number | undefined) => [v != null ? v.toFixed(4) : '—', 'Silhouette']} />
        <ReferenceLine x={bestK} stroke="#805AD5" strokeDasharray="5 5" label={{ value: `K=${bestK}`, position: 'top', fontSize: 10, fill: '#805AD5' }} />
        <Line type="monotone" dataKey="silhouette" stroke="#3182CE" strokeWidth={2} dot={{ r: 4, fill: '#3182CE' }} activeDot={{ r: 6 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// v7.0 — New Tables & Figures
// ═══════════════════════════════════════════════════════════════════════════

// ─── Fig M1 / S1: Distribution Shape (Violin-like box-whisker) ───────────
//
// Recharts doesn't have a native violin — we approximate with a
// horizontal box-whisker (min/Q1/median/Q3/max) per layer, per indicator.

const VIOLIN_LAYERS = ['full', 'foreground', 'middleground', 'background'] as const;
const VIOLIN_LAYER_COLORS: Record<string, string> = {
  full: '#3182CE', foreground: '#E53E3E', middleground: '#38A169', background: '#805AD5',
};

interface ViolinChartProps {
  imageRecords: ImageRecord[];
  indicatorId: string;
  indicatorName?: string;
}

export function ViolinChart({ imageRecords, indicatorId, indicatorName }: ViolinChartProps) {
  const stats = useMemo(() => {
    return VIOLIN_LAYERS.map(layer => {
      const vals = imageRecords
        .filter(r => r.indicator_id === indicatorId && r.layer === layer)
        .map(r => r.value)
        .sort((a, b) => a - b);
      if (vals.length === 0) return null;
      const q = (p: number) => {
        const idx = p * (vals.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return lo === hi ? vals[lo] : vals[lo] * (hi - idx) + vals[hi] * (idx - lo);
      };
      return {
        layer,
        n: vals.length,
        min: vals[0],
        q1: q(0.25),
        median: q(0.5),
        q3: q(0.75),
        max: vals[vals.length - 1],
        mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      };
    }).filter(Boolean) as { layer: string; n: number; min: number; q1: number; median: number; q3: number; max: number; mean: number }[];
  }, [imageRecords, indicatorId]);

  if (stats.length === 0) return null;

  const svgW = 500;
  const svgH = 180;
  const plotL = 60, plotR = svgW - 20, plotT = 20, plotB = svgH - 35;
  const allVals = stats.flatMap(d => [d.min, d.max]);
  const yMin = Math.min(...allVals);
  const yMax = Math.max(...allVals);
  const yRange = yMax - yMin || 1;
  const toY = (v: number) => plotB - ((v - yMin) / yRange) * (plotB - plotT);
  const boxW = Math.min(60, (plotR - plotL) / stats.length - 10);

  return (
    <Box>
      {indicatorName && <Text fontSize="xs" fontWeight="bold" mb={1} textAlign="center">{indicatorName} ({indicatorId})</Text>}
      <Box overflow="visible">
        <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
          {/* Y-axis gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map(t => {
            const v = yMin + t * yRange;
            const y = toY(v);
            return (
              <g key={t}>
                <line x1={plotL} y1={y} x2={plotR} y2={y} stroke="#E2E8F0" />
                <text x={plotL - 5} y={y + 4} textAnchor="end" fontSize={9} fill="#718096">{v.toFixed(1)}</text>
              </g>
            );
          })}
          {stats.map((d, i) => {
            const cx = plotL + (i + 0.5) * ((plotR - plotL) / stats.length);
            const color = VIOLIN_LAYER_COLORS[d.layer] || '#718096';
            return (
              <g key={d.layer}>
                <line x1={cx} y1={toY(d.min)} x2={cx} y2={toY(d.max)} stroke={color} strokeWidth={1.5} />
                <line x1={cx - boxW / 4} y1={toY(d.min)} x2={cx + boxW / 4} y2={toY(d.min)} stroke={color} strokeWidth={1.5} />
                <line x1={cx - boxW / 4} y1={toY(d.max)} x2={cx + boxW / 4} y2={toY(d.max)} stroke={color} strokeWidth={1.5} />
                <rect x={cx - boxW / 2} y={toY(d.q3)} width={boxW} height={Math.max(1, toY(d.q1) - toY(d.q3))} fill={color} opacity={0.25} stroke={color} strokeWidth={1.5} rx={2} />
                <line x1={cx - boxW / 2} y1={toY(d.median)} x2={cx + boxW / 2} y2={toY(d.median)} stroke={color} strokeWidth={2.5} />
                {/* Mean diamond */}
                <polygon
                  points={`${cx},${toY(d.mean) - 4} ${cx + 4},${toY(d.mean)} ${cx},${toY(d.mean) + 4} ${cx - 4},${toY(d.mean)}`}
                  fill="white" stroke={color} strokeWidth={1.5}
                />
                <text x={cx} y={plotB + 14} textAnchor="middle" fontSize={10} fill="#4A5568">{d.layer === 'full' ? 'Full' : d.layer === 'foreground' ? 'FG' : d.layer === 'middleground' ? 'MG' : 'BG'}</text>
                <text x={cx} y={plotB + 26} textAnchor="middle" fontSize={8} fill="#A0AEC0">n={d.n}</text>
              </g>
            );
          })}
        </svg>
      </Box>
    </Box>
  );
}

// ─── Multi-indicator violin grid (Fig M1 full layout) ────────────────────

interface ViolinGridProps {
  imageRecords: ImageRecord[];
  indicatorDefs: Record<string, IndicatorDefinitionInput>;
}

export function ViolinGrid({ imageRecords, indicatorDefs }: ViolinGridProps) {
  const indicatorIds = useMemo(() => {
    const ids = new Set(imageRecords.map(r => r.indicator_id));
    return Array.from(ids).sort();
  }, [imageRecords]);

  if (indicatorIds.length === 0) return null;

  return (
    <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} spacing={4}>
      {indicatorIds.map(id => (
        <ViolinChart
          key={id}
          imageRecords={imageRecords}
          indicatorId={id}
          indicatorName={indicatorDefs[id]?.name}
        />
      ))}
    </SimpleGrid>
  );
}

// ─── Table M2: Global Descriptive Statistics ─────────────────────────────

interface GlobalStatsTableProps {
  stats: GlobalIndicatorStats[];
}

export function GlobalStatsTable({ stats }: GlobalStatsTableProps) {
  if (!stats || stats.length === 0) return null;

  const cellW = 70;
  const nameW = 140;
  const rowH = 28;
  const headerH = 50;
  const cols = ['Full', 'FG', 'MG', 'BG', 'CV%', 'Shapiro p', 'K-W p'];
  const svgW = nameW + cols.length * cellW;
  const svgH = headerH + stats.length * rowH + 4;

  function fmtP(p: number | null | undefined): string {
    if (p == null) return '-';
    if (p < 0.001) return '<.001';
    if (p < 0.01) return p.toFixed(3);
    return p.toFixed(2);
  }

  return (
    <Box overflow="visible">
      <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {/* Header */}
        {cols.map((c, ci) => (
          <text key={c} x={nameW + ci * cellW + cellW / 2} y={headerH - 8} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#4A5568">{c}</text>
        ))}
        <text x={4} y={headerH - 8} fontSize={9} fontWeight="bold" fill="#4A5568">Indicator</text>
        <line x1={0} y1={headerH} x2={svgW} y2={headerH} stroke="#CBD5E0" />

        {stats.map((s, ri) => {
          const y = headerH + ri * rowH;
          const layerKeys = ['full', 'foreground', 'middleground', 'background'];
          const layerVals = layerKeys.map(l => s.by_layer[l]);
          const cells: string[] = [
            ...layerVals.map(v =>
              v && v.Mean != null && v.Std != null
                ? `${v.Mean.toFixed(1)}±${v.Std.toFixed(1)}`
                : '—',
            ),
            s.cv_full != null ? `${s.cv_full.toFixed(0)}` : '—',
            fmtP(s.shapiro_p),
            fmtP(s.kruskal_p),
          ];
          const shapiroSig = s.shapiro_p != null && s.shapiro_p < 0.05;
          const kruskalSig = s.kruskal_p != null && s.kruskal_p < 0.05;

          return (
            <g key={s.indicator_id}>
              {ri % 2 === 0 && (
                <rect x={0} y={y} width={svgW} height={rowH} fill="#F7FAFC" />
              )}
              <text x={4} y={y + rowH / 2 + 4} fontSize={9} fill="#2D3748" fontWeight="bold">
                {s.indicator_id}
              </text>
              {cells.map((val, ci) => (
                <text
                  key={ci}
                  x={nameW + ci * cellW + cellW / 2}
                  y={y + rowH / 2 + 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill={
                    (ci === 5 && shapiroSig) ? '#E53E3E' :
                    (ci === 6 && kruskalSig) ? '#E53E3E' :
                    '#4A5568'
                  }
                  fontWeight={(ci === 5 && shapiroSig) || (ci === 6 && kruskalSig) ? 'bold' : 'normal'}
                >
                  {val}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </Box>
  );
}

// ─── Table M4: Data Quality Diagnostics ──────────────────────────────────

interface DataQualityTableProps {
  rows: DataQualityRow[];
}

export function DataQualityTable({ rows }: DataQualityTableProps) {
  if (!rows || rows.length === 0) return null;

  const cellW = 75;
  const nameW = 120;
  const rowH = 26;
  const headerH = 46;
  const cols = ['Total N', 'FG %', 'MG %', 'BG %', 'Normal?', 'Corr Method'];
  const svgW = nameW + cols.length * cellW;
  const svgH = headerH + rows.length * rowH + 4;

  return (
    <Box overflow="visible">
      {/* DataQualityTable SVG body — unchanged */}
      <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {cols.map((c, ci) => (
          <text key={c} x={nameW + ci * cellW + cellW / 2} y={headerH - 8} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#4A5568">{c}</text>
        ))}
        <text x={4} y={headerH - 8} fontSize={9} fontWeight="bold" fill="#4A5568">Indicator</text>
        <line x1={0} y1={headerH} x2={svgW} y2={headerH} stroke="#CBD5E0" />

        {rows.map((r, ri) => {
          const y = headerH + ri * rowH;
          const cells: string[] = [
            String(r.total_images),
            r.fg_coverage_pct != null ? `${r.fg_coverage_pct.toFixed(0)}` : '—',
            r.mg_coverage_pct != null ? `${r.mg_coverage_pct.toFixed(0)}` : '—',
            r.bg_coverage_pct != null ? `${r.bg_coverage_pct.toFixed(0)}` : '—',
            r.is_normal == null ? '-' : r.is_normal ? 'Yes' : 'No',
            r.correlation_method,
          ];

          return (
            <g key={r.indicator_id}>
              {ri % 2 === 0 && <rect x={0} y={y} width={svgW} height={rowH} fill="#F7FAFC" />}
              <text x={4} y={y + rowH / 2 + 4} fontSize={9} fill="#2D3748" fontWeight="bold">{r.indicator_id}</text>
              {cells.map((val, ci) => (
                <text key={ci} x={nameW + ci * cellW + cellW / 2} y={y + rowH / 2 + 4}
                  textAnchor="middle" fontSize={9} fill="#4A5568">{val}</text>
              ))}
            </g>
          );
        })}
      </svg>
    </Box>
  );
}


// ═════════════════════════════════════════════════════════════════════════
// v6.1 — HDBSCAN Cluster Diagnostic Charts (Phase C)
// ═════════════════════════════════════════════════════════════════════════

// ─── 1) Cluster Centroid Heatmap (clusters × indicators z-score) ───────────
//
// Why a heatmap and not just radar: with ≥ 8 indicators a radar becomes a
// tangled hairball. A clusters × indicators grid colored by z-score lets
// the user scan one row to read a cluster's "signature" (e.g. "C1 = high
// green, low artificial surface, neutral sky") without overlapping lines.

interface ClusterCentroidHeatmapProps {
  archetypes: ArchetypeProfile[];
  indicatorLabels?: Record<string, string>;
}

export function ClusterCentroidHeatmap({
  archetypes,
  indicatorLabels,
}: ClusterCentroidHeatmapProps) {
  const indicators = useMemo(() => {
    if (!archetypes || archetypes.length === 0) return [];
    return Array.from(
      new Set(archetypes.flatMap(a => Object.keys(a.centroid_z_scores))),
    ).sort();
  }, [archetypes]);

  if (!archetypes || archetypes.length === 0) return null;
  if (indicators.length === 0) return null;

  const cellW = 56;
  const cellH = 32;
  const labelW = 140;
  // v4 polish — derive headerH from rotatedLabelTopMargin (same helper
  // PriorityHeatmap / CorrelationHeatmap use) so long indicator IDs like
  // IND_NAT_LND don't get the leading "IND_" character clipped above the
  // SVG box. We truncate to 14 chars below for visual brevity, so feed
  // that as the maxLabelChars hint to the helper.
  const colLabelMaxChars = 14;
  const colLabelFontSize = 10;
  const headerH = rotatedLabelTopMargin(colLabelMaxChars, colLabelFontSize);
  const svgW = labelW + indicators.length * cellW + 8;
  const svgH = headerH + archetypes.length * cellH + 8;

  return (
    <Box overflow="visible">
      <svg width={svgW} height={svgH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        {indicators.map((ind, ci) => {
          const cx = labelW + ci * cellW + cellW / 2;
          const label = indicatorLabels?.[ind] ?? ind;
          return (
            <text
              key={ind}
              transform={`translate(${cx}, ${headerH - 6}) rotate(45)`}
              fontSize={10}
              fill="#4A5568"
              textAnchor="end"
            >
              <title>{label}</title>
              {label.length > 14 ? label.slice(0, 14) + '…' : label}
            </text>
          );
        })}
        <text x={4} y={headerH - 6} fontSize={10} fontWeight="bold" fill="#4A5568">Cluster</text>
        <line x1={0} y1={headerH} x2={svgW} y2={headerH} stroke="#CBD5E0" />

        {archetypes.map((a, ri) => {
          const y = headerH + ri * cellH;
          // v4.x — Defensive label fallback. After a panorama view switch +
          // cluster re-run, the archetypes array can have entries with
          // missing/null label or count for a render frame; without the
          // fallback `.length` and `.toFixed()` on undefined throw and
          // white-screen the whole Reports page.
          const labelText = typeof a.archetype_label === 'string' ? a.archetype_label : `Cluster ${a.archetype_id ?? ri}`;
          const pointCount = typeof a.point_count === 'number' ? a.point_count : 0;
          // v4.x — Pair archetype_id with the row index. archetype_id is the
          // natural identifier for the row, but the composite all_sub_clusters
          // bucket can briefly emit duplicates during a stale render frame, and
          // duplicate React keys silently drop rows / mis-align centroid colors.
          // The `${id}-${ri}` form keeps the key human-readable while making it
          // collision-proof against any upstream re-ID slip.
          return (
            <g key={`${a.archetype_id ?? 'na'}-${ri}`}>
              <rect x={0} y={y} width={labelW} height={cellH} fill={ri % 2 ? '#F7FAFC' : '#FFFFFF'} />
              <text x={6} y={y + cellH / 2 + 4} fontSize={10} fontWeight="bold" fill="#2D3748">
                <title>{`${labelText} · n=${pointCount}`}</title>
                {labelText.length > 18 ? labelText.slice(0, 18) + '…' : labelText}
              </text>
              <text x={labelW - 6} y={y + cellH / 2 + 4} fontSize={9} textAnchor="end" fill="#718096">
                n={pointCount}
              </text>
              {indicators.map((ind, ci) => {
                // Optional chain on the parent dict — a.centroid_z_scores
                // can be undefined for malformed/stale archetypes.
                const z = a.centroid_z_scores?.[ind] ?? 0;
                const cx = labelW + ci * cellW;
                return (
                  <g key={ind}>
                    <rect
                      x={cx + 1}
                      y={y + 1}
                      width={cellW - 2}
                      height={cellH - 2}
                      fill={divergingColor(z / 2.5, true)}
                      stroke="#E2E8F0"
                      strokeWidth={0.5}
                    >
                      <title>{`${labelText} · ${ind}: z = ${z.toFixed(2)}`}</title>
                    </rect>
                    <text
                      x={cx + cellW / 2}
                      y={y + cellH / 2 + 3}
                      fontSize={9}
                      textAnchor="middle"
                      fill={Math.abs(z) > 1.5 ? '#FFFFFF' : '#2D3748'}
                      style={{ pointerEvents: 'none' }}
                    >
                      {z.toFixed(1)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <Text fontSize="xs" color="gray.500" mt={2}>
        Cells coloured by z-score (mean per cluster). Red = above project mean,
        blue = below. Cell numbers are the rounded z-score.
      </Text>
    </Box>
  );
}


// ─── 2) Per-Point Silhouette Plot (HDBSCAN-aware) ───────────────────────────

interface SilhouettePerPointPlotProps {
  silhouettePerPoint: (number | null)[];
  labelsSmoothed: number[];
  archetypes: ArchetypeProfile[];
  noisePointIds?: string[];
  pointIdsOrdered: string[];
}

export function SilhouettePerPointPlot({
  silhouettePerPoint,
  labelsSmoothed,
  archetypes,
  noisePointIds = [],
  pointIdsOrdered,
}: SilhouettePerPointPlotProps) {
  const grouped = useMemo(() => {
    if (!silhouettePerPoint || silhouettePerPoint.length === 0) return [];
    const noiseSet = new Set(noisePointIds);
    const byCluster: Record<number, { sil: number; isNoise: boolean }[]> = {};
    silhouettePerPoint.forEach((sil, i) => {
      const cid = labelsSmoothed[i];
      const pid = pointIdsOrdered[i];
      const isNoise = noiseSet.has(pid);
      const value = sil ?? 0;
      if (!byCluster[cid]) byCluster[cid] = [];
      byCluster[cid].push({ sil: value, isNoise });
    });
    Object.values(byCluster).forEach(arr => arr.sort((a, b) => b.sil - a.sil));
    return Object.entries(byCluster)
      .map(([cid, arr]) => ({ cluster_id: Number(cid), points: arr }))
      .sort((a, b) => a.cluster_id - b.cluster_id);
  }, [silhouettePerPoint, labelsSmoothed, noisePointIds, pointIdsOrdered]);

  if (grouped.length === 0) return null;

  const archMap = Object.fromEntries(archetypes.map(a => [a.archetype_id, a]));
  const totalPoints = grouped.reduce((s, g) => s + g.points.length, 0);
  const barH = Math.max(2, Math.min(6, Math.floor(360 / Math.max(1, totalPoints))));
  const groupGap = 8;
  const labelW = 140;
  const plotW = 380;
  const plotX0 = labelW + 30;
  const zeroLineX = plotX0 + plotW / 2;
  const totalH = grouped.reduce(
    (s, g) => s + g.points.length * barH + groupGap,
    0,
  ) + 24;
  const validPts = silhouettePerPoint.filter((v): v is number => v !== null);
  const meanSil = validPts.length ? validPts.reduce((a, b) => a + b, 0) / validPts.length : 0;

  let y = 24;
  return (
    <Box overflow="visible">
      <svg width={plotX0 + plotW + 16} height={totalH} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        <line x1={zeroLineX} y1={4} x2={zeroLineX} y2={totalH - 4} stroke="#A0AEC0" strokeDasharray="3 3" />
        <line
          x1={plotX0 + ((meanSil + 1) / 2) * plotW}
          y1={4}
          x2={plotX0 + ((meanSil + 1) / 2) * plotW}
          y2={totalH - 4}
          stroke="#3182CE"
          strokeDasharray="2 2"
          strokeWidth={1.5}
        />
        <text x={plotX0 + ((meanSil + 1) / 2) * plotW + 4} y={14} fontSize={9} fill="#3182CE">
          mean = {meanSil.toFixed(2)}
        </text>
        <text x={zeroLineX} y={totalH - 2} fontSize={9} fill="#718096" textAnchor="middle">0</text>
        <text x={plotX0} y={totalH - 2} fontSize={9} fill="#718096">−1</text>
        <text x={plotX0 + plotW} y={totalH - 2} fontSize={9} fill="#718096" textAnchor="end">+1</text>

        {grouped.map((g) => {
          const arch = archMap[g.cluster_id];
          const groupY0 = y;
          const groupH = g.points.length * barH;
          const fill = getZoneColor(g.cluster_id);
          const out = (
            <g key={g.cluster_id}>
              <text x={labelW} y={groupY0 + groupH / 2 + 3} fontSize={10} fontWeight="bold" textAnchor="end" fill="#2D3748">
                {/* v4.x — `arch` may be present but with undefined label
                    (malformed archetype after view-switch hydration).
                    Optional-chain on `.length` to avoid white-screen. */}
                {arch && typeof arch.archetype_label === 'string'
                  ? (arch.archetype_label.length > 18 ? arch.archetype_label.slice(0, 18) + '…' : arch.archetype_label)
                  : `Cluster ${g.cluster_id}`}
              </text>
              <text x={labelW} y={groupY0 + groupH / 2 + 16} fontSize={9} textAnchor="end" fill="#718096">
                n = {g.points.length}
              </text>
              {g.points.map((p, i) => {
                const barW = (Math.abs(p.sil) / 1.0) * (plotW / 2);
                const x = p.sil >= 0 ? zeroLineX : zeroLineX - barW;
                const barY = groupY0 + i * barH;
                return (
                  <rect
                    key={i}
                    x={x}
                    y={barY}
                    width={Math.max(0.5, barW)}
                    height={Math.max(1, barH - 0.5)}
                    fill={p.isNoise ? '#A0AEC0' : fill}
                    fillOpacity={p.sil < 0 ? 0.6 : 0.9}
                  />
                );
              })}
            </g>
          );
          y += groupH + groupGap;
          return out;
        })}
      </svg>
      <Text fontSize="xs" color="gray.500" mt={2}>
        Each row is a point; bars left of zero indicate the point is closer to
        another cluster (low silhouette → boundary case). Gray bars mark
        points HDBSCAN flagged as noise before reassignment.
      </Text>
    </Box>
  );
}


// ─── 3) HDBSCAN Condensed Tree ──────────────────────────────────────────────

interface HDBSCANCondensedTreeProps {
  edges: { parent: number; child: number; lambda_val: number; child_size: number }[];
  persistence?: Record<string, number>;
}

export function HDBSCANCondensedTree({ edges, persistence }: HDBSCANCondensedTreeProps) {
  const { lambdaMax } = useMemo(() => {
    if (!edges || edges.length === 0) return { lambdaMax: 0 };
    let lmax = 0;
    for (const e of edges) lmax = Math.max(lmax, e.lambda_val);
    return { lambdaMax: lmax };
  }, [edges]);

  if (!edges || edges.length === 0) {
    return (
      <Text fontSize="sm" color="gray.500" fontStyle="italic" p={4}>
        No condensed tree available (HDBSCAN fallback may have triggered).
      </Text>
    );
  }

  const W = 540;
  const H = 320;
  const padX = 50;
  const padY = 30;

  const childrenByParent = new Map<number, number[]>();
  edges.forEach(e => {
    if (!childrenByParent.has(e.parent)) childrenByParent.set(e.parent, []);
    childrenByParent.get(e.parent)!.push(e.child);
  });
  const xPos = new Map<number, number>();
  const allChildren = new Set(edges.map(e => e.child));
  const roots = [...new Set(edges.map(e => e.parent))].filter(p => !allChildren.has(p));
  let leafCounter = 0;
  const totalLeaves = Math.max(1, edges.length / 2);
  const layout = (id: number) => {
    const kids = childrenByParent.get(id) ?? [];
    if (kids.length === 0) {
      xPos.set(id, padX + (leafCounter / Math.max(1, totalLeaves)) * (W - 2 * padX));
      leafCounter++;
      return;
    }
    kids.forEach(layout);
    const xs = kids.map(k => xPos.get(k) ?? padX);
    xPos.set(id, xs.reduce((a, b) => a + b, 0) / xs.length);
  };
  roots.forEach(layout);

  const yForLambda = (l: number) => padY + (l / Math.max(0.0001, lambdaMax)) * (H - 2 * padY);

  return (
    <Box overflow="visible">
      <svg width={W} height={H + 40} style={{ fontFamily: 'system-ui, sans-serif', overflow: 'visible' }}>
        <line x1={padX - 8} y1={padY} x2={padX - 8} y2={H - padY} stroke="#A0AEC0" />
        <text x={padX - 12} y={padY - 4} fontSize={10} textAnchor="end" fill="#4A5568">
          λ = {lambdaMax.toFixed(2)}
        </text>
        <text x={padX - 12} y={H - padY + 4} fontSize={10} textAnchor="end" fill="#4A5568">λ = 0</text>
        <text transform={`translate(14, ${H / 2}) rotate(-90)`} fontSize={10} fill="#4A5568">
          λ (density threshold)
        </text>

        {edges.map((e, i) => {
          const x1 = xPos.get(e.parent) ?? padX;
          const x2 = xPos.get(e.child) ?? padX;
          const y1 = yForLambda(0);
          const y2 = yForLambda(e.lambda_val);
          const isLeaf = e.child_size > 1;
          const persistKey = String(e.child);
          const persist = persistence?.[persistKey];
          return (
            <g key={i}>
              <line
                x1={x1} y1={y1} x2={x1} y2={y2}
                stroke={isLeaf ? '#3182CE' : '#CBD5E0'}
                strokeWidth={Math.max(1, Math.min(8, Math.log2(e.child_size + 1)))}
                strokeOpacity={0.6}
              />
              <line x1={x1} y1={y2} x2={x2} y2={y2} stroke="#A0AEC0" strokeWidth={1} />
              {isLeaf && (
                <circle
                  cx={x2}
                  cy={y2}
                  r={Math.max(2, Math.min(6, Math.sqrt(e.child_size)))}
                  fill={persist && persist > 0.05 ? '#38A169' : '#3182CE'}
                  fillOpacity={0.85}
                >
                  <title>
                    Cluster #{e.child} · size = {e.child_size}
                    {persist !== undefined ? ` · persistence = ${persist.toFixed(3)}` : ''}
                  </title>
                </circle>
              )}
            </g>
          );
        })}
      </svg>
      <Text fontSize="xs" color="gray.500" mt={2}>
        Tree from HDBSCAN. Y-axis is λ (inverse density threshold). Branches
        spanning a wide λ range (long vertical bars) are stable clusters;
        short/thin slivers were rejected as density noise. Green dots =
        clusters with persistence &gt; 0.05.
      </Text>
    </Box>
  );
}
