import {
  Box,
  HStack,
  Text,
  Progress,
  Badge,
  Tooltip,
  VStack,
} from '@chakra-ui/react';
import { CHART_REGISTRY, isChartAvailable } from './registry';
import type { ChartContext } from './ChartContext';

interface AnalysisConfidenceGaugeProps {
  ctx: ChartContext;
  /** Word count from the most recent AI report, used to detect "thin" outputs. */
  aiReportWordCount?: number | null;
}

interface Computed {
  score: number;
  label: 'Strong' | 'Moderate' | 'Thin' | 'Insufficient';
  factors: { label: string; impact: number }[];
}

/**
 * 5.10.8 (4) — pre-flight signal for the AI Report.
 *
 * Combines a few signals into a single 0-100 "Analysis Confidence":
 *   • analysis mode (zone-level beats image-level)
 *   • how many registry charts have data
 *   • indicators with NaN means
 *   • layer coverage average
 *   • word count of the previously generated AI report (proxy for last run quality)
 */
function computeConfidence(
  ctx: ChartContext,
  aiReportWordCount?: number | null,
): Computed {
  const factors: { label: string; impact: number }[] = [];
  let score = 0;

  // Base from analysis mode
  if (ctx.analysisMode === 'zone_level') {
    score += 35;
    factors.push({ label: 'Zone-level mode (cross-zone z-scores valid)', impact: +35 });
  } else {
    score += 15;
    factors.push({ label: 'Image-level fallback (single zone)', impact: +15 });
  }

  // Registry chart availability
  const total = CHART_REGISTRY.filter((c) => c.tab === 'analysis').length;
  const available = CHART_REGISTRY.filter(
    (c) => c.tab === 'analysis' && isChartAvailable(c, ctx),
  ).length;
  const ratio = total > 0 ? available / total : 0;
  const chartImpact = Math.round(ratio * 30);
  score += chartImpact;
  factors.push({
    label: `Charts with data (${available}/${total})`,
    impact: chartImpact,
  });

  // Indicators with valid means
  const totalInd = ctx.globalIndicatorStats.length;
  const validInd = ctx.globalIndicatorStats.filter(
    (s) => s.by_layer?.full?.Mean != null && s.by_layer.full.N != null && s.by_layer.full.N > 0,
  ).length;
  if (totalInd > 0) {
    const indImpact = Math.round((validInd / totalInd) * 20);
    score += indImpact;
    factors.push({
      label: `Indicators with valid means (${validInd}/${totalInd})`,
      impact: indImpact,
    });
  }

  // Layer coverage average
  if (ctx.dataQuality.length > 0) {
    const avg =
      ctx.dataQuality.reduce((acc, row) => {
        const fg = row.fg_coverage_pct ?? 0;
        const mg = row.mg_coverage_pct ?? 0;
        const bg = row.bg_coverage_pct ?? 0;
        return acc + (fg + mg + bg) / 3;
      }, 0) / ctx.dataQuality.length;
    const covImpact = Math.round((avg / 100) * 10);
    score += covImpact;
    factors.push({ label: `Avg FG/MG/BG coverage (${avg.toFixed(0)}%)`, impact: covImpact });
  }

  // Penalise thin AI report from previous run
  if (aiReportWordCount != null && aiReportWordCount > 0 && aiReportWordCount < 250) {
    score -= 15;
    factors.push({
      label: `Last AI report was thin (${aiReportWordCount} words)`,
      impact: -15,
    });
  }

  score = Math.max(0, Math.min(100, score));

  let label: Computed['label'];
  if (score >= 75) label = 'Strong';
  else if (score >= 50) label = 'Moderate';
  else if (score >= 25) label = 'Thin';
  else label = 'Insufficient';

  return { score, label, factors };
}

export function AnalysisConfidenceGauge({ ctx, aiReportWordCount }: AnalysisConfidenceGaugeProps) {
  const { score, label, factors } = computeConfidence(ctx, aiReportWordCount);

  const colorScheme =
    label === 'Strong' ? 'green'
      : label === 'Moderate' ? 'blue'
        : label === 'Thin' ? 'orange'
          : 'red';

  const tooltipBody = (
    <VStack align="stretch" spacing={1} fontSize="xs">
      <Text fontWeight="bold">Analysis Confidence factors</Text>
      {factors.map((f) => (
        <HStack key={f.label} justify="space-between" spacing={3}>
          <Text>{f.label}</Text>
          <Text color={f.impact >= 0 ? 'green.200' : 'red.200'}>
            {f.impact >= 0 ? '+' : ''}{f.impact}
          </Text>
        </HStack>
      ))}
    </VStack>
  );

  return (
    <Tooltip label={tooltipBody} placement="bottom" hasArrow>
      <Box
        minW="180px"
        bg={`${colorScheme}.50`}
        borderRadius="md"
        px={3}
        py={2}
        cursor="help"
      >
        <HStack justify="space-between" mb={1}>
          <Text fontSize="2xs" color="gray.600" fontWeight="medium" textTransform="uppercase" letterSpacing="wide">
            Analysis Confidence
          </Text>
          <Badge colorScheme={colorScheme} fontSize="2xs">
            {label}
          </Badge>
        </HStack>
        <HStack spacing={2}>
          <Progress
            value={score}
            colorScheme={colorScheme}
            size="sm"
            borderRadius="full"
            flex="1"
          />
          <Text fontSize="xs" fontWeight="bold" color={`${colorScheme}.700`}>
            {score}/100
          </Text>
        </HStack>
      </Box>
    </Tooltip>
  );
}
