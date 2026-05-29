/**
 * #7-B — Whole-page export bundle.
 *
 * Builds a ZIP containing every visible chart's SVG + CSV (when tabular data
 * is available), the rendered AI report markdown, and a metadata.json
 * describing the project + grouping mode the bundle was captured under.
 *
 * Implemented entirely client-side via JSZip — no backend kaleido /
 * puppeteer dependency. Charts are captured from the live DOM, so callers
 * must ensure all chart cards are mounted before invoking this (Reports.tsx
 * passes forceMount={true} to every ChartHost so this is automatic post-#2).
 */

import JSZip from 'jszip';

import type { ExportColumn } from './exportChart';
import type { GroupingMode } from '../types';

export interface BundleChartArtifact {
  /** Stable chart id (used as filename stem). */
  chartId: string;
  /** Human-readable title — written into metadata.json. */
  title: string;
  /** DOM node of the rendered chart card; first <svg> inside it is captured. */
  node: HTMLElement | null;
  /** Optional tabular data — when present, a CSV sibling is added. */
  rows?: Record<string, unknown>[];
  columns?: ExportColumn[];
  /** Optional cached LLM "What this means" interpretation — written as
   * summaries/{chartId}.json so the paper-writer has the model's reading
   * of every chart alongside the figure itself. */
  aiSummary?: Record<string, unknown> | null;
}

export interface BundleOptions {
  charts: BundleChartArtifact[];
  /** Project slug — drives the ZIP filename and metadata. */
  projectSlug: string;
  /** Project name (human-readable) — written into metadata.json. */
  projectName?: string | null;
  /** Active grouping mode (zones | clusters). Tagged into the filename so
   * zone-mode and cluster-mode bundles never overwrite each other. */
  groupingMode: GroupingMode;
  /** Optional rendered AI report markdown — written as report.md. */
  aiReport?: string | null;
  /** Optional structured metadata about the AI report (model, word count). */
  aiReportMeta?: Record<string, unknown> | null;
  /** Optional design strategies payload (per-view). Written as
   * design_strategies.json (raw) and design_strategies.md (flattened
   * human-readable). Mirrors the backend nature-bundle layout so a paper
   * draft template can swap sources without changing file names. */
  designStrategies?: Record<string, unknown> | null;
  /** Extra metadata fields merged into metadata.json. */
  extraMetadata?: Record<string, unknown>;
  /** If true, also capture every chart card as a PNG via html2canvas
   * (slow, ~1-2 s per chart on a modern laptop — skipped by default
   * because doing 20 in a row was freezing the renderer). */
  includePNG?: boolean;
  /** Fires after each chart is processed so the caller can show a
   * "Capturing 3 of 20…" progress toast or bar. Optional. */
  onProgress?: (info: { current: number; total: number; chartId: string; title: string }) => void;
  /** Optional map of chart_id → SVG string that replaces what we would
   * have captured from the DOM. Typically populated by Reports.tsx
   * with the server-rendered nature-grade SVGs from
   * GET /api/projects/{id}/nature-bundle.zip so the exported figures
   * are publication-quality and not at the mercy of Recharts/D3
   * outerHTML quirks. */
  chartSvgOverrides?: Map<string, string>;
}

