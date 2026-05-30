/**
 * useTaskProgress
 * ---------------
 * A lightweight, reusable progress indicator for long-running front-end
 * operations that do NOT expose a granular progress channel — the bundle
 * (.zip) export, clustering, and the Excel export. Before this, those waits
 * showed either a toast that auto-dismissed after a couple of seconds or no
 * feedback at all, so a 30-90s server-side render looked frozen.
 *
 * It renders ONE persistent Chakra toast card with:
 *
 *   1. A phase label the caller updates as the operation moves between steps
 *      (e.g. "Rendering charts on the server…" → "Packaging bundle…").
 *   2. A self-ticking elapsed-time counter. This is the key "it's alive"
 *      signal — even when a phase is a single opaque blocking request with
 *      no sub-progress, the seconds keep counting up.
 *   3. An animated bar — indeterminate (striped, moving) by default, or
 *      determinate with an "n / N" readout when the caller supplies
 *      current/total (e.g. packaging chart 7 / 21).
 *
 * The visual language (purple card, "Ns elapsed" / "Nm Ns elapsed" format)
 * matches AiReportProgress so every wait in the app reads the same way.
 *
 * Usage:
 *   const progress = useTaskProgress();
 *   progress.begin('Rendering charts on the server…', 'zones view');
 *   progress.setPhase('Packaging bundle…');
 *   progress.setStep(7, 21);                  // determinate n / N
 *   progress.succeed('Bundle ready', '21 charts');  // closes card, green toast
 *   progress.fail('Export failed', err.message);    // closes card, red toast
 *   progress.dismiss();                       // closes card silently
 *
 * The handle is referentially stable (memoised), so it is safe to list in a
 * useCallback / useEffect dependency array.
 */
import { Box, HStack, Progress, Spinner, Text, VStack, useToast } from '@chakra-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface BodyProps {
  /** Fixed timestamp (ms) when the operation started — drives the counter. */
  startedAt: number;
  /** Current phase label, e.g. "Packaging bundle…". */
  phase: string;
  /** Optional secondary line, e.g. "zones view" or the current chart id. */
  detail?: string;
  /** Determinate progress: items done. Omit for an indeterminate bar. */
  current?: number;
  /** Determinate progress: items total. Omit for an indeterminate bar. */
  total?: number;
}

/** "12s elapsed" under a minute, "2m 05s elapsed" beyond. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s elapsed`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s elapsed`;
}

/**
 * The card body. Owns its own 500ms ticker so the elapsed counter advances
 * without the caller having to re-paint. `startedAt` is the single source of
 * truth, so the counter stays correct even if Chakra remounts the body on a
 * toast.update().
 */
function TaskProgressBody({ startedAt, phase, detail, current, total }: BodyProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const determinate =
    typeof current === 'number' && typeof total === 'number' && total > 0;
  const percent = determinate
    ? Math.min(100, Math.round((current! / total!) * 100))
    : 0;
  const elapsed = Math.max(0, now - startedAt);

  return (
    <Box
      p={3}
      minW="320px"
      maxW="380px"
      borderWidth={1}
      borderRadius="md"
      borderColor="purple.200"
      bg="purple.50"
      boxShadow="lg"
    >
      <VStack align="stretch" spacing={2}>
        <HStack justify="space-between" align="center">
          <HStack spacing={2} minW={0}>
            <Spinner
              size="sm"
              color="purple.500"
              thickness="2px"
              speed="0.7s"
              flexShrink={0}
            />
            <Text
              fontSize="sm"
              fontWeight="semibold"
              color="purple.700"
              noOfLines={1}
            >
              {phase}
            </Text>
          </HStack>
          <Text fontSize="xs" color="gray.600" flexShrink={0} ml={2}>
            {formatElapsed(elapsed)}
          </Text>
        </HStack>

        <Progress
          value={determinate ? percent : undefined}
          size="sm"
          colorScheme="purple"
          borderRadius="full"
          isIndeterminate={!determinate}
          hasStripe={!determinate}
          isAnimated={!determinate}
        />

        {(detail || determinate) && (
          <HStack justify="space-between" align="baseline">
            <Text fontSize="xs" color="gray.600" noOfLines={1}>
              {detail ?? ''}
            </Text>
            {determinate && (
              <Text fontSize="xs" color="gray.600" flexShrink={0} ml={2}>
                {current} / {total}
              </Text>
            )}
          </HStack>
        )}
      </VStack>
    </Box>
  );
}

