import { useState } from 'react';
import {
  Box,
  Card,
  CardBody,
  CardHeader,
  Collapse,
  Flex,
  Heading,
  HStack,
  Icon,
  IconButton,
  Link,
  Text,
  VStack,
} from '@chakra-ui/react';
import { BookOpen, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react';

/**
 * v4 / Module 4 — Top-of-Analysis narrative panel.
 *
 * Renders between the Pipeline Overview card and the AI Report card on the
 * Reports page. Gives users a quick map of:
 *   - what each of the 5 sections answers
 *   - the data-level funnel (Image → Zone → Cross-zone → Cluster)
 *   - the refCode scheme (A1/A2 · B1–B4 · C1–C4 · D1–D3, plus E1–E8
 *     when clustering has run) used throughout
 *
 * Default expanded; can be collapsed by clicking the chevron.
 */

interface SectionEntry {
  code: 'A' | 'B' | 'C' | 'D';
  title: string;
  question: string;
  refRange: string;
  anchorId: string;
}

// v4 polish — Section E (Cluster Diagnostics) is not a prerequisite in this
// guide. Cluster diagnostic charts (E1–E8) still render on the Reports page when clustering ran,
// but they don't get their own top-level section in this map / data-level
// funnel anymore. Keeping the guide simpler and less branchy.
const SECTIONS: SectionEntry[] = [
  {
    code: 'A',
    title: 'Setup & Data Quality',
    question: 'What did we measure and how trustworthy is it?',
    refRange: 'A1, A2',
    anchorId: 'analysis-section-setup',
  },
  {
    code: 'B',
    title: 'Zone-Level Findings',
    question: 'Where do zones differ?',
    refRange: 'B1 – B4',
    anchorId: 'analysis-section-zone',
  },
  {
    code: 'C',
    title: 'Indicator Drill-Down',
    question:
      'From global to within-zone — what does each indicator look like at each scale?',
    refRange: 'C1 – C4',
    anchorId: 'analysis-section-indicator',
  },
  {
    code: 'D',
    title: 'Reference & Cross-Cutting',
    question: 'Raw values and indicator-to-indicator relationships.',
    refRange: 'D1 – D3',
    anchorId: 'analysis-section-reference',
  },
];

const DATA_LEVELS = [
  { label: 'Image-level', hint: 'Each image is a row (C1, C3, C4, D1)' },
  { label: 'Zone-level', hint: 'Each zone aggregates its images (A2, C2, D2)' },
  { label: 'Cross-zone', hint: 'z-score / radar / matrix across zones (B1–B4)' },
];

interface AnalysisGuideProps {
  /** Optional initial collapsed state (default false = expanded). */
  defaultCollapsed?: boolean;
  /** v4 / Module 1 — current viewing mode. Drives which sections / data
   *  levels are highlighted vs greyed out:
   *   'single_zone'  — Single View: A + C + D1 active; B / D2-D3 muted
   *   'cluster'      — Dual View / clusters: all four sections active
   *   'multi_zone'   — multi user-zone: A + B + C + D active
   *  When omitted, all sections render at full strength (legacy behaviour). */
  mode?: 'single_zone' | 'multi_zone' | 'cluster';
}

const MODE_TO_VIABLE_SECTIONS: Record<NonNullable<AnalysisGuideProps['mode']>, Set<SectionEntry['code']>> = {
  single_zone: new Set(['A', 'C', 'D']),
  multi_zone: new Set(['A', 'B', 'C', 'D']),
  cluster: new Set(['A', 'B', 'C', 'D']),
};

const MODE_TO_VIABLE_LEVELS: Record<NonNullable<AnalysisGuideProps['mode']>, Set<string>> = {
  // 'Cross-zone' is not meaningful in Single View.
  single_zone: new Set(['Image-level', 'Zone-level']),
  multi_zone: new Set(['Image-level', 'Zone-level', 'Cross-zone']),
  cluster: new Set(['Image-level', 'Zone-level', 'Cross-zone']),
};

export function AnalysisGuide({ defaultCollapsed = false, mode }: AnalysisGuideProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const viableSectionCodes = mode ? MODE_TO_VIABLE_SECTIONS[mode] : null;
  const viableLevelLabels = mode ? MODE_TO_VIABLE_LEVELS[mode] : null;
  const isSectionViable = (code: SectionEntry['code']) =>
    !viableSectionCodes || viableSectionCodes.has(code);
  const isLevelViable = (label: string) =>
    !viableLevelLabels || viableLevelLabels.has(label);

  return (
    <Card mb={4} borderColor="purple.200" borderWidth={1}>
      <CardHeader pb={collapsed ? 4 : 2}>
        <HStack justify="space-between" align="center">
          <HStack spacing={2}>
            <Icon as={BookOpen} color="purple.500" boxSize={4} />
            <Heading size="sm">How to read this analysis</Heading>
          </HStack>
          <IconButton
            aria-label={collapsed ? 'Expand guide' : 'Collapse guide'}
            icon={collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            size="xs"
            variant="ghost"
            onClick={() => setCollapsed((c) => !c)}
          />
        </HStack>
      </CardHeader>
      <Collapse in={!collapsed} animateOpacity>
        <CardBody pt={0}>
          <Text fontSize="xs" color="gray.600" mb={3}>
            The Analysis tab below is split into 4 sections that follow a single narrative arc
            from broad to specific. Each chart carries a refCode (e.g. <Text as="span" fontWeight="bold">B2</Text>)
            so you can cite it directly in reports and discussions.
          </Text>

          {/* 5-section walkthrough — mode-aware: sections that aren't
              viable in the current view (e.g. B / D2-D3 / E in Single View)
              render greyed out with a "not in this mode" badge instead of
              being silently dropped. This way the user still sees the full
              menu and understands which sections light up under Dual View. */}
          <VStack align="stretch" spacing={2} mb={4}>
            {SECTIONS.map((s) => {
              const viable = isSectionViable(s.code);
              return (
                <Flex
                  key={s.code}
                  align="flex-start"
                  gap={3}
                  p={2}
                  borderRadius="md"
                  opacity={viable ? 1 : 0.45}
                  _hover={{ bg: viable ? 'purple.50' : undefined }}
                >
                  <Box
                    flexShrink={0}
                    w="28px"
                    h="28px"
                    borderRadius="full"
                    bg={viable ? 'purple.100' : 'gray.100'}
                    color={viable ? 'purple.700' : 'gray.500'}
                    fontWeight="bold"
                    fontSize="sm"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                  >
                    {s.code}
                  </Box>
                  <Box flex={1} minW={0}>
                    <HStack spacing={2} flexWrap="wrap">
                      {viable ? (
                        <Link
                          href={`#${s.anchorId}`}
                          fontSize="sm"
                          fontWeight="bold"
                          color="purple.700"
                        >
                          {s.title}
                        </Link>
                      ) : (
                        <Text fontSize="sm" fontWeight="bold" color="gray.500">
                          {s.title}
                        </Text>
                      )}
                      <Text fontSize="2xs" color="gray.500">
                        ({s.refRange})
                      </Text>
                      {!viable && mode && (
                        <Text
                          fontSize="2xs"
                          color="gray.500"
                          bg="gray.100"
                          px={1.5}
                          py={0.5}
                          borderRadius="sm"
                        >
                          not in {mode === 'single_zone' ? 'Single View' : mode === 'cluster' ? 'this view' : 'this view'}
                        </Text>
                      )}
                    </HStack>
                    <Text fontSize="xs" color="gray.600" mt={0.5}>
                      {s.question}
                    </Text>
                  </Box>
                </Flex>
              );
            })}
          </VStack>

          {/* Data-level funnel */}
          <Box borderTopWidth={1} borderColor="gray.200" pt={3}>
            <Text fontSize="xs" fontWeight="bold" color="gray.700" mb={2}>
              Data-level funnel
            </Text>
            <Text fontSize="2xs" color="gray.500" mb={2}>
              Each section operates at a different aggregation level.
            </Text>
            <HStack spacing={1} wrap="wrap">
              {DATA_LEVELS.map((d, i) => {
                const viable = isLevelViable(d.label);
                return (
                  <HStack key={d.label} spacing={1}>
                    <Box
                      px={2}
                      py={1}
                      bg={
                        !viable ? 'gray.50'
                          : i === 0 ? 'blue.50'
                            : i === 1 ? 'green.50'
                              : 'orange.50'
                      }
                      borderRadius="md"
                      borderWidth={1}
                      borderColor={
                        !viable ? 'gray.200'
                          : i === 0 ? 'blue.200'
                            : i === 1 ? 'green.200'
                              : 'orange.200'
                      }
                      opacity={viable ? 1 : 0.5}
                    >
                      <Text fontSize="2xs" fontWeight="bold" color={viable ? 'inherit' : 'gray.500'}>
                        {d.label}
                      </Text>
                      <Text fontSize="2xs" color="gray.600">
                        {d.hint}
                      </Text>
                    </Box>
                    {i < DATA_LEVELS.length - 1 && (
                      <Icon as={ArrowRight} boxSize={3} color="gray.400" />
                    )}
                  </HStack>
                );
              })}
            </HStack>
          </Box>
        </CardBody>
      </Collapse>
    </Card>
  );
}