function sanitizeSlug(input: string | null | undefined, fallback: string): string {
  if (!input) return fallback;
  return input.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-').slice(0, 60) || fallback;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

function escapeCSVCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCSV(rows: Record<string, unknown>[], columns?: ExportColumn[]): string {
  const cols: ExportColumn[] = columns && columns.length > 0
    ? columns
    : (rows.length > 0 ? Object.keys(rows[0]).map((k) => ({ key: k, label: k })) : []);
  if (cols.length === 0) return '';
  const header = cols.map((c) => escapeCSVCell(c.label)).join(',');
  const body = rows
    .map((row) => cols.map((c) => escapeCSVCell(row[c.key])).join(','))
    .join('\r\n');
  // U+FEFF BOM for Excel-on-Windows UTF-8 detection.
  return `\uFEFF${header}\r\n${body}\r\n`;
}

/** Same skip-rules as exportSVG: lucide icons, aria-hidden=true,
 * role=presentation/img, and anything inside a button / menu / toolbar
 * are decorative — we must skip them or the bundle ends up full of 14×14
 * ellipsis icons instead of charts. */
function isUiIcon(svg: SVGSVGElement): boolean {
  if (svg.classList.contains('lucide')) return true;
  for (const cls of Array.from(svg.classList)) {
    if (cls.startsWith('lucide-')) return true;
  }
  if (svg.getAttribute('aria-hidden') === 'true') return true;
  const role = svg.getAttribute('role');
  if (role === 'presentation' || role === 'img') return true;
  for (let el: Element | null = svg.parentElement; el; el = el.parentElement) {
    if (el === svg.ownerDocument?.body) break;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a') return true;
    const r = el.getAttribute('role');
    if (r === 'menu' || r === 'menuitem' || r === 'button' || r === 'toolbar') return true;
    if (el.hasAttribute('data-export-ignore')) return true;
  }
  return false;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Parse an "rgb(r,g,b)" or "rgba(r,g,b,a)" string into a `#RRGGBB` hex.
 *  Returns null for `transparent`, fully-transparent rgba, or unparseable. */
function rgbToHex(rgb: string | null | undefined): string | null {
  if (!rgb) return null;
  const m = rgb.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!m) return null;
  const a = m[4] != null ? Number(m[4]) : 1;
  if (a < 0.05) return null;
  const r = Math.round(Number(m[1]));
  const g = Math.round(Number(m[2]));
  const b = Math.round(Number(m[3]));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Read the visible text out of a node, collapsing whitespace. Empty / blank
 *  nodes return null so the caller can skip them. */
function visibleText(el: Element): string | null {
  const t = (el as HTMLElement).innerText ?? el.textContent ?? '';
  const cleaned = t.replace(/\s+/g, ' ').trim();
  return cleaned.length === 0 ? null : cleaned;
}

/** Walk `card` looking for HTML elements that LIVE OUTSIDE the chart `svg`
 *  and look like legend / chip / caption elements. For each, append a
 *  matching pair of SVG <rect> (background swatch) + <text> (label) to
 *  `svgClone` so the serialised SVG file preserves the visual key. This
 *  replaces our previous html2canvas approach: it's 100× faster, stays
 *  in vector, and renders identically in Illustrator / Inkscape / LaTeX
 *  without foreignObject fallbacks. */
function inlineLegendsIntoSvg(
  card: HTMLElement,
  svg: SVGSVGElement,
  svgClone: SVGSVGElement,
  svgRect: DOMRect,
): { extraHeight: number } {
  // We allow legend strips to sit BELOW the chart svg in the final exported
  // viewBox. The "below band" starts at the bottom of the original chart svg.
  const baseY = Math.ceil(svgRect.height) + 6;
  let cursorY = baseY;
  let maxRight = 0;

  // Pre-build a Set of nodes that are inside the chart SVG itself or inside
  // the ⋯ menu — those must be excluded from the legend walk.
  const insideSvg = (el: Element): boolean => {
    let n: Element | null = el;
    while (n) {
      if (n === svg) return true;
      n = n.parentElement;
    }
    return false;
  };
  const insideMenu = (el: Element): boolean => {
    let n: Element | null = el;
    while (n) {
      if (n === card) return false;
      if (n instanceof HTMLElement) {
        const r = n.getAttribute('role');
        if (r === 'menu' || r === 'menuitem' || r === 'button' || r === 'toolbar') return true;
        const tag = n.tagName.toLowerCase();
        if (tag === 'button' || tag === 'a') return true;
        if (n.hasAttribute('data-export-ignore')) return true;
      }
      n = n.parentElement;
    }
    return false;
  };

  // 1) Color swatches — leaf-ish elements with a visible background color
  //    OR an explicit border colour. These are the colour keys at the
  //    bottom of clustering / categorical legends.
  const swatchCandidates = Array.from(card.querySelectorAll('*')) as HTMLElement[];
  for (const el of swatchCandidates) {
    if (!(el instanceof HTMLElement)) continue;
    if (insideSvg(el)) continue;
    if (insideMenu(el)) continue;
    // Only treat leaf-ish (no element children) nodes as swatches.
    if (el.children.length !== 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.width > 40 || rect.height > 40) continue;     // skip card backgrounds
    const cs = window.getComputedStyle(el);
    const bg = rgbToHex(cs.backgroundColor);
    if (!bg) continue;
    // Position swatch relative to the chart svg's top-left.
    const x = Math.max(0, rect.left - svgRect.left);
    const y = baseY + (rect.top - svgRect.bottom);
    const w = Math.min(rect.width, 24);
    const h = Math.min(rect.height, 16);
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(Math.round(x)));
    r.setAttribute('y', String(Math.round(y)));
    r.setAttribute('width', String(Math.round(w)));
    r.setAttribute('height', String(Math.round(h)));
    r.setAttribute('rx', '2');
    r.setAttribute('fill', bg);
    const borderHex = rgbToHex(cs.borderColor);
    if (borderHex && borderHex !== bg) {
      r.setAttribute('stroke', borderHex);
      r.setAttribute('stroke-width', '0.5');
    }
    svgClone.appendChild(r);
    cursorY = Math.max(cursorY, y + h);
    maxRight = Math.max(maxRight, x + w);
  }

  // 2) Visible text labels OUTSIDE the chart svg — titles, captions,
  //    legend keys, indicator-direction badges, scale-bar text. We grab
  //    text nodes by walking and rendering each text-bearing leaf element
  //    in its original (rect-relative) position so the layout matches
  //    what the reader sees in the live UI.
  const textCandidates = Array.from(card.querySelectorAll('*')) as HTMLElement[];
  for (const el of textCandidates) {
    if (!(el instanceof HTMLElement)) continue;
    if (insideSvg(el)) continue;
    if (insideMenu(el)) continue;
    // Only render leaf-ish nodes — otherwise we'd emit the parent's text
    // plus each child's text on top of each other.
    if (el.children.length !== 0) continue;
    const txt = visibleText(el);
    if (!txt) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const cs = window.getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize) || 11;
    const fontWeight = cs.fontWeight;
    const color = rgbToHex(cs.color) ?? '#1A1A1A';
    const x = Math.max(0, rect.left - svgRect.left);
    const y = baseY + (rect.top - svgRect.bottom) + fontSize * 0.8;
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(Math.round(x)));
    t.setAttribute('y', String(Math.round(y)));
    t.setAttribute('font-size', String(fontSize));
    t.setAttribute('font-family', cs.fontFamily || 'system-ui, sans-serif');
    if (fontWeight === 'bold' || Number(fontWeight) >= 600) {
      t.setAttribute('font-weight', '700');
    }
    if (cs.fontStyle === 'italic') t.setAttribute('font-style', 'italic');
    t.setAttribute('fill', color);
    t.textContent = txt;
    svgClone.appendChild(t);
    cursorY = Math.max(cursorY, y + 2);
    maxRight = Math.max(maxRight, x + (rect.width));
  }

  return { extraHeight: Math.max(0, cursorY - baseY) };
}

