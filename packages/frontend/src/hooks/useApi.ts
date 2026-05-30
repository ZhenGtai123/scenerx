import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import type { ProjectCreate, ZoneAnalysisRequest, FullAnalysisRequest, ProjectPipelineRequest, ReportRequest, ClusteringRequest, ClusteringByProjectRequest, MergedExportRequest, GroupingMode, RecommendationResponse } from '../types';

// Query keys
export const queryKeys = {
  health: ['health'],
  config: ['config'],
  visionHealth: ['vision-health'],
  llmProviders: ['llm-providers'],
  projects: ['projects'],
  project: (id: string) => ['project', id],
  calculators: ['calculators'],
  calculator: (id: string) => ['calculator', id],
  semanticConfig: ['semanticConfig'],
  knowledgeBase: ['knowledgeBase'],
  providerModels: (provider: string) => ['provider-models', provider],
  task: (id: string) => ['task', id],
  encodingSections: ['encoding-sections'],
};

// Health & Config hooks
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => api.health().then((r) => r.data),
    refetchInterval: 30000,
  });
}

export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => api.getConfig().then((r) => r.data),
  });
}

// Vision API health + model info. Cached for a couple minutes so that
// opening / closing the SettingsDrawer doesn't re-ping a slow Vision API
// every time. Manual refresh (the Test button) calls
// queryClient.invalidateQueries({ queryKey: queryKeys.visionHealth }).
export function useVisionHealth(enabled = true) {
  return useQuery({
    queryKey: ['vision-health'],
    queryFn: () => api.testVision().then((r) => r.data),
    enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
}

// LLM Provider hooks
export function useLLMProviders() {
  return useQuery({
    queryKey: queryKeys.llmProviders,
    queryFn: () => api.getLLMProviders().then((r) => r.data),
  });
}

// Provider models hook
export function useProviderModels(provider: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providerModels(provider || ''),
    queryFn: () => api.getProviderModels(provider!).then((r) => r.data),
    enabled: !!provider,
    staleTime: 5 * 60 * 1000, // cache 5 min
  });
}

// Project hooks
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.projects.list().then((r) => r.data),
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => api.projects.get(id).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: ProjectCreate) => api.projects.create(data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// Calculator hooks
export function useCalculators() {
  return useQuery({
    queryKey: queryKeys.calculators,
    queryFn: () => api.metrics.list().then((r) => r.data),
  });
}

export function useCalculator(id: string) {
  return useQuery({
    queryKey: queryKeys.calculator(id),
    queryFn: () => api.metrics.get(id).then((r) => r.data),
    enabled: !!id,
  });
}

export function useUploadCalculator() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => api.metrics.upload(file).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.calculators });
    },
  });
}

// Semantic config hooks
export function useSemanticConfig() {
  return useQuery({
    queryKey: queryKeys.semanticConfig,
    queryFn: () => api.vision.getSemanticConfig().then((r) => r.data),
  });
}

// Knowledge base hooks
export function useKnowledgeBaseSummary() {
  return useQuery({
    queryKey: queryKeys.knowledgeBase,
    queryFn: () => api.indicators.getKnowledgeBaseSummary().then((r) => r.data),
  });
}

// Task polling hook
export function useTaskStatus(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.task(taskId || ''),
    queryFn: () => api.tasks.getStatus(taskId!).then((r) => r.data),
    enabled: enabled && !!taskId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      if (data.status === 'SUCCESS' || data.status === 'FAILURE' || data.status === 'REVOKED') {
        return false;
      }
      return 2000;
    },
  });
}

// Analysis mutations
export function useRunZoneAnalysis() {
  return useMutation({
    mutationFn: (data: ZoneAnalysisRequest) =>
      api.analysis.runZoneStatistics(data).then(r => r.data),
  });
}

export function useRunClustering() {
  return useMutation({
    mutationFn: (data: ClusteringRequest) =>
      api.analysis.runClustering(data).then(r => r.data),
  });
}

export function useRunClusteringByProject() {
  return useMutation({
    mutationFn: (data: ClusteringByProjectRequest) =>
      api.analysis.runClusteringByProject(data).then(r => r.data),
  });
}

/** Within-zone clustering: cluster each zone's images independently, return a
 *  composite ZoneAnalysisResult treating sub-clusters as virtual sub-zones. */
export function useRunClusteringWithinZones() {
  return useMutation({
    mutationFn: (data: ClusteringByProjectRequest) =>
      api.analysis.runClusteringWithinZones(data).then(r => r.data),
  });
}

export function useExportMerged() {
  return useMutation({
    mutationFn: (data: MergedExportRequest) =>
      api.analysis.exportMerged(data).then(r => r.data),
  });
}

