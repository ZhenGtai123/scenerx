import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Heading,
  Button,
  VStack,
  HStack,
  SimpleGrid,
  Card,
  CardHeader,
  CardBody,
  Text,
  Badge,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Alert,
  AlertIcon,
  Divider,
  Wrap,
  WrapItem,
  Tag,
  TagLabel,
  Icon,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  TabPanels,
  Skeleton,
  Spinner,
  Progress,
  Accordion,
  AccordionItem,
  AccordionButton,
  AccordionPanel,
  AccordionIcon,
  Tooltip,
  useToast,
} from '@chakra-ui/react';
import { Download, FileText, FileImage, FileSpreadsheet, CheckCircle, AlertTriangle, Sparkles, RefreshCw } from 'lucide-react';
import useAppStore from '../store/useAppStore';
import { generateReport } from '../utils/generateReport';
import { exportAnalysisExcel } from '../utils/exportExcel';
import { exportBundle } from '../utils/exportBundle';
import { useRunDesignStrategies, useRunClusteringByProject, useRunClusteringWithinZones } from '../hooks/useApi';
import { useGroupingUnits } from '../hooks/useGroupingUnits';
import useAppToast from '../hooks/useAppToast';
import PageShell from '../components/PageShell';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import {
  CHART_REGISTRY,
  SECTION_ORDER,
  SECTION_META,
  type ChartSection,
} from '../components/analysisCharts/registry';
import { SectionHeading } from '../components/analysisCharts/SectionHeading';
import { AnalysisGuide } from '../components/AnalysisGuide';
import { ChartHost, type ChartHostHandle } from '../components/analysisCharts/ChartHost';
import { ChartLoadingProgress } from '../components/analysisCharts/ChartLoadingProgress';
import { ChartPicker } from '../components/analysisCharts/ChartPicker';
import { buildChartContext } from '../components/analysisCharts/ChartContext';
import { ModeAlert } from '../components/analysisCharts/ModeAlert';
import { DataQualitySummary } from '../components/analysisCharts/DataQualitySummary';
import { AnalysisConfidenceGauge } from '../components/analysisCharts/AnalysisConfidenceGauge';
import { GlossaryDrawer } from '../components/GlossaryDrawer';
import { AiReportProgress, type AiReportProgressState } from '../components/AiReportProgress';
import { api } from '../api';
import {
  captureChartsForReport,
  waitForPaint,
  type CapturedChart,
} from '../utils/captureCharts';
import type { ReportRequest, ZoneDesignOutput, ClusteringResponse, GroupingMode, ZoneAnalysisResult, DesignStrategyResult } from '../types';

// ---------------------------------------------------------------------------
// Stale-strategies detection helper
// ---------------------------------------------------------------------------
//
// Compute a compact fingerprint of a DesignStrategyResult so we can detect
// when the AI report's narrative was written against an older strategy
// payload than the user is currently looking at on the Strategies tab.
// Format: `${zoneCount}|${strategyCount}|${firstFewIds}` — enough to flip
// when zones, strategies, or their identifiers change, without storing the
// whole payload. Returns null for null/empty input.
function computeStrategySignature(strategies: DesignStrategyResult | null | undefined): string | null {
  if (!strategies || !strategies.zones) return null;
  const zoneEntries = Object.entries(strategies.zones);
  if (zoneEntries.length === 0) return null;
  const zoneCount = zoneEntries.length;
  let strategyCount = 0;
  const ids: string[] = [];
  for (const [zoneId, zone] of zoneEntries) {
    const zs = (zone as { design_strategies?: { strategy_name?: string }[] })?.design_strategies ?? [];
    strategyCount += zs.length;
    for (const s of zs.slice(0, 3)) {
      ids.push(`${zoneId}:${s?.strategy_name ?? '?'}`);
    }
  }
  return `${zoneCount}|${strategyCount}|${ids.slice(0, 12).join(';')}`;
}

// v4 / Phase C — viewId → backend request payload mapper. The backend's
// strategies + report endpoints accept a strict 2-state `grouping_mode`
// field for LLM-prompt branching (single-zone vs multi-zone templates),
// plus an optional `view_id` field for full-resolution persistence into
// the per-view dicts.
//
// We collapse the new viewIds into the legacy 2-state for prompt logic:
//   'zones', 'parent_zones'                       → 'zones'
//   'clusters', 'all_sub_clusters', 'within_zone:*' → 'clusters'
//
// And pass the full viewId through unchanged as `view_id` so the backend
// writes into project.design_strategy_results[viewId] /
// project.ai_reports[viewId] instead of the collapsed slot.
function viewIdToRequestFields(viewId: string): { grouping_mode: GroupingMode; view_id: string } {
  const isClusterDerived =
    viewId === 'clusters'
    || viewId === 'all_sub_clusters'
    || viewId.startsWith('within_zone:');
  return {
    grouping_mode: isClusterDerived ? 'clusters' : 'zones',
    view_id: viewId,
  };
}

// ---------------------------------------------------------------------------
// Pipeline-running card — #2 atomic gate
// ---------------------------------------------------------------------------

/** While the pipeline is running for the current project we replace the
 * Analysis tab content with a single progress card so users can't act on
 * stale or half-baked results. Mirrors the live pipelineRun state in the
 * zustand store. */