function captureSVGString(node: HTMLElement | null): string | null {
  if (!node) return null;
  const allSvgs = Array.from(node.querySelectorAll('svg')) as SVGSVGElement[];
  const ranked = allSvgs
    .filter((s) => !isUiIcon(s))
    .map((s) => {
      const r = s.getBoundingClientRect();
      return { svg: s, area: r.width * r.height };
    })
    .filter((c) => c.area > 0)
    .sort((a, b) => b.area - a.area);
  const svg = ranked[0]?.svg;
  // No real chart SVG → this is a table-only card. Skip the SVG file in
  // the bundle (the CSV sibling carries the data). DO NOT fall back to the
  // largest of all SVGs: the only remaining svg in such cards is the ⋯
  // menu's lucide icon, and exporting it produces the 14×14 ellipsis bug.
  if (!svg) return null;
  const cloned = svg.cloneNode(true) as SVGSVGElement;
  cloned.setAttribute('xmlns', SVG_NS);
  cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const rect = svg.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  let height = Math.ceil(rect.height);
  if (!cloned.getAttribute('width')) cloned.setAttribute('width', String(width));
  if (!cloned.getAttribute('viewBox')) {
    cloned.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  // Inline any HTML legend siblings of the chart svg as real <rect> + <text>
  // elements — gives us legends in pure vector without resorting to
  // html2canvas (which froze the renderer on 20+ chart cards).
  const { extraHeight } = inlineLegendsIntoSvg(node, svg, cloned, rect);
  if (extraHeight > 0) {
    height += extraHeight + 12;
    // Re-write the viewBox + height with the expanded canvas so all the
    // appended legend rects/texts fall inside the visible area.
    cloned.setAttribute('viewBox', `0 0 ${width} ${height}`);
    cloned.setAttribute('height', String(height));
  } else if (!cloned.getAttribute('height')) {
    cloned.setAttribute('height', String(height));
  }

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#ffffff');
  cloned.insertBefore(bg, cloned.firstChild);
  const xml = new XMLSerializer().serializeToString(cloned);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}

/** Capture the entire chart card as a PNG using html2canvas. Includes
 * any HTML legends / labels / chips that live outside the SVG itself
 * (Chakra HStack/Tag/Badge legends are routinely rendered as DOM
 * siblings of the SVG and are missing from the pure-vector export).
 *
 * The capture is bounded by:
 *  • `scale: 2` (≈ 192 dpi) — plenty for journal figures while keeping
 *    pixel count ~4× lower than the initial 3× attempt that froze the
 *    main thread for 20+ charts in a row.
 *  • A 15-second per-chart watchdog so a pathological card (gigantic
 *    SVG, infinite layout loop in html2canvas) can't deadlock the rest
 *    of the bundle.
 *  • A `setTimeout(0)` yield to the event loop *before* every capture so
 *    Chrome's renderer gets a chance to paint progress UI between
 *    consecutive expensive rasterisations.
 */
async function captureCardPNG(node: HTMLElement | null): Promise<Blob | null> {
  if (!node) return null;
  // Yield to the event loop so the parent's progress toast / spinner can
  // paint between charts. Without this, all 20 captures run inside one
  // task and Chrome flags the tab as unresponsive.
  await new Promise((r) => setTimeout(r, 0));
  try {
    const html2canvas = (await import('html2canvas')).default;
    const work = html2canvas(node, {
      backgroundColor: '#ffffff',
      scale: 2,             // ≈ 192 dpi — paper-quality, 4× cheaper than 3×
      useCORS: true,
      logging: false,
    });
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 15_000),
    );
    const canvas = await Promise.race([work, timeout]);
    if (!canvas) return null;
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  } catch {
    // PNG capture is a best-effort sibling; never block the SVG/CSV pipeline.
    return null;
  }
}

