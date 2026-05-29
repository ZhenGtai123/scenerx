import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useSearchParams, useParams, Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Heading,
  Button,
  VStack,
  HStack,
  Checkbox,
  CheckboxGroup,
  SimpleGrid,
  Card,
  CardHeader,
  CardBody,
  Image,
  Text,
  Badge,
  Progress,
  Alert,
  AlertIcon,
  Switch,
  FormControl,
  FormLabel,
  FormHelperText,
  Spinner,
  Accordion,
  AccordionItem,
  AccordionButton,
  AccordionPanel,
  AccordionIcon,
  Divider,
  List,
  ListItem,
  Wrap,
  WrapItem,
  AlertDialog,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogOverlay,
  CloseButton,
} from '@chakra-ui/react';
import { Grid as VirtualGrid } from 'react-window';
import { ScanSearch, Download, Eye, Archive, Lightbulb } from 'lucide-react';
import JSZip from 'jszip';
import { useSemanticConfig, useProject, useRecommendIndicators, useCalculators, useVisionHealth } from '../hooks/useApi';
import type { RecommendStage } from '../hooks/useApi';
import api from '../api';
import { ErrorBoundary } from '../components/ErrorBoundary';
import type { SemanticClass, UploadedImage, IndicatorRecommendation } from '../types';
import PageShell from '../components/PageShell';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import useAppToast from '../hooks/useAppToast';
import useAppStore from '../store/useAppStore';
import { thumbnailUrl } from '../components/ImageTile';

const DIMENSIONS = [
  { id: 'PRF_AES', name: 'Aesthetics' },
  { id: 'PRF_RST', name: 'Restoration' },
  { id: 'PRF_EMO', name: 'Emotion' },
  { id: 'PRF_THR', name: 'Thermal' },
  { id: 'PRF_USE', name: 'Spatial Use' },
  { id: 'PRF_SOC', name: 'Social' },
];

/* ── Memoized sub-components ─────────────────────────────────────── */

/** Single image tile in the "Project Images" selection grid. */
const VisionImageTile = memo(function VisionImageTile({
  projectId,
  imageId,
  selected,
  onToggle,
}: {
  projectId: string;
  imageId: string;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); io.disconnect(); } },
      { rootMargin: '100px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Box
      ref={ref}
      position="relative"
      cursor="pointer"
      onClick={() => onToggle(imageId)}
      opacity={selected ? 1 : 0.5}
      border={selected ? '2px solid' : '2px solid transparent'}
      borderColor={selected ? 'blue.500' : 'transparent'}
      borderRadius="md"
      h="100%"
      w="100%"
    >
      <Box
        h="100%"
        w="100%"
        borderRadius="md"
        bg="gray.200"
        backgroundImage={visible ? `url(${thumbnailUrl(projectId, imageId)})` : undefined}
        backgroundSize="cover"
        backgroundPosition="center"
      />
    </Box>
  );
});

/** Lazy-loaded mask image — only fetches when scrolled into view. */
const LazyMaskImage = memo(function LazyMaskImage({
  src,
  label,
}: {
  src: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); io.disconnect(); } },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Box ref={ref} position="relative" borderRadius="md" overflow="hidden" bg="gray.50">
      {visible ? (
        <Image
          src={src}
          alt={label}
          w="100%"
          h="80px"
          objectFit="cover"
          fallback={
            <Box h="80px" display="flex" alignItems="center" justifyContent="center">
              <Text fontSize="2xs" color="gray.400">{label}</Text>
            </Box>
          }
        />
      ) : (
        <Box h="80px" display="flex" alignItems="center" justifyContent="center">
          <Text fontSize="2xs" color="gray.400">{label}</Text>
        </Box>
      )}
      <HStack
        position="absolute"
        bottom={0}
        left={0}
        right={0}
        bg="blackAlpha.600"
        px={1}
        py={0.5}
        justify="space-between"
      >
        <Text fontSize="2xs" color="white" noOfLines={1}>{label}</Text>
        <HStack spacing={0}>
          <Button
            as="a"
            href={src}
            target="_blank"
            size="xs"
            variant="ghost"
            color="white"
            minW="auto"
            p={0}
            _hover={{ bg: 'whiteAlpha.300' }}
          >
            <Eye size={12} />
          </Button>
          <Button
            as="a"
            href={src}
            download={`${label.replace(/\s+/g, '_')}.png`}
            size="xs"
            variant="ghost"
            color="white"
            minW="auto"
            p={0}
            _hover={{ bg: 'whiteAlpha.300' }}
          >
            <Download size={12} />
          </Button>
        </HStack>
      </HStack>
    </Box>
  );
});

