import type {
  ZoneAnalysisResult,
  DesignStrategyResult,
  ProjectPipelineResult,
} from '../types';
import type { CapturedChart } from './captureCharts';

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined) return '-';
  return v.toFixed(decimals);
}

function mdTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---');
  const lines = [
    '| ' + headers.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...rows.map(r => '| ' + r.join(' | ') + ' |'),
  ];
  return lines.join('\n');
}

export function generateReport(params: {
  projectName?: string;
  pipelineResult?: ProjectPipelineResult | null;
  zoneResult: ZoneAnalysisResult;
  designResult?: DesignStrategyResult | null;
  radarProfiles?: Record<string, Record<string, number>> | null;
  correlationByLayer?: Record<string, Record<string, Record<string, number>>> | null;
  /** 6.B(1) — captured charts to embed inline as base64 PNG. */
  chartImages?: CapturedChart[];
}): string {
  const { projectName, pipelineResult, zoneResult, designResult, radarProfiles, correlationByLayer, chartImages } = params;
  const sections: string[] = [];

  // chart_id → markdown image block (used to interleave charts with their
  // narrative section). Stripping the `data:image/png;base64,` prefix isn't
  // necessary — markdown renderers accept full data URLs.
  const imageById = new Map<string, CapturedChart>(
    (chartImages ?? []).map((c) => [c.chart_id, c]),
  );
  const renderImage = (chartId: string): string | null => {
    const c = imageById.get(chartId);
    if (!c) return null;
    const altText = c.title.replace(/[[\]]/g, '');
    const block = `![${altText}](${c.dataURL})`;
    return c.caption ? `${block}\n\n*${c.caption}*` : block;
  };

  // 1. Header
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  let header = `# SceneRx Analysis Report\n\nGenerated: ${timestamp}`;
  if (projectName) header += `\nProject: ${projectName}`;
  sections.push(header);

  // 2. Pipeline Summary
  if (pipelineResult) {
    sections.push('## Pipeline Summary');
    sections.push(mdTable(
      ['Metric', 'Value'],
      [
        ['Total Images', String(pipelineResult.total_images)],
        ['Zone-Assigned Images', String(pipelineResult.zone_assigned_images)],
        ['Calculations Run', String(pipelineResult.calculations_run)],
        ['Calculations Succeeded', String(pipelineResult.calculations_succeeded)],
        ['Calculations Failed', String(pipelineResult.calculations_failed)],
        ['Zone Statistics Count', String(pipelineResult.zone_statistics_count)],
      ],
    ));
    const pipelineSteps = pipelineResult.steps ?? [];
    if (pipelineSteps.length > 0) {
      sections.push('### Pipeline Steps\n');
      sections.push(pipelineSteps.map(s => `- **${s.step}**: ${s.status} — ${s.detail}`).join('\n'));
    }
  }

  // 3. Zone Diagnostics Overview (v6.0 descriptive)
  // Guard the spread — a partial/empty zone_analysis (present but no
  // zone_diagnostics) would otherwise throw "is not iterable".
  const sortedDiags = [...(zoneResult.zone_diagnostics ?? [])].sort((a, b) => b.mean_abs_z - a.mean_abs_z);
  if (sortedDiags.length > 0) {
    sections.push('## Zone Diagnostics Overview');
    const zoneDevImg = renderImage('zone-deviation-overview');
    if (zoneDevImg) sections.push(zoneDevImg);
    sections.push(mdTable(
      ['Zone Name', 'Mean |z|', 'Rank', 'Points'],
      sortedDiags.map(d => [d.zone_name, fmt(d.mean_abs_z), String(d.rank), String(d.point_count)]),
    ));
  }

  // 3.5 Spatial overview (image-only — no text counterpart in this export)
  const spatialImg = renderImage('spatial-overview');
  if (spatialImg) {
    sections.push('## Spatial Distribution');
    sections.push(spatialImg);
  }

  // 4. Zone Statistics — Full Layer
  const fullStats = zoneResult.zone_statistics.filter(s => s.layer === 'full');
  if (fullStats.length > 0) {
    sections.push('## Zone Statistics — Full Layer');
    sections.push(mdTable(
      ['Zone', 'Indicator', 'Mean', 'Std', 'Z-score', 'Percentile'],
      fullStats.map(s => [
        s.zone_name,
        s.indicator_id,
        fmt(s.mean),
        fmt(s.std),
        fmt(s.z_score),
        fmt(s.percentile, 0),
      ]),
    ));
  }

  // 5. Indicator Definitions
  const defs = Object.values(zoneResult.indicator_definitions);
  if (defs.length > 0) {
    sections.push('## Indicator Definitions');
    sections.push(mdTable(
      ['ID', 'Name', 'Unit', 'Direction', 'Category'],
      defs.map(d => [
        d.id,
        d.name,
        d.unit || '-',
        d.target_direction || '-',
        d.category || '-',
      ]),
    ));
  }

  // 6. Radar Profiles
  if (radarProfiles && Object.keys(radarProfiles).length > 0) {
    const zones = Object.keys(radarProfiles);
    const allIndicators = Array.from(
      new Set(zones.flatMap(z => Object.keys(radarProfiles[z]))),
    ).sort();
    if (allIndicators.length > 0) {
      sections.push('## Radar Profiles');
      const radarImg = renderImage('radar-profiles');
      if (radarImg) sections.push(radarImg);
      sections.push(mdTable(
        ['Indicator', ...zones],
        allIndicators.map(ind =>
          [ind, ...zones.map(z => fmt(radarProfiles[z]?.[ind], 0))],
        ),
      ));
    }
  }

  // 7. Correlation Matrix — Full Layer
  if (correlationByLayer) {
    const corr = correlationByLayer['full'];
    if (corr) {
      const indicators = Object.keys(corr).sort();
      if (indicators.length > 0) {
        sections.push('## Correlation Matrix — Full Layer');
        const corrImg = renderImage('correlation-heatmap');
        if (corrImg) sections.push(corrImg);
        sections.push(mdTable(
          ['', ...indicators],
          indicators.map(row =>
            [row, ...indicators.map(col => fmt(corr[row]?.[col], 3))],
          ),
        ));
      }
    }
  }

  // 7.5 Any extra opted-in charts that don't have a text counterpart yet
  const renderedIds = new Set([
    'zone-deviation-overview',
    'spatial-overview',
    'radar-profiles',
    'correlation-heatmap',
  ]);
  const extras = (chartImages ?? []).filter((c) => !renderedIds.has(c.chart_id));
  if (extras.length > 0) {
    sections.push('## Additional Charts');
    for (const c of extras) {
      sections.push(`### ${c.title}`);
      const altText = c.title.replace(/[[\]]/g, '');
      sections.push(`![${altText}](${c.dataURL})`);
      if (c.caption) sections.push(`*${c.caption}*`);
    }
  }

  // 8. Design Strategies
  if (designResult) {
    sections.push('## Design Strategies');
    for (const zone of Object.values(designResult.zones)) {
      sections.push(`### Zone: ${zone.zone_name} (mean|z|=${fmt(zone.mean_abs_z)})`);
      if (zone.overall_assessment) {
        sections.push(`**Assessment:** ${zone.overall_assessment}`);
      }
      for (const strategy of zone.design_strategies) {
        sections.push(`#### Strategy ${strategy.priority}: ${strategy.strategy_name} (Confidence: ${strategy.confidence})`);
        sections.push(`- **Target indicators:** ${strategy.target_indicators.join(', ')}`);
        sections.push(`- **Intervention:** ${strategy.intervention.object} / ${strategy.intervention.action} / ${strategy.intervention.variable}`);
        if (strategy.intervention.specific_guidance) {
          sections.push(`- **Guidance:** ${strategy.intervention.specific_guidance}`);
        }
        if (strategy.signatures && strategy.signatures.length > 0) {
          const sigStr = strategy.signatures.slice(0, 3).map(s =>
            `${s.operation?.name || s.operation?.id || '?'} x ${s.semantic_layer?.name || '?'} @ ${s.spatial_layer?.name || '?'} / ${s.morphological_layer?.name || '?'}`
          ).join('; ');
          sections.push(`- **Signatures (I-SVCs):** ${sigStr}`);
        }
        if (strategy.pathway?.mechanism_description) {
          sections.push(`- **Pathway:** ${strategy.pathway.pathway_type?.name ? `(${strategy.pathway.pathway_type.name}) ` : ''}${strategy.pathway.mechanism_description}`);
        }
        if (strategy.expected_effects.length > 0) {
          sections.push(`- **Expected effects:** ${strategy.expected_effects.map(e => `${e.indicator} ${e.direction} (${e.magnitude})`).join('; ')}`);
        }
        if (strategy.potential_tradeoffs) {
          sections.push(`- **Tradeoffs:** ${strategy.potential_tradeoffs}`);
        }
        if (strategy.transferability_note) {
          sections.push(`- **Transferability:** ${strategy.transferability_note}`);
        }
        if (strategy.implementation_guidance) {
          sections.push(`- **Implementation:** ${strategy.implementation_guidance}`);
        }
      }
      if (zone.implementation_sequence) {
        sections.push(`\n**Implementation Sequence:** ${zone.implementation_sequence}`);
      }
      if (zone.synergies) {
        sections.push(`**Synergies:** ${zone.synergies}`);
      }
    }
  }

  // 7. Footer
  sections.push('---\n\nGenerated by SceneRx-AI Analysis Pipeline');

  return sections.join('\n\n');
}