export interface TaskProgress {
  /** Open the progress card and start the elapsed counter. */
  begin: (phase: string, detail?: string) => void;
  /** Move to a new phase. Resets the bar to indeterminate. */
  setPhase: (phase: string, detail?: string) => void;
  /** Switch the bar to a determinate "current / total" readout. */
  setStep: (current: number, total: number, phase?: string, detail?: string) => void;
  /** Close the card and show a green success toast. */
  succeed: (message: string, detail?: string) => void;
  /** Close the card and show a red error toast. */
  fail: (message: string, detail?: string) => void;
  /** Close the card with no follow-up toast. */
  dismiss: () => void;
}

/**
 * Returns a stable handle that drives one progress card. Call it once per
 * operation in a component (e.g. one for bundle export, one for clustering)
 * so concurrent operations get independent cards.
 */
export function useTaskProgress(): TaskProgress {
  const toast = useToast();
  const idRef = useRef<string | number | null>(null);
  const startedRef = useRef<number>(0);
  const snapRef = useRef<{
    phase: string;
    detail?: string;
    current?: number;
    total?: number;
  }>({ phase: '' });

  const paint = useCallback(() => {
    const { phase, detail, current, total } = snapRef.current;
    const render = () => (
      <TaskProgressBody
        startedAt={startedRef.current}
        phase={phase}
        detail={detail}
        current={current}
        total={total}
      />
    );
    if (idRef.current != null && toast.isActive(idRef.current)) {
      toast.update(idRef.current, { render });
    } else {
      idRef.current = toast({
        duration: null,
        isClosable: false,
        position: 'top-right',
        render,
      });
    }
  }, [toast]);

  const begin = useCallback(
    (phase: string, detail?: string) => {
      startedRef.current = Date.now();
      snapRef.current = { phase, detail };
      paint();
    },
    [paint],
  );

  const setPhase = useCallback(
    (phase: string, detail?: string) => {
      // A new phase clears any determinate step → back to indeterminate.
      snapRef.current = { phase, detail };
      paint();
    },
    [paint],
  );

  const setStep = useCallback(
    (current: number, total: number, phase?: string, detail?: string) => {
      snapRef.current = {
        phase: phase ?? snapRef.current.phase,
        detail: detail ?? snapRef.current.detail,
        current,
        total,
      };
      paint();
    },
    [paint],
  );

  const dismiss = useCallback(() => {
    if (idRef.current != null && toast.isActive(idRef.current)) {
      toast.close(idRef.current);
    }
    idRef.current = null;
  }, [toast]);

  const succeed = useCallback(
    (message: string, detail?: string) => {
      dismiss();
      toast({
        title: message,
        description: detail,
        status: 'success',
        duration: 5000,
        isClosable: true,
        position: 'top-right',
      });
    },
    [toast, dismiss],
  );

  const fail = useCallback(
    (message: string, detail?: string) => {
      dismiss();
      toast({
        title: message,
        description: detail,
        status: 'error',
        duration: 9000,
        isClosable: true,
        position: 'top-right',
      });
    },
    [toast, dismiss],
  );

  return useMemo(
    () => ({ begin, setPhase, setStep, succeed, fail, dismiss }),
    [begin, setPhase, setStep, succeed, fail, dismiss],
  );
}

export default useTaskProgress;
