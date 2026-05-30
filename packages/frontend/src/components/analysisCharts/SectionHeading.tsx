import { Badge, Box, Heading, HStack, Text } from '@chakra-ui/react';
import { SECTION_META, type ChartSection } from './registry';
import type { GroupingMode } from '../../types';

interface SectionHeadingProps {
  section: ChartSection;
  /** v4 / Module 4: drives the dynamic data-level badge to the right of the
   * heading. Defaults to 'zones' for backward compatibility. */
  groupingMode?: GroupingMode;
}

/**
 * Heading + subtitle for the per-section subgroups on the Analysis tab.
 * Lives in its own file so registry.tsx (which is data + helpers) doesn't
 * mix component and non-component exports — that pattern breaks Vite's
 * fast-refresh.
 *
 * v4 / Module 4 changes:
 *   - Subtitle now starts with the chapter question (set in SECTION_META).
 *   - A small Badge to the right of the heading shows the data-level the
 *     section operates on. The badge text depends on the active groupingMode
 *     (zones / clusters) so users can tell at a glance whether the figures
 *     below describe user zones or KMeans archetypes.
 */
export function SectionHeading({ section, groupingMode = 'zones' }: SectionHeadingProps) {
  const meta = SECTION_META[section];
  const badgeText = meta.dataLevelByMode?.(groupingMode);
  // v4.x - prefer mode-aware title/subtitle when defined (e.g. "Cluster-Level
  // Findings" in clusters view instead of "Zone-Level Findings"). Falls back
  // to the static title / subtitle for sections that don't overload zone
  // semantics.
  const displayTitle = meta.titleByMode?.(groupingMode) ?? meta.title;
  const displaySubtitle = meta.subtitleByMode?.(groupingMode) ?? meta.subtitle;
  return (
    <Box mb={2} mt={2}>
      <HStack spacing={2} align="center" wrap="wrap">
        <Heading size="sm" color="gray.700">
          {displayTitle}
        </Heading>
        {badgeText && (
          <Badge
            variant="subtle"
            colorScheme={groupingMode === 'clusters' ? 'teal' : 'blue'}
            fontSize="2xs"
            textTransform="none"
          >
            {badgeText}
          </Badge>
        )}
      </HStack>
      <Text fontSize="xs" color="gray.500" mt={0.5}>
        {displaySubtitle}
      </Text>
    </Box>
  );
}
