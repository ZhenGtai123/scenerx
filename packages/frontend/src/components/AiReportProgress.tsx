/**
 * AiReportProgress
 * ----------------
 * Determinate progress bar for the AI Report flow (Strategies → Report).
 *
 * Why a custom component instead of just `<Progress isIndeterminate />`?
 * Strategy generation iterates over K zones/clusters with 2 LLM calls per
 * unit (diagnosis + synthesis). For K=5 clusters that's 10+ LLM round-trips
 * — about 60-90s of waiting. A two-step bar ("Step 1/2 → Step 2/2") gave
 * the user no sense of how far through the slow phase they were and made
 * Option C cluster generation feel pathologically slower than Option B
 * single-zone generation.
 *
 * This component renders three pieces of feedback:
 *   1. A determinate Chakra `<Progress>` bar covering the whole flow,
 *      weighted 70% strategies / 30% report (since strategies dominate
 *      the wall-clock time at K>=2).
 *   2. A primary status label ("Cluster 3 / 5 — synthesizing strategies…").
 *   3. A secondary elapsed-time counter so the user knows the page is
 *      alive even when an individual LLM call is slow.
 *
 * The component is purely presentational. It accepts a single `state` prop
 * shaped like the union below; the parent (Reports.tsx) is responsible for
 * mapping SSE events into that state.
 */

import { Box, HStack, Progress, Text, VStack } from '@chakra-ui/react';
import { useEffect, useState } from 'react';

export type AiReportProgressState =
  /** No flow active — render nothing. */
  | { kind: 'idle' }
  /** Stage 1 (design strategies) has started but no per-unit events yet. */
  | { kind: 'strategies_starting'; unitTotal: number }
  /** Stage 1 in flight — currently working on `unitIndex` of `unitTotal`. */
  | {
      kind: 'strategies_running';
      stage: 'diagnosis' | 'strategies' | 'unit_done';
      unitIndex: number;
      unitTotal: number;
      unitLabel: string;
    }
  /** Stage 1 finished — about to start Stage 2 (report generation). */
  | { kind: 'strategies_done'; unitTotal: number }
  /** Stage 2 in flight — current LLM phase. */
  | {
      kind: 'report_running';
      phase: 'preparing' | 'awaiting_llm' | 'rendering';
      label: string;
    }
  /** Both stages done — bar fills to 100% briefly before parent unmounts us. */
  | { kind: 'done' }
  /** A stage errored — bar freezes and shows red. */
  | { kind: 'error'; message: string };

interface Props {
  state: AiReportProgressState;
}

/**
 * Wall-clock split between strategies and report. Strategies are ~10× more
 * LLM round-trips than the single report call when K>=2 clusters, so they
 * legitimately dominate. Even for K=1 (single-zone) the split is closer to
 * 50/50 — using 70/30 just means single-zone shows the bar slightly ahead
 * during strategies, which is a minor UX wart vs the alternative (cluster
 * mode showing the bar pinned at <50% for most of the wait).
 */
const STRATEGIES_WEIGHT = 0.7;
const REPORT_WEIGHT = 1.0 - STRATEGIES_WEIGHT;