function PipelineRunningCard({
  projectName,
  imageProgress,
  steps,
}: {
  projectName: string | null;
  imageProgress: { current: number; total: number; filename: string } | null;
  steps: Array<{ step: string; status: string; detail: string }>;
}) {
  const calcDone = steps.some((s) => s.step === 'run_calculations' && s.status === 'completed');
  const lastStep = steps[steps.length - 1];
  const pct =
    !calcDone && imageProgress && imageProgress.total > 0
      ? (imageProgress.current / imageProgress.total) * 100
      : null;
  return (
    <Card mb={4}>
      <CardBody>
        <VStack align="stretch" spacing={4}>
          <HStack spacing={3}>
            <Sparkles size={18} color="#3182CE" />
            <Box flex="1">
              <Text fontWeight="bold" fontSize="md">
                Pipeline running · {projectName ?? 'project'}
              </Text>
              <Text fontSize="xs" color="gray.500">
                The analysis grid is hidden until the pipeline completes — all charts
                will appear together once the data is ready.
              </Text>
            </Box>
          </HStack>
          {pct !== null ? (
            <Box>
              <HStack justify="space-between" mb={1}>
                <Text fontSize="xs" color="gray.600">
                  Computing image-level metrics — {imageProgress!.current} / {imageProgress!.total}
                </Text>
                <Text fontSize="xs" color="gray.500">{pct.toFixed(0)}%</Text>
              </HStack>
              <Progress value={pct} size="sm" colorScheme="blue" hasStripe isAnimated borderRadius="full" />
            </Box>
          ) : (
            <Progress size="sm" isIndeterminate colorScheme="blue" borderRadius="full" />
          )}
          {steps.length > 0 && (
            <VStack align="stretch" spacing={1} pt={1}>
              {steps.map((s, idx) => (
                <HStack key={`${s.step}-${idx}`} fontSize="xs" color="gray.600">
                  {s.status === 'completed' ? (
                    <CheckCircle size={12} color="#38A169" />
                  ) : s.status === 'failed' ? (
                    <AlertTriangle size={12} color="#E53E3E" />
                  ) : (
                    <Sparkles size={12} color="#3182CE" />
                  )}
                  <Text>
                    <Text as="span" fontWeight="medium">{s.step}</Text>
                    {' · '}
                    {s.status}
                    {s.detail ? ` — ${s.detail}` : ''}
                  </Text>
                </HStack>
              ))}
              {lastStep && lastStep.status !== 'completed' && (
                <Text fontSize="2xs" color="gray.400" pl={5}>
                  {lastStep.detail || 'working…'}
                </Text>
              )}
            </VStack>
          )}
        </VStack>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Multi-zone entry gate — v4 / Module 1 (multi-zone variant)
// ---------------------------------------------------------------------------

/** Rendered in place of the chart grid when a project has ≥ 2 user zones
 *  but the user hasn't yet picked a multi-zone strategy. Two options:
 *    A — keep zone-level analysis as-is (no clustering)
 *    B — within each zone run HDBSCAN to surface intra-zone heterogeneity
 *
 *  Picking either option fires Design Strategies generation immediately so
 *  the user lands on the Strategies tab with results ready. */
function MultiZoneEntryGate({
  zoneCount,
  imageCount,
  onPickZoneOnly,
  onPickWithinZoneCluster,
  isClusteringRunning,
  canRunClustering,
}: {
  zoneCount: number;
  imageCount: number;
  onPickZoneOnly: () => void;
  onPickWithinZoneCluster: () => void;
  isClusteringRunning: boolean;
  canRunClustering: boolean;
}) {
  return (
    <Card mb={4} borderColor="orange.300" borderWidth="1px">
      <CardBody>
        <VStack align="stretch" spacing={4}>
          <HStack spacing={3} align="start">
            <AlertTriangle size={24} color="#DD6B20" />
            <Box flex="1">
              <Heading size="sm" mb={1}>
                Pick how you want to analyse this multi-zone project
              </Heading>
              <Text fontSize="sm" color="gray.600">
                {zoneCount} zones, {imageCount} image record{imageCount === 1 ? '' : 's'}.
                You can either compare the zones as-is, or run HDBSCAN within
                each zone to surface intra-zone heterogeneity (sub-archetypes).
              </Text>
              <Text fontSize="sm" color="gray.600" mt={2}>
                Pick one of the two paths below — design strategies will
                start generating immediately after.
              </Text>
            </Box>
          </HStack>

          <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
            <Card variant="outline">
              <CardBody>
                <VStack align="stretch" spacing={3}>
                  <Heading size="xs">Option A — Zone-level only</Heading>
                  <Text fontSize="xs" color="gray.600">
                    Treat each user zone as a single unit. Cross-zone
                    z-scores, correlations, radar profiles all driven by the
                    {' '}{zoneCount} user zones. Fastest path; recommended
                    when zones are already homogeneous.
                  </Text>
                  <Button
                    size="sm"
                    colorScheme="purple"
                    variant="outline"
                    onClick={onPickZoneOnly}
                  >
                    Use zones as-is (no clustering)
                  </Button>
                </VStack>
              </CardBody>
            </Card>

            <Card variant="outline">
              <CardBody>
                <VStack align="stretch" spacing={3}>
                  <Heading size="xs">Option B — Within-zone clustering</Heading>
                  <Text fontSize="xs" color="gray.600">
                    For each user zone separately run HDBSCAN on its images
                    to find sub-archetypes (e.g. zone1_A / zone1_B,
                    zone2_A / zone2_B / zone2_C). All charts then compare
                    the resulting sub-zones. Best when zones are large or
                    visually heterogeneous.
                  </Text>
                  <Button
                    size="sm"
                    colorScheme="teal"
                    onClick={onPickWithinZoneCluster}
                    isLoading={isClusteringRunning}
                    isDisabled={!canRunClustering}
                    loadingText="Clustering each zone…"
                  >
                    Cluster within zones (HDBSCAN)
                  </Button>
                </VStack>
              </CardBody>
            </Card>
          </SimpleGrid>
        </VStack>
      </CardBody>
    </Card>
  );
}


// ---------------------------------------------------------------------------
// Single-zone hard gate — #1 entry card
// ---------------------------------------------------------------------------

/** Rendered in place of the entire chart grid when the project has fewer
 * than 2 user zones AND clustering has not yet been run. Single-zone
 * analyses produce mathematically meaningless charts (z-scores all 0, no
 * cross-zone correlations), so we force the user to either add another
 * zone or run clustering before any charts appear. */
function SingleZoneEntryGate({
  projectId,
  zoneCount,
  imageCount,
  onPickViewOnly,
  onPickCluster,
  isClusteringRunning,
  canRunClustering,
}: {
  projectId: string | null;
  zoneCount: number;
  imageCount: number;
  onPickViewOnly: () => void;
  onPickCluster: () => void;
  isClusteringRunning: boolean;
  canRunClustering: boolean;
}) {
  // v4 / Module 1 — three soft paths: Add zone / Single View / Dual View.
  const navigate = useNavigate();
  return (
    <Card mb={4} borderColor="orange.300" borderWidth="1px">
      <CardBody>
        <VStack align="stretch" spacing={4}>
          <HStack spacing={3} align="start">
            <AlertTriangle size={24} color="#DD6B20" />
            <Box flex="1">
              <Heading size="sm" mb={1}>
                Pick how you want to view this single-zone project
              </Heading>
              <Text fontSize="sm" color="gray.600">
                This project has only {zoneCount} zone{zoneCount === 1 ? '' : 's'}
                {' '}({imageCount} image record{imageCount === 1 ? '' : 's'}).
                Cross-zone z-scores, correlations, and the radar/heatmap charts
                require ≥ 2 grouping units, but you can still view image-level
                distribution and geographic charts within the single zone.
              </Text>
              <Text fontSize="sm" color="gray.600" mt={2}>
                Pick one of the three paths below.
              </Text>
            </Box>
          </HStack>

          <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4}>
            <Card variant="outline">
              <CardBody>
                <VStack align="stretch" spacing={3}>
                  <Heading size="xs">Option A — Add another zone</Heading>
                  <Text fontSize="xs" color="gray.600">
                    Define a second spatial polygon (e.g. a contrasting site or
                    a sub-area). Re-running the pipeline is needed afterwards.
                  </Text>
                  <Button
                    size="sm"
                    colorScheme="blue"
                    variant="outline"
                    isDisabled={!projectId}
                    onClick={() => projectId && navigate(`/projects/${projectId}/edit`)}
                  >
                    Edit project &amp; add zones
                  </Button>
                </VStack>
              </CardBody>
            </Card>

            <Card variant="outline">
              <CardBody>
                <VStack align="stretch" spacing={3}>
                  <Heading size="xs">Option B — Single View</Heading>
                  <Text fontSize="xs" color="gray.600">
                    View charts that are computable from a single zone
                    (distribution, value spatial maps, global descriptive
                    stats). Clustering will not run in this mode — pick Dual
                    View instead if you want archetype clustering.
                  </Text>
                  <Button
                    size="sm"
                    colorScheme="purple"
                    variant="outline"
                    onClick={onPickViewOnly}
                  >
                    View single zone (no clustering)
                  </Button>
                </VStack>
              </CardBody>
            </Card>

            <Card variant="outline">
              <CardBody>
                <VStack align="stretch" spacing={3}>
                  <Heading size="xs">Option C — Dual View</Heading>
                  <Text fontSize="xs" color="gray.600">
                    Run HDBSCAN density-based clustering on per-image
                    indicator values, then display the single-zone view and
                    the cluster view side by side via the segmented control.
                  </Text>
                  <Button
                    size="sm"
                    colorScheme="teal"
                    onClick={onPickCluster}
                    isLoading={isClusteringRunning}
                    isDisabled={!canRunClustering}
                    loadingText="Clustering…"
                  >
                    Run clustering (both views)
                  </Button>
                </VStack>
              </CardBody>
            </Card>
          </SimpleGrid>
        </VStack>
      </CardBody>
    </Card>
  );
}

/** Single View → Run clustering upgrade banner. v4 / Module 1. */
function _SingleViewUpgradeBar({
  onRunClustering,
  isClusteringRunning,
  canRunClustering,
}: {
  onRunClustering: () => void;
  isClusteringRunning: boolean;
  canRunClustering: boolean;
}) {
  return (
    <Card mb={3} borderColor="purple.200" borderWidth="1px" bg="purple.50">
      <CardBody py={3}>
        <HStack spacing={3} justify="space-between" wrap="wrap">
          <Box flex="1" minW="240px">
            <Text fontSize="sm" fontWeight="bold" color="purple.800">
              Single View — single-zone descriptive charts only
            </Text>
            <Text fontSize="xs" color="purple.700">
              Cross-zone z-score / radar / correlation charts are hidden. Run
              clustering to upgrade to Dual View and unlock them.
            </Text>
          </Box>
          <Button
            size="sm"
            colorScheme="purple"
            onClick={onRunClustering}
            isLoading={isClusteringRunning}
            isDisabled={!canRunClustering}
            loadingText="Clustering…"
          >
            Run clustering
          </Button>
        </HStack>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cluster-mode empty hint — #1 acceptance criterion
// ---------------------------------------------------------------------------

/** Rendered inside the Analysis tab when the user has flipped the segmented
 * control to "Cluster view" but clustering has not yet been run. The hint
 * keeps the toggle visible (so the user can flip back) while explaining
 * the missing prerequisite, instead of silently rendering a blank chart
 * grid backed by zone-mode data. */
function ClusterEmptyHint({
  onRunClustering,
  isClusteringRunning,
  canRunClustering,
}: {
  onRunClustering: () => void;
  isClusteringRunning: boolean;
  canRunClustering: boolean;
}) {
  return (
    <Card mb={6} borderColor="teal.200" borderWidth="1px" bg="teal.50">
      <CardBody>
        <HStack spacing={4} align="start">
          <Sparkles size={22} color="#319795" />
          <Box flex="1">
            <Heading size="sm" mb={1} color="teal.800">
              Cluster view selected — clustering hasn't been run yet
            </Heading>
            <Text fontSize="sm" color="teal.900">
              Run KMeans clustering on per-image indicator values to group
              the project into archetypes. Each archetype then drives the
              charts in this view as a virtual zone (z-scores, correlations,
              radar profiles all rebuilt around clusters).
            </Text>
          </Box>
          <Button
            size="sm"
            colorScheme="teal"
            onClick={onRunClustering}
            isLoading={isClusteringRunning}
            isDisabled={!canRunClustering}
            loadingText="Clustering…"
            flexShrink={0}
          >
            Run Clustering
          </Button>
        </HStack>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Non-chart helpers (chart formatting is now in analysisCharts/registry.tsx)
// ---------------------------------------------------------------------------


function deviationColorScheme(meanAbsZ: number): string {
  if (meanAbsZ >= 1.5) return 'red';
  if (meanAbsZ >= 1.0) return 'orange';
  if (meanAbsZ >= 0.5) return 'yellow';
  return 'green';
}

// ---------------------------------------------------------------------------
// Simple markdown renderer (no external dependency)
// ---------------------------------------------------------------------------

function renderMarkdown(md: string) {
  const lines = md.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('### ')) {
      elements.push(<Heading key={i} size="sm" mt={4} mb={2}>{line.slice(4)}</Heading>);
    } else if (line.startsWith('## ')) {
      elements.push(<Heading key={i} size="md" mt={5} mb={2} borderBottom="1px solid" borderColor="gray.200" pb={1}>{line.slice(3)}</Heading>);
    } else if (line.startsWith('# ')) {
      elements.push(<Heading key={i} size="lg" mt={6} mb={3}>{line.slice(2)}</Heading>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <Text key={i} fontSize="sm" pl={4} position="relative" _before={{ content: '"•"', position: 'absolute', left: '4px' }}>
          {line.slice(2)}
        </Text>
      );
    } else if (line.startsWith('> ')) {
      elements.push(
        <Box key={i} borderLeft="3px solid" borderColor="blue.300" pl={3} py={1} my={1} bg="blue.50" borderRadius="sm">
          <Text fontSize="sm" fontStyle="italic">{line.slice(2)}</Text>
        </Box>
      );
    } else if (line.startsWith('|') && line.includes('|')) {
      // Collect table rows
      const tableRows: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].startsWith('|')) {
        i++;
        tableRows.push(lines[i]);
      }
      const dataRows = tableRows.filter(r => !r.match(/^\|[\s-:|]+\|$/));
      if (dataRows.length > 0) {
        const headers = dataRows[0].split('|').filter(c => c.trim()).map(c => c.trim());
        const body = dataRows.slice(1).map(r => r.split('|').filter(c => c.trim()).map(c => c.trim()));
        elements.push(
          <Box key={i} overflowX="auto" my={2} maxW="100%">
            <Table size="sm" variant="simple" w="auto">
              <Thead><Tr>{headers.map((h, hi) => <Th key={hi} fontSize="xs" whiteSpace="nowrap">{h}</Th>)}</Tr></Thead>
              <Tbody>
                {body.map((row, ri) => (
                  <Tr key={ri}>{row.map((cell, ci) => <Td key={ci} fontSize="xs">{cell}</Td>)}</Tr>
                ))}
              </Tbody>
            </Table>
          </Box>
        );
      }
    } else if (line.trim() === '') {
      elements.push(<Box key={i} h={2} />);
    } else {
      // Apply inline formatting
      const formatted = line
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
      elements.push(
        <Text key={i} fontSize="sm" dangerouslySetInnerHTML={{ __html: formatted }} sx={{ '& code': { bg: 'gray.100', px: 1, borderRadius: 'sm', fontFamily: 'mono', fontSize: 'xs' }, '& strong': { fontWeight: 'bold' } }} />
      );
    }
    i++;
  }

  return <VStack align="stretch" spacing={0} w="100%" minW={0} sx={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{elements}</VStack>;
}

// ---------------------------------------------------------------------------
// Reports Component
// ---------------------------------------------------------------------------

/**
 * Walk the React Query cache for chart-summary entries belonging to the
 * current project and roll them into the analysis_narratives shape consumed
 * by the design-strategies endpoint. All current registry summaries are
 * cross-zone, so we file them under "_global".
 */
/** Build the narrative-block payload that Stage 3 (DesignEngine Agent A)
 * pipes into its diagnosis prompt. Reads chart-summary entries out of the
 * React Query cache and emits per-zone + global blobs.
 *
 * Prefers the v2 structured fields (overall, findings[], local_breakdown[],
 * implication) when the backend produced them, since they cite specific
 * z-scores / r-values / unit labels and match exactly what the user sees on
 * each card. v1 (summary + highlight_points) is the fallback for old
 * cached entries or degraded responses.
 *
 * v2 `local_breakdown` entries are routed to their owning unit_id (zone or
 * cluster) so Agent A's per-unit prompt receives unit-specific narratives
 * instead of the same global blob for every unit.
 */
function collectAnalysisNarratives(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string | null | undefined,
): Record<string, Record<string, string>> {
  if (!projectId) return {};
  const queries = queryClient.getQueryCache().findAll({ queryKey: ['chart-summary'] });
  const out: Record<string, Record<string, string>> = {};
  const ensure = (zoneId: string): Record<string, string> => {
    if (!out[zoneId]) out[zoneId] = {};
    return out[zoneId];
  };

  for (const q of queries) {
    const key = q.queryKey as unknown[];
    if (key[2] !== projectId) continue;
    const data = q.state.data as
      | {
          summary?: string;
          highlight_points?: string[];
          summary_v2?: {
            overall: string;
            findings: { point: string; evidence: string }[];
            local_breakdown: { unit_id: string; unit_label: string; interpretation: string }[];
            implication: string;
          } | null;
        }
      | undefined;
    if (!data) continue;
    const chartId = String(key[1] ?? '');
    if (!chartId) continue;

    const v2 = data.summary_v2 ?? null;
    if (v2) {
      // v2 → rich per-unit + global text. The "global" blob omits
      // local_breakdown (those are routed to their unit instead) so we
      // don't double-feed each unit's interpretation under both keys.
      const findingLines = v2.findings
        .filter((f) => f.point)
        .map((f) => (f.evidence ? `- ${f.point} (${f.evidence})` : `- ${f.point}`))
        .join('\n');
      const globalParts: string[] = [];
      if (v2.overall) globalParts.push(`Overall: ${v2.overall}`);
      if (findingLines) globalParts.push(`Key findings:\n${findingLines}`);
      if (v2.implication) globalParts.push(`Design implication: ${v2.implication}`);
      const globalText = globalParts.join('\n\n');
      if (globalText) ensure('_global')[chartId] = globalText;

      for (const lb of v2.local_breakdown) {
        if (!lb.interpretation) continue;
        const zoneId = lb.unit_id || lb.unit_label;
        if (!zoneId) continue;
        // Per-unit narrative: prepend the chart's overall stance so Agent A
        // sees the global picture even when reading unit-scoped section.
        const lead = v2.overall ? `${v2.overall}\n` : '';
        ensure(zoneId)[chartId] = `${lead}This unit (${lb.unit_label || zoneId}): ${lb.interpretation}`;
      }
    } else if (data.summary) {
      // v1 fallback — single global blob with bullets.
      const bullets = data.highlight_points?.length
        ? '\n  • ' + data.highlight_points.join('\n  • ')
        : '';
      ensure('_global')[chartId] = `${data.summary}${bullets}`;
    }
  }
  return out;
}

function Reports() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useAppToast();
  // Native Chakra toast for the long-running bundle progress flow — we need
  // .update()/.close() on a stable id, which useAppToast's callable wrapper
  // does not expose. Other toasts in this file keep using useAppToast.
  const rawToast = useToast();
  const queryClient = useQueryClient();

  const {
    currentProject,
    recommendations,
    selectedIndicators,
    indicatorRelationships,
    recommendationSummary,
    zoneAnalysisResult,
    designStrategyResult,
    designStrategyResultsByViewId,
    analysisViewsByViewId,
    activeViewId,
    pipelineResult,
    aiReport,
    setAiReport,
    aiReportMeta,
    setAiReportMeta,
    hiddenChartIds,
    toggleChart,
    resetCharts,
    showAiSummary,
    setShowAiSummary,
    colorblindMode,
    setColorblindMode,
    pipelineRun,
    groupingMode,
    setGroupingMode,
    userZoneAnalysisResult,
    setUserZoneAnalysisResult,
    clusterAnalysisResult,
    setClusterAnalysisResult,
    singleZoneStrategy,
    setSingleZoneStrategy,
    multiZoneStrategy,
    setMultiZoneStrategy,
  } = useAppStore();

  // #2 — when the pipeline is actively running for THIS project, the analysis
  // tab content is hidden behind a single PipelineProgress card so users can't
  // act on half-baked state. Stale results from previous runs are also masked.
  const isPipelineRunningHere =
    pipelineRun.isRunning && pipelineRun.projectId === routeProjectId;

  const projectName = currentProject?.project_name || pipelineResult?.project_name || 'Unknown Project';

  // Clustering + retry strategies
  const clusteringMutation = useRunClusteringByProject();
  const withinZoneClusteringMutation = useRunClusteringWithinZones();
  const designStrategiesMutation = useRunDesignStrategies();
  const [clusteringResult, setClusteringResult] = useState<ClusteringResponse | null>(null);

  // Chart export plumbing (6.B(1)). chartRefs is populated by ref callbacks
  // on every ChartHost; exporting flips forceMount so lazy-loaded cards and
  // the clustering accordion render before captureChartsForReport runs.
  const chartRefs = useRef<Map<string, ChartHostHandle | null>>(new Map());
  const [exporting, setExporting] = useState(false);
  const setChartRef = useCallback((id: string) => (handle: ChartHostHandle | null) => {
    if (handle) chartRefs.current.set(id, handle);
    else chartRefs.current.delete(id);
  }, []);

  // Track which charts have hydrated so the loading progress bar can show
  // "mounted / total". Reset whenever the analysis mode flips (post-clustering
  // mode change re-mounts the chart grid with a different set of available
  // charts).
  const [mountedChartIds, setMountedChartIds] = useState<Set<string>>(() => new Set());
  // v4 polish — track whether the user explicitly initiated the AI report
  // flow (Generate / Regenerate button click). designStrategiesMutation is
  // shared between handleRunClustering's auto-regen-after-clustering and
  // handleGenerateAiReport's Step 1 fallback, so showing the button as
  // "Step 1/2 — Strategies…" purely on `designStrategiesMutation.isPending`
  // misleads the user into thinking they triggered AI report generation
  // (when actually clustering is still finishing in the background). This
  // flag is true ONLY while handleGenerateAiReport is in flight.
  const [isGeneratingAiReport, setIsGeneratingAiReport] = useState(false);
  // v4 / Module 13 — granular SSE-driven progress state. The progress bar
  // reads off this single union so the parent doesn't have to track stage,
  // unitIndex, unitTotal, etc. as separate `useState` slots. AbortController
  // is held in a ref so the Cancel button can yank both SSE streams.
  const [aiReportProgress, setAiReportProgress] = useState<AiReportProgressState>({ kind: 'idle' });
  const aiReportAbortRef = useRef<AbortController | null>(null);
  // Belt-and-suspenders: if the Reports page unmounts (route change, app
  // logout, etc.) while an AI Report flow is in flight, abort the SSE
  // streams so the fetch() inside consumeSseStream stops reading and the
  // backend can drop its in-flight LLM request.
  useEffect(() => {
    return () => {
      aiReportAbortRef.current?.abort();
    };
  }, []);
  const handleChartMount = useCallback((id: string) => {
    setMountedChartIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Layer selector retired (PDF #2): all layerAware charts now render
  // 4-up small multiples. ChartContext still requires a `selectedLayer` value
  // — pass 'full' as the only consumer left (Zone × Indicator Matrix in
  // Reference Tables) is full-layer by spec.
  const selectedLayer = 'full';

  // Check if Stage 3 failed in pipeline
  const stage3Failed = pipelineResult?.steps?.some(s => s.step === 'design_strategies' && s.status === 'failed') ?? false;
  const stage3Error = stage3Failed
    ? pipelineResult?.steps?.find(s => s.step === 'design_strategies')?.detail ?? 'Unknown error'
    : null;

  // v4 / Module 14 — `handleRetryStagе3` callback removed. It used to be
  // the click handler for the standalone "Generate Strategies" / "Retry
  // Stage 3" button on the Design Strategies tab. We removed that button
  // because it created a parallel code path to the AI Report card's
  // Generate button (race condition risk: two simultaneous mutateAsync
  // calls writing to the same `designStrategyResult` slot, with the AI
  // Report's strategy_signature potentially pointing to whichever
  // arrived last). The single entry point for strategy generation is now
  // `handleGenerateAiReport` (which kicks off strategies + report as a
  // bundled SSE flow). If you find yourself wanting to add a "regenerate
  // strategies only" path again, prefer composing it on top of
  // `handleGenerateAiReport` rather than re-introducing a parallel mutation.

  // v4 — auto-fire Design Strategies + AI Report as a single coupled flow.
  //
  // Why coupled: the user complained that "AI report and design strategies
  // should be generated once, they're one thing." Treating them as two
  // separate buttons (and two separate stale states) led to:
  //   1. Strategies regen → invalidates AI report → user sees "Generate"
  //      button reappear and has to click again.
  //   2. AI report cites the strategies, so they go stale together —
  //      maintaining "stale" warnings for both is a constant nag.
  // Coupling them into one auto-fire means: pick an option at the entry
  // gate → background job runs strategies + report sequentially → both
  // land at once. No second click, no stale dance.
  //
  // Skip rule: if BOTH already exist for this project, don't re-fire.
  // (If strategies exist but report doesn't, fire just the report.)
  // v4 / Module 14 — accepts an optional `modeOverride` argument for callers
  // that have just changed groupingMode but whose closure variable hasn't
  // updated yet (handleRunClustering / handleRunWithinZoneClustering).
  const handleRunClustering = useCallback(async () => {
    // v4 polish — accept routeProjectId as a fallback so the button works
    // even if currentProject is briefly null during a React Query refetch
    // (the previous early-return-on-null made Option C silently
    // unresponsive: button enabled but click did nothing). Also surface a
    // clear toast on the remaining failure modes.
    const projectIdForCluster = currentProject?.id ?? routeProjectId ?? null;
    // Defensive guard — multi-zone projects must use within-zone clustering,
    // not pooled global HDBSCAN. The UI hides every entry-point that calls
    // this handler when userZoneCount ≥ 2 (binary toggle, cluster panel
    // re-run button, ModeAlert in image_level mode), but a stale URL
    // navigation, prefetch, or test path could still get here. Bail out
    // with a clear toast pointing the user at the correct affordance.
    const userZoneCountAtCallTime = currentProject?.spatial_zones?.length ?? 0;
    if (userZoneCountAtCallTime >= 2) {
      toast({
        title: 'Global clustering disabled for multi-zone projects',
        description: 'Use Run Within-Zone Clustering from the entry gate instead — '
          + 'pooled clustering would ignore your zone boundaries.',
        status: 'info',
        duration: 6000,
      });
      return;
    }
    if (!zoneAnalysisResult) {
      toast({
        title: 'Cannot cluster — analysis not loaded yet',
        description: 'Wait a moment for the analysis to finish loading and try again.',
        status: 'warning',
        duration: 4000,
      });
      return;
    }
    if (!projectIdForCluster) {
      toast({
        title: 'Cannot cluster — project not loaded yet',
        status: 'warning',
        duration: 4000,
      });
      return;
    }
    try {
      const indicatorIds = Object.keys(zoneAnalysisResult.indicator_definitions);
      if (indicatorIds.length === 0) {
        toast({
          title: 'Cannot cluster — no indicators in analysis',
          description: 'Re-run the project pipeline to populate indicator definitions.',
          status: 'warning',
          duration: 5000,
        });
        return;
      }
      toast({ title: 'Running clustering on per-image indicators…', status: 'info', duration: 4000 });
      const result = await clusteringMutation.mutateAsync({
        project_id: projectIdForCluster,
        indicator_ids: indicatorIds,
        layer: 'full',
      });
      setClusteringResult(result);
      if (result.skipped) {
        toast({ title: `Clustering skipped: ${result.reason}`, status: 'info', duration: 6000 });
      } else if (result.clustering) {
        // #1 — Backend now returns a complete cluster-as-zone Stage 2.5
        // payload (zone_statistics, correlation, radar, layer_statistics
        // all rebuilt around clusters). Snapshot the user-zone analysis so
        // the user can toggle back, then swap the active dataset to the
        // cluster one and flip groupingMode → 'clusters' so the segmented
        // control reflects reality.
        if (!userZoneAnalysisResult) {
          setUserZoneAnalysisResult(zoneAnalysisResult);
        }
        const fullClusterAnalysis = result.zone_analysis ?? {
          // Legacy fallback for older backends that don't return
          // zone_analysis: do the partial-replacement we used to do.
          ...zoneAnalysisResult,
          clustering: result.clustering,
          segment_diagnostics: result.segment_diagnostics,
          zone_diagnostics: result.segment_diagnostics,
          analysis_mode: 'zone_level',
          zone_source: 'cluster',
        };
        setClusterAnalysisResult(fullClusterAnalysis);
        // v4 polish — full state-set parallel with handleRunWithinZoneClustering
        // so the active-display fields (aiReport / aiReportMeta /
        // designStrategyResult) all bind to the freshly-landed 'clusters'
        // view, not the stale 'zones' view they were pointing at before.
        // The setAiReportForViewId / setDesignStrategyResultForViewId calls
        // below auto-mirror to active-display when targetViewId matches the
        // currently-set activeViewId — so we set activeViewId FIRST, then
        // wipe the slot, then auto-fire.
        useAppStore.getState().setActiveViewId('clusters');
        useAppStore.getState().setZoneAnalysisResult(fullClusterAnalysis);
        // v4 polish — flip groupingMode to 'clusters' after clustering
        // so legacy code paths gating on it stay in sync.
        setGroupingMode('clusters');
        setSingleZoneStrategy('cluster');
        const gpsNote = result.n_points_with_gps ? ` · ${result.n_points_with_gps}/${result.n_points_used} with GPS` : '';
        toast({
          title: `${result.clustering.k} archetypes promoted to zones (silhouette: ${result.clustering.silhouette_score.toFixed(2)})${gpsNote}`,
          status: 'success',
        });

        // Wipe the 'clusters' slot specifically — strategies + AI report.
        // This both clears any stale prior-run cache AND mirrors null into
        // the active-display fields (since activeViewId === 'clusters' now).
        // The 'zones' slot is left untouched — toggling back via the
        // segmented control swaps to whatever the user had there.
        const store = useAppStore.getState();
        store.setDesignStrategyResultForViewId('clusters', null);
        store.setAiReportForViewId('clusters', null, null);
        queryClient.invalidateQueries({ queryKey: ['chart-summary'] });
        // v4 polish — strategies + AI report are bound to the user
        // explicitly clicking Generate AI Report. We no longer auto-fire
        // strategies on view-switch / clustering-success. The view lands
        // on its charts; Strategies and AI Report cards both show their
        // empty-state CTA until the user clicks Generate AI Report (which
        // runs strategies as Step 1, then narrates as Step 2).
      }
    } catch (err: unknown) {
      // v4 polish — surface the backend's actual error message instead of a
      // generic "Clustering failed" toast so root-cause is visible without
      // diving into Network tab.
      const detail = err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
        : null;
      const fallback = err instanceof Error ? err.message : 'Unknown error';
      toast({
        title: 'Clustering failed',
        description: detail || fallback,
        status: 'error',
        duration: 10000,
        isClosable: true,
      });
      console.error('[Clustering] backend error:', err);
    }
  }, [
    zoneAnalysisResult,
    currentProject,
    clusteringMutation,
    toast,
    userZoneAnalysisResult,
    setUserZoneAnalysisResult,
    setClusterAnalysisResult,
    setSingleZoneStrategy,
    queryClient,
    designStrategiesMutation,
    routeProjectId,
  ]);

  // v4 / Module 1 (multi-zone Option B) — within-zone HDBSCAN. For each user
  // zone, run HDBSCAN on its images independently; the backend stitches the
  // per-zone results into one composite ZoneAnalysisResult treating each
  // sub-cluster as a virtual zone. After the new analysis lands, kick off
  // strategies regen so the user lands on the Strategies tab with results.
  const handleRunWithinZoneClustering = useCallback(async () => {
    // v4 polish — same fallback as handleRunClustering. Use routeProjectId
    // when currentProject is briefly null during a React Query refetch.
    const projectIdForCluster = currentProject?.id ?? routeProjectId ?? null;
    if (!zoneAnalysisResult) {
      toast({
        title: 'Cannot cluster — analysis not loaded yet',
        description: 'Wait a moment for the analysis to finish loading and try again.',
        status: 'warning',
        duration: 4000,
      });
      return;
    }
    if (!projectIdForCluster) {
      toast({ title: 'Cannot cluster — project not loaded yet', status: 'warning', duration: 4000 });
      return;
    }
    try {
      const indicatorIds = Object.keys(zoneAnalysisResult.indicator_definitions);
      if (indicatorIds.length === 0) {
        toast({
          title: 'Cannot cluster — no indicators in analysis',
          description: 'Re-run the project pipeline to populate indicator definitions.',
          status: 'warning',
          duration: 5000,
        });
        return;
      }
      toast({
        title: 'Running HDBSCAN within each zone…',
        status: 'info',
        duration: 4000,
      });
      const result = await withinZoneClusteringMutation.mutateAsync({
        project_id: projectIdForCluster,
        indicator_ids: indicatorIds,
        layer: 'full',
      });
      if (result.skipped) {
        toast({ title: `Within-zone clustering skipped: ${result.reason}`, status: 'info', duration: 6000 });
        return;
      }
      const composite = result.zone_analysis;
      if (!composite) {
        toast({ title: 'Within-zone clustering produced no analysis payload.', status: 'warning' });
        return;
      }
      // v4 / Phase A+C — within-zone clustering now returns a multi-view
      // payload: parent_zones (N units), all_sub_clusters (NK units), and
      // within_zone:<zone_id> (per-zone drill-downs). Stash all of them
      // in the store so the segmented control can swap views client-side
      // without round-trips. Default landing is 'parent_zones' (zone-level
      // overview), per Phase D.
      if (!userZoneAnalysisResult) setUserZoneAnalysisResult(zoneAnalysisResult);
      setClusterAnalysisResult(composite);
      const analysisViews = (result.analysis_views ?? {}) as Record<string, ZoneAnalysisResult>;
      // Backward-compat: older backends (pre Phase A) won't return analysis_views.
      // Synthesize at least 'all_sub_clusters' from the legacy zone_analysis
      // field so the segmented control still has something to show.
      const viewsMap: Record<string, ZoneAnalysisResult | null> = {
        ...analysisViews,
      };
      if (!viewsMap.all_sub_clusters) viewsMap.all_sub_clusters = composite;
      useAppStore.getState().setAnalysisViewsByViewId(viewsMap);

      // Default to parent_zones if available (zone-level overview), else
      // fall back to all_sub_clusters. Strategies / AI report follow.
      const landingViewId = viewsMap.parent_zones ? 'parent_zones' : 'all_sub_clusters';
      const landingAnalysis = viewsMap[landingViewId] ?? composite;
      useAppStore.getState().setActiveViewId(landingViewId);
      useAppStore.getState().setZoneAnalysisResult(landingAnalysis);
      // Keep groupingMode in sync with the landing view's nature
      // ('parent_zones' is zone-level, others are cluster-level). Existing
      // chart logic still gates on groupingMode for some legacy paths.
      setGroupingMode(landingViewId === 'parent_zones' ? 'zones' : 'clusters');
      setMultiZoneStrategy('within_zone_cluster');

      const subZoneCount = composite.zone_diagnostics?.length ?? 0;
      const zCount = currentProject?.spatial_zones?.length ?? 0;
      toast({
        title: `Within-zone clustering: ${subZoneCount} sub-zones across ${zCount} zones`,
        description: `Showing ${landingViewId === 'parent_zones' ? 'parent-zone overview' : 'all sub-clusters'}; toggle the view selector to drill in.`,
        status: 'success',
        duration: 6000,
      });
      // Wipe stale per-view caches that the user might have from a prior
      // within-zone run (different K, different cluster shapes). Keep
      // 'zones' slot untouched — that's the user's pre-clustering work.
      const store = useAppStore.getState();
      const viewIdsToReset = Object.keys(viewsMap).filter((v) => v !== 'zones');
      for (const vid of viewIdsToReset) {
        store.setDesignStrategyResultForViewId(vid, null);
        store.setAiReportForViewId(vid, null, null);
      }
      queryClient.invalidateQueries({ queryKey: ['chart-summary'] });
      // v4 polish — strategies + AI report are bound to the user
      // explicitly clicking Generate AI Report on each view. We no longer
      // auto-fire on landing. The Strategies / AI Report cards show their
      // empty-state CTA in any view that hasn't been generated yet; user
      // can switch views freely without paying LLM cost on each switch.
    } catch (err: unknown) {
      const detail = err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
        : null;
      const fallback = err instanceof Error ? err.message : 'Unknown error';
      toast({
        title: 'Within-zone clustering failed',
        description: detail || fallback,
        status: 'error',
        duration: 10000,
        isClosable: true,
      });
      console.error('[Within-zone clustering] backend error:', err);
    }
  }, [
    zoneAnalysisResult,
    currentProject,
    routeProjectId,
    withinZoneClusteringMutation,
    toast,
    userZoneAnalysisResult,
    setUserZoneAnalysisResult,
    setClusterAnalysisResult,
    setMultiZoneStrategy,
    setGroupingMode,
    queryClient,
  ]);

  // v4 / Phase C — generic view switcher. Handles arbitrary viewId
  // (zones, clusters, parent_zones, all_sub_clusters, within_zone:<id>),
  // resolves the target ZoneAnalysisResult from analysisViewsByViewId or
  // the legacy userZoneAnalysisResult / clusterAnalysisResult fallbacks,
  // and swaps active-display fields (zoneAnalysis, strategies, aiReport)
  // atomically.
  const handleSwitchView = useCallback(
    (targetViewId: string) => {
      const store = useAppStore.getState();
      if (targetViewId === store.activeViewId) return;

      // Resolve target analysis: prefer the multi-view dict, fall back
      // to the legacy two-slot fields for backward compat.
      const fromMultiView = store.analysisViewsByViewId[targetViewId];
      let targetAnalysis: ZoneAnalysisResult | null = null;
      if (fromMultiView) {
        targetAnalysis = fromMultiView;
      } else if (targetViewId === 'zones') {
        targetAnalysis = userZoneAnalysisResult ?? null;
      } else if (
        targetViewId === 'clusters'
        || targetViewId === 'all_sub_clusters'
      ) {
        targetAnalysis = clusterAnalysisResult ?? null;
      }

      if (targetAnalysis) {
        store.setZoneAnalysisResult(targetAnalysis);
      }

      // Update legacy groupingMode for code paths still gating on it.
      // 'zones' and 'parent_zones' are zone-level; everything else is
      // cluster-derived (sub-clusters or zone drill-down).
      const nextGroupingMode: GroupingMode =
        targetViewId === 'zones' || targetViewId === 'parent_zones'
          ? 'zones'
          : 'clusters';
      setGroupingMode(nextGroupingMode);
      store.setActiveViewId(targetViewId);

      // Swap active-display strategies + AI report from the target
      // view's slot. Either slot may be null — in that case the
      // Strategies / AI Report cards naturally show their Generate
      // CTAs. The OTHER views' caches stay preserved.
      const next = useAppStore.getState();
      store.setAiReport(next.aiReportsByViewId[targetViewId] ?? null);
      store.setAiReportMeta(next.aiReportMetasByViewId[targetViewId] ?? null);
      store.setDesignStrategyResultForViewId(
        targetViewId,
        next.designStrategyResultsByViewId[targetViewId] ?? null,
      );
    },
    [clusterAnalysisResult, userZoneAnalysisResult, setGroupingMode],
  );

  const handleGenerateAiReport = useCallback(async () => {
    if (!zoneAnalysisResult) return;
    // v4 / Module 13 — granular SSE-driven progress. Replaces the previous
    // 2-step toast UX with a determinate progress bar that shows per-cluster
    // strategy generation progress (Cluster 3 of 5 · synthesizing strategies)
    // followed by per-phase report progress (Calling LLM…).
    //
    // Architecture:
    //   • Each AbortController governs both SSE streams. Cancel button
    //     calls .abort() which propagates to fetch() inside consumeSseStream.
    //   • The progress bar reads from a single union state managed here.
    //   • Result events carry the typed payloads — we mutate the store only
    //     after both stages succeed (same atomic-reveal rule as before).
    setIsGeneratingAiReport(true);
    const abortCtl = new AbortController();
    aiReportAbortRef.current = abortCtl;
    setAiReportProgress({ kind: 'strategies_starting', unitTotal: 0 });
    try {
      // Strip image_records — they can be 10K+ entries and the report
      // service doesn't use them. Keeps the HTTP body small.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { image_records: _ir, ...zoneAnalysisCompact } = zoneAnalysisResult;
      const projectContext = currentProject ? {
        project: {
          name: currentProject.project_name,
          location: currentProject.project_location,
          // v6.x — surface the Stage 1 zone graph to Agent A so cross-zone
          // interpretation can be conditioned on declared edges rather than
          // treating every zone pair as independent.
          spatial_zones: (currentProject.spatial_zones || []).map(z => ({
            zone_id: z.zone_id,
            zone_name: z.zone_name,
          })),
          spatial_relations: currentProject.spatial_relations || [],
        },
        context: {
          climate: { koppen_zone_id: currentProject.koppen_zone_id },
          urban_form: { space_type_id: currentProject.space_type_id, lcz_type_id: currentProject.lcz_type_id },
          user: { age_group_id: currentProject.age_group_id },
        },
        performance_query: {
          design_brief: currentProject.design_brief,
          dimensions: currentProject.performance_dimensions,
        },
      } : undefined;

      // ── Step 1: ensure strategies exist (cache-aware) ──────────────
      // v4 policy decision: AI report generation is fully manual; the
      // entry-gate auto-fire only generates strategies. So when the user
      // clicks "Generate Strategies + AI Report" here, the strategies
      // are usually ALREADY in the slot from auto-fire — re-running them
      // would waste 30-60s of LLM time.
      //
      // Cache rule:
      //   - Initial Generate (no aiReport yet, button reads "Generate"):
      //       Skip Step 1 if strategies already exist for this view; run
      //       it only when the slot is genuinely empty.
      //   - Regenerate (aiReport exists, button reads "Regenerate"):
      //       Force-rerun Step 1 — the user explicitly wants both
      //       artefacts refreshed, matching the button label.
      const isRegen = !!aiReport;
      let strategies = designStrategyResult;
      const haveCachedStrategies =
        strategies && strategies.zones && Object.keys(strategies.zones).length > 0;
      const shouldRunStrategies = isRegen || !haveCachedStrategies;

      if (shouldRunStrategies) {
        const narratives = collectAnalysisNarratives(queryClient, routeProjectId);
        // SSE stream: capture progress events into local state, capture
        // the final `result` event into `streamedStrategies` for next stage.
        let streamedStrategies: DesignStrategyResult | null = null;
        let streamError: string | null = null;
        await api.analysis.runDesignStrategiesStream(
          {
            zone_analysis: zoneAnalysisResult,
            analysis_narratives: narratives,
            use_llm: true,
            project_id: routeProjectId ?? undefined,
            // v4 / Phase C — persist into the active view's slot.
            ...viewIdToRequestFields(activeViewId),
          },
          (ev) => {
            if (ev.type === 'started') {
              setAiReportProgress({ kind: 'strategies_starting', unitTotal: ev.unit_total });
            } else if (ev.type === 'progress') {
              setAiReportProgress({
                kind: 'strategies_running',
                stage: ev.stage,
                unitIndex: ev.unit_index,
                unitTotal: ev.unit_total,
                unitLabel: ev.unit_label,
              });
            } else if (ev.type === 'result') {
              streamedStrategies = ev.data as DesignStrategyResult;
            } else if (ev.type === 'error') {
              streamError = ev.message;
            }
          },
          abortCtl.signal,
        );
        if (streamError) throw new Error(streamError);
        if (!streamedStrategies) throw new Error('Strategy stream ended without a result event');
        const finalStrategies: DesignStrategyResult = streamedStrategies;
        strategies = finalStrategies;
        useAppStore.getState().setDesignStrategyResult(finalStrategies);
        setAiReportProgress({
          kind: 'strategies_done',
          unitTotal: Object.keys(finalStrategies.zones).length,
        });
      } else {
        // Skipped Step 1 — jump the progress bar straight to "strategies
        // done" so Stage 2 starts at the right baseline (~70% per the
        // bar's strategies/report weighting).
        setAiReportProgress({
          kind: 'strategies_done',
          unitTotal: strategies && strategies.zones ? Object.keys(strategies.zones).length : 0,
        });
      }

      // ── Step 2: narrate the report (with strategies guaranteed present) ──
      const request: ReportRequest = {
        zone_analysis: zoneAnalysisCompact as typeof zoneAnalysisResult,
        design_strategies: strategies ?? undefined,
        stage1_recommendations: recommendations.length > 0
          ? (recommendations as unknown as Record<string, unknown>[])
          : undefined,
        project_context: projectContext,
        format: 'markdown',
        project_id: routeProjectId ?? undefined,
        ...viewIdToRequestFields(activeViewId),
      };
      let reportResult: { content: string; metadata: Record<string, unknown> } | null = null;
      let reportStreamError: string | null = null;
      await api.analysis.generateReportStream(
        request,
        (ev) => {
          if (ev.type === 'progress') {
            setAiReportProgress({
              kind: 'report_running',
              phase: ev.phase,
              label: ev.label,
            });
          } else if (ev.type === 'result') {
            reportResult = ev.data;
          } else if (ev.type === 'error') {
            reportStreamError = ev.message;
          }
        },
        abortCtl.signal,
      );
      if (reportStreamError) throw new Error(reportStreamError);
      if (!reportResult) throw new Error('Report stream ended without a result event');
      // Local non-null reference: TS doesn't narrow vars assigned inside
      // an SSE callback's closure after the awaited stream completes.
      const result: { content: string; metadata: Record<string, unknown> } = reportResult;
      // Only set aiReport AFTER both steps succeeded. Until this line the
      // AI Report card shows "Generating…" — the user never sees a half
      // state. v4 / Module 9 — same rule of "one atomic reveal" we use for
      // the chart grid.
      setAiReport(result.content);
      const strategySignature = computeStrategySignature(strategies);
      setAiReportMeta({
        ...(result.metadata ?? {}),
        view_id: activeViewId,
        grouping_mode: viewIdToRequestFields(activeViewId).grouping_mode,
        strategy_signature: strategySignature,
      });
      const wc = Number(result.metadata?.word_count ?? 0);
      const dataWarning = result.metadata?.data_quality_warning as string | undefined;
      // v4 / Module 13 — truncation toast. Fires at generation time so the
      // user sees the warning even before scrolling down to read the
      // banner. The banner remains as a persistent reminder; the toast is
      // the immediate "you should know" signal.
      const truncationWarning = result.metadata?.truncation_warning as
        | { current_model?: string; recommended_model?: string | null; user_message?: string }
        | null
        | undefined;
      // v4 / Module 11.2.3 — single-zone reports are intentionally shorter
      // (no archetype profile section). Don't bark at users about "minimal
      // content" if they explicitly chose Single View.
      // Note: derive zone count from zoneAnalysisResult directly (not from
      // `sortedDiagnostics`, which is declared LATER in the component and
      // would create a Temporal Dead Zone error in this useCallback's deps).
      const zoneDiagCount = zoneAnalysisResult?.zone_diagnostics?.length ?? 0;
      const isSingleZoneReport =
        groupingMode === 'zones'
        && zoneDiagCount < 2
        && !clusterAnalysisResult;
      if (truncationWarning) {
        toast({
          title: 'AI report was truncated by the model output cap',
          description:
            truncationWarning.recommended_model
              ? `Switch to ${truncationWarning.recommended_model} (Settings → LLM Provider) and regenerate to get the full report.`
              : (truncationWarning.user_message || 'Reduce the cluster count K and regenerate, or switch to a higher-output-token model.'),
          status: 'warning',
          duration: 12000,
          isClosable: true,
        });
      } else if (dataWarning) {
        toast({
          title: 'AI report generated with caveats',
          description: dataWarning,
          status: 'warning',
          duration: 8000,
        });
      } else if (isSingleZoneReport) {
        toast({
          title: `Single-zone report generated — ${wc} words`,
          description: 'For cross-zone diagnostic content, switch to Dual View and re-generate.',
          status: 'info',
          duration: 6000,
        });
      } else if (wc < 100) {
        toast({
          title: 'AI report has minimal content',
          description: `Only ${wc} words returned — likely thin source data. Check that analysis charts have non-zero values.`,
          status: 'warning',
          duration: 8000,
        });
      } else {
        toast({ title: `AI report generated — ${wc} words`, status: 'success' });
      }
      // Mark the bar as done; it'll auto-fade when isGeneratingAiReport flips
      // off in `finally`.
      setAiReportProgress({ kind: 'done' });
    } catch (err: unknown) {
      // v4 polish — surface the backend's actual detail (or fetch error
      // text) instead of a generic "AI report generation failed" so the
      // user can tell whether it was a 500, a timeout, or a payload
      // validation error. Also log to console for deeper debugging.
      const detail = err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
        : null;
      const fallback = err instanceof Error ? err.message : 'Unknown error';
      const isAbort = err instanceof Error && err.name === 'AbortError';
      toast({
        title: isAbort ? 'AI report generation cancelled' : 'AI report generation failed',
        description: detail || fallback,
        status: isAbort ? 'info' : 'error',
        duration: 10000,
        isClosable: true,
      });
      setAiReportProgress(
        isAbort
          ? { kind: 'idle' }
          : { kind: 'error', message: detail || fallback },
      );
      // eslint-disable-next-line no-console
      console.error('[AI Report] backend error:', err);
    } finally {
      setIsGeneratingAiReport(false);
      aiReportAbortRef.current = null;
      // Auto-clear the bar 1.5s after a `done` so the user sees "100% — Done in
      // Xs" briefly before it disappears. Errors stick until the user clicks
      // Generate again (which resets to strategies_starting at the top of try).
      window.setTimeout(() => {
        setAiReportProgress((prev) => (prev.kind === 'done' ? { kind: 'idle' } : prev));
      }, 1500);
    }
  }, [zoneAnalysisResult, designStrategyResult, recommendations, currentProject, queryClient, groupingMode, clusterAnalysisResult, toast, setAiReport, setAiReportMeta, routeProjectId]);

  // Completion status
  const hasVision = (currentProject?.uploaded_images?.length ?? 0) > 0;
  const hasIndicators = recommendations.length > 0;
  const hasAnalysis = zoneAnalysisResult !== null;
  const hasDesign = designStrategyResult !== null || pipelineResult?.design_strategies !== null && pipelineResult?.design_strategies !== undefined;
  const isEmpty = !hasIndicators && !hasAnalysis && !hasDesign;

  const steps = [
    { name: 'Vision', done: hasVision },
    { name: 'Indicators', done: hasIndicators },
    { name: 'Analysis', done: hasAnalysis },
    { name: 'Design', done: hasDesign },
  ];
  const completedSteps = steps.filter(s => s.done).length;

  // Unified chart context (memoized — cheap, recomputes only when inputs change)
  const chartCtx = useMemo(
    () =>
      buildChartContext({
        zoneAnalysisResult,
        pipelineResult: pipelineResult ?? null,
        clusteringResult,
        currentProject: currentProject ?? null,
        selectedLayer,
        colorblindMode,
      }),
    [zoneAnalysisResult, pipelineResult, clusteringResult, currentProject, selectedLayer, colorblindMode],
  );

  // Debug hook — expose chartCtx to window so we can inspect from DevTools
  // when charts unexpectedly drop. Safe to keep in production: it's a
  // read-only snapshot of in-memory state, the same data the page is
  // already rendering. Open Console and run `window.__SCENERX_CTX__`.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __SCENERX_CTX__?: unknown }).__SCENERX_CTX__ = {
        imageRecords: chartCtx.imageRecords?.length ?? 0,
        gpsImages: chartCtx.gpsImages?.length ?? 0,
        gpsIndicatorIds: chartCtx.gpsIndicatorIds?.length ?? 0,
        indicatorDefs: Object.keys(chartCtx.indicatorDefs ?? {}).length,
        dataQuality: chartCtx.dataQuality?.length ?? 0,
        sortedDiagnostics: chartCtx.sortedDiagnostics?.length ?? 0,
        analysisMode: chartCtx.analysisMode,
        zoneSource: chartCtx.zoneSource,
        currentProject_uploadedImages: currentProject?.uploaded_images?.length ?? 0,
        currentProject_imagesWithZone: currentProject?.uploaded_images?.filter(
          (i: { zone_id: string | null }) => !!i.zone_id,
        ).length ?? 0,
        currentProject_imagesWithMetrics: currentProject?.uploaded_images?.filter(
          (i: { metrics_results: Record<string, unknown> | null }) =>
            i.metrics_results && Object.keys(i.metrics_results).length > 0,
        ).length ?? 0,
        zoneAnalysisResult_imageRecords: zoneAnalysisResult?.image_records?.length ?? 0,
      };
    }
  }, [chartCtx, currentProject, zoneAnalysisResult]);

  // Compact project context handed to chart-summary requests so LLM grounding
  // doesn't require a separate fetch per chart.
  const chartProjectContext = useMemo<Record<string, unknown> | null>(() => {
    if (!currentProject) return null;
    return {
      project_name: currentProject.project_name,
      project_location: currentProject.project_location,
      koppen_zone: currentProject.koppen_zone_id,
      space_type: currentProject.space_type_id,
      lcz_type: currentProject.lcz_type_id,
      age_group: currentProject.age_group_id,
      performance_dimensions: currentProject.performance_dimensions,
      design_brief: currentProject.design_brief,
    };
  }, [currentProject]);

  const hiddenSet = useMemo(() => new Set(hiddenChartIds), [hiddenChartIds]);

  // v4 polish — derive an "effective mode" from the actual data shape
  // (current grouping mode + zone count of the active analysis), instead
  // of from the user's entry-gate pick. This way:
  //   • Option B (Single View)               → 'single_zone'  (zone_diagnostics < 2 in zones mode)
  //   • Option C (Dual View) zones tab        → 'single_zone'  (same underlying data — original 1-zone analysis)
  //   • Option C cluster tab after clustering → 'cluster'      (cluster-as-zone payload, multi unit)
  //   • Multi-zone Option A zones tab         → 'multi_zone'   (≥ 2 user zones)
  //   • Multi-zone Option B within-zone       → 'cluster'      (cluster-as-zone with sub-zones)
  // The chart filter and "How to read" panel both consume this so they
  // match what the user is currently looking at, not what they picked at
  // the entry gate. Fixes: Option C zone tab showing B-section charts
  // with degenerate (1-zone) data instead of the same charts as Option B.
  const effectiveModeForCharts = useMemo<'single_zone' | 'multi_zone' | 'cluster'>(() => {
    if (groupingMode === 'clusters' && clusterAnalysisResult) return 'cluster';
    // zones tab — look at the underlying user-zone analysis
    const activeZoneAnalysis = userZoneAnalysisResult ?? zoneAnalysisResult;
    const zoneCount = activeZoneAnalysis?.zone_diagnostics?.length ?? 0;
    if (zoneCount < 2) return 'single_zone';
    return 'multi_zone';
  }, [groupingMode, clusterAnalysisResult, userZoneAnalysisResult, zoneAnalysisResult]);

  // v4 polish — N=2 degenerate-grouping chart hide list. These five charts
  // depend on cross-grouping z-scores or Pearson correlations, both of which
  // collapse mathematically with only 2 grouping units (zones or clusters):
  //   - z = (x - mean) / std → ±√2/2 ≈ ±0.707 for both points
  //   - Pearson r → ±1 for any indicator pair (2-point fit is always perfect)
  //   - Percentile rank (B3 radar) → 0% / 100% for the 2 points
  // We hide these five rather than render meaningless ±0.71 / ±1 grids. The
  // ModeAlert banner explains the hide; image-level distributions in section
  // C still render normally because they don't depend on cross-grouping
  // comparison.
  const DEGENERATE_AT_N2_CHART_IDS = useMemo(
    () => new Set([
      'zone-deviation-overview', // B1 — mean |z| ranking
      'priority-heatmap',        // B2 — z-score grid
      'radar-profiles',          // B3 — percentile profile per layer
      'spatial-z-deviation',     // B4 — mean |z| on map
      'correlation-heatmap',     // D3 — Pearson r between indicators
    ]),
    [],
  );
  // Active when the current grouping has fewer than 3 units. sortedDiagnostics
  // already reflects the active grouping (zones in zone-mode, sub-clusters in
  // within-zone drill, etc.), so this single check covers:
  //   - N=2 zones (project-level)
  //   - K=2 clusters (global cluster view)
  //   - K=1 or K=2 sub-clusters in a within-zone drill view
  // All cross-grouping z-score / Pearson-r charts (B1/B2/B3/B4/D3) are
  // mathematically degenerate at < 3 grouping units. We hide them rather
  // than render meaningless ±0.71 / ±1 grids. Stale-analysis case is
  // handled by its own banner — no need to gate here.
  //
  // The check requires analysisMode === 'zone_level' as a sanity guard so
  // we don't fire for image-level fallback analyses (those don't have
  // cross-grouping charts in scope to begin with — viableInModes already
  // filters them).
  const isDegenerateN2Grouping =
    chartCtx.analysisMode === 'zone_level'
    && chartCtx.sortedDiagnostics.length <= 2
    && chartCtx.sortedDiagnostics.length > 0;

  // Unified analysis tab — all 'analysis' charts (formerly split between diagnostics+statistics)
  // v4 polish — restrict registry to charts viable in the current effective
  // mode. Falls through (allows the chart) when viableInModes is undefined.
  const analysisCharts = useMemo(
    () => CHART_REGISTRY.filter(c => {
      if (c.tab !== 'analysis') return false;
      if (hiddenSet.has(c.id)) return false;
      // N=2 degenerate filter — hide the 5 cross-grouping charts. See
      // DEGENERATE_AT_N2_CHART_IDS comment for the math.
      if (isDegenerateN2Grouping && DEGENERATE_AT_N2_CHART_IDS.has(c.id)) return false;
      const modes = c.viableInModes;
      if (modes && !modes.includes(effectiveModeForCharts)) return false;
      return true;
    }),
    [hiddenSet, effectiveModeForCharts, isDegenerateN2Grouping, DEGENERATE_AT_N2_CHART_IDS],
  );
  const clusteringCharts = useMemo(
    () => analysisCharts.filter(c => c.section === 'clustering'),
    [analysisCharts],
  );
  // Group non-clustering charts by section so Reports.tsx can render
  // sub-headings (5.10.2). Sections that have zero available charts (after
  // ChartHost's own isAvailable check) still render their group header but
  // the rendered list will be empty — handled with a fallback in the JSX.
  const sectionedCharts = useMemo(() => {
    const grouped: Partial<Record<ChartSection, typeof analysisCharts>> = {};
    for (const c of analysisCharts) {
      if (c.section === 'clustering') continue;
      const list = grouped[c.section] ?? [];
      list.push(c);
      grouped[c.section] = list;
    }
    return grouped;
  }, [analysisCharts]);
  const sortedDiagnostics = chartCtx.sortedDiagnostics;
  // #22 — mode-uniform unit list: { id, name, colorScheme, bg, rank, ... }
  // for the cards/legends below. Decouples the rendering from "which Z-score
  // → which Chakra color" so future palette changes happen in one place.
  const groupingUnits = useGroupingUnits(sortedDiagnostics, groupingMode);

  // Total visible chart count drives the loading progress denominator —
  // include both sectioned charts and clustering charts (when the gating
  // panel is open).
  const showClusteringPanel = chartCtx.analysisMode === 'image_level';
  const visibleChartIds = useMemo(() => {
    const ids: string[] = [];
    for (const c of analysisCharts) {
      if (c.section === 'clustering' && !showClusteringPanel) continue;
      if (!c.isAvailable(chartCtx)) continue;
      ids.push(c.id);
    }
    return ids;
  }, [analysisCharts, showClusteringPanel, chartCtx]);

  // #1 — single-zone hard gate. Use the analyzer's own `analysis_mode`
  // signal (image_level == zones < 2 at compute time) instead of the live
  // project's spatial_zones count, because:
  //   1. `currentProject` can be null briefly post-pipeline while React
  //      Query refetches the project payload — relying on it would falsely
  //      hide a perfectly-good multi-zone analysis result during that gap.
  //   2. The analyzer is the source of truth: if it produced zone-level
  //      diagnostics, the data is valid regardless of the project's
  //      spatial_zones list (which may be stale).
  // Gate only fires when (a) we have an analysis loaded AND (b) it ran in
  // image-level (degenerate) mode AND (c) clustering hasn't replaced it.
  const isClusterDerived =
    chartCtx.zoneSource === 'cluster' || !!clusterAnalysisResult;
  const userZoneCount = currentProject?.spatial_zones?.length ?? 0;
  // v4 / Module 14 — stale-analysis detector. Fires when the cached
  // zone_analysis_result was computed against a different effective zone
  // count than the project currently has. Two cases:
  //   1. Pipeline ran when effective N=1 (analysisMode='image_level'
  //      fallback), then user added zones AND assigned images to them →
  //      now effective N≥2 but analysisMode is still 'image_level'.
  //   2. Pipeline ran when effective N≥2 (analysisMode='zone_level'), then
  //      user deleted zones / unassigned images → now effective N<2 but
  //      analysisMode='zone_level'.
  //
  // CRITICAL — "effective N" means zones that actually have images.
  // project.spatial_zones.length alone is misleading: a user may have 2
  // zones defined but only 1 with images assigned (the other is empty).
  // The backend's analyzer sees len(zones_with_data)=1, correctly returns
  // image_level. If we naively compare userZoneCount=2 to 'image_level',
  // we'd false-fire stale and force the user to "re-run pipeline" forever
  // — even though the analysis IS up-to-date for the actual data.
  //
  // We compute zonesWithImages by walking uploaded_images: any zone_id
  // that appears at least once with a real assignment counts. This
  // matches the backend's effective-N logic.
  const zonesWithImages = (() => {
    const ids = new Set<string>();
    for (const img of currentProject?.uploaded_images ?? []) {
      if (img.zone_id) ids.add(img.zone_id);
    }
    return ids.size;
  })();
  const zonesChangedAfterPipeline =
    hasAnalysis &&
    !isClusterDerived &&
    (
      (zonesWithImages >= 2 && chartCtx.analysisMode === 'image_level') ||
      (zonesWithImages < 2 && chartCtx.analysisMode === 'zone_level')
    );
  // v4 / Module 1: gate fires only when the user has not yet picked a path
  // AND the analysis is consistent with the project's zone count.
  const singleZoneGated =
    hasAnalysis &&
    chartCtx.analysisMode === 'image_level' &&
    !isClusterDerived &&
    !zonesChangedAfterPipeline &&
    singleZoneStrategy === null;
  // v4 / Module 1 (multi-zone): mirror gate for projects with ≥ 2 user zones.
  // Fires before any chart renders, asking the user whether to keep zone-level
  // analysis as-is or run within-zone HDBSCAN sub-clustering. Resets each
  // session (multiZoneStrategy is in-memory only).
  const multiZoneGated =
    hasAnalysis &&
    chartCtx.analysisMode === 'zone_level' &&
    !isClusterDerived &&
    userZoneCount >= 2 &&
    !zonesChangedAfterPipeline &&
    multiZoneStrategy === null;
  // v4 / Module 1: when the user picked Single View, surface a Run-clustering
  // banner above the chart grid so they can upgrade to Dual View later.
  // (Banner removed in v4 polish; variable kept for potential reuse.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _inSingleView =
    singleZoneStrategy === 'view_only' && !isClusterDerived;

  // #1 — segmented control eligibility: show whenever the project has
  // enough zones to make clustering meaningful (≥ 2 user zones in zone
  // mode, or any cluster snapshot already cached). When the user clicks
  // "Cluster view" before running clustering, we still render the toggle
  // and surface a ClusterEmptyHint card explaining the next step (per
  // spec acceptance criterion: "未执行聚类时切到 Cluster 视图，给出
  // 「请先执行聚类」的引导，而不是空白图表").
  // v4 / Module 1 lock-down — once the user picks Single View, clustering is
  // permanently disabled for this session: the segmented control hides, the
  // SVC Archetype accordion hides, and ModeAlert no longer shows the "Run
  // Clustering" button. Single View is now a terminal choice (was previously
  // upgradeable). Pick Dual View at the entry gate for clustering.
  const clusteringLocked = singleZoneStrategy === 'view_only' && !isClusterDerived;
  const groupingToggleAvailable =
    !singleZoneGated &&
    !clusteringLocked &&
    (sortedDiagnostics.length >= 2 || !!clusterAnalysisResult);
  // wantsClusterButMissing fires the "Cluster view selected — clustering
  // hasn't been run yet" hint card. It must NOT fire when within-zone
  // clustering has already produced parent_zones / all_sub_clusters views,
  // because in that case clustering HAS been run — just not as global
  // pooled clustering, so clusterAnalysisResult is null. The within-zone
  // path lands the user on groupingMode='clusters' for sub-cluster views,
  // which without this guard would falsely surface the empty-cluster hint.
  const hasWithinZoneClusterViews = !!(
    analysisViewsByViewId.parent_zones || analysisViewsByViewId.all_sub_clusters
  );
  const wantsClusterButMissing =
    !clusteringLocked &&
    groupingMode === 'clusters' &&
    !clusterAnalysisResult &&
    !hasWithinZoneClusterViews;

  // #2 — atomic chart reveal. Charts are eagerly mounted (forceMount=true on
  // every host below) so they all start rendering at once; we keep them
  // behind a Skeleton overlay until each expanded-section chart has fired
  // onMount, then fade the overlay out. Charts living inside collapsed
  // accordions (setup, reference) are excluded — they only mount when the
  // user expands the section, and we don't want to block the whole grid on
  // user interaction.
  const eagerChartIds = useMemo(() => {
    const collapsedSections = new Set<ChartSection>(
      (Object.keys(SECTION_META) as ChartSection[]).filter(
        (s) => SECTION_META[s].defaultCollapsed,
      ),
    );
    return visibleChartIds.filter((id) => {
      const chart = analysisCharts.find((c) => c.id === id);
      if (!chart) return false;
      return !collapsedSections.has(chart.section);
    });
  }, [visibleChartIds, analysisCharts]);
  const allChartsReady =
    eagerChartIds.length === 0 ||
    eagerChartIds.every((id) => mountedChartIds.has(id));

  // v4 / Module 3 — non-blocking interpretations progress. We poll the
  // React Query cache for chart-summary queries belonging to this project
  // and surface a (done / total) tuple. The strip below the main chart
  // loader shows "Generating interpretations… N/M" so users know the page
  // isn't frozen while LLM calls are still in flight. This does NOT block
  // the Skeleton overlay — charts render the moment they're ready.
  const interpretationsCounts = useMemo(() => {
    if (!routeProjectId) return { total: 0, done: 0 };
    const queries = queryClient.getQueryCache().findAll({ queryKey: ['chart-summary'] });
    let total = 0;
    let done = 0;
    for (const q of queries) {
      const key = q.queryKey as unknown[];
      if (key[2] !== routeProjectId) continue;
      total += 1;
      const status = q.state.status as string;
      if (status === 'success' || status === 'error') done += 1;
    }
    return { total, done };
    // Re-evaluates whenever React re-renders (any state change). For tighter
    // tracking we could subscribe to cache events; this is good enough for
    // a status strip that doesn't need millisecond accuracy.
  }, [routeProjectId, queryClient, mountedChartIds]);

  // Reset the mounted set when the visible chart roster changes (mode flip,
  // hidden chart toggle). Effect runs after render so React commits the new
  // visibleChartIds before we drop stale entries.
  useEffect(() => {
    setMountedChartIds((prev) => {
      const visibleSet = new Set(visibleChartIds);
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleChartIds]);

  // v4 polish — multi-zone projects must not display the global cluster
  // view. Global clustering pools all images and ignores zone boundaries;
  // applying it to a project where the user explicitly defined zones
  // overwrites that spatial structure. The user-facing UI hides the
  // "Cluster view" button for multi-zone (see binary-toggle JSX above);
  // this effect handles cached state that bypasses the toggle:
  //   - clusterAnalysisResult lingering from a previous run when the
  //     project had fewer zones, or from before this policy landed
  //   - groupingMode='clusters' picked from that stale cache
  //
  // CRITICAL guard — within-zone clustering ALSO writes clusterAnalysisResult
  // (handleRunWithinZoneClustering line ~1152, as a backward-compat mirror
  // of the all_sub_clusters view). The presence of `parent_zones` /
  // `all_sub_clusters` in analysisViewsByViewId is the discriminator that
  // says "this clusterAnalysisResult came from within-zone, leave it
  // alone". Without this guard, the effect wipes the freshly-set state
  // immediately after within-zone clustering succeeds, the entry gate
  // re-fires, and the user can never get past it.
  useEffect(() => {
    const hasWithinZoneViews = !!(
      analysisViewsByViewId.parent_zones || analysisViewsByViewId.all_sub_clusters
    );
    if (userZoneCount >= 2 && clusterAnalysisResult && !hasWithinZoneViews) {
      setClusterAnalysisResult(null);
      if (groupingMode === 'clusters') {
        setGroupingMode('zones');
      }
    }
  }, [userZoneCount, clusterAnalysisResult, groupingMode, analysisViewsByViewId,
      setClusterAnalysisResult, setGroupingMode]);

  // v4 polish — frontend stale-detection for within-zone clustering used
  // to live here (Task #107), checking for orphan within_zone:<zone_id>
  // keys whose zone was deleted from the project. It was REMOVED in Task
  // #108 because edge cases produced false positives that wiped freshly-
  // completed clustering results, leaving the user stuck at the entry
  // gate. The legitimate stale case (delete-zone-after-clustering) is
  // covered by the backend's Layer 1 cascading invalidation:
  //   - Project zones change → backend wipes zone_analysis_result + AI
  //   - hydrateFromProject sees the wiped fields, sets
  //     analysisViewsByViewId={} on every project payload mount
  // If a user manages to keep stale within-zone state (no project re-mount,
  // no React Query refetch), they can recover by clicking the View
  // selector or refreshing the page. That's a far better failure mode
  // than the previous "you can never re-cluster" bug.

  // Pull cached chart-summary captions out of React Query so embedded images
  // get human-readable captions when the user has generated them.
  const captionFor = useCallback(
    (chartId: string): string | null => {
      const queries = queryClient.getQueryCache().findAll({ queryKey: ['chart-summary'] });
      for (const q of queries) {
        const key = q.queryKey as unknown[];
        if (key[1] !== chartId) continue;
        if (key[2] !== routeProjectId) continue;
        const data = q.state.data as { summary?: string } | undefined;
        if (data?.summary) return data.summary;
      }
      return null;
    },
    [queryClient, routeProjectId],
  );

  // Capture all exportByDefault charts. Sets `exporting` so lazy-loaded cards
  // and the clustering accordion render before html2canvas runs.
  //
  // v4.3 — also pre-fetch the backend's matplotlib SVGs from
  // /api/projects/{id}/nature-bundle.zip and pass them through as
  // `matplotlibSvgs`. captureChartsForReport will rasterise these instead
  // of html2canvas-screenshotting the Recharts DOM, so the AI report's
  // embedded charts share the same Nature-grade style as the standalone
  // bundle.
  const captureChartsForDownload = useCallback(async (): Promise<CapturedChart[]> => {
    if (!hasAnalysis) return [];
    setExporting(true);
    try {
      // Pre-load matplotlib SVGs (best effort — falls back to html2canvas
      // for any chart_id the backend didn't render).
      const matplotlibSvgs = new Map<string, string>();
      if (routeProjectId) {
        try {
          const baseURL =
            (import.meta.env.VITE_API_URL as string | undefined) ||
            'http://localhost:8080';
          const res = await fetch(
            `${baseURL}/api/projects/${routeProjectId}/nature-bundle.zip?view=${groupingMode}`,
            { method: 'GET' },
          );
          if (res.ok) {
            const JSZipMod = (await import('jszip')).default;
            const zip = await JSZipMod.loadAsync(await res.blob());
            await Promise.all(
              Object.values(zip.files).map(async (entry) => {
                if (entry.dir) return;
                const m = /\/charts\/([^/]+)\.svg$/.exec(entry.name);
                if (m) matplotlibSvgs.set(m[1], await entry.async('string'));
              }),
            );
          }
        } catch (e) {
          console.warn('[capture] could not pre-load nature-bundle:', e);
        }
      }
      // Two paint frames — first lets React commit `exporting=true`,
      // second lets ChartHosts unfold lazy bodies + the accordion.
      await waitForPaint();
      await waitForPaint();
      return await captureChartsForReport({
        charts: CHART_REGISTRY.filter((c) => c.tab === 'analysis'),
        ctx: chartCtx,
        refs: chartRefs.current,
        captionFor,
        matplotlibSvgs: matplotlibSvgs.size > 0 ? matplotlibSvgs : undefined,
      });
    } finally {
      setExporting(false);
    }
  }, [hasAnalysis, chartCtx, captionFor, routeProjectId]);

  // Downloads — v4 / Module 10.3.1: handleDownloadMarkdown / handleDownloadPdf
  // are kept for potential reuse but are no longer wired to UI buttons. The
  // underscore-prefix below silences "unused" lint warnings.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleDownloadMarkdown = useCallback(async () => {
    if (!zoneAnalysisResult) return;
    toast({ title: 'Capturing charts…', status: 'info', duration: 2000 });
    const chartImages = await captureChartsForDownload();
    const md = generateReport({
      projectName,
      pipelineResult,
      zoneResult: zoneAnalysisResult,
      designResult: designStrategyResult,
      radarProfiles: zoneAnalysisResult.radar_profiles ?? null,
      correlationByLayer: zoneAnalysisResult.correlation_by_layer ?? null,
      chartImages,
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, '_')}_report.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast({
      title: chartImages.length > 0
        ? `Report downloaded — ${chartImages.length} chart(s) embedded`
        : 'Report downloaded (no charts captured)',
      status: 'success',
    });
  }, [zoneAnalysisResult, captureChartsForDownload, projectName, pipelineResult, designStrategyResult, toast]);

  // #7-B — whole-page ZIP bundle. Walks every available chart in the
  // analysis registry, captures its SVG via DOM lookup (forceMount keeps
  // bodies present) and pulls tabular data via descriptor.exportRows when
  // the descriptor opted in. The AI report and a metadata.json round it
  // out so a researcher can drop the zip straight into a paper repo.
  const handleExportBundle = useCallback(async () => {
    if (!zoneAnalysisResult) return;
    toast({ title: 'Building export bundle…', status: 'info', duration: 2000 });
    try {
      const cards = CHART_REGISTRY.filter(
        (c) => c.tab === 'analysis' && c.isAvailable(chartCtx) && !hiddenChartIds.includes(c.id),
      );
      // Use the ChartHostHandle.getNode() refs we already collect for the
      // PDF / image-capture flow, instead of fishing the cards out of the DOM
      // by aria-label. aria-label matching breaks when chart titles contain
      // characters CSS attribute selectors don't like (apostrophes, quotes,
      // backslashes), and refs are O(1) without any DOM scan.
      // Pull the LLM "What this means" interpretation for each chart out of
      // the React Query cache. Each card's useChartSummary uses a key of
      // ['chart-summary', chartId, projectId, groupingMode, payload]; we look
      // up the most recent successful entry for (chartId × projectId ×
      // groupingMode) and attach it to the bundle as summaries/*.json so the
      // paper-writer has the model's reading alongside the figure itself.
      const summaryQueries = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['chart-summary'] });
      const summaryByChartId = new Map<string, Record<string, unknown>>();
      for (const q of summaryQueries) {
        const key = q.queryKey as unknown[];
        // [tag, chartId, projectId, groupingMode, payload]
        if (key[2] !== routeProjectId) continue;
        if (key[3] !== groupingMode) continue;
        const data = q.state.data as Record<string, unknown> | undefined;
        if (!data) continue;
        const chartId = String(key[1] ?? '');
        if (!chartId) continue;
        // Prefer the most recently updated entry if there are multiple
        // (different payload snapshots).
        const existing = summaryByChartId.get(chartId);
        if (
          !existing ||
          (q.state.dataUpdatedAt ?? 0) >
            (Number(existing.__dataUpdatedAt) || 0)
        ) {
          summaryByChartId.set(chartId, {
            ...data,
            __dataUpdatedAt: q.state.dataUpdatedAt,
          });
        }
      }

      // v4.6 — pre-warm any summary not yet in the React Query cache.
      // useChartSummary fires lazily (only on panel-open), so users who
      // export without scrolling through every clustering panel would
      // be missing ~8 summaries. Fan them out in parallel here.
      const missingForPrewarm = cards.filter((c) => {
        const has = summaryByChartId.has(c.id);
        const fn = (c as { summaryPayload?: (ctx: unknown) => unknown }).summaryPayload;
        return !has && typeof fn === 'function';
      });
      if (missingForPrewarm.length > 0) {
        toast({
          title: `Generating ${missingForPrewarm.length} chart summaries…`,
          status: 'info',
          duration: 2500,
        });
        await Promise.all(
          missingForPrewarm.map(async (c) => {
            try {
              const fn = (c as { summaryPayload: (ctx: unknown) => Record<string, unknown> | null }).summaryPayload;
              const payload = fn(chartCtx);
              if (payload == null) return;
              const resp = await api.analysis.chartSummary({
                chart_id: c.id,
                chart_title: c.title,
                chart_description:
                  (c as { description?: string | null }).description ?? null,
                project_id: routeProjectId ?? '',
                payload,
                project_context: chartProjectContext,
                grouping_mode: groupingMode,
              });
              if (resp?.data) {
                summaryByChartId.set(
                  c.id,
                  resp.data as unknown as Record<string, unknown>,
                );
              }
            } catch (err) {
              console.warn(`[bundle] pre-warm summary for ${c.id} failed:`, err);
            }
          }),
        );
      }

      const artifacts = cards.map((c) => {
        const handle = chartRefs.current.get(c.id);
        const tab = c.exportRows ? c.exportRows(chartCtx) : null;
        const summary = summaryByChartId.get(c.id) ?? null;
        if (summary) {
          // Drop internal sort key before serializing.
          delete (summary as Record<string, unknown>).__dataUpdatedAt;
        }
        return {
          chartId: c.id,
          title: c.title,
          node: handle?.getNode() ?? null,
          rows: tab?.rows,
          columns: tab?.columns,
          aiSummary: summary,
        };
      });
      // Progress toast — closeable, live-updating "n / N" indicator that
      // also shows the current chart id so users on slow machines can see
      // the bundle is making forward progress.
      const progressId = 'export-bundle-progress';
      if (rawToast.isActive(progressId)) rawToast.close(progressId);
      rawToast({
        id: progressId,
        title: 'Fetching server-rendered nature SVGs…',
        description: `${groupingMode} view`,
        status: 'info',
        duration: null,
        isClosable: false,
        position: 'top-right',
      });

      // Pull the publication-grade SVGs from the backend so every chart
      // in the bundle is rendered by matplotlib (Liberation Sans + elite
      // muted palette, no HTML-legend overflow). If the server is
      // unreachable we silently fall back to the live-DOM capture so the
      // bundle is never empty.
      const natureSvgs = new Map<string, string>();
      if (routeProjectId) {
        try {
          const baseURL =
            (import.meta.env.VITE_API_URL as string | undefined) ||
            'http://localhost:8080';
          const res = await fetch(
            `${baseURL}/api/projects/${routeProjectId}/nature-bundle.zip?view=${groupingMode}`,
            { method: 'GET' },
          );
          if (res.ok) {
            const JSZipMod = (await import('jszip')).default;
            const zip = await JSZipMod.loadAsync(await res.blob());
            await Promise.all(
              Object.values(zip.files).map(async (entry) => {
                if (entry.dir) return;
                const mSvg = /\/charts\/([^/]+)\.svg$/.exec(entry.name);
                if (mSvg) {
                  natureSvgs.set(mSvg[1], await entry.async('string'));
                  return;
                }
                // v4.2 — also harvest the per-chart LLM summaries the
                // backend now writes to summaries/<chart_id>.json. Without
                // this the FE's exportBundle would discard them (it only
                // writes summaries from React Query cache, which is empty
                // unless the user clicked "What this means" on every card).
                const mSum = /\/summaries\/([^/]+)\.json$/.exec(entry.name);
                if (mSum) {
                  try {
                    const text = await entry.async('string');
                    const obj = JSON.parse(text) as Record<string, unknown>;
                    if (!summaryByChartId.has(mSum[1])) {
                      summaryByChartId.set(mSum[1], obj);
                    }
                  } catch (e) {
                    console.warn('[bundle] failed to parse summary',
                                 mSum[1], e);
                  }
                }
              }),
            );
          } else {
            console.warn(
              '[bundle] nature-bundle endpoint returned',
              res.status,
              '— falling back to live-DOM SVGs',
            );
          }
        } catch (e) {
          console.warn(
            '[bundle] nature-bundle fetch failed; falling back to DOM:',
            e,
          );
        }
      }

      rawToast.update(progressId, {
        title: `Building bundle… 0 / ${artifacts.length}`,
        description: natureSvgs.size > 0
          ? `Nature SVGs: ${natureSvgs.size} · ${groupingMode} view`
          : `${groupingMode} view (live-DOM SVGs)`,
      });

      const result = await exportBundle({
        charts: artifacts,
        projectSlug: currentProject?.project_name ?? 'project',
        projectName: currentProject?.project_name ?? null,
        groupingMode,
        aiReport: aiReport ?? null,
        aiReportMeta: aiReportMeta ?? null,
        chartSvgOverrides: natureSvgs.size > 0 ? natureSvgs : undefined,
        extraMetadata: {
          zone_count: zoneAnalysisResult.zone_diagnostics?.length ?? 0,
          analysis_mode: zoneAnalysisResult.analysis_mode,
          zone_source: zoneAnalysisResult.zone_source,
          design_strategies_present: !!designStrategyResult,
          nature_svg_count: natureSvgs.size,
        },
        onProgress: ({ current, total, title }) => {
          rawToast.update(progressId, {
            title: `Building bundle… ${current} / ${total}`,
            description: title,
          });
        },
      });
      rawToast.close(progressId);
      toast({
        title: `Bundle ready: ${result.filename}`,
        description:
          `${result.charts} chart(s) · ${result.csvs} CSV` +
          (result.pngs > 0 ? ` · ${result.pngs} PNG` : '') +
          ` · ${result.summaries} AI summary`,
        status: 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bundle export failed';
      if (rawToast.isActive('export-bundle-progress')) {
        rawToast.close('export-bundle-progress');
      }
      toast({ title: message, status: 'error' });
    }
  }, [
    zoneAnalysisResult,
    chartCtx,
    hiddenChartIds,
    currentProject,
    groupingMode,
    aiReport,
    aiReportMeta,
    designStrategyResult,
    queryClient,
    routeProjectId,
    toast,
    rawToast,
  ]);

  const handleExportJson = () => {
    // Per-image metrics: flatten uploaded_images to id + zone + GPS + metrics
    const imageMetrics = currentProject?.uploaded_images?.map(img => ({
      image_id: img.image_id,
      filename: img.filename,
      zone_id: img.zone_id,
      has_gps: img.has_gps,
      latitude: img.latitude,
      longitude: img.longitude,
      metrics: img.metrics_results,
    })) ?? [];

    const data = {
      project_name: projectName,
      project_location: currentProject?.project_location ?? null,
      exported_at: new Date().toISOString(),
      recommendations,
      selected_indicators: selectedIndicators,
      image_metrics: imageMetrics,
      zone_analysis: zoneAnalysisResult,
      design_strategies: designStrategyResult,
      pipeline_result: pipelineResult,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, '_')}_data.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'JSON exported', status: 'success' });
  };

  const handleExportExcel = async () => {
    try {
      await exportAnalysisExcel({
        projectName,
        images: currentProject?.uploaded_images ?? [],
        zoneStats: zoneAnalysisResult?.zone_statistics ?? [],
        diagnostics: zoneAnalysisResult?.zone_diagnostics ?? [],
        correlationByLayer: zoneAnalysisResult?.correlation_by_layer ?? null,
        pvalueByLayer: zoneAnalysisResult?.pvalue_by_layer ?? null,
        globalStats: zoneAnalysisResult?.global_indicator_stats ?? [],
      });
      toast({ title: 'Excel exported', status: 'success' });
    } catch {
      toast({ title: 'Excel export failed', status: 'error' });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleDownloadPdf = useCallback(async () => {
    if (!zoneAnalysisResult) return;
    toast({ title: 'Capturing charts…', status: 'info', duration: 2000 });
    try {
      const chartImages = await captureChartsForDownload();
      const { jsPDF } = await import('jspdf');
      const md = generateReport({
        projectName,
        pipelineResult,
        zoneResult: zoneAnalysisResult,
        designResult: designStrategyResult,
        radarProfiles: zoneAnalysisResult.radar_profiles ?? null,
        correlationByLayer: zoneAnalysisResult.correlation_by_layer ?? null,
      });

      const pdf = new jsPDF('p', 'mm', 'a4');
      const margin = 15;
      const pageW = 210 - margin * 2;
      const pageH = 297 - margin * 2;
      let y = margin;

      const addText = (text: string, size: number, style: 'normal' | 'bold' = 'normal') => {
        pdf.setFontSize(size);
        pdf.setFont('helvetica', style);
        const lines = pdf.splitTextToSize(text, pageW);
        for (const line of lines) {
          if (y + size * 0.4 > margin + pageH) {
            pdf.addPage();
            y = margin;
          }
          pdf.text(line, margin, y);
          y += size * 0.45;
        }
      };

      const addChartImage = (chart: CapturedChart) => {
        // Equal-aspect resize: cap width at pageW, scale height proportionally,
        // then if it would overflow 60% of the page height shrink to fit.
        const aspect = chart.heightPx > 0 ? chart.widthPx / chart.heightPx : 1;
        let imgW = pageW;
        let imgH = imgW / aspect;
        const maxH = pageH * 0.6;
        if (imgH > maxH) {
          imgH = maxH;
          imgW = imgH * aspect;
        }
        if (y + imgH + 12 > margin + pageH) {
          pdf.addPage();
          y = margin;
        }
        addText(chart.title, 11, 'bold');
        try {
          pdf.addImage(chart.dataURL, 'PNG', margin, y, imgW, imgH, undefined, 'FAST');
        } catch (err) {
          console.warn('PDF addImage failed for', chart.chart_id, err);
        }
        y += imgH + 2;
        if (chart.caption) {
          pdf.setFontSize(8);
          pdf.setFont('helvetica', 'italic');
          pdf.setTextColor(110);
          const captionLines = pdf.splitTextToSize(chart.caption, pageW);
          for (const line of captionLines) {
            if (y + 4 > margin + pageH) { pdf.addPage(); y = margin; }
            pdf.text(line, margin, y);
            y += 3.5;
          }
          pdf.setTextColor(0);
          pdf.setFont('helvetica', 'normal');
        }
        y += 4;
      };

      // Title page
      pdf.setFontSize(20);
      pdf.setFont('helvetica', 'bold');
      pdf.text(projectName, margin, 40);
      pdf.setFontSize(12);
      pdf.setFont('helvetica', 'normal');
      pdf.text('SceneRx Analysis Report', margin, 50);
      pdf.text(new Date().toLocaleDateString(), margin, 58);
      if (pipelineResult) {
        pdf.setFontSize(10);
        pdf.text(`Images: ${pipelineResult.zone_assigned_images}/${pipelineResult.total_images}`, margin, 70);
        pdf.text(`Calculations: ${pipelineResult.calculations_succeeded} succeeded`, margin, 76);
        pdf.text(`Zone Stats: ${pipelineResult.zone_statistics_count}`, margin, 82);
        pdf.text(`Zones: ${sortedDiagnostics.length}`, margin, 88);
        if (chartImages.length > 0) {
          pdf.text(`Embedded Charts: ${chartImages.length}`, margin, 94);
        }
      }
      pdf.addPage();
      y = margin;

      // Embedded charts page (right after title, before text body)
      if (chartImages.length > 0) {
        addText('Charts', 16, 'bold');
        y += 2;
        for (const chart of chartImages) {
          addChartImage(chart);
        }
        pdf.addPage();
        y = margin;
      }

      // Render markdown content (text body — image lines already embedded above)
      for (const line of md.split('\n')) {
        if (line.startsWith('![')) continue; // images already embedded
        if (line.startsWith('### ')) {
          y += 2;
          addText(line.slice(4), 12, 'bold');
          y += 1;
        } else if (line.startsWith('## ')) {
          y += 3;
          addText(line.slice(3), 14, 'bold');
          y += 1;
        } else if (line.startsWith('# ')) {
          y += 4;
          addText(line.slice(2), 16, 'bold');
          y += 2;
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          addText(`  \u2022 ${line.slice(2)}`, 10);
        } else if (line.startsWith('|') && !line.match(/^\|[\s-:|]+\|$/)) {
          // Table rows — render as tab-separated text
          const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
          addText(cells.join('    '), 9);
        } else if (line.trim() === '') {
          y += 2;
        } else {
          const clean = line
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/`(.+?)`/g, '$1');
          addText(clean, 10);
        }
      }

      // Footer with page numbers
      const totalPages = pdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(150);
        pdf.text(`${projectName} — Page ${i}/${totalPages}`, 105, 290, { align: 'center' });
        pdf.setTextColor(0);
      }

      pdf.save(`${projectName.replace(/\s+/g, '_')}_report.pdf`);
      toast({
        title: chartImages.length > 0
          ? `PDF downloaded — ${chartImages.length} chart(s) embedded`
          : 'PDF downloaded',
        status: 'success',
      });
    } catch (err) {
      console.error('PDF generation failed', err);
      toast({ title: 'PDF generation failed', status: 'error' });
    }
  }, [zoneAnalysisResult, designStrategyResult, pipelineResult, projectName, sortedDiagnostics, toast, captureChartsForDownload]);

  const handleDownloadAiReportPdf = useCallback(async () => {
    if (!aiReport) return;
    toast({ title: 'Generating PDF...', status: 'info', duration: 2000 });
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const margin = 15;
      const pageW = 210 - margin * 2;
      const pageH = 297 - margin * 2;
      let y = margin;

      const addText = (text: string, size: number, style: 'normal' | 'bold' = 'normal') => {
        pdf.setFontSize(size);
        pdf.setFont('helvetica', style);
        const lines = pdf.splitTextToSize(text, pageW);
        for (const line of lines) {
          if (y + size * 0.4 > margin + pageH) {
            pdf.addPage();
            y = margin;
          }
          pdf.text(line, margin, y);
          y += size * 0.45;
        }
      };

      for (const line of aiReport.split('\n')) {
        if (line.startsWith('### ')) {
          y += 2;
          addText(line.slice(4), 12, 'bold');
          y += 1;
        } else if (line.startsWith('## ')) {
          y += 3;
          addText(line.slice(3), 14, 'bold');
          y += 1;
        } else if (line.startsWith('# ')) {
          y += 4;
          addText(line.slice(2), 16, 'bold');
          y += 2;
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          addText(`  \u2022 ${line.slice(2)}`, 10);
        } else if (line.trim() === '') {
          y += 3;
        } else {
          // Strip markdown bold/italic for PDF
          const clean = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
          addText(clean, 10);
        }
      }

      pdf.save(`${projectName.replace(/\s+/g, '_')}_ai_report.pdf`);
      toast({ title: 'PDF downloaded', status: 'success' });
    } catch {
      toast({ title: 'PDF generation failed', status: 'error' });
    }
  }, [aiReport, projectName, toast]);

  // v4 / Module 10.3.1 — keep the deprecated handlers alive (no UI reference)
  // so the file still compiles in `noUnusedLocals` mode without deleting
  // 240+ lines of report-export logic that may be revived in a future sprint.
  void _handleDownloadMarkdown;
  void _handleDownloadPdf;
  void _SingleViewUpgradeBar;
  void _inSingleView;

  return (
    <PageShell>
      <PageHeader title="Results & Report">
        <HStack spacing={2}>
          <GlossaryDrawer />
          {hasAnalysis && (
            <ChartPicker
              hiddenIds={hiddenChartIds}
              onToggle={toggleChart}
              onReset={resetCharts}
              showAiSummary={showAiSummary}
              onShowAiSummaryChange={setShowAiSummary}
              colorblindMode={colorblindMode}
              onColorblindModeChange={setColorblindMode}
            />
          )}
          {/* v4 / Module 10.3.1 — Report (.md) and Report (.pdf) buttons
              removed. They produced a data-centric duplicate of the AI
              Report and tended to drift out of sync (different snapshots,
              contradictory chart-summary captions). The AI Report is now
              the single narrative deliverable; tabular data still goes
              through Data (.xlsx) / Raw (.json) / Bundle (.zip). */}
          <Tooltip label="Multi-sheet spreadsheet: image metrics, zone statistics, correlations, and global stats" placement="bottom" hasArrow>
            <Button size="sm" leftIcon={<FileSpreadsheet size={14} />} onClick={handleExportExcel} isDisabled={isEmpty} colorScheme="teal">
              Data (.xlsx)
            </Button>
          </Tooltip>
          <Tooltip label="Complete raw data dump: all pipeline results, zone analysis, and per-image metrics" placement="bottom" hasArrow>
            <Button size="sm" leftIcon={<FileText size={14} />} onClick={handleExportJson} isDisabled={isEmpty} variant="outline">
              Raw (.json)
            </Button>
          </Tooltip>
          <Tooltip
            label="ZIP bundle: every chart redrawn server-side by matplotlib (Nature-grade SVGs) + CSV tables + per-chart LLM interpretation + the AI report. Filename includes the active grouping mode so zone-mode and cluster-mode bundles don't overwrite each other."
            placement="bottom"
            hasArrow
          >
            <Button size="sm" leftIcon={<Download size={14} />} onClick={handleExportBundle} isDisabled={!hasAnalysis} colorScheme="purple">
              Bundle (.zip)
            </Button>
          </Tooltip>
        </HStack>
      </PageHeader>

      {isEmpty ? (
        pipelineResult !== null ? (
          <EmptyState
            icon={AlertTriangle}
            title="Pipeline finished but the result didn't reach the browser"
            description={
              `The backend reported ${pipelineResult.zone_statistics_count} zone-stat ` +
              `record(s) and ${pipelineResult.calculations_succeeded} successful calculations, ` +
              `but the streamed result event was lost in transit (most often a proxy or buffer ` +
              `truncating a multi-MB SSE chunk). Re-run the pipeline; if it persists, check the ` +
              `browser console for "[Pipeline SSE] Failed to parse event" and the network tab ` +
              `for the final data: line of /api/analysis/project-pipeline/stream.`
            }
          />
        ) : (
          <EmptyState
            icon={AlertTriangle}
            title="No results yet"
            description={
              currentProject?.spatial_zones && currentProject.spatial_zones.length > 0
                ? "Run the analysis pipeline first, then come back here to view results and generate reports. (Editing zones or reassigning images automatically clears prior analysis — re-run pipeline to refresh.)"
                : "Run the analysis pipeline first, then come back here to view results and generate reports."
            }
          >
            {/* v4 / Module 14 — direct link to the Analysis page so the
                user can launch the pipeline in one click instead of
                hunting through the sidebar. Especially useful after
                zone edits, which auto-invalidate analysis on the backend. */}
            {routeProjectId && (
              <Button
                colorScheme="purple"
                leftIcon={<RefreshCw size={16} />}
                onClick={() => navigate(`/projects/${routeProjectId}/analysis`)}
              >
                Run pipeline
              </Button>
            )}
          </EmptyState>
        )
      ) : (
        <Box>
          {/* Pipeline Overview */}
          <Card mb={6} role="region" aria-label="Pipeline overview">
            <CardHeader>
              <HStack justify="space-between">
                <Heading size="md">Pipeline Overview</Heading>
                <Text fontSize="sm" color="gray.500">{completedSteps}/{steps.length} steps</Text>
              </HStack>
            </CardHeader>
            <CardBody>
              <HStack spacing={4} flexWrap="wrap" mb={3}>
                {steps.map(s => (
                  <HStack key={s.name} spacing={1}>
                    <Icon as={s.done ? CheckCircle : AlertTriangle} color={s.done ? 'green.500' : 'gray.400'} boxSize={4} />
                    <Text fontSize="sm" color={s.done ? 'green.600' : 'gray.500'}>{s.name}</Text>
                  </HStack>
                ))}
              </HStack>
              {pipelineResult && (
                <SimpleGrid columns={{ base: 2, md: 5 }} spacing={3}>
                  <Box><Text fontSize="xs" color="gray.500">Images</Text><Text fontWeight="bold">{pipelineResult.zone_assigned_images}/{pipelineResult.total_images}</Text></Box>
                  <Box><Text fontSize="xs" color="gray.500">Calculations</Text><Text fontWeight="bold" color="green.600">{pipelineResult.calculations_succeeded} OK</Text></Box>
                  <Box><Text fontSize="xs" color="gray.500">Zone Stats</Text><Text fontWeight="bold">{pipelineResult.zone_statistics_count}</Text></Box>
                  <Box><Text fontSize="xs" color="gray.500">Zones</Text><Text fontWeight="bold">{sortedDiagnostics.length}</Text></Box>
                  <Box>
                    <Text fontSize="xs" color="gray.500">GPS Coverage</Text>
                    <Text fontWeight="bold" color={chartCtx.gpsImages.length > 0 ? 'green.600' : 'gray.400'}>
                      {chartCtx.gpsImages.length}/{currentProject?.uploaded_images?.length ?? 0}
                      {currentProject?.uploaded_images?.length ? ` (${Math.round(chartCtx.gpsImages.length / currentProject.uploaded_images.length * 100)}%)` : ''}
                    </Text>
                  </Box>
                </SimpleGrid>
              )}
            </CardBody>
          </Card>

          {/* v4 / Module 4 — Top-of-Analysis narrative panel.
              Module 1 alignment: hide on single-zone projects until the
              user picks Single View or Dual View, AND hide on multi-zone
              projects until the user picks Zone-only or Within-zone
              clustering. Otherwise the narrative guide preempts the entry-
              card decision. */}
          {hasAnalysis && !singleZoneGated && !multiZoneGated && (
            // v4 polish — use the same effective mode as the chart filter
            // so the "How to read" guide highlights only the sections the
            // user can actually see right now. Switching the segmented
            // control (zones ↔ clusters) flips this live.
            <AnalysisGuide mode={effectiveModeForCharts} />
          )}

          {/* AI Report Section.
              Module 11 alignment: hide on single-zone projects until the
              user picks Single View or Dual View — generating an AI report
              on a degenerate (image_level, all-zero z-score) state used to
              error out / produce empty content. After picking, Single View
              triggers the single-zone prompt branch (Module 11.2.1) and
              Dual View triggers the multi-archetype prompt. */}
          {hasAnalysis && !singleZoneGated && !multiZoneGated && (
            <Card
              mb={6}
              borderColor={aiReport ? 'purple.300' : 'gray.200'}
              borderWidth={aiReport ? 2 : 1}
              overflow="hidden"
              role="region"
              aria-label="AI-generated report"
            >
              <CardHeader>
                <VStack align="stretch" spacing={3}>
                  <HStack spacing={2} flexWrap="wrap">
                    <Icon as={Sparkles} color="purple.500" boxSize={5} />
                    <Heading size="md">AI Report</Heading>
                    {!aiReport && <Badge colorScheme="gray" variant="subtle">Not generated</Badge>}
                    {aiReportMeta && (
                      <Badge colorScheme="purple" variant="subtle">
                        {String(aiReportMeta.word_count || '?')} words
                      </Badge>
                    )}
                    <Box flex="1" />
                    <AnalysisConfidenceGauge
                      ctx={chartCtx}
                      aiReportWordCount={
                        aiReportMeta?.word_count != null
                          ? Number(aiReportMeta.word_count)
                          : null
                      }
                    />
                  </HStack>
                  {/* v4 polish — coupling note. The Generate button kicks
                      off design strategies AND the narrative report as
                      one bundled flow. The Strategies tab is the
                      structured (machine-readable) output; the AI Report
                      is the prose narration of those same strategies.
                      Surfacing this makes it less surprising when the
                      Strategies tab updates as a side effect of clicking
                      Generate here. */}
                  <Text fontSize="xs" color="gray.600" lineHeight="1.5">
                    Clicking Generate runs the <Text as="span" fontWeight="semibold">design
                    strategies</Text> engine first, then narrates the resulting
                    strategies into this markdown report. Both outputs are
                    refreshed together — the
                    {' '}<Text as="span" fontWeight="semibold">Design Strategies</Text>{' '}
                    tab above shows the structured form of what the report below
                    discusses in prose.
                  </Text>
                  <HStack spacing={2} flexWrap="wrap">
                    <Button
                      size="sm"
                      leftIcon={<Sparkles size={14} />}
                      onClick={handleGenerateAiReport}
                      // v4 polish — gate isLoading on the local
                      // isGeneratingAiReport flag, not on the bare
                      // mutation pending state. The mutations are shared
                      // with handleRunClustering's auto-strategy-regen,
                      // and showing the AI Report button as loading
                      // during clustering's regen used to confuse users
                      // ("why is generation slow when I haven't even
                      // clicked Generate?").
                      isLoading={isGeneratingAiReport}
                      loadingText="Generating…"
                      colorScheme="purple"
                    >
                      {/* v4 polish — make the bundling explicit on the
                          button itself. Clicking this button always runs
                          BOTH stages (strategies → report); the AI
                          report's prose narrates the strategies that the
                          design engine just produced. Without this label
                          users were confused why their first click took
                          so long ("I just wanted the report") and why
                          the Strategies tab quietly refreshed alongside. */}
                      {aiReport ? 'Regenerate Strategies + AI Report' : 'Generate Strategies + AI Report'}
                    </Button>
                    {/* Cancel button — only visible while THIS user-initiated
                        flow is running (not when clustering is independently
                        regenerating strategies in the background). Aborts
                        the in-flight SSE streams via the AbortController
                        held in aiReportAbortRef. */}
                    {isGeneratingAiReport && (
                      <Button
                        size="sm"
                        variant="outline"
                        colorScheme="red"
                        onClick={() => {
                          aiReportAbortRef.current?.abort();
                          // The catch block in handleGenerateAiReport will
                          // see the AbortError and clear isGeneratingAiReport
                          // / aiReportProgress. We don't need to flip them
                          // here.
                          toast({
                            title: 'Cancelling AI report generation…',
                            description:
                              'The in-flight LLM call may still complete on the backend, but the page is now unblocked.',
                            status: 'info',
                            duration: 6000,
                            isClosable: true,
                          });
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                    {aiReport && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => {
                          const blob = new Blob([aiReport], { type: 'text/markdown' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `${projectName.replace(/\s+/g, '_')}_ai_report.md`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}>
                          Download MD
                        </Button>
                        <Button size="sm" colorScheme="green" variant="outline" leftIcon={<FileImage size={12} />} onClick={handleDownloadAiReportPdf}>
                          Download PDF
                        </Button>
                      </>
                    )}
                  </HStack>
                  {/* v4 / Module 13 — granular progress bar. Renders only
                      while a generate/regenerate flow is active; resolves
                      to null when state.kind === 'idle'. */}
                  <AiReportProgress state={aiReportProgress} />
                </VStack>
              </CardHeader>
              {aiReport && (
                <CardBody pt={0}>
                  {/* v4 / Module 13 — TRUNCATION banner. Renders when the
                      LLM hit its output-token cap mid-report (typically
                      stops in the middle of Section 4, missing later
                      clusters' strategies). Surfaces the recommended model
                      upgrade so the user can fix it in one click instead
                      of guessing why their report is incomplete. */}
                  {(() => {
                    const tw = aiReportMeta?.truncation_warning as
                      | {
                          truncated?: boolean;
                          current_model?: string;
                          recommended_model?: string | null;
                          rationale?: string;
                          user_message?: string;
                          output_tokens?: number | null;
                        }
                      | null
                      | undefined;
                    if (!tw || !tw.truncated) return null;
                    return (
                      <Alert status="warning" mb={3} borderRadius="md" alignItems="flex-start" colorScheme="orange">
                        <AlertIcon mt={1} />
                        <Box flex="1">
                          <Text fontSize="sm" fontWeight="bold">
                            Report was cut off — the LLM hit its output-token cap
                          </Text>
                          <Text fontSize="xs" color="gray.700" mt={1}>
                            The current model (
                            <Text as="span" fontFamily="mono" fontSize="2xs">
                              {tw.current_model || 'unknown'}
                            </Text>
                            ) stopped generating before finishing the report. Trailing
                            sections — typically the last few clusters in Section 4 —
                            are missing or incomplete.
                          </Text>
                          {tw.recommended_model ? (
                            <Text fontSize="xs" color="gray.700" mt={1}>
                              <Text as="span" fontWeight="semibold">Recommended fix:</Text>
                              {' '}switch to{' '}
                              <Text as="span" fontFamily="mono" fontSize="2xs">
                                {tw.recommended_model}
                              </Text>
                              {' '}in Settings → LLM Provider, then regenerate. {tw.rationale}
                            </Text>
                          ) : (
                            <Text fontSize="xs" color="gray.700" mt={1}>
                              <Text as="span" fontWeight="semibold">Recommended fix:</Text>
                              {' '}{tw.rationale || 'Reduce the cluster count K, or split the report into two halves.'}
                            </Text>
                          )}
                          {tw.output_tokens != null && (
                            <Text fontSize="2xs" color="gray.500" mt={1}>
                              Emitted {tw.output_tokens} output tokens before truncation.
                            </Text>
                          )}
                        </Box>
                        <Button
                          size="xs"
                          colorScheme="orange"
                          variant="solid"
                          onClick={handleGenerateAiReport}
                          isLoading={isGeneratingAiReport}
                          loadingText="Regenerating..."
                          flexShrink={0}
                        >
                          Regenerate
                        </Button>
                      </Alert>
                    );
                  })()}
                  {/* #8.5 + Phase C — warn when the active view differs from
                      the one the report was written for. With multi-view
                      support, the meta's `grouping_mode` value may now be
                      a full viewId (e.g. 'parent_zones'), not just the
                      legacy 'zones'/'clusters'. Compare against
                      activeViewId so a parent_zones report doesn't
                      falsely flag as mismatched against legacy 'zones'. */}
                  {(() => {
                    const reportViewId = (aiReportMeta?.view_id as string | undefined)
                      ?? (aiReportMeta?.grouping_mode as string | undefined);
                    if (!reportViewId || reportViewId === activeViewId) return null;
                    return (
                      <Alert status="warning" mb={3} borderRadius="md" alignItems="flex-start">
                        <AlertIcon mt={1} />
                        <Box flex="1">
                          <Text fontSize="sm" fontWeight="bold">
                            This report was written for the {reportViewId} view —
                            you're now viewing {activeViewId}.
                          </Text>
                          <Text fontSize="xs" color="gray.600" mt={1}>
                            Unit names and statistics in the prose may not line up with the charts above.
                            Regenerate the report to refresh it for the current view.
                          </Text>
                        </Box>
                        <Button
                          size="xs"
                          colorScheme="orange"
                          variant="outline"
                          onClick={handleGenerateAiReport}
                          isLoading={isGeneratingAiReport}
                          loadingText="Regenerating..."
                          flexShrink={0}
                        >
                          Regenerate
                        </Button>
                      </Alert>
                    );
                  })()}
                  {/* v4 — strategies-stale banner. Fires when the
                      designStrategyResult on the Strategies tab has a
                      different signature than the one this AI report was
                      generated against. Without this, the AI report would
                      keep narrating the OLD strategies even after the
                      Strategies tab refreshed. */}
                  {(() => {
                    const reportSig =
                      typeof aiReportMeta?.strategy_signature === 'string'
                        ? aiReportMeta.strategy_signature
                        : null;
                    const liveSig = computeStrategySignature(designStrategyResult);
                    const stale =
                      !!reportSig && !!liveSig && reportSig !== liveSig;
                    if (!stale) return null;
                    return (
                      <Alert status="warning" mb={3} borderRadius="md" alignItems="flex-start">
                        <AlertIcon mt={1} />
                        <Box flex="1">
                          <Text fontSize="sm" fontWeight="bold">
                            Design strategies have changed since this report was written.
                          </Text>
                          <Text fontSize="xs" color="gray.600" mt={1}>
                            The narrative below cites the previous strategy set.
                            Regenerate the report so its Section 4 matches the current
                            strategies on the Strategies tab.
                          </Text>
                        </Box>
                        <Button
                          size="xs"
                          colorScheme="orange"
                          variant="outline"
                          onClick={handleGenerateAiReport}
                          isLoading={isGeneratingAiReport}
                          loadingText="Regenerating..."
                          flexShrink={0}
                        >
                          Regenerate
                        </Button>
                      </Alert>
                    );
                  })()}
                  <Box maxH="70vh" overflowY="auto" p={4} bg="white" borderRadius="md" border="1px solid" borderColor="gray.100">
                    {renderMarkdown(aiReport)}
                  </Box>
                </CardBody>
              )}
            </Card>
          )}

          {/* Main Tabs */}
          <Tabs colorScheme="blue" variant="enclosed" mb={6}>
            <TabList>
              <Tab>Analysis</Tab>
              {hasAnalysis && <Tab>Design Strategies {stage3Failed && <Badge colorScheme="red" ml={1} fontSize="2xs">failed</Badge>}</Tab>}
              <Tab>Indicators</Tab>
            </TabList>

            <TabPanels>
              {/* ── Tab: Analysis (5-panel narrative — PDF #7) ── */}
              <TabPanel px={0}>
                {/* #2 — pipeline-running gate. While the pipeline is in flight
                    for THIS project, suppress the analysis grid entirely and
                    surface a single progress card. Stale results from a
                    previous run stay hidden behind it. */}
                {isPipelineRunningHere ? (
                  <PipelineRunningCard
                    projectName={pipelineRun.projectName}
                    imageProgress={pipelineRun.imageProgress}
                    steps={pipelineRun.steps}
                  />
                ) : zonesChangedAfterPipeline ? (
                  // v4 / Module 14 — stale-analysis banner. The project's
                  // zone count no longer matches what the cached analysis
                  // was computed against. Hide both entry gates and force
                  // a re-run so the user doesn't end up on the wrong
                  // path (e.g. seeing single-zone Options A/B/C while
                  // their project actually has 2+ zones).
                  <Card mb={4} borderColor="orange.300" borderWidth="2px">
                    <CardBody>
                      <VStack align="stretch" spacing={4}>
                        <HStack spacing={3} align="start">
                          <AlertTriangle size={24} color="#DD6B20" />
                          <Box flex="1">
                            <Heading size="sm" mb={1}>
                              The cached analysis no longer matches your project
                            </Heading>
                            <Text fontSize="sm" color="gray.700">
                              Your project currently has{' '}
                              <Text as="span" fontWeight="bold">{userZoneCount} zone{userZoneCount === 1 ? '' : 's'}</Text>,
                              but the saved analysis was computed against{' '}
                              <Text as="span" fontWeight="bold">
                                {chartCtx.analysisMode === 'image_level' ? 'a single zone' : 'multiple zones'}
                              </Text>
                              . Charts, design strategies, and the AI Report from that
                              run would describe the wrong set of zones.
                            </Text>
                            <Text fontSize="sm" color="gray.700" mt={2}>
                              Re-run the pipeline to refresh everything against the
                              current zones, then come back here.
                            </Text>
                          </Box>
                        </HStack>
                        <HStack>
                          <Button
                            colorScheme="orange"
                            leftIcon={<RefreshCw size={16} />}
                            onClick={() => routeProjectId && navigate(`/projects/${routeProjectId}/analysis`)}
                            isDisabled={!routeProjectId}
                          >
                            Re-run pipeline
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => routeProjectId && navigate(`/projects/${routeProjectId}/edit`)}
                            isDisabled={!routeProjectId}
                          >
                            Edit zones
                          </Button>
                        </HStack>
                      </VStack>
                    </CardBody>
                  </Card>
                ) : singleZoneGated ? (
                  // v4 / Module 1 — three-card branching: Add zone /
                  // Single View / Dual View. Charts render only after the
                  // user picks Single View or Dual View.
                  <SingleZoneEntryGate
                    projectId={routeProjectId ?? null}
                    zoneCount={userZoneCount}
                    imageCount={chartCtx.imageRecords.length}
                    onPickViewOnly={() => {
                      setSingleZoneStrategy('view_only');
                      // v4 polish — no auto-fire. Strategies + AI report
                      // generate only when user clicks Generate AI Report.
                    }}
                    onPickCluster={handleRunClustering}
                    isClusteringRunning={clusteringMutation.isPending}
                    canRunClustering={!!currentProject || !!routeProjectId}
                  />
                ) : multiZoneGated ? (
                  // v4 / Module 1 (multi-zone) — two-card branching:
                  // Zone-only or Within-zone HDBSCAN. Picking either fires
                  // strategies generation immediately.
                  <MultiZoneEntryGate
                    zoneCount={userZoneCount}
                    imageCount={chartCtx.imageRecords.length}
                    onPickZoneOnly={() => {
                      setMultiZoneStrategy('zone_only');
                      // v4 polish — no auto-fire. Strategies + AI report
                      // generate only when user clicks Generate AI Report.
                    }}
                    onPickWithinZoneCluster={handleRunWithinZoneClustering}
                    isClusteringRunning={withinZoneClusteringMutation.isPending}
                    canRunClustering={!!currentProject || !!routeProjectId}
                  />
                ) : (
                  <>
                {/* v4 / Module 1 — Single View upgrade banner removed:
                    duplicated with the existing Single-Zone Mode banner
                    surfaced by the chart grid below. */}
                {/* v4 / Phase C — view selector. Two layouts depending on
                    whether the project has within-zone clustering active:
                      • Legacy (single-zone Option C, multi-zone zone-only):
                        binary "Zones | Clusters" toggle.
                      • Within-zone clustering: primary toggle "Parent zones |
                        Sub-clusters" + secondary chip row (Drill into a zone)
                        when Sub-clusters is active.
                    Driven entirely by analysisViewsByViewId so the same
                    component handles future view variants without changes. */}
                {groupingToggleAvailable && (() => {
                  const views = analysisViewsByViewId;
                  const hasParentZones = !!views.parent_zones;
                  const hasAllSubClusters = !!views.all_sub_clusters;
                  const isWithinZoneMode = hasParentZones && hasAllSubClusters;
                  const drillViewIds = Object.keys(views).filter((v) => v.startsWith('within_zone:'));
                  const isOnDrillView = activeViewId.startsWith('within_zone:');
                  const isOnSubClusterView = activeViewId === 'all_sub_clusters' || isOnDrillView;
                  const userZones = currentProject?.spatial_zones ?? [];
                  const zoneNameById = (zid: string) =>
                    userZones.find((z) => z.zone_id === zid)?.zone_name || zid;
                  // For multi-zone projects in plain zone-only mode (no
                  // within-zone clustering yet), the binary toggle would
                  // collapse to a single "Zone view" button — pooled
                  // clustering is disabled for multi-zone, so there's no
                  // second option to switch to. Hide the entire selector
                  // in that case; the chart grid already implicitly shows
                  // "you're looking at zones" via section headers.
                  const noOptionsToToggle = !isWithinZoneMode && userZoneCount >= 2;
                  if (noOptionsToToggle) return null;
                  return (
                    <VStack mb={4} spacing={2} align="stretch">
                      <HStack spacing={0} align="center">
                        <Text fontSize="xs" fontWeight="bold" color="gray.600" mr={3}>
                          View:
                        </Text>
                        {isWithinZoneMode ? (
                          <>
                            <Button
                              size="sm"
                              variant={activeViewId === 'parent_zones' ? 'solid' : 'outline'}
                              colorScheme="blue"
                              borderRightRadius={0}
                              onClick={() => handleSwitchView('parent_zones')}
                            >
                              Parent zones ({views.parent_zones?.zone_diagnostics?.length ?? 0})
                            </Button>
                            <Button
                              size="sm"
                              variant={isOnSubClusterView ? 'solid' : 'outline'}
                              colorScheme="blue"
                              borderLeftRadius={0}
                              onClick={() => handleSwitchView('all_sub_clusters')}
                            >
                              Sub-clusters ({views.all_sub_clusters?.zone_diagnostics?.length ?? 0})
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant={groupingMode === 'zones' ? 'solid' : 'outline'}
                              colorScheme="blue"
                              borderRightRadius={userZoneCount >= 2 ? undefined : 0}
                              onClick={() => handleSwitchView('zones')}
                            >
                              Zone view ({(userZoneAnalysisResult ?? zoneAnalysisResult)?.zone_diagnostics?.length ?? 0})
                            </Button>
                            {/* v4 polish — global "Cluster view" is single-zone
                                only. For multi-zone projects (userZoneCount ≥ 2),
                                clustering must respect the user's zone definition,
                                which means within-zone HDBSCAN, not pooled
                                clustering across all images. The within-zone
                                path is reached through the entry gate (Run
                                Within-Zone Clustering button), not this toggle.
                                Surfacing a "Cluster view" toggle here would
                                offer pooled clustering that ignores zones —
                                semantically wrong for a multi-zone project,
                                because it overwrites the spatial structure the
                                user just defined. */}
                            {userZoneCount < 2 && (
                              <Button
                                size="sm"
                                variant={groupingMode === 'clusters' ? 'solid' : 'outline'}
                                colorScheme="blue"
                                borderLeftRadius={0}
                                onClick={() => handleSwitchView('clusters')}
                              >
                                Cluster view {clusterAnalysisResult ? `(${clusterAnalysisResult.zone_diagnostics?.length ?? 0})` : '(not run)'}
                              </Button>
                            )}
                          </>
                        )}
                      </HStack>
                      {/* Secondary chip row — Sub-clusters → drill into a
                          specific parent zone. Only renders for
                          within-zone-clustering projects when the user is
                          currently on the Sub-clusters branch. */}
                      {isWithinZoneMode && isOnSubClusterView && drillViewIds.length > 0 && (
                        <HStack spacing={1} flexWrap="wrap" align="center">
                          <Text fontSize="2xs" color="gray.500" mr={1}>
                            Showing:
                          </Text>
                          <Button
                            size="xs"
                            variant={activeViewId === 'all_sub_clusters' ? 'solid' : 'outline'}
                            colorScheme="purple"
                            onClick={() => handleSwitchView('all_sub_clusters')}
                          >
                            All zones flat
                          </Button>
                          {drillViewIds.map((viewId) => {
                            const zoneId = viewId.slice('within_zone:'.length);
                            const subCount = views[viewId]?.zone_diagnostics?.length ?? 0;
                            return (
                              <Button
                                key={viewId}
                                size="xs"
                                variant={activeViewId === viewId ? 'solid' : 'outline'}
                                colorScheme="purple"
                                onClick={() => handleSwitchView(viewId)}
                              >
                                {zoneNameById(zoneId)} ({subCount})
                              </Button>
                            );
                          })}
                        </HStack>
                      )}
                    </VStack>
                  );
                })()}

                {/* #1 acceptance — guidance when Cluster view selected
                    without clustering having been run. */}
                {wantsClusterButMissing && (
                  <ClusterEmptyHint
                    onRunClustering={handleRunClustering}
                    isClusteringRunning={clusteringMutation.isPending}
                    canRunClustering={!!currentProject}
                  />
                )}

                {/* Single-zone / image-level mode banner.
                    v4 polish — hidden once the user has explicitly chosen a
                    path at the entry gate (Single View, Dual View, or
                    cluster-derived). Repeating "this is single-zone, add
                    another zone" after they've already picked Single View
                    is just noise. The banner stays only for the unusual
                    case where the project is image-level but no entry-gate
                    pick has been made (e.g., legacy projects loaded
                    without the gate firing). */}
                {singleZoneStrategy === null && !isClusterDerived && (
                  <ModeAlert
                    analysisMode={chartCtx.analysisMode}
                    zoneSource={chartCtx.zoneSource}
                    projectId={routeProjectId ?? null}
                    zoneCount={
                      currentProject?.spatial_zones?.length ?? sortedDiagnostics.length
                    }
                    imageCount={chartCtx.imageRecords.length}
                    onRunClustering={handleRunClustering}
                    isClusteringRunning={clusteringMutation.isPending}
                    canRunClustering={!!currentProject}
                    hideClusteringButton={clusteringLocked}
                  />
                )}

                {/* v4 polish — N=2 / K=2 degenerate-grouping banner.
                    Same condition that drives DEGENERATE_AT_N2_CHART_IDS
                    filter above (isDegenerateN2Grouping). Covers both:
                      - N=2 user zones (zoneSource='user') → CTA points at
                        within-zone clustering, which produces multiple
                        sub-clusters per zone and escapes N=2 entirely.
                      - K=2 clusters (zoneSource='cluster') → "Run
                        clustering" CTA hidden because re-running with the
                        same data tends to land on K=2 again. The user's
                        only real path forward is to add zones / images.

                    Auto-dismissed when:
                      - User adds a 3rd zone → backend invalidates analysis
                        → re-run pipeline → N≥3, banner gone
                      - User runs within-zone clustering → switches to a
                        view with K≥3 sub-clusters → condition no longer
                        holds. */}
                {isDegenerateN2Grouping && !zonesChangedAfterPipeline && (
                  <ModeAlert
                    analysisMode={chartCtx.analysisMode}
                    zoneSource={chartCtx.zoneSource}
                    projectId={routeProjectId ?? null}
                    zoneCount={chartCtx.sortedDiagnostics.length}
                    imageCount={chartCtx.imageRecords.length}
                    onRunClustering={handleRunWithinZoneClustering}
                    isClusteringRunning={withinZoneClusteringMutation.isPending}
                    canRunClustering={!!currentProject}
                    hideClusteringButton={isClusterDerived}
                    showDegenerateNTwoWarning
                  />
                )}

                {/* Data Quality summary — surfaces report warning + key metrics */}
                <DataQualitySummary
                  ctx={chartCtx}
                  reportWarning={
                    (aiReportMeta?.data_quality_warning as string | undefined) ?? null
                  }
                />

                {/* Loading progress — kept as a thin status strip; the
                    primary loading UX now comes from the Skeleton overlay
                    over the chart grid (see #2). */}
                {!allChartsReady && (
                  <ChartLoadingProgress
                    total={eagerChartIds.length}
                    mounted={mountedChartIds.size}
                    interpretationsTotal={interpretationsCounts.total}
                    interpretationsMounted={interpretationsCounts.done}
                  />
                )}

                {/* Computation warnings.
                    v4 / Module 1: filter out the "Only 1 zone" cross-zone
                    z-score warning when the user explicitly picked Single
                    View. They already chose this path at the entry gate, so
                    repeating "z-scores are undefined, add more zones"
                    underneath is just noise. We keep all other warnings. */}
                {(() => {
                  const allWarnings =
                    zoneAnalysisResult?.computation_metadata?.warnings ?? [];
                  const filteredWarnings =
                    singleZoneStrategy === 'view_only'
                      ? allWarnings.filter(
                          w =>
                            !/only\s+1\s+zone/i.test(w) &&
                            !/cross-zone\s+z-scores?\s+are\s+undefined/i.test(w),
                        )
                      : allWarnings;
                  if (filteredWarnings.length === 0) return null;
                  return (
                  <Alert status="warning" mb={4} borderRadius="md" alignItems="flex-start">
                    <AlertIcon />
                    <Box>
                      <Text fontWeight="bold" fontSize="sm">Analysis warnings</Text>
                      <VStack align="stretch" spacing={0} mt={1}>
                        {filteredWarnings.map((w, i) => (
                          <Text key={i} fontSize="xs" color="gray.700">• {w}</Text>
                        ))}
                      </VStack>
                    </Box>
                  </Alert>
                  );
                })()}

                {/* v4 / Module 1 — chart-grid gate. Originally required at
                    least one zone diagnostic, which made sense in zone-level
                    mode but unintentionally hid every single-zone chart
                    (A1/A2 setup, C1-C4 distribution + spatial, D1 global
                    stats) for image_level projects. After Single View was
                    introduced, those charts MUST render even when
                    sortedDiagnostics is empty — they're the whole point of
                    Single View. We now allow the grid to render whenever we
                    have either zone diagnostics OR image-level records. */}
                {(sortedDiagnostics.length > 0 || chartCtx.imageRecords.length > 0)
                  && !wantsClusterButMissing && (
                  <Box position="relative">
                  {/* Skeleton overlay — covers the chart grid until every
                      eagerly-mounted chart has fired onMount (deferred to
                      double-rAF so SVG/Canvas paint completes), so the user
                      sees one synchronous reveal instead of a progressive
                      drip-feed of cards. v4 polish — added a top header
                      with spinner + progress so the user knows the page is
                      working, not frozen. */}
                  {!allChartsReady && (
                    <Box
                      position="absolute"
                      inset={0}
                      zIndex={2}
                      bg="white"
                      borderRadius="md"
                      p={4}
                    >
                      <HStack spacing={3} mb={4} p={3} bg="blue.50" borderRadius="md" borderWidth={1} borderColor="blue.200">
                        <Spinner size="sm" color="blue.500" />
                        <Box flex={1}>
                          <Text fontSize="sm" fontWeight="bold" color="blue.800">
                            Rendering charts… {mountedChartIds.size} / {eagerChartIds.length}
                          </Text>
                          <Text fontSize="xs" color="blue.700">
                            Building all charts so they appear together. This usually takes a few seconds for projects with hundreds of images.
                          </Text>
                        </Box>
                      </HStack>
                      <VStack spacing={4} align="stretch">
                        <Skeleton height="120px" borderRadius="md" />
                        <Skeleton height="240px" borderRadius="md" />
                        <Skeleton height="200px" borderRadius="md" />
                        <Skeleton height="200px" borderRadius="md" />
                      </VStack>
                    </Box>
                  )}
                  <VStack
                    spacing={6}
                    align="stretch"
                    style={{ visibility: allChartsReady ? 'visible' : 'hidden' }}
                  >
                    {/* Zone Cards — driven by useGroupingUnits so the same
                        layout works for zone-mode and cluster-mode views. */}
                    {/* Issue 1 polish — the |z| values shown here are
                        re-computed against THIS view's set of grouping
                        units. The same sub-cluster therefore has different
                        |z| in 'all_sub_clusters' vs 'within_zone:zone_X'
                        because the baseline (mean and std) is different.
                        Surface a small info banner so users don't think
                        it's a bug. */}
                    {groupingUnits.length > 0 && (
                      <Tooltip
                        label="Each |z| value is the mean absolute z-score across all indicators for this unit, computed against the baseline (mean and std) of the OTHER units in this same view. Switching views (e.g. between Parent zones, All sub-clusters, and a single zone's drill-down) changes that baseline, so the same sub-cluster will show different |z| values across views — that's expected, not a bug."
                        placement="top"
                        hasArrow
                        openDelay={200}
                        maxW="380px"
                      >
                        <HStack
                          mb={1}
                          px={2}
                          py={1}
                          spacing={2}
                          borderWidth={1}
                          borderColor="gray.200"
                          borderRadius="md"
                          bg="gray.50"
                          fontSize="xs"
                          color="gray.600"
                          cursor="help"
                          w="fit-content"
                        >
                          <Icon as={AlertTriangle} boxSize={3} color="gray.500" />
                          <Text>
                            <Text as="span" fontWeight="semibold">|z|</Text> values are computed against THIS view's baseline —
                            hover for details on why the same unit can show different |z| across views.
                          </Text>
                        </HStack>
                      </Tooltip>
                    )}
                    <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing={4}>
                      {groupingUnits.map((u) => (
                        <Card key={u.id} bg={u.bg}>
                          <CardBody>
                            <VStack align="stretch" spacing={2}>
                              <HStack justify="space-between">
                                <HStack spacing={1}>
                                  {u.rank > 0 && <Badge colorScheme="purple" fontSize="xs">#{u.rank}</Badge>}
                                  {/* Tooltip on hover — full unit name when
                                      noOfLines={1} truncates it. */}
                                  <Tooltip label={u.name} placement="top" hasArrow openDelay={300}>
                                    <Text fontWeight="bold" fontSize="sm" noOfLines={1} cursor="default">{u.name}</Text>
                                  </Tooltip>
                                </HStack>
                                <Badge colorScheme={u.colorScheme}>|z|={u.meanAbsZ?.toFixed(2) ?? '—'}</Badge>
                              </HStack>
                              <HStack justify="space-between"><Text fontSize="xs" color="gray.600">Mean |z|</Text><Text fontWeight="bold">{u.meanAbsZ?.toFixed(2) ?? '—'}</Text></HStack>
                              <HStack justify="space-between"><Text fontSize="xs" color="gray.600">Points</Text><Text fontWeight="bold">{u.pointCount}</Text></HStack>
                            </VStack>
                          </CardBody>
                        </Card>
                      ))}
                    </SimpleGrid>

                    {/* Clusters block — hoisted above the section narrative
                        in cluster view so the user reads "what these
                        clusters are" before per-cluster findings (B),
                        per-indicator drill-down (C), and reference tables
                        (D). Hidden in zone view + when clusteringLocked. */}
                    {groupingMode === 'clusters' && !!clusterAnalysisResult && !clusteringLocked && (
                    <Accordion allowToggle defaultIndex={[0]} index={exporting ? [0] : undefined}>
                      <AccordionItem border="1px solid" borderColor="teal.200" borderRadius="md">
                        <AccordionButton bg="teal.50" _hover={{ bg: 'teal.100' }}>
                          <Box flex="1" textAlign="left">
                            <HStack spacing={2}>
                              <Text fontWeight="bold" fontSize="sm">Clusters</Text>
                              {clusteringResult?.clustering && (
                                <Badge colorScheme="green" fontSize="2xs">
                                  k={clusteringResult.clustering.k} · silhouette={clusteringResult.clustering.silhouette_score.toFixed(2)}
                                </Badge>
                              )}
                              {clusteringResult?.skipped && (
                                <Badge colorScheme="yellow" fontSize="2xs">{clusteringResult.reason}</Badge>
                              )}
                            </HStack>
                            <Text fontSize="xs" color="gray.600" mt={0.5}>
                              Density-based clusters (HDBSCAN) discovered from per-image indicator values. Each cluster groups images that share a similar visual signature.
                            </Text>
                          </Box>
                          <AccordionIcon />
                        </AccordionButton>
                        <AccordionPanel pb={4}>
                          <VStack align="stretch" spacing={4}>
                            <HStack justify="flex-end">
                              <Button
                                size="sm"
                                colorScheme="teal"
                                variant="outline"
                                onClick={handleRunClustering}
                                isLoading={clusteringMutation.isPending}
                                isDisabled={!currentProject}
                              >
                                {clusteringResult?.clustering ? 'Re-run clustering' : 'Run clustering'}
                              </Button>
                            </HStack>
                            {clusteringResult?.clustering && clusteringResult.clustering.archetype_profiles.length > 0 && (
                              <Wrap spacing={2}>
                                {clusteringResult.clustering.archetype_profiles.map(a => (
                                  <WrapItem key={a.archetype_id}>
                                    <Tag size="sm" colorScheme="teal" variant="subtle">
                                      <TagLabel>Cluster {a.archetype_id}: {a.archetype_label} ({a.point_count} pts)</TagLabel>
                                    </Tag>
                                  </WrapItem>
                                ))}
                              </Wrap>
                            )}
                            {clusteringCharts.map(chart => (
                              <ChartHost
                                key={chart.id}
                                ref={setChartRef(chart.id)}
                                descriptor={chart}
                                ctx={chartCtx}
                                onHide={toggleChart}
                                projectId={routeProjectId ?? null}
                                projectContext={chartProjectContext}
                                showAiSummary={showAiSummary}
                                forceMount
                                onMount={handleChartMount}
                                projectSlug={currentProject?.project_name ?? null}
                              />
                            ))}
                          </VStack>
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                    )}

                    {/* 5-panel narrative (PDF #7). Setup (A) and Reference
                        Tables (D) are folded by default; Zone Findings (B) and
                        Indicator Drill-Down (C) render expanded. Clustering (E)
                        is hoisted above this loop in cluster view. */}
                    {SECTION_ORDER.filter(s => s !== 'clustering').map(section => {
                      const charts = sectionedCharts[section] ?? [];
                      if (charts.length === 0) return null;
                      const visibleCount = charts.filter(c => c.isAvailable(chartCtx)).length;
                      if (visibleCount === 0) return null;
                      const meta = SECTION_META[section];
                      const chartList = (
                        <VStack spacing={4} align="stretch">
                          {charts.map(chart => (
                            <ChartHost
                              key={chart.id}
                              ref={setChartRef(chart.id)}
                              descriptor={chart}
                              ctx={chartCtx}
                              onHide={toggleChart}
                              projectId={routeProjectId ?? null}
                              projectContext={chartProjectContext}
                              showAiSummary={showAiSummary}
                              forceMount
                              onMount={handleChartMount}
                              projectSlug={currentProject?.project_name ?? null}
                            />
                          ))}
                        </VStack>
                      );

                      if (meta.defaultCollapsed) {
                        return (
                          <Accordion
                            key={section}
                            allowToggle
                            index={exporting ? [0] : undefined}
                          >
                            <AccordionItem border="1px solid" borderColor="gray.200" borderRadius="md">
                              <AccordionButton bg="gray.50" _hover={{ bg: 'gray.100' }}>
                                <Box flex="1" textAlign="left">
                                  <Text fontWeight="bold" fontSize="sm" color="gray.700">
                                    {meta.title}
                                  </Text>
                                  <Text fontSize="xs" color="gray.500" mt={0.5}>
                                    {meta.subtitle}
                                  </Text>
                                </Box>
                                <AccordionIcon />
                              </AccordionButton>
                              <AccordionPanel pb={4}>{chartList}</AccordionPanel>
                            </AccordionItem>
                          </Accordion>
                        );
                      }

                      return (
                        <Box key={section}>
                          <SectionHeading section={section} groupingMode={groupingMode} />
                          {chartList}
                        </Box>
                      );
                    })}

                    {/* GPS coverage hint — shown when no spatial charts rendered */}
                    {chartCtx.gpsImages.length === 0 && (
                      <Alert status="info" borderRadius="md" variant="left-accent">
                        <AlertIcon />
                        <Box>
                          <Text fontSize="sm" fontWeight="bold">Spatial Distribution Charts unavailable</Text>
                          <Text fontSize="xs" color="gray.600">
                            None of the images have GPS coordinates (EXIF lat/lng). Spatial scatter maps require at least a few geo-located images — they don't need 100% coverage.
                            If some images have GPS, they will appear automatically.
                          </Text>
                        </Box>
                      </Alert>
                    )}

                    {/* Clusters block has been hoisted ABOVE the sectioned
                        chart loop so it appears between the zone-card
                        summary row and Section A/B/C/D in cluster view —
                        matches user expectation that "what these clusters
                        are" reads first, then per-cluster findings (B),
                        per-indicator drill-down (C), tables (D). The
                        original render position here is intentionally
                        empty. */}
                  </VStack>
                  </Box>
                )}
                  </>
                )}
              </TabPanel>

              {/* ── Tab: Design Strategies ── */}
              {hasAnalysis && (
                <TabPanel px={0}>
                  {/* v4 / Module 14 — view-mode hint. Strategies are stored
                      per-view (zones / clusters), so toggling the segmented
                      control above swaps which set is shown. The hint banner
                      mirrors the AI Report card's grouping_mode banner so
                      users have one consistent mental model: every Reports
                      artifact (charts, strategies, AI report) follows the
                      active view. The "other view available" Badge tells the
                      user when a flip back would surface a different cached
                      result — preventing the surprise of "where did my old
                      strategies go?" after toggling. */}
                  {hasDesign && designStrategyResult && (() => {
                    // v4 / Phase C — view-aware strategies hint. Lists
                    // every OTHER view that has cached strategies so the
                    // user knows toggling the segmented control surfaces
                    // a different cached set rather than blank state.
                    const cachedOtherViews = Object.entries(designStrategyResultsByViewId)
                      .filter(([vid, res]) =>
                        vid !== activeViewId
                        && res
                        && Object.keys(res.zones || {}).length > 0,
                      )
                      .map(([vid]) => vid);
                    const friendlyName = (viewId: string): string => {
                      if (viewId === 'zones') return 'Zones';
                      if (viewId === 'clusters') return 'Clusters';
                      if (viewId === 'parent_zones') return 'Parent zones';
                      if (viewId === 'all_sub_clusters') return 'All sub-clusters';
                      if (viewId.startsWith('within_zone:')) {
                        const zid = viewId.slice('within_zone:'.length);
                        const zname = currentProject?.spatial_zones?.find((z) => z.zone_id === zid)?.zone_name || zid;
                        return `${zname} (sub-clusters)`;
                      }
                      return viewId;
                    };
                    return (
                      <HStack mb={3} px={2} py={1.5} bg="purple.50" borderRadius="md" borderWidth={1} borderColor="purple.200" spacing={2} flexWrap="wrap">
                        <Text fontSize="xs" color="purple.700">
                          Showing strategies for the
                        </Text>
                        <Badge colorScheme="purple" variant="solid" fontSize="2xs">
                          {friendlyName(activeViewId)} view
                        </Badge>
                        {cachedOtherViews.length > 0 && (
                          <>
                            <Text fontSize="xs" color="gray.500">·</Text>
                            <Text fontSize="xs" color="gray.600">
                              Cached strategies also for{' '}
                              {cachedOtherViews
                                .map(friendlyName)
                                .join(', ')}{' '}
                              — toggle the view selector above to swap.
                            </Text>
                          </>
                        )}
                      </HStack>
                    );
                  })()}
                  {/* Stage 3 failed / missing — informational only.
                      v4 / Module 14 — the standalone "Generate Strategies"
                      / "Retry Stage 3" button used to live here, but that
                      created a parallel code path to the AI Report card's
                      Generate button. Two buttons writing to the same
                      strategies slot from two different handlers (one
                      direct mutation, one SSE stream) is a sync hazard:
                      a user double-clicking would race two LLM calls and
                      overwrite each other, and the strategy_signature on
                      the AI Report could end up pointing to a strategy
                      set the user can't see. Keeping the alert as a
                      pointer so the user knows where to go: the AI Report
                      card on top of the page is the single entry point. */}
                  {(stage3Failed || !hasDesign) && (
                    <Alert status={stage3Failed ? 'error' : 'info'} mb={4} borderRadius="md" alignItems="flex-start">
                      <AlertIcon mt={0.5} />
                      <Box flex="1">
                        <Text fontWeight="bold" fontSize="sm">
                          {stage3Failed ? 'Design strategy generation failed' : 'No design strategies yet'}
                        </Text>
                        {stage3Error && <Text fontSize="xs" color="gray.600" mt={1}>{stage3Error}</Text>}
                        <Text fontSize="xs" color="gray.700" mt={1}>
                          Strategies are generated together with the AI Report.
                          Scroll up to the
                          {' '}<Text as="span" fontWeight="semibold">AI Report</Text>{' '}
                          card and click
                          {' '}<Text as="span" fontWeight="semibold">
                            {hasDesign ? 'Regenerate Strategies + AI Report' : 'Generate Strategies + AI Report'}
                          </Text>{' '}
                          — that one button runs both stages.
                        </Text>
                      </Box>
                    </Alert>
                  )}

                  {/* v4 / Module 9.3.5 — Source data snapshot folding panel.
                      Surfaces the "what data was this strategy generated against"
                      metadata so reviewers can audit consistency between the
                      strategies, the active grouping mode, and the chart-summary
                      cache. Hidden when no strategies have been generated. */}
                  {hasDesign && designStrategyResult && (
                    <Accordion allowToggle mb={3}>
                      <AccordionItem border="1px solid" borderColor="gray.200" borderRadius="md">
                        <AccordionButton bg="gray.50" _hover={{ bg: 'gray.100' }}>
                          <Box flex="1" textAlign="left">
                            <Text fontSize="sm" fontWeight="bold" color="gray.700">
                              Source data snapshot
                            </Text>
                            <Text fontSize="xs" color="gray.500" mt={0.5}>
                              How and against what these strategies were generated.
                            </Text>
                          </Box>
                          <AccordionIcon />
                        </AccordionButton>
                        <AccordionPanel pb={4}>
                          {(() => {
                            const meta = designStrategyResult.metadata as Record<string, unknown> | undefined;
                            const diagSource = String(meta?.diagnosis_source ?? '—');
                            const diagMode = String(meta?.diagnosis_mode ?? '—');
                            const totalZones = String(meta?.total_zones ?? '—');
                            const totalStrategies = String(meta?.total_strategies ?? '—');
                            const totalIomMatches = String(meta?.total_iom_matches ?? '—');
                            const stage2Mode = chartCtx.zoneSource === 'cluster' || !!clusterAnalysisResult ? 'cluster' : 'zones';
                            const aiReportMode = aiReportMeta?.grouping_mode != null ? String(aiReportMeta.grouping_mode) : '—';
                            const consistent = diagSource === 'segments' ? stage2Mode === 'cluster' : diagSource === 'zones' ? stage2Mode === 'zones' : true;
                            const summaryQueries = queryClient
                              .getQueryCache()
                              .findAll({ queryKey: ['chart-summary'] })
                              .filter((q) => (q.queryKey as unknown[])[2] === routeProjectId);
                            const totalSummaries = summaryQueries.length;
                            const summariesDone = summaryQueries.filter((q) => q.state.status === 'success').length;
                            return (
                              <VStack align="stretch" spacing={2} fontSize="xs">
                                <SimpleGrid columns={{ base: 1, md: 2 }} spacing={2}>
                                  <HStack><Text fontWeight="bold" w="180px">Diagnosis source:</Text><Badge>{diagSource}</Badge></HStack>
                                  <HStack><Text fontWeight="bold" w="180px">Diagnosis mode:</Text><Badge colorScheme={diagMode === 'LLM' ? 'purple' : 'gray'}>{diagMode}</Badge></HStack>
                                  <HStack><Text fontWeight="bold" w="180px">Stage-2 active mode:</Text><Badge colorScheme={stage2Mode === 'cluster' ? 'teal' : 'blue'}>{stage2Mode}</Badge></HStack>
                                  <HStack><Text fontWeight="bold" w="180px">AI report grouping:</Text><Badge>{aiReportMode}</Badge></HStack>
                                  <HStack><Text fontWeight="bold" w="180px">Total zones / archetypes:</Text><Text>{totalZones}</Text></HStack>
                                  <HStack><Text fontWeight="bold" w="180px">Total strategies:</Text><Text>{totalStrategies}</Text></HStack>
                                  <HStack><Text fontWeight="bold" w="180px">Total IOM matches:</Text><Text>{totalIomMatches}</Text></HStack>
                                  <HStack>
                                    <Text fontWeight="bold" w="180px">Chart summaries cached:</Text>
                                    <Text>{summariesDone}/{totalSummaries}</Text>
                                  </HStack>
                                </SimpleGrid>
                                <HStack mt={1} pt={2} borderTop="1px solid" borderColor="gray.100">
                                  <Text fontWeight="bold">Consistency:</Text>
                                  {consistent ? (
                                    <Badge colorScheme="green">aligned</Badge>
                                  ) : (
                                    <Badge colorScheme="red">mixed sources — strategies generated against {diagSource} but Stage-2 is showing {stage2Mode}</Badge>
                                  )}
                                </HStack>
                                {!consistent && (
                                  <Text fontSize="2xs" color="red.600">
                                    Click "Regenerate Strategies" or switch the segmented control back to {diagSource === 'segments' ? 'cluster' : 'zone'} view to bring them back in sync.
                                  </Text>
                                )}
                              </VStack>
                            );
                          })()}
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                  )}

                  {hasDesign && designStrategyResult && <Accordion allowMultiple defaultIndex={[0]}>
                    {Object.entries(designStrategyResult.zones).map(([zoneId, zone]: [string, ZoneDesignOutput]) => (
                      <AccordionItem key={zoneId}>
                        <AccordionButton>
                          <HStack flex="1" justify="space-between" pr={2}>
                            <HStack spacing={3}>
                              <Text fontWeight="bold">{zone.zone_name}</Text>
                              <Badge colorScheme={deviationColorScheme(zone.mean_abs_z)}>|z|={zone.mean_abs_z?.toFixed(2) ?? '—'}</Badge>
                            </HStack>
                            <Text fontSize="sm" color="gray.500">{zone.design_strategies.length} strategies</Text>
                          </HStack>
                          <AccordionIcon />
                        </AccordionButton>
                        <AccordionPanel>
                          <VStack align="stretch" spacing={4}>
                            {zone.overall_assessment && (
                              <Alert status="info" variant="left-accent"><AlertIcon /><Text fontSize="sm">{zone.overall_assessment}</Text></Alert>
                            )}

                            {zone.design_strategies.map((strategy, idx) => (
                              <Card key={idx} variant="outline">
                                <CardBody>
                                  <VStack align="stretch" spacing={3}>
                                    <HStack justify="space-between">
                                      <HStack spacing={2}>
                                        <Badge colorScheme="purple">P{strategy.priority}</Badge>
                                        <Text fontWeight="bold" fontSize="sm">{strategy.strategy_name}</Text>
                                      </HStack>
                                      <Badge colorScheme={strategy.confidence === 'High' ? 'green' : strategy.confidence === 'Medium' ? 'yellow' : 'gray'}>
                                        {strategy.confidence}
                                      </Badge>
                                    </HStack>

                                    <Wrap>{strategy.target_indicators.map(ind => <WrapItem key={ind}><Tag size="sm" colorScheme="blue"><TagLabel>{ind}</TagLabel></Tag></WrapItem>)}</Wrap>

                                    {strategy.spatial_location && (
                                      <Text fontSize="xs" color="gray.600"><Text as="span" fontWeight="bold">Location:</Text> {strategy.spatial_location}</Text>
                                    )}

                                    <Box bg="gray.50" p={3} borderRadius="md">
                                      <Text fontSize="xs" fontWeight="bold" mb={1}>Intervention</Text>
                                      <SimpleGrid columns={2} spacing={1} fontSize="xs">
                                        <Text><strong>Object:</strong> {strategy.intervention.object}</Text>
                                        <Text><strong>Action:</strong> {strategy.intervention.action}</Text>
                                        <Text><strong>Variable:</strong> {strategy.intervention.variable}</Text>
                                      </SimpleGrid>
                                      {strategy.intervention.specific_guidance && <Text fontSize="xs" mt={1} fontStyle="italic">{strategy.intervention.specific_guidance}</Text>}
                                    </Box>

                                    {strategy.signatures && strategy.signatures.length > 0 && (
                                      <Box>
                                        <Text fontSize="xs" fontWeight="bold" mb={1}>Signatures</Text>
                                        <Wrap>
                                          {strategy.signatures.slice(0, 4).map((sig, si) => (
                                            <WrapItem key={si}>
                                              <Tag size="sm" colorScheme="teal" variant="subtle">
                                                <TagLabel>{sig.operation?.name || '?'} x {sig.semantic_layer?.name || '?'} @ {sig.spatial_layer?.name || '?'} / {sig.morphological_layer?.name || '?'}</TagLabel>
                                              </Tag>
                                            </WrapItem>
                                          ))}
                                        </Wrap>
                                      </Box>
                                    )}

                                    {strategy.pathway?.mechanism_description && (
                                      <Text fontSize="xs" color="blue.600" fontStyle="italic">
                                        <Text as="span" fontWeight="bold">Pathway:</Text> {strategy.pathway.pathway_type?.name ? `(${strategy.pathway.pathway_type.name}) ` : ''}{strategy.pathway.mechanism_description}
                                      </Text>
                                    )}

                                    {strategy.expected_effects.length > 0 && (
                                      <Box>
                                        <Text fontSize="xs" fontWeight="bold" mb={1}>Expected Effects</Text>
                                        <Wrap>{strategy.expected_effects.map((eff, i) => <WrapItem key={i}><Tag size="sm" colorScheme={eff.direction === 'increase' ? 'green' : 'red'}><TagLabel>{eff.indicator} {eff.direction} ({eff.magnitude})</TagLabel></Tag></WrapItem>)}</Wrap>
                                      </Box>
                                    )}

                                    {strategy.potential_tradeoffs && <Text fontSize="xs" color="orange.600"><Text as="span" fontWeight="bold">Tradeoffs:</Text> {strategy.potential_tradeoffs}</Text>}
                                    {strategy.boundary_effects && <Text fontSize="xs" color="purple.600"><Text as="span" fontWeight="bold">Boundary Effects:</Text> {strategy.boundary_effects}</Text>}
                                    {strategy.implementation_guidance && (
                                      <Box bg="green.50" p={2} borderRadius="md">
                                        <Text fontSize="xs" fontWeight="bold" color="green.700" mb={1}>Implementation Guidance</Text>
                                        <Text fontSize="xs" color="green.800">{strategy.implementation_guidance}</Text>
                                      </Box>
                                    )}

                                    {strategy.supporting_ioms.length > 0 && (
                                      <Box>
                                        <Text fontSize="xs" fontWeight="bold" mb={1}>Supporting IOMs</Text>
                                        <Wrap>{strategy.supporting_ioms.map((iom, i) => <WrapItem key={i}><Tag size="sm" variant="outline" colorScheme="gray"><TagLabel>{iom}</TagLabel></Tag></WrapItem>)}</Wrap>
                                      </Box>
                                    )}

                                    {/* #3 — collapsible Evidence panel: per-indicator z-scores
                                        for THIS unit, plus fallback / retry flags from Agent A.
                                        The z-scores tell the user exactly what numerical
                                        signal motivated the strategy, so they can sanity-check
                                        the LLM's reasoning. */}
                                    <Accordion allowToggle>
                                      <AccordionItem border="none">
                                        <AccordionButton px={0} py={1} _hover={{ bg: 'transparent' }}>
                                          <Text fontSize="xs" color="gray.500" fontWeight="medium">
                                            Evidence
                                          </Text>
                                          <AccordionIcon ml={1} boxSize={4} color="gray.400" />
                                        </AccordionButton>
                                        <AccordionPanel px={0} py={2}>
                                          <VStack align="stretch" spacing={2} fontSize="xs">
                                            {(() => {
                                              const diag = zoneAnalysisResult?.zone_diagnostics?.find(
                                                (d) => d.zone_id === zoneId,
                                              );
                                              const rows = strategy.target_indicators
                                                .map((ind) => {
                                                  const layerData = diag?.indicator_status?.[ind] as
                                                    | Record<string, { value?: number | null; z_score?: number }>
                                                    | undefined;
                                                  const full = layerData?.full;
                                                  return {
                                                    ind,
                                                    value: full?.value ?? null,
                                                    z: full?.z_score ?? null,
                                                  };
                                                });
                                              return (
                                                <Box>
                                                  <Text fontWeight="bold" mb={1}>
                                                    Indicator deltas in {zone.zone_name}
                                                  </Text>
                                                  <SimpleGrid columns={3} spacingX={3} spacingY={1}>
                                                    <Text color="gray.500">Indicator</Text>
                                                    <Text color="gray.500" textAlign="right">value</Text>
                                                    <Text color="gray.500" textAlign="right">z-score</Text>
                                                    {rows.map((r) => (
                                                      <Box key={r.ind} display="contents">
                                                        <Text fontFamily="mono">{r.ind}</Text>
                                                        <Text textAlign="right">
                                                          {r.value != null ? Number(r.value).toFixed(3) : '—'}
                                                        </Text>
                                                        <Text
                                                          textAlign="right"
                                                          color={
                                                            r.z == null
                                                              ? 'gray.400'
                                                              : Math.abs(r.z) >= 1
                                                                ? 'red.500'
                                                                : 'gray.700'
                                                          }
                                                        >
                                                          {r.z != null ? Number(r.z).toFixed(2) : '—'}
                                                        </Text>
                                                      </Box>
                                                    ))}
                                                  </SimpleGrid>
                                                </Box>
                                              );
                                            })()}
                                            {(zone.diagnosis?.strategies_fallback_used ||
                                              zone.diagnosis?.strategies_retry_used) && (
                                              <HStack spacing={2} pt={1}>
                                                {!!zone.diagnosis?.strategies_retry_used && (
                                                  <Badge fontSize="2xs" colorScheme="yellow">LLM retried</Badge>
                                                )}
                                                {!!zone.diagnosis?.strategies_fallback_used && (
                                                  <Badge fontSize="2xs" colorScheme="orange">rule-based padding</Badge>
                                                )}
                                              </HStack>
                                            )}
                                            {zone.diagnosis?.integrated_diagnosis && (
                                              <Box pt={1}>
                                                <Text fontWeight="bold" mb={1}>Agent A diagnosis</Text>
                                                <Text color="gray.700" lineHeight="1.5">
                                                  {String(zone.diagnosis.integrated_diagnosis)}
                                                </Text>
                                              </Box>
                                            )}
                                          </VStack>
                                        </AccordionPanel>
                                      </AccordionItem>
                                    </Accordion>
                                  </VStack>
                                </CardBody>
                              </Card>
                            ))}

                            <Divider />
                            {zone.implementation_sequence && <Box><Text fontSize="xs" fontWeight="bold">Implementation Sequence</Text><Text fontSize="xs">{zone.implementation_sequence}</Text></Box>}
                            {zone.synergies && <Box><Text fontSize="xs" fontWeight="bold">Synergies</Text><Text fontSize="xs">{zone.synergies}</Text></Box>}
                          </VStack>
                        </AccordionPanel>
                      </AccordionItem>
                    ))}
                  </Accordion>}
                </TabPanel>
              )}

              {/* ── Tab: Indicators ── */}
              <TabPanel px={0}>
                <VStack spacing={6} align="stretch">
                  {recommendations.length > 0 && (
                    <Card>
                      <CardHeader>
                        <HStack justify="space-between">
                          <Heading size="sm">Recommended Indicators ({recommendations.length})</Heading>
                          <Badge colorScheme="blue">{selectedIndicators.length} selected</Badge>
                        </HStack>
                      </CardHeader>
                      <CardBody>
                        <Wrap spacing={3}>
                          {recommendations.map(rec => {
                            const selected = selectedIndicators.some(s => s.indicator_id === rec.indicator_id);
                            return (
                              <WrapItem key={rec.indicator_id}>
                                <Tag size="lg" colorScheme={selected ? 'green' : 'gray'} variant={selected ? 'solid' : 'outline'}>
                                  <TagLabel>{rec.indicator_id} {(rec.relevance_score * 100).toFixed(0)}%</TagLabel>
                                </Tag>
                              </WrapItem>
                            );
                          })}
                        </Wrap>
                      </CardBody>
                    </Card>
                  )}

                  {indicatorRelationships.length > 0 && (
                    <Card>
                      <CardHeader><Heading size="sm">Indicator Relationships</Heading></CardHeader>
                      <CardBody>
                        <VStack align="stretch" spacing={2}>
                          {indicatorRelationships.map((rel, i) => (
                            <HStack key={i} fontSize="sm" spacing={2}>
                              <Badge colorScheme={rel.relationship_type === 'synergistic' ? 'green' : rel.relationship_type === 'inverse' ? 'red' : 'gray'}>{rel.relationship_type}</Badge>
                              <Badge colorScheme="blue">{rel.indicator_b}</Badge>
                              {rel.explanation && <Text fontSize="xs" color="gray.500" noOfLines={1} flex={1}>{rel.explanation}</Text>}
                            </HStack>
                          ))}
                        </VStack>
                      </CardBody>
                    </Card>
                  )}

                  {recommendationSummary && (
                    <Card>
                      <CardHeader><Heading size="sm">Recommendation Summary</Heading></CardHeader>
                      <CardBody>
                        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
                          {recommendationSummary.key_findings.length > 0 && (
                            <Box>
                              <Text fontSize="sm" fontWeight="bold" mb={1}>Key Findings</Text>
                              <VStack align="stretch" spacing={1}>
                                {recommendationSummary.key_findings.map((f, i) => <Text key={i} fontSize="sm">&#x2713; {f}</Text>)}
                              </VStack>
                            </Box>
                          )}
                          {recommendationSummary.evidence_gaps.length > 0 && (
                            <Box>
                              <Text fontSize="sm" fontWeight="bold" mb={1}>Evidence Gaps</Text>
                              <VStack align="stretch" spacing={1}>
                                {recommendationSummary.evidence_gaps.map((g, i) => <Text key={i} fontSize="sm">&#x26A0; {g}</Text>)}
                              </VStack>
                            </Box>
                          )}
                        </SimpleGrid>
                      </CardBody>
                    </Card>
                  )}
                </VStack>
              </TabPanel>

            </TabPanels>
          </Tabs>
       