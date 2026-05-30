import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  AlertTitle,
  AlertDescription,
  Box,
  Button,
  HStack,
  CloseButton,
  Text,
} from '@chakra-ui/react';

interface ModeAlertProps {
  analysisMode: 'zone_level' | 'image_level';
  zoneSource: 'user' | 'cluster' | null;
  projectId: string | null;
  zoneCount: number;
  imageCount: number;
  onRunClustering: () => void;
  isClusteringRunning: boolean;
  canRunClustering: boolean;
  /** v4 / Module 1 lock-down. When true, the "Run Clustering" call-to-action
   * is hidden and the description is reworded to drop the upgrade promise.
   * Set by Reports.tsx when the user has explicitly picked Single View at
   * the entry gate. */
  hideClusteringButton?: boolean;
  /** v4 polish — when true and zoneCount === 2, show the "degenerate
   * cross-grouping statistics" warning. Reports.tsx hides the 5 cross-zone
   * z-score / Pearson-r charts (B1/B2/B3/B4/D3) at the same time.
   * Math behind the hide:
   *   - z = (x - mean) / std collapses to ±√2/2 ≈ ±0.707 for both points
   *     (a property of standardising 2 values, not a bug)
   *   - Pearson correlation between any two indicators is always ±1
   *     (a 2-point fit is always perfect), so D3 correlation values
   *     carry no information.
   * Parent component (Reports.tsx) is responsible for gating — pass true
   * for both N=2 zone projects AND K=2 cluster snapshots. */
  showDegenerateNTwoWarning?: boolean;
}

const SESSION_KEY_PREFIX = 'scenerx.modeAlert.dismissed:';