/** Compute the bar's percentage [0–100] and the text labels for a given state. */
function deriveBar(state: AiReportProgressState): {
  percent: number;
  primary: string;
  secondary: string;
  colorScheme: 'purple' | 'red' | 'green';
  isIndeterminate: boolean;
} {
  switch (state.kind) {
    case 'idle':
      return { percent: 0, primary: '', secondary: '', colorScheme: 'purple', isIndeterminate: false };

    case 'strategies_starting':
      return {
        percent: 0,
        primary: `Step 1 of 2 — Generating design strategies for ${state.unitTotal} ${state.unitTotal === 1 ? 'unit' : 'units'}…`,
        secondary: 'Connecting to LLM…',
        colorScheme: 'purple',
        isIndeterminate: true,
      };

    case 'strategies_running': {
      // Sub-step weight inside one unit: diagnosis = 0.5, strategies = 1.0,
      // unit_done = 1.0. So if we're on unit 3 of 5 in "strategies", that's
      // (2 full units + 1.0 sub-step) / 5 = 60% through stage 1.
      const subProgress =
        state.stage === 'diagnosis' ? 0.0 : state.stage === 'strategies' ? 0.5 : 1.0;
      const stageFraction = (state.unitIndex + subProgress) / Math.max(state.unitTotal, 1);
      const percent = Math.min(100, Math.max(0, stageFraction * STRATEGIES_WEIGHT * 100));
      const stageLabel =
        state.stage === 'diagnosis'
          ? 'diagnosing'
          : state.stage === 'strategies'
            ? 'synthesizing strategies'
            : 'finalizing';
      return {
        percent,
        primary: `Step 1 of 2 — ${state.unitLabel} (${state.unitIndex + 1} of ${state.unitTotal}) · ${stageLabel}…`,
        secondary: `Stage progress: ${Math.round(stageFraction * 100)}%`,
        colorScheme: 'purple',
        isIndeterminate: false,
      };
    }

    case 'strategies_done':
      return {
        percent: STRATEGIES_WEIGHT * 100,
        primary: 'Step 1 done — handing off to report writer…',
        secondary: `${state.unitTotal} ${state.unitTotal === 1 ? 'unit' : 'units'} processed`,
        colorScheme: 'purple',
        isIndeterminate: false,
      };

    case 'report_running': {
      // Map phase → fraction inside Stage 2 (preparing 0.05 / awaiting_llm 0.5
      // → indeterminate / rendering 1.0).
      const phaseFraction =
        state.phase === 'preparing' ? 0.05 : state.phase === 'awaiting_llm' ? 0.5 : 0.95;
      const percent = (STRATEGIES_WEIGHT + REPORT_WEIGHT * phaseFraction) * 100;
      return {
        percent,
        primary: `Step 2 of 2 — ${state.label}`,
        secondary:
          state.phase === 'awaiting_llm'
            ? 'The LLM is composing the narrative — this typically takes 15–40 seconds.'
            : 'Almost there…',
        colorScheme: 'purple',
        isIndeterminate: state.phase === 'awaiting_llm',
      };
    }

    case 'done':
      return {
        percent: 100,
        primary: 'Done — rendering the report…',
        secondary: '',
        colorScheme: 'green',
        isIndeterminate: false,
      };

    case 'error':
      return {
        percent: 0,
        primary: 'Generation failed',
        secondary: state.message,
        colorScheme: 'red',
        isIndeterminate: false,
      };
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s elapsed`;
  return `${Math.floor(s / 60)}m ${s % 60}s elapsed`;
}

export function AiReportProgress({ state }: Props) {
  const { percent, primary, secondary, colorScheme, isIndeterminate } = deriveBar(state);

  // Track elapsed time across the whole flow. Reset whenever we transition
  // out of an active state (idle/done/error). Using a single timer here so
  // we don't need to pipe a start-time prop down from the parent.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const isActive =
      state.kind !== 'idle' && state.kind !== 'done' && state.kind !== 'error';
    if (isActive && startedAt === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- One-shot startedAt initialization on the idle→active edge; we need the actual transition timestamp, which can't be a render-time derived value.
      setStartedAt(Date.now());
    } else if (!isActive && startedAt !== null) {
      // Keep the final elapsed shown briefly via the `done`/`error` rendering;
      // resetting here would cause it to flicker to 0s before the parent
      // unmounts us.
      if (state.kind === 'idle') setStartedAt(null);
    }
  }, [state.kind, startedAt]);
  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [startedAt]);

  if (state.kind === 'idle') return null;

  const elapsed = startedAt !== null ? now - startedAt : 0;

  return (
    <Box
      mb={3}
      p={3}
      borderWidth={1}
      borderRadius="md"
      borderColor={state.kind === 'error' ? 'red.200' : 'purple.200'}
      bg={state.kind === 'error' ? 'red.50' : 'purple.50'}
    >
      <VStack align="stretch" spacing={2}>
        <HStack justify="space-between" align="baseline">
          <Text fontSize="sm" fontWeight="semibold" color={state.kind === 'error' ? 'red.700' : 'purple.700'}>
            {primary}
          </Text>
          <Text fontSize="xs" color="gray.600" flexShrink={0} ml={2}>
            {state.kind !== 'error' && state.kind !== 'done' && startedAt !== null
              ? formatElapsed(elapsed)
              : state.kind === 'done'
                ? `Done in ${formatElapsed(elapsed)}`
                : ''}
          </Text>
        </HStack>
        <Progress
          value={percent}
          size="sm"
          colorScheme={colorScheme}
          borderRadius="full"
          isIndeterminate={isIndeterminate}
          hasStripe={isIndeterminate}
          isAnimated={isIndeterminate}
        />
        {secondary && (
          <Text fontSize="xs" color={state.kind === 'error' ? 'red.600' : 'gray.600'}>
            {secondary}
          </Text>
        )}
      </VStack>
    </Box>
  );
}

export default AiReportProgress;