/** Build and trigger download of the bundle ZIP. Returns the count of
 * artifacts that ended up inside the archive (charts that lack SVG, CSV,
 * PNG, and AI summary are skipped). */
export async function exportBundle(opts: BundleOptions): Promise<{
  filename: string;
  charts: number;
  csvs: number;
  pngs: number;
  summaries: number;
}> {
  const zip = new JSZip();
  const slug = sanitizeSlug(opts.projectSlug, 'project');
  const ts = timestamp();
  const folderName = `${slug}_${opts.groupingMode}_${ts}`;
  const root = zip.folder(folderName) ?? zip;
  const charts = root.folder('charts') ?? root;
  const data = root.folder('data') ?? root;
  const summariesDir = root.folder('summaries') ?? root;

  let chartCount = 0;
  let csvCount = 0;
  let pngCount = 0;
  let summaryCount = 0;
  const manifest: {
    chart_id: string;
    title: string;
    files: string[];
  }[] = [];

  const totalCharts = opts.charts.length;
  let processed = 0;
  for (const c of opts.charts) {
    const safeId = sanitizeSlug(c.chartId, 'chart');
    const files: string[] = [];

    // (1) SVG — prefer the server-rendered nature-style SVG when the
    // caller supplied an override; fall back to the live-DOM capture
    // (which now also re-draws HTML legends as <rect>/<text>).
    const overrideSvg = opts.chartSvgOverrides?.get(c.chartId);
    const svg = overrideSvg ?? captureSVGString(c.node);
    if (svg) {
      charts.file(`${safeId}.svg`, svg);
      files.push(`charts/${safeId}.svg`);
    }

    // (2) PNG — opt-in only (`opts.includePNG === true`). html2canvas at any
    // useful resolution is heavy enough that doing it sequentially for 20+
    // charts froze the renderer for 30 s+ and tripped Chrome's "Page
    // Unresponsive" dialog. Vector SVG + raw CSV cover the headline use
    // case; PNG is reserved for the standalone per-chart Export → PNG
    // menu item where the user only pays the cost for one chart at a time.
    if (opts.includePNG) {
      const pngBlob = await captureCardPNG(c.node);
      if (pngBlob) {
        charts.file(`${safeId}.png`, pngBlob);
        files.push(`charts/${safeId}.png`);
        pngCount += 1;
      }
    }

    // (3) CSV — tabular data.
    if (c.rows && c.rows.length > 0) {
      const csv = rowsToCSV(c.rows, c.columns);
      if (csv) {
        data.file(`${safeId}.csv`, csv);
        files.push(`data/${safeId}.csv`);
        csvCount += 1;
      }
    }

    // (4) AI summary JSON — the model's "What this means" interpretation
    // (overall + key findings + per-unit breakdown + design implication).
    if (c.aiSummary) {
      summariesDir.file(
        `${safeId}.json`,
        JSON.stringify(c.aiSummary, null, 2),
      );
      files.push(`summaries/${safeId}.json`);
      summaryCount += 1;
    }

    if (files.length > 0) {
      chartCount += 1;
      manifest.push({ chart_id: c.chartId, title: c.title, files });
    }

    processed += 1;
    opts.onProgress?.({
      current: processed,
      total: totalCharts,
      chartId: c.chartId,
      title: c.title,
    });

    // Yield to the event loop between charts so the progress toast and
    // the user's Cancel button stay responsive even on slow machines.
    await new Promise((r) => setTimeout(r, 0));
  }

  if (opts.aiReport) {
    root.file('report.md', opts.aiReport);
  }

  // v4.x — Design strategies: write JSON (raw payload) + MD (flattened).
  // Mirrors backend nature-bundle so a paper template can read either.
  // Unknown shape → skip the MD flattening but still emit the JSON so the
  // data isn't lost. Wrapped in a guard because designStrategies is
  // optional and may be null/undefined.
  let designStrategiesWritten = false;
  if (opts.designStrategies && typeof opts.designStrategies === 'object') {
    const ds = opts.designStrategies as Record<string, unknown>;
    root.file('design_strategies.json', JSON.stringify(ds, null, 2));
    const stratsRaw = (ds.strategies ?? ds.items) as unknown;
    const lines: string[] = [
      `# Design Strategies — ${opts.projectName ?? slug}`,
      '',
      `- Grouping mode: ${opts.groupingMode}`,
      `- Generated: ${new Date().toISOString()}`,
      '',
    ];
    if (Array.isArray(stratsRaw) && stratsRaw.length > 0) {
      stratsRaw.forEach((s, i) => {
        if (!s || typeof s !== 'object') return;
        const obj = s as Record<string, unknown>;
        const title = (obj.title as string) || (obj.name as string) || `Strategy ${i + 1}`;
        lines.push(`## ${i + 1}. ${title}`);
        if (obj.category) lines.push(`- Category: ${obj.category as string}`);
        if (obj.priority) lines.push(`- Priority: ${obj.priority as string}`);
        if (obj.description) { lines.push(''); lines.push(String(obj.description)); }
        const steps = (obj.implementation_steps ?? obj.steps) as unknown;
        if (Array.isArray(steps) && steps.length > 0) {
          lines.push('');
          lines.push('**Implementation steps:**');
          steps.forEach((st) => lines.push(`- ${String(st)}`));
        }
        lines.push('');
      });
    } else {
      lines.push(
        'Strategies payload uses a non-standard shape; see ' +
        '`design_strategies.json` for the raw data.',
        '',
      );
    }
    root.file('design_strategies.md', lines.join('\n'));
    designStrategiesWritten = true;
  }

  const metadata = {
    project_slug: slug,
    project_name: opts.projectName ?? null,
    grouping_mode: opts.groupingMode,
    generated_at: new Date().toISOString(),
    ai_report_present: !!opts.aiReport,
    ai_report_meta: opts.aiReportMeta ?? null,
    design_strategies_present: designStrategiesWritten,
    chart_count: chartCount,
    csv_count: csvCount,
    png_count: pngCount,
    summary_count: summaryCount,
    charts: manifest,
    ...(opts.extraMetadata ?? {}),
  };
  root.file('metadata.json', JSON.stringify(metadata, null, 2));

  // v4.x — Baseline section at the top of README so anyone opening the ZIP
  // sees what view/baseline produced these numbers, before reading anything
  // else. The same project can produce many bundles (one per panorama view
  // × viewId) and their |z| / z-score / correlation values are NOT directly
  // comparable across bundles (each view computes mean/std against its own
  // grouping-unit pool). Spelling this out at the top prevents the most
  // common audit mistake: cross-bundle numeric comparison without aligning
  // baselines.
  const md = opts.extraMetadata as Record<string, unknown> | undefined;
  const panoramaView = typeof md?.panorama_view === 'string' ? md.panorama_view : null;
  const viewId = typeof md?.view_id === 'string' ? md.view_id : null;
  const baselineLabel = typeof md?.baseline_label === 'string' ? md.baseline_label : null;
  const baselineUnits = typeof md?.baseline_units === 'number' ? md.baseline_units : null;
  const baselineSection = (panoramaView || viewId || baselineLabel)
    ? `## ⚠ Baseline (read first)\n\n` +
      (panoramaView ? `- **Panorama view**: \`${panoramaView}\`\n` : '') +
      (viewId ? `- **View id**: \`${viewId}\`\n` : '') +
      (baselineLabel ? `- **Baseline label**: ${baselineLabel}\n` : '') +
      (baselineUnits != null ? `- **Baseline grouping units (N)**: ${baselineUnits}\n` : '') +
      `\n` +
      `All numeric values in this bundle — |z|, z-scores, correlations,\n` +
      `radar profiles, chart axes labelled in standardised units — are\n` +
      `calibrated against the baseline above. **Do NOT cross-compare**\n` +
      `numbers in this bundle with numbers in bundles exported from a\n` +
      `different panorama view or a different view id; mean/std are\n` +
      `re-computed against each view's own set of grouping units, so the\n` +
      `"same" unit gets different standardised values across bundles.\n` +
      `Raw indicator values (in CSVs) are absolute and ARE comparable.\n\n`
    : '';

  const readme =
    `# SceneRx export bundle\n\n` +
    baselineSection +
    `- Project: ${opts.projectName ?? slug}\n` +
    `- Grouping mode: ${opts.groupingMode}\n` +
    `- Generated: ${metadata.generated_at}\n` +
    `- ${chartCount} chart(s), ${csvCount} CSV(s)` +
    (pngCount > 0 ? `, ${pngCount} PNG(s)` : '') +
    `, ${summaryCount} AI summary file(s)` +
    (designStrategiesWritten ? `, design strategies included` : '') +
    `\n\n` +
    `## Layout\n\n` +
    `\`\`\`\n${folderName}/\n├── charts/                # SVG (vector chart only)${pngCount > 0 ? ' + optional PNG' : ''}\n` +
    `├── data/                  # CSV tables matching each chart\n` +
    `├── summaries/             # AI "What this means" JSON per chart\n` +
    `├── report.md              # AI-generated narrative report (only if present)\n` +
    `├── design_strategies.md   # Flattened design strategies (only if present)\n` +
    `├── design_strategies.json # Raw strategies payload (only if present)\n` +
    `└── metadata.json\n\`\`\`\n\n` +
    `## Notes\n\n` +
    `- **SVG** = pure vector chart only — best for re-editing in Illustrator /\n` +
    `  Inkscape. NOTE: does NOT include HTML legends/badges that Chakra UI\n` +
    `  renders outside the chart's <svg>. For figures that need legends,\n` +
    `  use the per-chart "Export → PNG" menu item.\n` +
    `- **summaries/*.json** = the LLM's structured interpretation of each\n` +
    `  chart (overall · key findings · per-unit breakdown · design\n` +
    `  implication). Use to seed figure captions or as supplementary text.\n` +
    `- **report.md** / **design_strategies.*** = downstream AI deliverables\n` +
    `  tied to the panorama view + view id in metadata.json. Absent if not\n` +
    `  generated for this drill yet.\n` +
    `- CSVs use UTF-8 with BOM so Excel on Windows opens non-ASCII labels\n` +
    `  without mojibake.\n` +
    `- File names are stable: regenerating with the same chart_id and\n` +
    `  grouping_mode produces predictable paths for relative references.\n`;
  root.file('README.md', readme);

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${folderName}.zip`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return { filename, charts: chartCount, csvs: csvCount, pngs: pngCount, summaries: summaryCount };
}
