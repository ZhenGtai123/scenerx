import { useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Box, HStack, Text, Progress, Button, Icon } from '@chakra-ui/react';
import { Activity, X, ExternalLink } from 'lucide-react';
import useAppStore from '../store/useAppStore';

/**
 * Sticky top bar that mirrors the active pipeline run on every page.
 *
 * Pipeline state lives in the global zustand store (`pipelineRun`), so the
 * SSE stream survives Analysis page unmount. This component renders nothing
 * when no run is in flight.
 *
 * Also installs a `beforeunload` warning so closing the tab / refreshing
 * during a run prompts the browser's native "Leave site?" dialog.
 */
function GlobalPipelineProgress() {
  const { pipelineRun, cancelPipeline } = useAppStore();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const onAnalysisPage =
    pipelineRun.projectId !== null &&
    pathname === `/projects/${pipelineRun.projectId}/analysis`;

  useEffect(() => {
    if (!pipelineRun.isRunning) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore the message string and show their own copy,
      // but setting returnValue is what triggers the prompt.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pipelineRun.isRunning]);

  // Image-level percentage is meaningful only during the run_calculations
  // phase. Once that step is `completed`, the imageProgress counters stop
  // updating but stay at 100% — so the bar would falsely look "done" while
  // aggregate / zone_analysis / design_strategies are still running. After
  // run_calculations completes, fall through to indeterminate.
  const calcDone = useMemo(
    () => pipelineRun.steps.some(s => s.step === 'run_calculations' && s.status === 'completed'),
    [pipelineRun.steps],
  );

  const pct = useMemo(() => {
    if (calcDone) return null;
    if (!pipelineRun.imageProgress) return null;
    const { current, total } = pipelineRun.imageProgress;
    if (!total) return null;
    return (current / total) * 100;
  }, [pipelineRun.imageProgress, calcDone]);

  const etaSeconds = useMemo(() => {
    const { imageProgress, startedAt } = pipelineRun;
    if (!imageProgress || !startedAt || imageProgress.current === 0) return null;
    const elapsed = (Date.now() - startedAt) / 1000;
    const perImage = elapsed / imageProgress.current;
    const remaining = imageProgress.total - imageProgress.current;
    return Math.round(perImage * remaining);
  }, [pipelineRun]);

  if (!pipelineRun.isRunning || onAnalysisPage) return null;

  // v4.x — `.at(-1)` returns undefined on empty arrays (vs `[length - 1]`
  // which evaluates to `[-1]` and also returns undefined but reads as a
  // negative-index access). Same runtime behaviour, clearer intent.
  const lastStep = pipelineRun.steps.at(-1);
  const stageLabel = lastStep ? `${lastStep.step} (${lastStep.status})` : 'starting…';

  return (
    <Box
      position="sticky"
      top={0}
      zIndex={20}
      bg="blue.600"
      color="white"
      px={4}
      py={2}
      boxShadow="md"
    >
      <HStack spacing={4} align="center">
        <Icon as={Activity} boxSize={4} />
        <Box flex={1} minW={0}>
          <HStack spacing={3} fontSize="sm" mb={1}>
            <Text fontWeight="bold" noOfLines={1}>
              Pipeline running · {pipelineRun.projectName ?? pipelineRun.projectId}
            </Text>
            {pipelineRun.imageProgress && !calcDone && (
              <Text fontSize="xs" opacity={0.9} whiteSpace="nowrap">
                {pipelineRun.imageProgress.current} / {pipelineRun.imageProgress.total}
                {pct !== null && ` · ${pct.toFixed(0)}%`}
                {etaSeconds !== null && etaSeconds > 0 && ` · ~${formatDuration(etaSeconds)} left`}
              </Text>
            )}
            <Text fontSize="xs" opacity={0.8} noOfLines={1}>
              {stageLabel}
            </Text>
          </HStack>
          {pct !== null ? (
            <Progress
              value={pct}
              size="xs"
              colorScheme="green"
              bg="blue.700"
              hasStripe
              isAnimated
              borderRadius="full"
            />
          ) : (
            <Progress size="xs" isIndeterminate colorScheme="green" bg="blue.700" borderRadius="full" />
          )}
        </Box>
        {!onAnalysisPage && pipelineRun.projectId && (
          <Button
            size="xs"
            leftIcon={<ExternalLink size={12} />}
            variant="outline"
            colorScheme="whiteAlpha"
            color="white"
            borderColor="whiteAlpha.500"
            _hover={{ bg: 'whiteAlpha.200' }}
            onClick={() => navigate(`/projects/${pipelineRun.projectId}/analysis`)}
          >
            View
          </Button>
        )}
        <Button
          size="xs"
          leftIcon={<X size={12} />}
          variant="outline"
          colorScheme="whiteAlpha"
          color="white"
          borderColor="whiteAlpha.500"
          _hover={{ bg: 'red.500', borderColor: 'red.500' }}
          onClick={cancelPipeline}
        >
          Cancel
        </Button>
      </HStack>
    </Box>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export default GlobalPipelineProgress;
