import { useCallback, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../hooks/useApi';
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
  Alert,
  AlertIcon,
  Tag,
  TagLabel,
  Wrap,
  WrapItem,
  Tooltip,
} from '@chakra-ui/react';
import { BarChart3, ArrowRight } from 'lucide-react';
import {
  useCalculators,
  useProjects,
} from '../hooks/useApi';
import type {
  ProjectPipelineProgress,
} from '../types';
import useAppStore from '../store/useAppStore';
import useAppToast from '../hooks/useAppToast';
import PageShell from '../components/PageShell';
import PageHeader from '../components/PageHeader';
import { ErrorBoundary } from '../components/ErrorBoundary';

const STEP_STATUS_COLORS: Record<string, string> = {
  completed: 'green',
  skipped: 'gray',
  failed: 'red',
};

function Analysis() {
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useAppToast();
  const {
    selectedIndicators,
    pipelineResult,
    zoneAnalysisResult,
    pipelineRun,
    startPipeline,
    setSingleZoneStrategy,
    setMultiZoneStrategy,
  } = useAppStore();

  // Re-pickable entry gate — every navigation from Analysis to Reports
  // resets the per-session path picks (singleZoneStrategy / multiZoneStrategy)
  // back to null. This forces the multi-zone or single-zone entry-card
  // picker to re-fire on the Reports page even if the user previously chose
  // a path in this session, so they can switch from Zone-only to
  // Within-zone clustering (or vice versa) just by going back and forward
  // again. Without the reset, the picker only fires once per project mount
  // — fine for a fresh load, frustrating when iterating.
  const goToReports = useCallback(() => {
    setSingleZoneStrategy(null);
    setMultiZoneStrategy(null);
    navigate(`/projects/${routeProjectId}/reports`);
  }, [setSingleZoneStrategy, setMultiZoneStrategy, navigate, routeProjectId]);

  // v4.x — Analysis pipeline is calc-only. The previous "Use LLM (Stage 3)"
  // switch was misleading because the backend has unconditionally skipped
  // Stage 3 in the pipeline since v4/Module 14 (see
  // packages/backend/app/api/routes/analysis.py:1948-1981). All LLM-driven
  // analysis (design strategies, AI report, per-chart summaries) and
  // clustering are now triggered on demand from per-section buttons on the
  // Reports page. No pipeline config beyond indicator selection remains.

  // Queries
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: calculators } = useCalculators();

  const selectedProjectId = routeProjectId || '';
  const selectedProject = useMemo(() => {
    if (!selectedProjectId || !projects) return null;
    return projects.find(p => p.id === selectedProjectId) ?? null;
  }, [selectedProjectId, projects]);
  const selectedIndicatorIds = useMemo(() => {
    if (!calculators || calculators.length === 0) return [];
    // Prefer the FETCHED project's selected_indicators so the chips render as
    // soon as the project list lands — independent of when the Zustand store
    // hydrates. Navigating BACK to this page used to flash "0 indicators"
    // until store hydration caught up; the store is the pre-hydration fallback.
    const src = (selectedProject?.selected_indicators ?? selectedIndicators) as { indicator_id: string }[];
    return src
      .map(i => i.indicator_id)
      .filter(id => calculators.some(c => c.id === id));
  }, [selectedProject, selectedIndicators, calculators]);

  // A pipeline is "running for *this* project" iff the global run state is
  // active and pinned to this projectId. If another project's pipeline is in
  // flight we treat this view as idle but disable the Run button below.
  const isRunningHere = pipelineRun.isRunning && pipelineRun.projectId === selectedProjectId;
  const isRunningElsewhere = pipelineRun.isRunning && pipelineRun.projectId !== selectedProjectId;
  const streamSteps = isRunningHere ? pipelineRun.steps : [];
  const imageProgress = isRunningHere ? pipelineRun.imageProgress : null;
  // The per-image counters are only meaningful while run_calculations is
  // active; once that step completes, hide them so they don't show stale
  // values while later stages run.
  const calcDone = streamSteps.some(s => s.step === 'run_calculations' && s.status === 'completed');

  const projectSummary = useMemo(() => {
    if (!selectedProject) return null;
    const totalImages = selectedProject.uploaded_images.length;
    const assigned = selectedProject.uploaded_images.filter(img => img.zone_id);
    const assignedImages = assigned.length;
    const analyzedImages = assigned.filter(img => {
      const mp = img.mask_filepaths;
      return !!(mp?.semantic_map || mp?.front_semantic_map || mp?.left_semantic_map || mp?.right_semantic_map);
    }).length;
    const zones = selectedProject.spatial_zones.length;
    return { totalImages, assignedImages, analyzedImages, zones };
  }, [selectedProject]);

  const queryClient = useQueryClient();
  const handleRunPipeline = useCallback(async () => {
    if (!selectedProjectId || selectedIndicatorIds.length === 0) return;
    const projectName = selectedProject?.project_name || routeProjectId || 'Unknown';
    // v4.x — When the project is in panorama mode, run the pipeline
    // sequentially per active view. The store-level loop in startPipeline
    // takes care of sequencing; we just hand it the views the user picked
    // in Vision Analysis (persisted on `project.active_panorama_views`).
    // Empty / undefined → legacy single-view run.
    const panoramaViews = selectedProject?.active_panorama_views ?? [];
    await startPipeline({
      projectId: selectedProjectId,
      projectName,
      indicatorIds: selectedIndicatorIds,
      panoramaViews: panoramaViews.length > 0 ? panoramaViews : undefined,
      onComplete: () => {
        toast({ title: 'Pipeline complete', status: 'success', duration: 3000 });
        // CRITICAL — refetch the project from /api/projects/{id} so the
        // frontend's zoneAnalysisResult includes the FULL image_records
        // payload that the backend just persisted. The SSE result event
        // intentionally strips image_records to keep its frame small
        // (large projects can blow past proxy limits), so the in-memory
        // store after the pipeline ends has zone_analysis.image_records=[].
        // Without this refetch, navigating to Reports would hit the
        // imageRecords-empty fallback (rebuildImageRecords) and the
        // C1/C3/C4 charts would silently disappear because their
        // isAvailable check requires imageRecords.length > 0.
        if (selectedProjectId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.project(selectedProjectId) });
        }
      },
      onError: (msg) => toast({ title: msg, status: 'error' }),
    });
  }, [selectedProjectId, selectedIndicatorIds, selectedProject, routeProjectId, startPipeline, toast, queryClient]);

  // Pipeline ran successfully — user can proceed to Reports even if zone_analysis
  // is empty (e.g. n_zones=1 with nothing to compare). Reports page handles nulls.
  const hasResults = pipelineResult !== null;

  return (
    <PageShell>
      <PageHeader title="Analysis Pipeline" />

      {/* Pipeline Configuration */}
      {/* v4.x — Per-card ErrorBoundary so a crash in the config form (e.g.
          missing indicator definitions, malformed project payload) doesn't
          take out the pipeline detail card or results summary below it. */}
      <ErrorBoundary label="Pipeline Configuration card">
      <Card mb={6}>
        <CardHeader>
          <Heading size="md">Pipeline Configuration</Heading>
        </CardHeader>
        <CardBody>
          <Text fontWeight="bold" mb={3}>
            Project: {selectedProject?.project_name || (projectsLoading ? 'Loading…' : (routeProjectId || 'No project'))}
          </Text>

          {isRunningElsewhere && (
            <Alert status="warning" mb={4}>
              <AlertIcon />
              A pipeline is already running for another project ({pipelineRun.projectName}).
              Wait for it to finish before starting a new run.
            </Alert>
          )}

          {projectSummary && (
            <>
              <Alert status={projectSummary.assignedImages > 0 ? 'info' : 'warning'} mb={4}>
                <AlertIcon />
                {projectSummary.assignedImages} of {projectSummary.totalImages} images assigned to {projectSummary.zones} zones
              </Alert>
              {projectSummary.assignedImages > 0 && projectSummary.analyzedImages === 0 && (
                <Alert status="error" mb={4}>
                  <AlertIcon />
                  No images have been analyzed by Vision API. Go to Prepare step to run vision analysis first.
                </Alert>
              )}
              {projectSummary.analyzedImages > 0 && projectSummary.analyzedImages < projectSummary.assignedImages && (
                <Alert status="warning" mb={4}>
                  <AlertIcon />
                  Only {projectSummary.analyzedImages} of {projectSummary.assignedImages} zone-assigned images have vision results. Unanalyzed images will be skipped.
                </Alert>
              )}
            </>
          )}

          <Box mb={4}>
            <Text fontSize="sm" fontWeight="bold" mb={2}>
              Selected Indicators ({selectedIndicatorIds.length})
            </Text>
            <Wrap>
              {selectedIndicatorIds.map(id => (
                <WrapItem key={id}>
                  <Tag size="sm" colorScheme="blue"><TagLabel>{id}</TagLabel></Tag>
                </WrapItem>
              ))}
            </Wrap>
            {selectedIndicatorIds.length === 0 && selectedProject && (
              <Text fontSize="sm" color="orange.500">
                No indicators selected. Go back to the Indicators step to select indicators.
              </Text>
            )}
            {selectedIndicatorIds.length === 0 && !selectedProject && projectsLoading && (
              <Text fontSize="sm" color="gray.500">Loading project…</Text>
            )}
          </Box>

          {/* v4.x — No "Analysis Parameters" block. The previous Stage 3 LLM
              toggle was removed because the backend always skips Stage 3 in
              the pipeline; design strategies + AI report + clustering all run
              on demand from per-section Generate buttons on the Reports page.
              See the comment near `const handleRunPipeline` above. */}
          <Alert status="info" mb={4} mt={2} fontSize="sm">
            <AlertIcon />
            <Box>
              This pipeline only computes indicator values. LLM analysis
              (design strategies, AI report) and clustering are triggered
              on demand from the Reports page after you pick a view.
            </Box>
          </Alert>

          <Button
            colorScheme="green"
            onClick={handleRunPipeline}
            isLoading={isRunningHere}
            isDisabled={
              !selectedProjectId ||
              selectedIndicatorIds.length === 0 ||
              pipelineRun.isRunning ||
              projectSummary?.analyzedImages === 0
            }
            mt={2}
          >
            Run Pipeline
          </Button>
        </CardBody>
      </Card>
      </ErrorBoundary>

      {/* Pipeline detail during a streaming run — complements the top sticky
          banner (which already shows progress %, ETA, active stage, Cancel).
          This card carries info the banner can't fit: the current image
          filename, success/failure counters, and the full stage history. */}
      {isRunningHere && (
        <ErrorBoundary label="Pipeline Status Detail card">
        <Card mb={6}>
          <CardHeader>
            <Heading size="md">Pipeline Detail</Heading>
          </CardHeader>
          <CardBody>
            <VStack align="stretch" spacing={4}>
              {/* Per-image counters (only meaningful during run_calculations) */}
              {imageProgress && !calcDone && (
                <HStack spacing={4} fontSize="sm">
                  <Text noOfLines={1} flex={1} color="gray.700">
                    Current:{' '}
                    <Text as="span" fontWeight="semibold">{imageProgress.filename}</Text>
                  </Text>
                  <Text color="green.600">{imageProgress.succeeded} ok</Text>
                  {imageProgress.failed > 0 && <Text color="red.600">{imageProgress.failed} failed</Text>}
                  {imageProgress.cached > 0 && <Text color="gray.500">{imageProgress.cached} cached</Text>}
                </HStack>
              )}

              {/* Pipeline stage list — fills in as SSE status events arrive */}
              {streamSteps.length > 0 && (
                <Box>
                  <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={2} textTransform="uppercase">
                    Stages
                  </Text>
                  <VStack align="stretch" spacing={1}>
                    {streamSteps.map((s, i) => (
                      <HStack key={i} fontSize="sm" spacing={2}>
                        <Badge
                          colorScheme={
                            s.status === 'completed' ? 'green' :
                            s.status === 'failed' ? 'red' :
                            s.status === 'running' ? 'blue' : 'gray'
                          }
                          variant={s.status === 'running' ? 'solid' : 'subtle'}
                        >
                          {s.status}
                        </Badge>
                        <Text fontWeight="semibold">{s.step}</Text>
                        <Text color="gray.600" fontSize="xs" noOfLines={1}>{s.detail}</Text>
                      </HStack>
                    ))}
                  </VStack>
                </Box>
              )}

              {!imageProgress && streamSteps.length === 0 && (
                <Text fontSize="sm" color="gray.500">Initializing pipeline…</Text>
              )}
            </VStack>
          </CardBody>
        </Card>
        </ErrorBoundary>
      )}

      {/* Pipeline Result Summary */}
      {pipelineResult && !isRunningHere && (
        <ErrorBoundary label="Pipeline Results Summary card">
        <Card mb={6}>
          <CardHeader>
            <Heading size="md">Pipeline Results</Heading>
          </CardHeader>
          <CardBody>
            <SimpleGrid columns={{ base: 2, md: 5 }} spacing={4} mb={4}>
              <Box>
                <Text fontSize="xs" color="gray.500">Images</Text>
                <Text fontSize="xl" fontWeight="bold">{pipelineResult.zone_assigned_images} / {pipelineResult.total_images}</Text>
              </Box>
              <Box>
                <Text fontSize="xs" color="gray.500">Calculated</Text>
                <Text fontSize="xl" fontWeight="bold" color="green.600">
                  {pipelineResult.calculations_succeeded + pipelineResult.calculations_cached}
                </Text>
                {pipelineResult.calculations_cached > 0 && (
                  <Text fontSize="2xs" color="gray.400">
                    {pipelineResult.calculations_succeeded} new, {pipelineResult.calculations_cached} cached
                  </Text>
                )}
              </Box>
              <Box>
                <Text fontSize="xs" color="gray.500">Failed</Text>
                <Text fontSize="xl" fontWeight="bold" color={pipelineResult.calculations_failed > 0 ? 'red.600' : 'gray.400'}>
                  {pipelineResult.calculations_failed}
                </Text>
              </Box>
              <Box>
                <Text fontSize="xs" color="gray.500">Zone Stats</Text>
                <Text fontSize="xl" fontWeight="bold">{pipelineResult.zone_statistics_count}</Text>
              </Box>
              <Box>
                <Text fontSize="xs" color="gray.500">Zones Analyzed</Text>
                <Text fontSize="xl" fontWeight="bold">
                  {zoneAnalysisResult?.zone_diagnostics?.length ?? 0}
                </Text>
              </Box>
            </SimpleGrid>

            <Wrap spacing={2} mb={4}>
              {pipelineResult.steps
                // v4 — hide design_strategies pipeline-stage badge here.
                // For single-zone projects this stage is intentionally skipped
                // (strategies are auto-fired on the Reports page after the
                // user picks Single/Dual View at the entry gate). Showing
                // "DESIGN_STRATEGIES: SKIPPED" up here just confused users
                // into thinking something failed.
                .filter((step: ProjectPipelineProgress) => step.step !== 'design_strategies')
                .map((step: ProjectPipelineProgress, idx: number) => (
                  <WrapItem key={idx}>
                    <Tooltip label={step.detail}>
                      <Badge colorScheme={STEP_STATUS_COLORS[step.status] || 'gray'} variant="subtle" px={2} py={1}>
                        {step.step}: {step.status}
                      </Badge>
                    </Tooltip>
                  </WrapItem>
                ))}
            </Wrap>

            {hasResults && (
              <Button
                colorScheme="blue"
                size="lg"
                rightIcon={<ArrowRight size={18} />}
                onClick={goToReports}
                w="full"
                mb={4}
              >
                View Results & Report
              </Button>
            )}

            {pipelineResult.skipped_images?.length > 0 && (
              <Alert status="info" borderRadius="md" alignItems="flex-start">
                <AlertIcon mt={1} />
                <Box flex={1}>
                  <HStack justify="space-between" align="flex-start" mb={1}>
                    <Text fontSize="sm" fontWeight="bold">
                      {pipelineResult.skipped_images.length} image(s) skipped — results are based on the remaining images
                    </Text>
                    <Button
                      size="xs"
                      colorScheme="orange"
                      variant="outline"
                      onClick={() => navigate(`/projects/${routeProjectId}/vision`)}
                      flexShrink={0}
                    >
                      Retry Vision
                    </Button>
                  </HStack>
                  <Text fontSize="xs" color="gray.600" mb={2}>
                    {pipelineResult.skipped_images.filter(s => s.reason === 'no_semantic_map').length > 0 &&
                      `${pipelineResult.skipped_images.filter(s => s.reason === 'no_semantic_map').length} not analyzed by Vision API`}
                    {pipelineResult.skipped_images.filter(s => s.reason === 'no_semantic_map').length > 0 &&
                      pipelineResult.skipped_images.filter(s => s.reason === 'invalid_semantic_map').length > 0 && ', '}
                    {pipelineResult.skipped_images.filter(s => s.reason === 'invalid_semantic_map').length > 0 &&
                      `${pipelineResult.skipped_images.filter(s => s.reason === 'invalid_semantic_map').length} invalid semantic map (single-color)`}
                  </Text>
                  <Wrap spacing={1}>
                    {pipelineResult.skipped_images.slice(0, 10).map(s => (
                      <WrapItem key={s.image_id}>
                        <Tag size="sm" colorScheme={s.reason === 'no_semantic_map' ? 'orange' : 'red'} variant="subtle">
                          <TagLabel>{s.filename}</TagLabel>
                        </Tag>
                      </WrapItem>
                    ))}
                    {pipelineResult.skipped_images.length > 10 && (
                      <WrapItem>
                        <Tag size="sm" variant="subtle">+{pipelineResult.skipped_images.length - 10} more</Tag>
                      </WrapItem>
                    )}
                  </Wrap>
                </Box>
              </Alert>
            )}
          </CardBody>
        </Card>
        </ErrorBoundary>
      )}

      {/* Empty state */}
      {!pipelineResult && !isRunningHere && (
        <Card>
          <CardBody textAlign="center" py={10}>
            <BarChart3 size={48} style={{ margin: '0 auto', opacity: 0.3 }} />
            <Text color="gray.500" mt={4}>
              Configure parameters above and run the pipeline to start analysis.
            </Text>
          </CardBody>
        </Card>
      )}

      {/* Navigation */}
      {routeProjectId && (
        <HStack justify="space-between" mt={6}>
          <Button as={Link} to={`/projects/${routeProjectId}/vision`} variant="outline">
            Back: Prepare
          </Button>
          <Button
            colorScheme="blue"
            isDisabled={!hasResults}
            onClick={goToReports}
          >
            Next: Results & Report
          </Button>
        </HStack>
      )}
    </PageShell>
  );
}

export default Analysis;