export function ModeAlert({
  analysisMode,
  zoneSource,
  projectId,
  zoneCount,
  imageCount,
  onRunClustering,
  isClusteringRunning,
  canRunClustering,
  hideClusteringButton = false,
  showDegenerateNTwoWarning = false,
}: ModeAlertProps) {
  const navigate = useNavigate();
  const sessionKey = projectId ? `${SESSION_KEY_PREFIX}${projectId}` : null;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (!sessionKey) return false;
    return sessionStorage.getItem(sessionKey) === '1';
  });

  // Reset dismissal when project changes — read sessionStorage and sync into
  // local state so the alert reappears for projects that haven't been
  // dismissed yet. Synchronous setState in this effect is intentional; the
  // alternative (key-based remount) is heavier for the same outcome.
  useEffect(() => {
    if (!sessionKey) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(sessionStorage.getItem(sessionKey) === '1');
  }, [sessionKey]);

  // v4 polish — three render conditions:
  //   1. image_level → existing single-zone-fallback / sub-zone copy
  //   2. showDegenerateNTwoWarning + zoneCount ≤ 2 → new degenerate-N
  //      warning explaining why 5 cross-grouping charts are now hidden.
  //      Covers zone N=2, cluster K=2, AND within-zone drill K=1/K=2 cases
  //      (parent gates which case via showDegenerateNTwoWarning).
  //   3. otherwise → no banner
  const isDegenerateN2 = showDegenerateNTwoWarning && zoneCount > 0 && zoneCount <= 2;
  const shouldRender = analysisMode === 'image_level' || isDegenerateN2;
  if (!shouldRender) return null;
  // v4.x — Dismiss now only hides the warning TEXT (title + body + sub-body).
  // The action buttons (Run Within-Zone Clustering, Add Another Zone) stay
  // visible as a compact button bar. Before this change, dismissing the
  // alert removed the entire component including the action buttons, leaving
  // users with no way to add zones or run clustering without clearing
  // sessionStorage. The "Dismiss" / "Continue with Image-Level" button is
  // still useful — it collapses the wordy warning to just the actions.

  const handleDismiss = () => {
    if (sessionKey) sessionStorage.setItem(sessionKey, '1');
    setDismissed(true);
  };

  const handleAddZone = () => {
    if (projectId) navigate(`/projects/${projectId}/edit`);
  };

  const isClusterDerived = zoneSource === 'cluster';

  // Title + body copy varies by mode. We keep the same Alert shell and
  // CTA buttons across all three branches so the UX feels uniform.
  // unit-noun depends on whether the grouping units are user-defined zones
  // or cluster-derived sub-units.
  // v4.x - prefer 'cluster' for any cluster-derived view (within-zone drill /
  // sub-clusters), regardless of degeneracy. Previously the non-degenerate
  // branch always returned 'zone', so on a cluster-derived view the
  // image-level fallback banner said "zones" even when the grouping units
  // were sub-clusters.
  const unitNoun = isClusterDerived ? 'cluster' : 'zone';
  const unitNounPlural = `${unitNoun}s`;

  // Numeric phrasing for the K=1 vs K=2 split — singular for K=1, "Only N"
  // wording for both since the failure mode (cross-grouping stats undefined
  // / degenerate) is the same.
  const countLabel = isDegenerateN2
    ? (zoneCount === 1 ? `1 ${unitNoun}` : `${zoneCount} ${unitNounPlural}`)
    : '';

  const title = isDegenerateN2
    ? `Cross-${unitNoun} Charts Hidden — Only ${countLabel}`
    : isClusterDerived
      ? 'Cluster Mode (Image-Level Fallback)'
      : 'Single-Zone (Image-Level) Mode';

  const body = isDegenerateN2
    ? (
      <>
        With only {countLabel}, cross-{unitNoun} z-scores and indicator
        correlations are mathematically{' '}
        {zoneCount === 1 ? 'undefined' : 'degenerate'}:
        {zoneCount === 1
          ? <> z-scores require ≥ 2 grouping units (standardisation needs at
              least 2 values), and correlations need at least 2 data points.</>
          : <> {' '}<Text as="span" fontWeight="semibold">z-scores collapse to ±0.71</Text>{' '}
              (a property of standardising 2 values, not a real signal), and
              {' '}<Text as="span" fontWeight="semibold">Pearson correlations are always ±1</Text>{' '}
              (a 2-point fit is always perfect).</>}
        {' '}To avoid showing meaningless numbers, the cross-{unitNoun} charts
        {' '}<Text as="span" fontWeight="semibold">B1, B2, B3, B4, and D3</Text>{' '}
        are hidden. Image-level distributions in section C still render
        normally — those don't depend on cross-{unitNoun} comparison.
      </>
    )
    : isClusterDerived
      ? `Falling back to image-level statistics on ${imageCount} GPS points (clusters derived from within-zone clustering, treated as grouping units).`
      : `Cross-${unitNoun} z-scores require ≥ 2 ${unitNounPlural}. With only ${zoneCount} ${unitNoun}${
          zoneCount === 1 ? '' : 's'
        }, falling back to image-level statistics on ${imageCount} GPS points.`;

  // For within-zone drill (zoneSource='cluster'), adding a project-level
  // zone does NOT change the K within the currently-displayed zone — each
  // zone is clustered independently. Surfacing "Add Another Zone" there
  // would mislead the user. The actionable fixes are out-of-band (re-run
  // clustering with different params, add images to this zone), so we
  // collapse the banner to pure information + Dismiss for the cluster-N=2
  // case.
  const isWithinZoneDrillDegenerate = isDegenerateN2 && isClusterDerived;

  const subBody = isWithinZoneDrillDegenerate
    ? 'Other views in this analysis (Parent zones, All sub-clusters, or other zone drills) may still show meaningful cross-grouping comparisons — switch the view selector above to check.'
    : isDegenerateN2
      ? `To unhide these charts, get to ≥ 3 ${unitNounPlural}:`
      : hideClusteringButton
        ? 'You picked Single View at the entry gate — clustering is disabled for this project. To unlock cross-zone comparisons:'
        : 'To unlock zone-level comparisons:';

  // CTA labels: for the N=2 zone case, "Run Clustering" points at within-zone
  // clustering (which produces multiple sub-clusters per zone, escaping the
  // N=2 trap). For the K=2 cluster case, the parent should pass
  // hideClusteringButton=true since "re-run clustering" is the wrong
  // affordance there. "Add Another Zone" used to stay for both cases, but
  // it's now suppressed when isClusterDerived (drilled into a within-zone
  // view) because it doesn't address the within-zone K issue.
  const clusterCtaLabel = isDegenerateN2 ? 'Run Within-Zone Clustering' : 'Run Clustering';
  const continueLabel = isDegenerateN2
    ? 'Dismiss'
    : 'Continue with Image-Level';

  // v4.x — When dismissed, render a COMPACT bar with just the action
  // buttons (Run Within-Zone Clustering, Add Another Zone). No warning
  // text, no close button. This keeps the affordances visible always so
  // users can act on the degeneracy whenever they want, without having to
  // clear sessionStorage to bring back the buttons.
  if (dismissed) {
    return (
      <HStack
        mb={4}
        px={3}
        py={2}
        borderRadius="md"
        borderWidth={1}
        borderColor="gray.200"
        bg="gray.50"
        spacing={2}
        flexWrap="wrap"
      >
        <Text fontSize="xs" color="gray.600" mr={2}>
          {isDegenerateN2 ? `N=${zoneCount} ${unitNounPlural} — options:` : 'Image-level mode — options:'}
        </Text>
        {!hideClusteringButton && (
          <Button
            size="xs"
            colorScheme="teal"
            variant="outline"
            onClick={onRunClustering}
            isLoading={isClusteringRunning}
            isDisabled={!canRunClustering}
            loadingText="Clustering..."
          >
            {clusterCtaLabel}
          </Button>
        )}
        {!isWithinZoneDrillDegenerate && (
          <Button
            size="xs"
            colorScheme="blue"
            variant="outline"
            onClick={handleAddZone}
            isDisabled={!projectId}
          >
            Add Another Zone
          </Button>
        )}
      </HStack>
    );
  }

  return (
    <Alert status="warning" mb={4} borderRadius="md" alignItems="flex-start">
      <AlertIcon mt={1} />
      <Box flex="1">
        <HStack justify="space-between" align="start">
          <AlertTitle fontSize="sm">{title}</AlertTitle>
          <CloseButton size="sm" onClick={handleDismiss} aria-label="Dismiss for this session" />
        </HStack>
        <AlertDescription>
          <Text fontSize="sm" mt={1}>{body}</Text>
          <Text fontSize="xs" color="gray.600" mt={1}>{subBody}</Text>
          <HStack spacing={2} mt={2} flexWrap="wrap">
            {!hideClusteringButton && (
              <Button
                size="xs"
                colorScheme="teal"
                onClick={onRunClustering}
                isLoading={isClusteringRunning}
                isDisabled={!canRunClustering}
                loadingText="Clustering..."
              >
                {clusterCtaLabel}
              </Button>
            )}
            {/* "Add Another Zone" only meaningful when adding a zone could
                actually unhide the charts — i.e., for N=2 user-zone case
                (zoneSource='user'). For within-zone drill (zoneSource=
                'cluster'), each zone is clustered independently, so adding
                a new project zone has zero effect on the displayed view's
                K. Suppress the button there to avoid misleading the user. */}
            {!isWithinZoneDrillDegenerate && (
              <Button
                size="xs"
                colorScheme="blue"
                variant="outline"
                onClick={handleAddZone}
                isDisabled={!projectId}
              >
                Add Another Zone
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={handleDismiss}>
              {continueLabel}
            </Button>
          </HStack>
        </AlertDescription>
      </Box>
    </Alert>
  );
}