export function useRunDesignStrategies() {
  return useMutation({
    mutationFn: (data: unknown) =>
      api.analysis.runDesignStrategies(data).then(r => r.data),
  });
}

export function useRunFullAnalysis() {
  return useMutation({
    mutationFn: (data: FullAnalysisRequest) =>
      api.analysis.runFull(data).then(r => r.data),
  });
}

export function useRunProjectPipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProjectPipelineRequest) =>
      api.analysis.runProjectPipeline(data).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useGenerateReport() {
  return useMutation({
    mutationFn: (data: ReportRequest) =>
      api.analysis.generateReport(data).then(r => r.data),
  });
}

interface ChartSummaryArgs {
  chart_id: string;
  chart_title: string;
  chart_description?: string | null;
  project_id: string;
  payload: Record<string, unknown>;
  project_context?: Record<string, unknown> | null;
  /** #6 — query key includes this so Zone-mode and Cluster-mode summaries
   * don't collide in the React Query cache. */
  grouping_mode?: GroupingMode;
  /** When false, the query is held back until the user opens the panel. */
  enabled?: boolean;
}

export function useChartSummary(args: ChartSummaryArgs) {
  const { enabled = false, ...body } = args;
  return useQuery({
    queryKey: [
      'chart-summary',
      body.chart_id,
      body.project_id,
      body.grouping_mode ?? 'zones',
      body.payload,
    ],
    queryFn: () => api.analysis.chartSummary(body).then(r => r.data),
    enabled,
    staleTime: 1000 * 60 * 60, // 1 hour — backend cache is the real TTL
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

// Vision project image analysis mutation
export function useAnalyzeProjectImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, imageId, request }: { projectId: string; imageId: string; request: Record<string, unknown> }) =>
      api.vision.analyzeProjectImage(projectId, imageId, request).then(r => r.data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(variables.projectId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Indicator recommendation — streaming
// ---------------------------------------------------------------------------
//
// Switched from the blocking POST /api/indicators/recommend to the SSE
// endpoint /api/indicators/recommend/stream so the UI can render real per-
// stage progress instead of a 2-5 min black box. The backend emits four
// event types (gemini_client.py:recommend_indicators_stream):
//
//   status  — coarse stage transitions ("Retrieving evidence…", "Built N
//             assessment cards from M evidence records", "LLM is generating
//             recommendations…")
//   chunk   — incremental text from the LLM JSON output
//   result  — final parsed RecommendationResponse
//   error   — terminal failure
//
// We map these onto a 4-stage progress model with rough percent estimates.
// The LLM-generating stage is the dominant cost (typically 80%+ of wall time)
// so we let it advance smoothly from 50% → 95% based on streamed char count
// (capped, since we don't know the exact final length up front).
//
// `progress` is attached to the returned mutation object so existing call
// sites can keep using `mutation.isPending` / `mutation.mutate(...)` and
// simply read `mutation.progress` for the bar.
export type RecommendStage =
  | 'idle'
  | 'retrieving'
  | 'cards'
  | 'generating'
  | 'done'
  | 'error';

export interface RecommendProgress {
  stage: RecommendStage;
  statusMessage: string;
  chunkCount: number;
  chunkChars: number;
  percent: number; // 0-100
}

const INITIAL_PROGRESS: RecommendProgress = {
  stage: 'idle',
  statusMessage: '',
  chunkCount: 0,
  chunkChars: 0,
  percent: 0,
};

// Stage → base percent. The generating stage slides 50→95 based on streamed
// char volume against an expected response size (heuristic, see below).
const STAGE_BASE_PERCENT: Record<RecommendStage, number> = {
  idle: 0,
  retrieving: 10,
  cards: 35,
  generating: 50,
  done: 100,
  error: 0,
};

// Rough expected response length in chars. A typical recommendation set
// (~10 indicators with rationale + relationships + summary) is around
// 5-8 KB of JSON. We use 6000 as the soft target so the bar fills up
// gradually without finishing prematurely on shorter responses.
const EXPECTED_RESPONSE_CHARS = 6000;

function classifyStatusMessage(msg: string): RecommendStage {
  const m = msg.toLowerCase();
  if (m.includes('retriev')) return 'retrieving';
  // Backend emits "Built {n} assessment cards from {m} evidence records"
  if (m.includes('built') || m.includes('assessment card')) return 'cards';
  // Backend emits "LLM is generating recommendations…"
  if (m.includes('llm') || m.includes('generat')) return 'generating';
  return 'retrieving'; // safe default for any unknown early status
}

export function useRecommendIndicators() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RecommendProgress>(INITIAL_PROGRESS);

  const mutation = useMutation({
    // Stage 1 returns a refreshed recommendation set; invalidate the
    // cached project so the next render picks up the new indicators
    // instead of showing the stale list (which would otherwise blank
    // the panel when the user switches an indicator).
    onSuccess: (_, variables) => {
      if (variables.project_id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.project(variables.project_id) });
      }
    },
    mutationFn: (request: {
      project_name: string;
      performance_dimensions: string[];
      subdimensions?: string[];
      design_brief?: string;
      project_location?: string;
      space_type_id?: string;
      koppen_zone_id?: string;
      lcz_type_id?: string;
      age_group_id?: string;
      project_id?: string;
    }) =>
      new Promise<RecommendationResponse>((resolve, reject) => {
        // Reset to a fresh "Starting…" state for every new call. We
        // initialise at the retrieving stage with a small non-zero percent
        // so the bar shows movement immediately on click instead of
        // appearing inert.
        setProgress({
          stage: 'retrieving',
          statusMessage: 'Starting…',
          chunkCount: 0,
          chunkChars: 0,
          percent: 5,
        });

        let finalResponse: RecommendationResponse | null = null;
        let terminalError: Error | null = null;

        api.indicators
          .recommendStream(request, (event) => {
            if (event.type === 'status') {
              const msg = event.message || '';
              const stage = classifyStatusMessage(msg);
              setProgress((p) => ({
                ...p,
                stage,
                statusMessage: msg,
                // Snap forward to the new stage's base percent — but never
                // go backwards if a later message somehow arrives out of
                // order (Math.max guards against an over-eager status
                // dropping us back from generating → cards).
                percent: Math.max(p.percent, STAGE_BASE_PERCENT[stage]),
              }));
            } else if (event.type === 'chunk') {
              const text = event.text || '';
              setProgress((p) => {
                const chunkChars = p.chunkChars + text.length;
                const chunkCount = p.chunkCount + 1;
                // Sliding generating-stage progress: 50% → 95% based on
                // streamed chars vs expected response size. Capped at 95%
                // because the actual completion happens on the `result`
                // event, not the last `chunk` event — we don't want to
                // hit 100% and then sit there waiting.
                const generatePercent = Math.min(
                  STAGE_BASE_PERCENT.generating +
                    (chunkChars / EXPECTED_RESPONSE_CHARS) * 45,
                  95,
                );
                return {
                  ...p,
                  stage: 'generating',
                  chunkCount,
                  chunkChars,
                  // Don't override the smarter status text the user already
                  // sees; only update if we're still on the initial
                  // "Starting…" message.
                  statusMessage:
                    p.statusMessage === 'Starting…'
                      ? 'LLM is generating recommendations…'
                      : p.statusMessage,
                  percent: Math.max(p.percent, generatePercent),
                };
              });
            } else if (event.type === 'result') {
              setProgress((p) => ({
                ...p,
                stage: 'done',
                statusMessage: 'Complete',
                percent: 100,
              }));
              if (event.data) {
                finalResponse = event.data as RecommendationResponse;
              } else {
                terminalError = new Error('Empty result payload');
              }
            } else if (event.type === 'error') {
              const msg = event.message || 'Recommendation failed';
              setProgress((p) => ({
                ...p,
                stage: 'error',
                statusMessage: msg,
              }));
              terminalError = new Error(msg);
            }
          })
          .then(() => {
            // SSE stream closed cleanly. The terminal event must already
            // have set either `finalResponse` or `terminalError`. If
            // neither, the backend dropped the connection before sending a
            // result — treat that as an error so the caller's onError
            // fires instead of an indefinite spinner.
            if (terminalError) {
              reject(terminalError);
            } else if (finalResponse) {
              resolve(finalResponse);
            } else {
              reject(
                new Error(
                  'Stream closed without a result event (connection dropped?)',
                ),
              );
            }
          })
          .catch((err) => {
            // Network / 5xx / fetch-level error before the SSE body could
            // emit a structured `error` event. Propagate so onError fires.
            const msg = err instanceof Error ? err.message : String(err);
            setProgress((p) => ({
              ...p,
              stage: 'error',
              statusMessage: msg,
            }));
            reject(err instanceof Error ? err : new Error(msg));
          });
      }),
  });

  return Object.assign(mutation, { progress });
}

// Auth mutations
export function useLogin() {
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      api.auth.login(username, password).then(r => r.data),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (data: { email: string; username: string; password: string; full_name?: string }) =>
      api.auth.register(data).then(r => r.data),
  });
}

export function useCurrentUser(enabled = false) {
  return useQuery({
    queryKey: ['currentUser'],
    queryFn: () => api.auth.me().then(r => r.data),
    enabled,
    retry: false,
  });
}

// Encoding dictionary (knowledge-base codebook). Static data, cache forever.
export function useEncodingSections() {
  return useQuery({
    queryKey: queryKeys.encodingSections,
    queryFn: () => api.encoding.getSections().then((r) => r.data),
    staleTime: Infinity,
    gcTime: Infinity,
  });