/** Auto-sizing virtualized grid for image selection. */
function ImageSelectionGrid({
  images,
  projectId,
  selectedProjectImages,
  onToggle,
}: {
  images: UploadedImage[];
  projectId: string;
  selectedProjectImages: Set<string>;
  onToggle: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const COLS = 4;
  const GAP = 8;
  const colW = containerWidth > 0 ? (containerWidth - GAP * (COLS - 1)) / COLS : 0;
  const ROW_H = Math.max(Math.round(colW * 0.7) + GAP, 52); // aspect ~0.7 + gap
  const rowCount = Math.ceil(images.length / COLS);
  const gridHeight = Math.min(rowCount * ROW_H, 240);

  return (
    <Box ref={containerRef} w="100%">
      {containerWidth > 0 && (
        <VirtualGrid
          columnCount={COLS}
          columnWidth={colW + GAP}
          rowCount={rowCount}
          rowHeight={ROW_H}
          style={{ height: gridHeight, width: containerWidth, overflowX: 'hidden' }}
          overscanCount={3}
          // react-window v2's strict cellComponent / cellProps typing rejects our
          // memo-wrapped renderer + user-prop bag even though the runtime contract
          // matches. Cast through `unknown` to keep the typecheck clean.
          cellComponent={ImageGridCell as unknown as Parameters<typeof VirtualGrid>[0]['cellComponent']}
          cellProps={{
            images,
            cols: COLS,
            projectId,
            selectedProjectImages,
            onToggle,
            gap: GAP,
          } as unknown as Parameters<typeof VirtualGrid>[0]['cellProps']}
        />
      )}
    </Box>
  );
}

/** Cell renderer for the virtualized image-selection grid. react-window v2
 * injects {ariaAttributes, columnIndex, rowIndex, style} alongside the
 * user-supplied cellProps. */
interface ImageGridCellUserProps {
  images: UploadedImage[];
  cols: number;
  projectId: string;
  selectedProjectImages: Set<string>;
  onToggle: (id: string) => void;
  gap: number;
}

const ImageGridCell = memo(function ImageGridCell({
  columnIndex,
  rowIndex,
  style,
  images,
  cols,
  projectId,
  selectedProjectImages,
  onToggle,
  gap,
}: {
  ariaAttributes?: { 'aria-colindex': number; role: 'gridcell' };
  columnIndex: number;
  rowIndex: number;
  style: React.CSSProperties;
} & ImageGridCellUserProps): React.ReactElement | null {
  const idx = rowIndex * cols + columnIndex;
  if (idx >= images.length) return null;
  const img = images[idx];
  return (
    <div style={{ ...style, paddingRight: gap, paddingBottom: gap }}>
      <VisionImageTile
        projectId={projectId}
        imageId={img.image_id}
        selected={selectedProjectImages.has(img.image_id)}
        onToggle={onToggle}
      />
    </div>
  );
});

/** Single recommendation AccordionItem. */
const RecommendationItem = memo(function RecommendationItem({
  rec,
  selected,
  onToggle,
  hasCalculator = true,
}: {
  rec: IndicatorRecommendation;
  selected: boolean;
  onToggle: (rec: IndicatorRecommendation) => void;
  hasCalculator?: boolean;
}) {
  return (
    <AccordionItem borderColor={selected ? 'blue.300' : 'gray.200'} opacity={hasCalculator ? 1 : 0.55}>
      <AccordionButton py={2}>
        <HStack flex="1" justify="space-between" pr={2}>
          <HStack spacing={2}>
            <Checkbox
              isChecked={selected}
              onChange={() => onToggle(rec)}
              onClick={(e) => e.stopPropagation()}
              size="sm"
              isDisabled={!hasCalculator}
            />
            <Badge colorScheme="blue" fontSize="xs">{rec.indicator_id}</Badge>
            <Text fontSize="sm" fontWeight="bold" noOfLines={1}>{rec.indicator_name}</Text>
            {!hasCalculator && <Badge colorScheme="red" fontSize="2xs">No calculator</Badge>}
          </HStack>
          <HStack spacing={1}>
            <Progress value={rec.relevance_score * 100} size="xs" w="40px" colorScheme="green" />
            <Text fontSize="xs">{(rec.relevance_score * 100).toFixed(0)}%</Text>
          </HStack>
        </HStack>
        <AccordionIcon />
      </AccordionButton>
      <AccordionPanel pb={3} px={3}>
        <VStack align="stretch" spacing={2}>
          <Text fontSize="xs">{rec.rationale}</Text>
          <Wrap spacing={1}>
            {rec.rank > 0 && <WrapItem><Badge colorScheme="purple" fontSize="2xs">#{rec.rank}</Badge></WrapItem>}
            <WrapItem>
              <Badge colorScheme={rec.relationship_direction === 'positive' || rec.relationship_direction === 'INCREASE' ? 'green' : 'orange'} fontSize="2xs">
                {rec.relationship_direction}
              </Badge>
            </WrapItem>
            {rec.strength_score && (
              <WrapItem>
                <Badge colorScheme={rec.strength_score === 'A' ? 'green' : rec.strength_score === 'B' ? 'blue' : 'gray'} fontSize="2xs">
                  Strength {rec.strength_score}
                </Badge>
              </WrapItem>
            )}
            <WrapItem>
              <Badge colorScheme={rec.confidence === 'high' ? 'green' : 'yellow'} fontSize="2xs">
                {rec.confidence} conf.
              </Badge>
            </WrapItem>
            {rec.transferability_summary && (
              <WrapItem>
                <Badge colorScheme="teal" variant="outline" fontSize="2xs">
                  {rec.transferability_summary.high_count}H/{rec.transferability_summary.moderate_count}M/{rec.transferability_summary.low_count}L
                </Badge>
              </WrapItem>
            )}
          </Wrap>
          {rec.evidence_citations && rec.evidence_citations.length > 0 ? (
            <Box>
              <Text fontSize="2xs" fontWeight="bold" color="gray.500" mb={1}>Evidence:</Text>
              {rec.evidence_citations.slice(0, 3).map((cit) => (
                <HStack key={cit.evidence_id} fontSize="2xs" color="gray.500" spacing={1}>
                  <Badge size="sm" variant="outline" fontSize="2xs">{cit.evidence_id}</Badge>
                  <Text noOfLines={1} flex={1}>{cit.citation}{cit.year ? ` (${cit.year})` : ''}</Text>
                </HStack>
              ))}
              {rec.evidence_citations.length > 3 && (
                <Text fontSize="2xs" color="gray.400">+{rec.evidence_citations.length - 3} more</Text>
              )}
            </Box>
          ) : rec.evidence_ids?.length > 0 ? (
            <Text fontSize="2xs" color="gray.400">
              Evidence: {rec.evidence_ids.slice(0, 3).join(', ')}{rec.evidence_ids.length > 3 ? ` +${rec.evidence_ids.length - 3}` : ''}
            </Text>
          ) : null}
        </VStack>
      </AccordionPanel>
    </AccordionItem>
  );
});

/* ── Main page component ─────────────────────────────────────────── */

function VisionAnalysis() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const projectId = routeProjectId || searchParams.get('project');

  const { data: semanticConfig, isLoading: configLoading } = useSemanticConfig();
  const { data: project, isLoading: projectLoading } = useProject(projectId || '');
  const { data: calculators } = useCalculators();
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Set of calculator IDs for quick lookup — recommendations without a calculator cannot be computed
  const calculatorIds = useMemo(
    () => new Set((calculators || []).map(c => c.id)),
    [calculators],
  );

  // Vision API health — shared cached query (2-min staleTime). Manual
  // re-check goes through refetch, which Settings Test button also uses.
  const {
    data: visionHealthData,
    isFetching: visionChecking,
    refetch: refetchVisionHealth,
  } = useVisionHealth();
  const visionHealthy = visionHealthData ? visionHealthData.healthy : null;
  const checkVisionHealth = useCallback(() => { void refetchVisionHealth(); }, [refetchVisionHealth]);

  // Form state
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [holeFilling, setHoleFilling] = useState(false);

  // Project image selection (Set for O(1) lookups)
  const [selectedProjectImages, setSelectedProjectImages] = useState<Set<string>>(new Set());

  // Panorama mode
  const [isPanorama, setIsPanorama] = useState(false);
  // v4.x — Per-view selection for downstream pipeline. Subset of
  // ["left", "front", "right"]. Reads/writes back to
  // `project.active_panorama_views`. When `isPanorama` flips on for the
  // first time we default to all three views ticked; users untick to
  // limit which views get their own indicator/clustering/report run.
  const [activePanoramaViews, setActivePanoramaViews] = useState<string[]>([]);

  // Force re-analyze (bypass skip-already-processed resume logic)
  const [forceRerun, setForceRerun] = useState(false);

  // Analysis state
  const [analyzing, setAnalyzing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{current: number; total: number} | null>(null);

  // Lazy render: show only N mask preview cards at a time (prevents 30K+ DOM nodes)
  const MASK_PREVIEW_PAGE = 10;
  const [maskVisibleCount, setMaskVisibleCount] = useState(MASK_PREVIEW_PAGE);

  // Vision results persisted in store (survive navigation)
  const {
    visionMaskResults: maskResults, setVisionMaskResults: setMaskResults,
    visionStatistics: statistics, setVisionStatistics: setStatistics,
    recommendations, setRecommendations,
    selectedIndicators, addSelectedIndicator, removeSelectedIndicator,
    indicatorRelationships, setIndicatorRelationships,
    recommendationSummary, setRecommendationSummary,
    recommendInFlight, setRecommendInFlight,
    pipelineRun,
  } = useAppStore();

  // Block vision analysis while a pipeline is running for the same project —
  // both write to project.uploaded_images[].metrics_results / mask_filepaths,
  // and concurrent writes via the SQLite store can clobber each other.
  const pipelineBlockingThisProject =
    pipelineRun.isRunning && pipelineRun.projectId === projectId;

  // Indicator recommendation
  const recommendMutation = useRecommendIndicators();

  const handleRunRecommendation = useCallback(() => {
    if (!project || !project.performance_dimensions?.length) return;
    // Layer 2 — mark in-flight so a hard refresh during the call shows
    // "Resuming…" instead of the empty Get-Recommendations state. The
    // backend's Layer 1 dedup ensures re-firing the request after refresh
    // attaches to the existing Gemini call instead of starting a new one.
    setRecommendInFlight({ projectId: project.id, startedAt: Date.now() });
    recommendMutation.mutate({
      project_name: project.project_name,
      project_location: project.project_location || '',
      space_type_id: project.space_type_id || '',
      koppen_zone_id: project.koppen_zone_id || '',
      lcz_type_id: project.lcz_type_id || '',
      age_group_id: project.age_group_id || '',
      performance_dimensions: project.performance_dimensions,
      design_brief: project.design_brief || '',
      // Trigger backend persistence so a returning user (different
      // browser, new tab, or fresh session) sees the same Stage 1 output
      // their pipeline was built from.
      project_id: project.id,
    }, {
      onSuccess: (result) => {
        setRecommendInFlight(null);
        if (result.success) {
          setRecommendations(result.recommendations);
          setIndicatorRelationships(result.indicator_relationships || []);
          setRecommendationSummary(result.summary || null);
          toast({ title: `${result.recommendations.length} indicators recommended`, status: 'success' });
        } else {
          toast({ title: result.error || 'Recommendation failed', status: 'error' });
        }
      },
      onError: (err) => {
        setRecommendInFlight(null);
        const msg = err instanceof Error ? err.message : 'Recommendation request failed';
        toast({ title: msg, status: 'error' });
      },
    });
  }, [project, recommendMutation, toast, setRecommendInFlight]);

  // Layer 2 — on mount, if the persisted store says a recommendation was
  // in flight for THIS project and recently (< 10 min), auto re-fire so the
  // backend Layer-1 dedup attaches us to the running Gemini call. Stale
  // markers (> 10 min) are dropped — the user can re-click Get
  // Recommendations explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!project) return;
    if (!recommendInFlight) return;
    if (recommendInFlight.projectId !== project.id) return;
    const ageMs = Date.now() - recommendInFlight.startedAt;
    if (ageMs > 10 * 60 * 1000) {
      // Stale — drop it.
      setRecommendInFlight(null);
      return;
    }
    if (recommendMutation.isPending) return;
    if (recommendations.length > 0) return;
    // Re-fire the same request; backend dedup re-attaches.
    handleRunRecommendation();
  }, [project?.id]);

  // Layer 2 — live elapsed-time ticker for the "Resuming…" / in-flight UI.
  // Updates once per second only while a recommendation is in flight, so
  // the rest of the page doesn't re-render needlessly.
  const [recNowTick, setRecNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!recommendInFlight && !recommendMutation.isPending) return;
    setRecNowTick(Date.now());
    const id = window.setInterval(() => setRecNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [recommendInFlight, recommendMutation.isPending]);

  const recElapsedLabel = useMemo(() => {
    if (!recommendInFlight) return null;
    const ms = Math.max(0, recNowTick - recommendInFlight.startedAt);
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }, [recommendInFlight, recNowTick]);

  // True when a marker exists for this project that pre-dates the current
  // mount — i.e. we just hard-refreshed and are reattaching to a running
  // backend call. Used to swap "Running…" copy for "Resuming…".
  const componentMountedAtRef = useRef<number>(Date.now());
  const isResumingRecommendation =
    !!recommendInFlight &&
    !!project &&
    recommendInFlight.projectId === project.id &&
    // marker was set at least 2s before this mount → it's from a prior session
    recommendInFlight.startedAt < componentMountedAtRef.current - 2000;

  // Preview: how many of the selected images are already processed (eligible for resume/skip)
  const resumePreview = useMemo(() => {
    if (!project || selectedProjectImages.size === 0) return { alreadyDone: 0, toProcess: 0 };
    const selectedSet = selectedProjectImages;
    let alreadyDone = 0;
    for (const img of project.uploaded_images) {
      if (!selectedSet.has(img.image_id)) continue;
      const mp = img.mask_filepaths;
      if (!mp || Object.keys(mp).length === 0) continue;
      // v4.x — Per-view aware: in panorama mode, count "already done" only
      // when EVERY currently-selected view has a semantic_map. Without this,
      // unchecking Front on an image that was processed with all 3 views
      // would still count as done, and the analyze pass wouldn't re-run for
      // the now-narrower scope.
      const viewsToCheck = activePanoramaViews.length > 0
        ? activePanoramaViews
        : ['left', 'front', 'right'];
      const matched = isPanorama
        ? viewsToCheck.every(v => !!mp[`${v}_semantic_map`])
        : !!mp['semantic_map'];
      if (matched) alreadyDone++;
    }
    return { alreadyDone, toProcess: selectedProjectImages.size - alreadyDone };
  }, [project, selectedProjectImages, isPanorama, activePanoramaViews]);

  const maskFileCount = useMemo(
    () => maskResults.reduce((s, r) => s + Object.keys(r.maskPaths).length, 0),
    [maskResults],
  );

  const selectedIndicatorIds = useMemo(
    () => new Set(selectedIndicators.map(i => i.indicator_id)),
    [selectedIndicators],
  );
  const toggleIndicator = useCallback((rec: IndicatorRecommendation) => {
    if (!calculatorIds.has(rec.indicator_id)) return; // no calculator — cannot compute
    if (selectedIndicatorIds.has(rec.indicator_id)) {
      removeSelectedIndicator(rec.indicator_id);
    } else {
      addSelectedIndicator(rec);
    }
  }, [selectedIndicatorIds, calculatorIds, removeSelectedIndicator, addSelectedIndicator]);

  // Remove any persisted selections whose calculator no longer exists
  useEffect(() => {
    if (calculatorIds.size === 0 || selectedIndicators.length === 0) return;
    const invalid = selectedIndicators.filter(i => !calculatorIds.has(i.indicator_id));
    if (invalid.length > 0) {
      invalid.forEach(i => removeSelectedIndicator(i.indicator_id));
    }
  }, [calculatorIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce-save selectedIndicators to the backend so toggles survive
  // reloads / project switches. We compare indicator_ids to avoid writing
  // when hydrate-from-project just populated the store with the same
  // values — and to avoid round-tripping the full recommendation objects
  // on every diff.
  const lastSavedSelectionRef = useRef<string | null>(null);
  // Buffer of the latest in-flight selection so the unmount cleanup
  // (below) can flush a pending save instead of dropping it.
  const pendingSelectionRef = useRef<IndicatorRecommendation[] | null>(null);
  useEffect(() => {
    if (!projectId || !project) return;
    const currentIds = selectedIndicators.map(i => i.indicator_id).sort().join(',');
    const persistedIds = (project.selected_indicators ?? [])
      .map(i => i.indicator_id).sort().join(',');
    // Initial mount or post-hydrate: store matches what's on the server.
    // Don't fire a redundant save — record it as the baseline.
    if (lastSavedSelectionRef.current === null) {
      lastSavedSelectionRef.current = persistedIds;
    }
    if (currentIds === lastSavedSelectionRef.current) return;
    pendingSelectionRef.current = selectedIndicators;
    const handle = window.setTimeout(() => {
      pendingSelectionRef.current = null;
      api.projects.updateSelectedIndicators(projectId, selectedIndicators)
        .then(() => {
          lastSavedSelectionRef.current = currentIds;
          // Keep the React Query cache in sync so a re-mount hydrates from
          // the just-saved selection rather than the stale fetched copy.
          queryClient.setQueryData<typeof project>(['project', projectId], (old) =>
            old ? { ...old, selected_indicators: selectedIndicators } : old,
          );
        })
        .catch(() => {
          // Non-fatal — selection still works in-session; user just won't
          // see it on a different device until they toggle again.
        });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [selectedIndicators, projectId, project, queryClient]);

  // Flush any pending selection save when the component unmounts (user
  // navigated away mid-debounce). Fire-and-forget — we don't await
  // because unmount cleanups can't be async, and worst case the user's
  // selection lives only in this session, same as before.
  useEffect(() => {
    return () => {
      if (projectId && pendingSelectionRef.current) {
        api.projects.updateSelectedIndicators(projectId, pendingSelectionRef.current)
          .catch(() => { /* swallowed */ });
      }
    };
  }, [projectId]);

  // Default: select all semantic classes once when config loads
  const classesInitialized = useRef(false);
  useEffect(() => {
    if (!classesInitialized.current && semanticConfig?.classes) {
      setSelectedClasses(semanticConfig.classes.map((c) => c.name));
      classesInitialized.current = true;
    }
  }, [semanticConfig]);

  // v4.x — Hydrate panorama view selection from the project record once it
  // arrives. If the project has `active_panorama_views` set, restore it AND
  // normalize: panorama mode is now all-or-nothing (the per-view picker was
  // retired), so any partial subset stored from a previous session (e.g.
  // ["left", "right"] from when the user had unchecked Front in the now-
  // removed CheckboxGroup) MUST be promoted to the full set, otherwise the
  // pipeline loop / vision processing / Reports segmented control would all
  // honour the stale partial selection and silently exclude views that
  // should be active.
  const panoramaHydrated = useRef(false);
  useEffect(() => {
    if (panoramaHydrated.current || !project) return;
    const stored = project.active_panorama_views;
    if (Array.isArray(stored) && stored.length > 0) {
      const fullSet = ['left', 'front', 'right'];
      const isFullSet = stored.length === 3 && fullSet.every(v => stored.includes(v));
      const normalized = isFullSet ? stored : fullSet;
      setActivePanoramaViews(normalized);
      setIsPanorama(true);
      if (!isFullSet && projectId) {
        // Write the normalized full set back to the project record so the
        // next consumer (Analysis page's pipeline trigger, Reports page's
        // segmented control, the backend's per-view filters) sees the
        // correct scope.
        api.projects.update(projectId, { active_panorama_views: fullSet })
          .catch(err => console.error('Normalize active_panorama_views failed', err));
      }
    }
    panoramaHydrated.current = true;
  }, [project, projectId]);

  // Default: select all project images once when project loads
  const imagesInitialized = useRef(false);
  useEffect(() => {
    if (!imagesInitialized.current && project?.uploaded_images && project.uploaded_images.length > 0) {
      setSelectedProjectImages(new Set(project.uploaded_images.map(img => img.image_id)));
      imagesInitialized.current = true;

      // Restore mask results from project data if Zustand store is empty.
      // Panorama keys are stored as `{view}_{key}` pointing at files on disk
      // under `masks/{project}/{imageId}_{view}/{key}.png`. Split them back
      // into per-view entries so the URL builder (`/api/masks/{project}/
      // {imageId}/{maskKey}.png`) lines up with the actual disk layout.
      if (maskResults.length === 0) {
        const restored: Array<{imageId: string; maskPaths: Record<string, string>}> = [];
        for (const img of project.uploaded_images) {
          if (!img.mask_filepaths || Object.keys(img.mask_filepaths).length === 0) continue;

          const standardPaths: Record<string, string> = {};
          const viewPaths: Record<string, Record<string, string>> = {};
          for (const [key, path] of Object.entries(img.mask_filepaths)) {
            const m = key.match(/^(left|front|right)_(.+)$/);
            if (m) {
              const view = m[1];
              const rest = m[2];
              if (!viewPaths[view]) viewPaths[view] = {};
              viewPaths[view][rest] = path;
            } else {
              standardPaths[key] = path;
            }
          }

          if (Object.keys(standardPaths).length > 0) {
            restored.push({ imageId: img.image_id, maskPaths: standardPaths });
          }
          for (const [view, paths] of Object.entries(viewPaths)) {
            restored.push({ imageId: `${img.image_id}_${view}`, maskPaths: paths });
          }
        }
        if (restored.length > 0) {
          setMaskResults(restored);
        }
      }
    }
  }, [project]);

  const handleSelectAll = () => {
    if (semanticConfig?.classes) {
      setSelectedClasses(semanticConfig.classes.map((c) => c.name));
    }
  };

  const handleSelectNone = () => {
    setSelectedClasses([]);
  };

  const handleSelectAllImages = useCallback(() => {
    if (project?.uploaded_images) {
      setSelectedProjectImages(new Set(project.uploaded_images.map(img => img.image_id)));
    }
  }, [project?.uploaded_images]);

  const handleSelectNoImages = useCallback(() => {
    setSelectedProjectImages(new Set());
  }, []);

  const toggleImageSelection = useCallback((imageId: string) => {
    setSelectedProjectImages(prev => {
      const next = new Set(prev);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
  }, []);

  const handleAnalyze = async () => {
    if (selectedClasses.length === 0) {
      toast({ title: 'Please select at least one class', status: 'warning' });
      return;
    }

    const classConfig = semanticConfig?.classes || [];
    const countability = selectedClasses.map((name) => {
      const cls = classConfig.find((c) => c.name === name);
      return cls?.countable || 0;
    });
    const openness = selectedClasses.map((name) => {
      const cls = classConfig.find((c) => c.name === name);
      return cls?.openness || 0;
    });

    setAnalyzing(true);
    setStatistics(null);
    setBatchProgress(null);
    setMaskResults([]);
    setMaskVisibleCount(MASK_PREVIEW_PAGE);

    try {
      if (selectedProjectImages.size > 0 && projectId) {
        const FLUSH_SIZE = 50;
        let processed = 0;
        let skipped = 0;
        let successCount = 0;
        // Rolling buffer — flushed to Zustand every FLUSH_SIZE iterations to keep JS heap bounded.
        let maskBuffer: Array<{imageId: string; maskPaths: Record<string, string>}> = [];
        const failedImages: string[] = [];
        const requestPayload = {
          semantic_classes: selectedClasses,
          semantic_countability: countability,
          openness_list: openness,
          enable_hole_filling: holeFilling,
        };

        const flushMaskBuffer = () => {
          if (maskBuffer.length === 0) return;
          const current = useAppStore.getState().visionMaskResults;
          setMaskResults([...current, ...maskBuffer]);
          maskBuffer = [];
        };

        // Detect whether this image is already processed by checking backend-persisted mask_filepaths.
        // Standard mode needs `semantic_map`; panorama mode needs at least one `{view}_semantic_map`
        // FOR A VIEW THAT'S CURRENTLY SELECTED. v4.x — if the user has unchecked
        // a view (e.g. Front), an image whose only saved masks are for that
        // unchecked view should NOT count as processed, so the analyze pass
        // generates masks for the selected views instead of bailing out as
        // "cached". The backend purge in vision.py removes the unchecked
        // view's mask files on the next run, completing the cleanup.
        const isAlreadyProcessed = (img: UploadedImage): boolean => {
          const mp = img.mask_filepaths;
          if (!mp || Object.keys(mp).length === 0) return false;
          if (isPanorama) {
            // Require EVERY selected view to have a semantic_map. If any
            // selected view is missing, the image needs re-processing.
            // Empty selection (legacy, shouldn't happen with isPanorama=true)
            // falls back to the original "any view present" check.
            const viewsToCheck = activePanoramaViews.length > 0
              ? activePanoramaViews
              : ['left', 'front', 'right'];
            return viewsToCheck.every(v => !!mp[`${v}_semantic_map`]);
          }
          return !!mp['semantic_map'];
        };

        for (const imageId of selectedProjectImages) {
          const img = project?.uploaded_images.find(i => i.image_id === imageId);
          if (!img) continue;

          // Resume: skip already-processed images (unless user forces re-run)
          if (!forceRerun && isAlreadyProcessed(img)) {
            // v4.x — Split panorama keys into per-view maskBuffer entries so
            // the URL builder (`/api/masks/{project}/{imageId}/{maskKey}.png`)
            // lines up with the actual on-disk layout
            // (`masks/{project}/{imageId}_{view}/{key}.png`).
            // Without this split, cached panorama images flowed through as
            // a single entry with imageId=raw + maskKey=`{view}_{key}`,
            // producing URLs `/api/masks/{p}/{img_id}/left_semantic_xxx.png`
            // that 404'd because the disk file is at
            // `/api/masks/{p}/{img_id}_left/semantic_xxx.png`.
            // Mirrors the hydration logic above (line 720-758) and the
            // fresh-processed path below (line 886-893) so all three
            // entry points produce identically-shaped maskBuffer entries.
            if (isPanorama) {
              const standardPaths: Record<string, string> = {};
              const viewPaths: Record<string, Record<string, string>> = {};
              for (const [key, path] of Object.entries(img.mask_filepaths)) {
                const m = key.match(/^(left|front|right)_(.+)$/);
                if (m) {
                  const view = m[1];
                  const rest = m[2];
                  if (!viewPaths[view]) viewPaths[view] = {};
                  viewPaths[view][rest] = path;
                } else {
                  standardPaths[key] = path;
                }
              }
              if (Object.keys(standardPaths).length > 0) {
                maskBuffer.push({ imageId, maskPaths: standardPaths });
              }
              for (const [view, paths] of Object.entries(viewPaths)) {
                maskBuffer.push({ imageId: `${imageId}_${view}`, maskPaths: paths });
              }
            } else {
              maskBuffer.push({ imageId, maskPaths: img.mask_filepaths });
            }
            successCount++;
            skipped++;
            processed++;
            setBatchProgress({ current: processed, total: selectedProjectImages.size });
            if (maskBuffer.length >= FLUSH_SIZE) flushMaskBuffer();
            continue;
          }

          try {
            if (isPanorama && projectId) {
              // Panorama mode: call panorama endpoint, get 3 views per image
              const response = await api.vision.analyzeProjectImagePanorama(projectId, imageId, requestPayload);

              const views = response.data.views as Record<string, {
                status: string;
                mask_paths: Record<string, string>;
                statistics: Record<string, unknown>;
              }> | undefined;
              if (views) {
                for (const [viewName, viewData] of Object.entries(views)) {
                  if (viewData.status === 'success') {
                    successCount++;
                    if (viewData.mask_paths && Object.keys(viewData.mask_paths).length > 0) {
                      maskBuffer.push({ imageId: `${imageId}_${viewName}`, maskPaths: viewData.mask_paths });
                    }
                  }
                }
              }
            } else {
              // Standard single-image mode
              const response = await api.vision.analyzeProjectImage(projectId, imageId, requestPayload);

              if (response.data.status === 'success') {
                successCount++;
                if (response.data.mask_paths && Object.keys(response.data.mask_paths).length > 0) {
                  maskBuffer.push({ imageId, maskPaths: response.data.mask_paths });
                }
              } else {
                failedImages.push(imageId);
              }
            }
          } catch (err) {
            failedImages.push(imageId);
            console.error(`Vision analysis failed for ${imageId}:`, err);
          }

          processed++;
          setBatchProgress({ current: processed, total: selectedProjectImages.size });
          if (maskBuffer.length >= FLUSH_SIZE) flushMaskBuffer();
        }

        // Final flush for any remaining items in the buffer
        flushMaskBuffer();

        // Refresh the cached project so readiness alerts (semantic_map presence)
        // reflect the masks that were just persisted on the backend, instead of
        // requiring the user to navigate away and back.
        if (projectId && (successCount > 0 || skipped > 0)) {
          queryClient.invalidateQueries({ queryKey: ['project', projectId] });
        }

        if (successCount > 0) {
          setStatistics({
            images_processed: successCount,
            total_images: selectedProjectImages.size,
          });
        }

        // Show result with failure + resume details
        const actuallyProcessed = processed - skipped;
        const resumeSuffix = skipped > 0 ? ` (${skipped} skipped, already processed)` : '';
        if (failedImages.length === 0) {
          toast({
            title: `Analysis complete: ${actuallyProcessed} newly processed${resumeSuffix}`,
            status: 'success',
          });
        } else {
          toast({
            title: `Analysis done with ${failedImages.length} failure(s)${resumeSuffix}: ${failedImages.slice(0, 3).join(', ')}${failedImages.length > 3 ? '...' : ''}`,
            status: 'warning',
            duration: 8000,
          });
        }
      } else {
        toast({ title: 'Please select an image', status: 'warning' });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Analysis failed';
      toast({ title: message, status: 'error' });
    }

    setAnalyzing(false);
    setBatchProgress(null);
  };

  const isPageLoading = configLoading || (projectId && projectLoading);

  // Readiness check: how many zone-assigned images have semantic_map masks.
  // Panorama-analyzed images store keys as `{view}_semantic_map` (e.g.
  // `left_semantic_map`) rather than the standard `semantic_map`, so we accept
  // either form — otherwise panorama runs would show "no images analyzed"
  // even after a successful analysis pass.
  const readiness = useMemo(() => {
    if (!project) return null;
    const assigned = project.uploaded_images.filter(img => img.zone_id);
    const hasSemantic = (img: UploadedImage) => {
      const mp = img.mask_filepaths;
      if (!mp) return false;
      return !!mp.semantic_map
        || !!mp.front_semantic_map
        || !!mp.left_semantic_map
        || !!mp.right_semantic_map;
    };
    const hasFMB = (img: UploadedImage) => {
      const mp = img.mask_filepaths;
      if (!mp) return false;
      const standard = mp.foreground_map && mp.middleground_map && mp.background_map;
      if (standard) return true;
      // Any view counts as having FMB coverage for that view
      return ['front', 'left', 'right'].some(v =>
        mp[`${v}_foreground_map`] && mp[`${v}_middleground_map`] && mp[`${v}_background_map`]
      );
    };
    const withSemantic = assigned.filter(hasSemantic);
    const withFMB = assigned.filter(hasFMB);
    return {
      totalImages: project.uploaded_images.length,
      assignedCount: assigned.length,
      semanticCount: withSemantic.length,
      fmbCount: withFMB.length,
      ready: withSemantic.length > 0,
    };
  }, [project]);

  // Readiness is enforced at the moment the user clicks Next, not as a permanent
  // panel — common pre-analysis state (semanticCount === 0) is a normal start
  // condition, not an error worth a red banner. Hard blockers render inline
  // above the buttons; soft warnings (partial coverage) surface in a confirm
  // dialog so the user can opt to proceed.
  const [proceedBlocker, setProceedBlocker] = useState<'no-zones' | 'no-masks' | null>(null);
  const [proceedSoft, setProceedSoft] = useState<{
    semanticDone: number;
    semanticTotal: number;
    fmbDone: number;
    fmbTotal: number;
  } | null>(null);
  const proceedCancelRef = useRef<HTMLButtonElement>(null);

  const navigateToAnalysis = useCallback(() => {
    if (routeProjectId) navigate(`/projects/${routeProjectId}/analysis`);
  }, [navigate, routeProjectId]);

  const handleNextClick = useCallback(() => {
    setProceedBlocker(null);
    if (!readiness) return;

    if (readiness.assignedCount === 0) {
      setProceedBlocker('no-zones');
      return;
    }
    if (readiness.semanticCount === 0) {
      setProceedBlocker('no-masks');
      return;
    }

    const semanticIncomplete = readiness.semanticCount < readiness.assignedCount;
    const fmbIncomplete = readiness.fmbCount < readiness.semanticCount;
    if (semanticIncomplete || fmbIncomplete) {
      setProceedSoft({
        semanticDone: readiness.semanticCount,
        semanticTotal: readiness.assignedCount,
        fmbDone: readiness.fmbCount,
        fmbTotal: readiness.semanticCount,
      });
      return;
    }

    navigateToAnalysis();
  }, [readiness, navigateToAnalysis]);

  return (
    <PageShell isLoading={!!isPageLoading} loadingText="Loading...">
      <PageHeader title="Prepare">
        {project && (
          <HStack>
            <Text color="gray.500">Project:</Text>
            <Button as={Link} to={`/projects/${projectId}`} variant="link" colorScheme="blue">
              {project.project_name}
            </Button>
          </HStack>
        )}
      </PageHeader>

      {/* Vision API status banner */}
      {visionHealthy === false && (
        <Alert status="error" mb={4} borderRadius="md">
          <AlertIcon />
          <Box flex={1}>
            <Text fontWeight="bold">Vision API is not running</Text>
            <Text fontSize="sm">
              Please start AI_City_View (default: http://localhost:8000) before running analysis.
            </Text>
          </Box>
          <Button size="sm" variant="outline" colorScheme="red" onClick={checkVisionHealth} isLoading={visionChecking}>
            Retry
          </Button>
        </Alert>
      )}

      <SimpleGrid columns={{ base: 1, xl: 2 }} spacing={6}>
        {/* ═══ LEFT COLUMN: Vision Analysis ═══ */}
        {/* v4.x — Per-card ErrorBoundaries: image grid, options form,
            semantic classes selector, and mask preview each get their own
            so one card's crash doesn't take out the rest of the column. */}
        <VStack spacing={6} align="stretch">
          {/* Project Images */}
          <ErrorBoundary label="Project Images grid">
          <Card>
            <CardHeader>
              <Heading size="md">Project Images</Heading>
            </CardHeader>
            <CardBody>
              {!project ? (
                <Alert status="warning">
                  <AlertIcon />
                  <Text fontSize="sm">No project selected. Navigate from a project page to use Vision Analysis.</Text>
                </Alert>
              ) : project.uploaded_images.length === 0 ? (
                <Alert status="info">
                  <AlertIcon />
                  No images in project. Upload images in the project page first.
                </Alert>
              ) : (
                <VStack align="stretch" spacing={3}>
                  <HStack justify="space-between">
                    <Text fontSize="sm" color="gray.600">
                      {selectedProjectImages.size} of {project.uploaded_images.length} selected
                    </Text>
                    <HStack>
                      <Button size="xs" onClick={handleSelectAllImages}>All</Button>
                      <Button size="xs" onClick={handleSelectNoImages}>None</Button>
                    </HStack>
                  </HStack>
                  <ImageSelectionGrid
                    images={project.uploaded_images}
                    projectId={projectId!}
                    selectedProjectImages={selectedProjectImages}
                    onToggle={toggleImageSelection}
                  />
                </VStack>
              )}
            </CardBody>
          </Card>
          </ErrorBoundary>

          {/* Analysis Options */}
          <ErrorBoundary label="Analysis Options card">
          <Card>
            <CardHeader>
              <Heading size="md">Options</Heading>
            </CardHeader>
            <CardBody>
              <VStack align="stretch" spacing={3}>
                <Checkbox
                  isChecked={holeFilling}
                  onChange={(e) => setHoleFilling(e.target.checked)}
                >
                  Enable Hole Filling
                </Checkbox>
                <FormControl display="flex" alignItems="center">
                  <Switch
                    id="panorama-mode"
                    isChecked={isPanorama}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setIsPanorama(next);
                      // v4.x — Panorama mode is an all-or-nothing toggle:
                      // ON means "treat as 3-view panorama, process all
                      // three views every time". The per-view picker that
                      // used to live here was removed because the upstream
                      // Vision API's /analyze/panorama endpoint atomically
                      // processes all three crops anyway (see
                      // docs/reproducibility_manifest.json: per_view_execution).
                      // Letting the user untick individual views suggested
                      // savings that the upstream API doesn't deliver, while
                      // adding edge cases (stale mask purges, partial
                      // bucket states, "no views selected" empty downstream).
                      // Either you want panorama mode → all 3 views go end-
                      // to-end, or you don't → empty list, legacy single-
                      // view path.
                      const nextViews = next ? ['left', 'front', 'right'] : [];
                      setActivePanoramaViews(nextViews);
                      if (projectId) {
                        api.projects.update(projectId, { active_panorama_views: nextViews })
                          .catch(err => console.error('Persist active_panorama_views failed', err));
                      }
                    }}
                    mr={3}
                  />
                  <Box>
                    <FormLabel htmlFor="panorama-mode" mb={0} fontSize="sm">
                      Panorama Mode
                    </FormLabel>
                    <FormHelperText mt={0} fontSize="xs">
                      Splits each panoramic image into 3 views (left / front / right).
                      Every view runs an independent indicator / clustering / report
                      pipeline; the Reports page has a segmented control to switch
                      between them.
                    </FormHelperText>
                  </Box>
                </FormControl>
                <FormControl display="flex" alignItems="center">
                  <Switch
                    id="force-rerun"
                    isChecked={forceRerun}
                    onChange={(e) => setForceRerun(e.target.checked)}
                    mr={3}
                    colorScheme="orange"
                  />
                  <Box>
                    <FormLabel htmlFor="force-rerun" mb={0} fontSize="sm">
                      Force re-analyze
                    </FormLabel>
                    <FormHelperText mt={0} fontSize="xs">
                      Ignore cached masks and re-run all selected images (off = resume from last crash)
                    </FormHelperText>
                  </Box>
                </FormControl>
              </VStack>
            </CardBody>
          </Card>
          </ErrorBoundary>

          {/* Semantic Classes */}
          <ErrorBoundary label="Semantic Classes card">
          <Card>
            <CardHeader>
              <HStack justify="space-between">
                <Heading size="md">Semantic Classes</Heading>
                <HStack>
                  <Button size="xs" onClick={handleSelectAll}>All</Button>
                  <Button size="xs" onClick={handleSelectNone}>None</Button>
                </HStack>
              </HStack>
            </CardHeader>
            <CardBody maxH="300px" overflowY="auto">
              <CheckboxGroup value={selectedClasses} onChange={(v) => setSelectedClasses(v as string[])}>
                <SimpleGrid columns={2} spacing={2}>
                  {semanticConfig?.classes?.map((cls: SemanticClass) => (
                    <Checkbox key={cls.name} value={cls.name} size="sm">
                      <HStack spacing={1}>
                        <Box w={3} h={3} bg={cls.color} borderRadius="sm" />
                        <Text fontSize="xs" noOfLines={1}>{cls.name}</Text>
                      </HStack>
                    </Checkbox>
                  ))}
                </SimpleGrid>
              </CheckboxGroup>
            </CardBody>
          </Card>
          </ErrorBoundary>

          {/* Resume hint */}
          {!forceRerun && resumePreview.alreadyDone > 0 && !analyzing && (
            <Alert status="info" size="sm" borderRadius="md" py={2}>
              <AlertIcon />
              <Text fontSize="sm">
                <strong>{resumePreview.alreadyDone}</strong> of {selectedProjectImages.size} already processed —
                {' '}only <strong>{resumePreview.toProcess}</strong> new image(s) will be analyzed.
                {' '}Enable "Force re-analyze" to process all.
              </Text>
            </Alert>
          )}

          {pipelineBlockingThisProject && (
            <Alert status="warning" borderRadius="md">
              <AlertIcon />
              <Text fontSize="sm">
                A pipeline is currently running for this project. Vision analysis is disabled until it finishes,
                because both write the same project data and can corrupt each other.
              </Text>
            </Alert>
          )}

          {/* Analyze Button */}
          <Button
            colorScheme="green"
            size="lg"
            onClick={handleAnalyze}
            isLoading={analyzing}
            isDisabled={
              selectedClasses.length === 0 ||
              selectedProjectImages.size === 0 ||
              visionHealthy === false ||
              pipelineBlockingThisProject
            }
          >
            {(() => {
              const total = selectedProjectImages.size;
              if (total === 0) return 'Analyze Image';
              if (!forceRerun && resumePreview.toProcess < total) {
                return `Analyze ${resumePreview.toProcess} New Image${resumePreview.toProcess !== 1 ? 's' : ''} (${resumePreview.alreadyDone} cached)`;
              }
              return total > 1 ? `Analyze ${total} Images` : 'Analyze Image';
            })()}
          </Button>

          {/* ── Vision Results ── */}
          {analyzing && (
            <Alert status="info">
              <AlertIcon />
              {batchProgress
                ? `Analyzing images... ${batchProgress.current}/${batchProgress.total}`
                : 'Analyzing image... This may take a moment.'}
            </Alert>
          )}

          {batchProgress && (
            <Progress
              value={(batchProgress.current / batchProgress.total) * 100}
              colorScheme="blue"
              hasStripe
              isAnimated
            />
          )}

          {statistics && (
            <Card>
              <CardHeader>
                <Heading size="md">Analysis Results</Heading>
              </CardHeader>
              <CardBody>
                <VStack align="stretch" spacing={3}>
                  {(statistics as Record<string, number>).images_processed !== undefined ? (
                    <>
                      <HStack justify="space-between">
                        <Text>Images Processed:</Text>
                        <Badge colorScheme="green">
                          {(statistics as Record<string, number>).images_processed} / {(statistics as Record<string, number>).total_images}
                        </Badge>
                      </HStack>
                      <Text fontSize="sm" color="gray.500">
                        Individual results are saved for each image.
                      </Text>
                    </>
                  ) : (
                    <>
                      <HStack justify="space-between">
                        <Text>Detected Classes:</Text>
                        <Badge colorScheme="green">{(statistics as Record<string, number>).detected_classes || 0}</Badge>
                      </HStack>
                      <HStack justify="space-between">
                        <Text>Total Classes:</Text>
                        <Badge>{(statistics as Record<string, number>).total_classes || 0}</Badge>
                      </HStack>

                      {(statistics as Record<string, Record<string, unknown>>).class_statistics && (
                        <Box mt={4}>
                          <Text fontWeight="bold" mb={2}>Class Distribution:</Text>
                          <VStack align="stretch" spacing={1} maxH="200px" overflowY="auto">
                            {Object.entries((statistics as Record<string, Record<string, unknown>>).class_statistics).map(([cls, data]) => (
                              <HStack key={cls} justify="space-between" fontSize="sm">
                                <Text noOfLines={1}>{cls}</Text>
                                <Badge>{String((data as Record<string, number>).percentage?.toFixed(1) || 0)}%</Badge>
                              </HStack>
                            ))}
                          </VStack>
                        </Box>
                      )}
                    </>
                  )}
                </VStack>
              </CardBody>
            </Card>
          )}

          {/* Mask Previews */}
          {maskResults.length > 0 && (
            <ErrorBoundary label="Vision Output Masks card">
            <Card>
              <CardHeader>
                <HStack justify="space-between">
                  <Heading size="md">Output Masks</Heading>
                  <HStack>
                    <Badge colorScheme="green">{maskFileCount} files</Badge>
                    <Button
                      size="xs"
                      leftIcon={<Archive size={12} />}
                      colorScheme="blue"
                      onClick={async () => {
                        const zip = new JSZip();
                        for (const { imageId, maskPaths } of maskResults) {
                          // Handle panorama view entries (e.g. "img1_left")
                          const vm = imageId.match(/^(.+)_(left|front|right)$/);
                          const baseId = vm ? vm[1] : imageId;
                          const view = vm ? vm[2] : null;
                          const img = project?.uploaded_images.find(i => i.image_id === baseId);
                          const baseName = img?.filename
                            ? img.filename.replace(/\.[^/.]+$/, '')
                            : baseId;
                          const folderName = view ? `${baseName}_${view}` : baseName;
                          const folder = zip.folder(folderName)!;
                          for (const maskKey of Object.keys(maskPaths)) {
                            const url = `/api/masks/${projectId}/${imageId}/${maskKey}.png`;
                            try {
                              const resp = await fetch(url);
                              if (resp.ok) {
                                const blob = await resp.blob();
                                folder.file(`${maskKey}.png`, blob);
                              }
                            } catch {
                              // skip failed fetches
                            }
                          }
                        }
                        const blob = await zip.generateAsync({ type: 'blob' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${project?.project_name?.replace(/\s+/g, '_') || 'masks'}_vision_outputs.zip`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download All (ZIP)
                    </Button>
                  </HStack>
                </HStack>
              </CardHeader>
              <CardBody maxH="520px" overflowY="auto">
                {maskResults.length > MASK_PREVIEW_PAGE && (
                  <Text fontSize="xs" color="gray.500" mb={2}>
                    Previewing {Math.min(maskVisibleCount, maskResults.length)} of {maskResults.length} results — ZIP download includes all.
                  </Text>
                )}
                <VStack align="stretch" spacing={4}>
                  {maskResults
                    // v4.x — Filter the preview so unchecked panorama views
                    // are hidden, even if their mask files still exist on
                    // disk from a previous run when they were selected. The
                    // backend purge handles the disk side on the NEXT
                    // analyze run with Force re-analyze; this filter handles
                    // the IMMEDIATE display so unchecking a view hides it
                    // right away without forcing a re-process. Non-panorama
                    // entries (no _left/_front/_right suffix on imageId)
                    // are always shown.
                    .filter(({ imageId }) => {
                      const vm = imageId.match(/^(.+)_(left|front|right)$/);
                      if (!vm) return true;
                      // Empty selection = legacy non-panorama project, show all.
                      if (activePanoramaViews.length === 0) return true;
                      return activePanoramaViews.includes(vm[2]);
                    })
                    .slice(0, maskVisibleCount).map(({ imageId, maskPaths }) => {
                    // For panorama entries like "img1_left", parse the view suffix
                    const viewMatch = imageId.match(/^(.+)_(left|front|right)$/);
                    const baseImageId = viewMatch ? viewMatch[1] : imageId;
                    const viewName = viewMatch ? viewMatch[2] : null;
                    const img = project?.uploaded_images.find(i => i.image_id === baseImageId);
                    const viewLabels: Record<string, string> = { left: 'Left View', front: 'Front View', right: 'Right View' };
                    const displayLabel = viewName
                      ? `${img?.filename || baseImageId} — ${viewLabels[viewName]}`
                      : (img?.filename || imageId);
                    return (
                      <Box key={imageId}>
                        {maskResults.length > 1 && (
                          <Text fontSize="sm" fontWeight="semibold" mb={2} color="gray.700">
                            {displayLabel}
                          </Text>
                        )}
                        <SimpleGrid columns={3} spacing={2}>
                          {Object.entries(maskPaths).map(([maskKey]) => (
                            <LazyMaskImage
                              key={maskKey}
                              src={`/api/masks/${projectId}/${imageId}/${maskKey}.png`}
                              label={maskKey.replace(/_/g, ' ')}
                            />
                          ))}
                        </SimpleGrid>
                      </Box>
                    );
                  })}
                </VStack>
                {maskResults.length > maskVisibleCount && (
                  <Button
                    size="sm"
                    variant="ghost"
                    mt={3}
                    w="full"
                    onClick={() => setMaskVisibleCount(c => c + MASK_PREVIEW_PAGE)}
                  >
                    Show more ({maskResults.length - maskVisibleCount} remaining)
                  </Button>
                )}
              </CardBody>
            </Card>
            </ErrorBoundary>
          )}

          {!analyzing && !statistics && maskResults.length === 0 && (
            <EmptyState
              icon={ScanSearch}
              title="No results yet"
              description="Select images, choose classes, then click Analyze."
            />
          )}
        </VStack>

        {/* ═══ RIGHT COLUMN: Indicator Recommendations ═══ */}
        <VStack spacing={6} align="stretch">
          <ErrorBoundary label="Indicator Recommendations panel">
          <Card>
            <CardHeader>
              <HStack justify="space-between">
                <HStack spacing={2}>
                  <Lightbulb size={18} />
                  <Heading size="md">Indicators</Heading>
                </HStack>
                <HStack spacing={2}>
                  {recommendMutation.isPending && <Spinner size="sm" />}
                  {selectedIndicators.length > 0 && (
                    <Badge colorScheme="blue">{selectedIndicators.length} selected</Badge>
                  )}
                </HStack>
              </HStack>
            </CardHeader>
            <CardBody>
              {/* Dimensions badges */}
              {project?.performance_dimensions && project.performance_dimensions.length > 0 && (
                <HStack spacing={1} flexWrap="wrap" mb={3}>
                  {project.performance_dimensions.map(d => {
                    const dim = DIMENSIONS.find(x => x.id === d);
                    return <Badge key={d} fontSize="2xs" colorScheme="purple">{dim?.name || d}</Badge>;
                  })}
                </HStack>
              )}

              {/* v4 polish — explain WHY the button is disabled, instead of
                  silently graying it out. Without `performance_dimensions`
                  on the project, the Stage 1 LLM has no goal to recommend
                  indicators for, so the request would 422 anyway. Surface
                  this with a one-click route to the Edit Project page. */}
              {project && (!project.performance_dimensions || project.performance_dimensions.length === 0) && (
                <Alert status="warning" mb={3} borderRadius="md" alignItems="flex-start" fontSize="sm">
                  <AlertIcon mt={0.5} />
                  <Box flex={1}>
                    <Text fontWeight="bold" fontSize="sm">
                      No performance dimensions set
                    </Text>
                    <Text fontSize="xs" color="gray.700" mt={1}>
                      The recommendation engine needs at least one performance
                      dimension (e.g. <i>Thermal Comfort</i>, <i>Mental Restoration</i>)
                      to know what indicators to suggest. Open the project's edit
                      page and pick one or more dimensions, then come back here.
                    </Text>
                    <Button
                      size="xs"
                      colorScheme="orange"
                      variant="outline"
                      mt={2}
                      as={Link}
                      to={`/projects/${routeProjectId}/edit`}
                    >
                      Edit project to add dimensions
                    </Button>
                  </Box>
                </Alert>
              )}

              {/* Run button */}
              <Button
                colorScheme="blue"
                size="sm"
                w="full"
                onClick={handleRunRecommendation}
                isLoading={recommendMutation.isPending}
                loadingText="Running (may take 2-4 min)..."
                isDisabled={!project?.performance_dimensions?.length}
              >
                {recommendations.length > 0 ? 'Re-run Recommendations' : 'Get Recommendations'}
              </Button>

              {(recommendMutation.isPending || isResumingRecommendation) && (
                <Box
                  mt={2}
                  p={3}
                  borderRadius="md"
                  borderLeft="3px solid"
                  bg={isResumingRecommendation ? 'orange.50' : 'blue.50'}
                  borderColor={isResumingRecommendation ? 'orange.300' : 'blue.300'}
                >
                  <HStack justify="space-between" align="baseline" mb={1.5}>
                    <Text fontSize="xs" fontWeight="bold">
                      {isResumingRecommendation
                        ? 'Resuming Stage 1 recommendation…'
                        : `Analyzing ${project?.performance_dimensions?.length || 0} dimension${(project?.performance_dimensions?.length || 0) === 1 ? '' : 's'}`}
                    </Text>
                    {recElapsedLabel && (
                      <Badge fontSize="2xs" colorScheme={isResumingRecommendation ? 'orange' : 'blue'}>
                        {recElapsedLabel} elapsed
                      </Badge>
                    )}
                  </HStack>

                  {isResumingRecommendation ? (
                    // After a hard refresh we can't reattach to the original
                    // SSE stream, so stage events are not available. Fall
                    // back to a generic indeterminate bar + elapsed time —
                    // the result will land in the store when the backend
                    // call finishes (Layer 1 dedup ensures it's the same
                    // call, not a duplicate).
                    <>
                      <Progress
                        size="xs"
                        isIndeterminate
                        colorScheme="orange"
                        borderRadius="sm"
                        mb={1.5}
                      />
                      <Text fontSize="xs" color="gray.600">
                        Reattaching to the running backend call — your previous request is still being processed.
                      </Text>
                    </>
                  ) : (
                    // Live recommendation in flight — drive the bar from
                    // the SSE progress state. Once the stream enters the
                    // `generating` stage, the percent advances with each
                    // chunk so the user sees the LLM actually producing
                    // tokens rather than wondering if it's hung.
                    <>
                      <Progress
                        size="xs"
                        value={recommendMutation.progress.percent}
                        colorScheme={recommendMutation.progress.stage === 'error' ? 'red' : 'blue'}
                        hasStripe
                        isAnimated
                        borderRadius="sm"
                        mb={1.5}
                      />

                      {/* Stage breadcrumb — bold the active one. Each step
                          corresponds to a distinct backend phase that
                          emits its own status event. */}
                      <HStack spacing={2} mb={1.5} fontSize="2xs">
                        {([
                          { key: 'retrieving', label: '1. Retrieving evidence' },
                          { key: 'cards', label: '2. Building cards' },
                          { key: 'generating', label: '3. LLM generating' },
                        ] as const).map((step, idx, arr) => {
                          const stageOrder: RecommendStage[] = ['idle', 'retrieving', 'cards', 'generating', 'done'];
                          const currentIdx = stageOrder.indexOf(recommendMutation.progress.stage);
                          const stepIdx = stageOrder.indexOf(step.key as RecommendStage);
                          const isActive = recommendMutation.progress.stage === step.key;
                          const isDone = currentIdx > stepIdx;
                          return (
                            <HStack key={step.key} spacing={1} flex={1}>
                              <Text
                                color={isDone ? 'green.600' : isActive ? 'blue.700' : 'gray.500'}
                                fontWeight={isActive ? 'bold' : 'normal'}
                              >
                                {isDone ? '✓ ' : ''}{step.label}
                              </Text>
                              {idx < arr.length - 1 && <Text color="gray.400">›</Text>}
                            </HStack>
                          );
                        })}
                      </HStack>

                      <HStack justify="space-between">
                        <Text fontSize="xs" color="gray.700">
                          {recommendMutation.progress.statusMessage || 'Starting…'}
                        </Text>
                        {recommendMutation.progress.chunkChars > 0 && (
                          <Text fontSize="2xs" color="gray.500">
                            {recommendMutation.progress.chunkChars.toLocaleString()} chars · {Math.round(recommendMutation.progress.percent)}%
                          </Text>
                        )}
                      </HStack>
                    </>
                  )}
                </Box>
              )}

              {/* Results — accordion with details. Hide recommendations whose
                  indicator has no calculator: they can't be computed anyway, so
                  showing them just adds noise. Fall back to the full list while
                  the calculators query is still loading (calculatorIds empty). */}
              {recommendations.length > 0 ? (
                <VStack align="stretch" spacing={3}>
                  {(() => {
                    const visibleRecs = calculatorIds.size > 0
                      ? recommendations.filter(rec => calculatorIds.has(rec.indicator_id))
                      : recommendations;
                    const hiddenRecs = calculatorIds.size > 0
                      ? recommendations.filter(rec => !calculatorIds.has(rec.indicator_id))
                      : [];
                    const hidden = hiddenRecs.length;
                    return (
                      <>
                        {hidden > 0 && (
                          <Box
                            fontSize="xs"
                            color="gray.600"
                            p={2}
                            bg="orange.50"
                            borderRadius="md"
                            borderLeft="3px solid"
                            borderColor="orange.300"
                          >
                            <Text fontWeight="semibold" mb={0.5}>
                              {hidden} recommendation{hidden > 1 ? 's' : ''} hidden — no calculator available
                            </Text>
                            <Text>
                              {hiddenRecs
                                .map(r => `${r.indicator_id} (${r.indicator_name})`)
                                .join('; ')}
                            </Text>
                          </Box>
                        )}
                        <Accordion allowMultiple>
                          {visibleRecs.map((rec) => (
                            <RecommendationItem
                              key={rec.indicator_id}
                              rec={rec}
                              selected={selectedIndicatorIds.has(rec.indicator_id)}
                              onToggle={toggleIndicator}
                              hasCalculator={calculatorIds.has(rec.indicator_id)}
                            />
                          ))}
                        </Accordion>
                      </>
                    );
                  })()}

                  {/* Relationships */}
                  {indicatorRelationships.length > 0 && (
                    <Box>
                      <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={1}>Relationships</Text>
                      <VStack align="stretch" spacing={1}>
                        {indicatorRelationships.map((rel, i) => (
                          <HStack key={i} fontSize="xs" spacing={1}>
                            <Badge fontSize="2xs">{rel.indicator_a}</Badge>
                            <Badge fontSize="2xs" colorScheme={rel.relationship_type === 'synergistic' ? 'green' : rel.relationship_type === 'inverse' ? 'red' : 'gray'}>
                              {rel.relationship_type}
                            </Badge>
                            <Badge fontSize="2xs">{rel.indicator_b}</Badge>
                          </HStack>
                        ))}
                      </VStack>
                    </Box>
                  )}

                  {/* Summary */}
                  {recommendationSummary && (
                    <Box>
                      <Divider mb={2} />
                      {recommendationSummary.key_findings?.length > 0 && (
                        <Box mb={2}>
                          <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={1}>Key Findings</Text>
                          <List spacing={0}>
                            {recommendationSummary.key_findings.map((f: string, i: number) => (
                              <ListItem key={i} fontSize="xs" display="flex" alignItems="start">
                                <Box as="span" color="green.500" mr={1} flexShrink={0}>&#x2713;</Box>
                                {f}
                              </ListItem>
                            ))}
                          </List>
                        </Box>
                      )}
                      {recommendationSummary.evidence_gaps?.length > 0 && (
                        <Box>
                          <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={1}>Evidence Gaps</Text>
                          <List spacing={0}>
                            {recommendationSummary.evidence_gaps.map((g: string, i: number) => (
                              <ListItem key={i} fontSize="xs" display="flex" alignItems="start">
                                <Box as="span" color="orange.500" mr={1} flexShrink={0}>&#x26A0;</Box>
                                {g}
                              </ListItem>
                            ))}
                          </List>
                        </Box>
                      )}
                    </Box>
                  )}
                </VStack>
              ) : !recommendMutation.isPending ? (
                <Text fontSize="sm" color="gray.500" textAlign="center">
                  Click "Get Recommendations" to start
                </Text>
              ) : null}
            </CardBody>
          </Card>
          </ErrorBoundary>
        </VStack>
      </SimpleGrid>

      {/* Inline blocker — shown only when user clicks Next while a hard
          precondition is unmet. Cleared when the user takes any action. */}
      {proceedBlocker === 'no-zones' && routeProjectId && (
        <Alert status="warning" mt={6} borderRadius="md">
          <AlertIcon />
          <Box flex={1}>
            <Text fontWeight="bold">No images assigned to zones</Text>
            <Text fontSize="sm">
              Go back to the Images step and assign images to zones before continuing.
            </Text>
          </Box>
          <Button
            as={Link}
            to={`/projects/${routeProjectId}`}
            size="sm"
            colorScheme="orange"
            variant="outline"
            mr={2}
          >
            Back: Images
          </Button>
          <CloseButton onClick={() => setProceedBlocker(null)} />
        </Alert>
      )}
      {proceedBlocker === 'no-masks' && (
        <Alert status="warning" mt={6} borderRadius="md">
          <AlertIcon />
          <Box flex={1}>
            <Text fontWeight="bold">No images analyzed yet</Text>
            <Text fontSize="sm">
              Run Vision Analysis above on at least one zone-assigned image before continuing.
            </Text>
          </Box>
          <CloseButton onClick={() => setProceedBlocker(null)} />
        </Alert>
      )}

      {/* Navigation buttons */}
      {routeProjectId && (
        <HStack justify="space-between" mt={proceedBlocker ? 3 : 6}>
          <Button as={Link} to={`/projects/${routeProjectId}`} variant="outline">
            Back: Images
          </Button>
          <Button colorScheme="blue" onClick={handleNextClick}>
            Next: Analysis
          </Button>
        </HStack>
      )}

      {/* Soft-warning confirm — partial semantic coverage and/or partial FMB
          coverage. Both are non-blocking; pipeline will skip unprocessed images. */}
      <AlertDialog
        isOpen={proceedSoft !== null}
        leastDestructiveRef={proceedCancelRef}
        onClose={() => setProceedSoft(null)}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader fontSize="lg" fontWeight="bold">
              Some images are not fully analyzed
            </AlertDialogHeader>
            <AlertDialogBody>
              {proceedSoft && proceedSoft.semanticDone < proceedSoft.semanticTotal && (
                <Text fontSize="sm" mb={2}>
                  <strong>{proceedSoft.semanticDone}</strong> of{' '}
                  <strong>{proceedSoft.semanticTotal}</strong> zone-assigned images are
                  analyzed. The remaining {proceedSoft.semanticTotal - proceedSoft.semanticDone}{' '}
                  will be skipped in the pipeline.
                </Text>
              )}
              {proceedSoft && proceedSoft.fmbDone < proceedSoft.fmbTotal && (
                <Text fontSize="sm" color="gray.600">
                  {proceedSoft.fmbDone} of {proceedSoft.fmbTotal} analyzed images have FMB
                  layer masks. Images without FMB masks will only have full-layer analysis.
                </Text>
              )}
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={proceedCancelRef} onClick={() => setProceedSoft(null)}>
                Cancel
              </Button>
              <Button
                colorScheme="blue"
                ml={3}
                onClick={() => {
                  setProceedSoft(null);
                  navigateToAnalysis();
                }}
              >
                Continue anyway
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </PageShell>
  );
}

export default VisionAnalysis;
