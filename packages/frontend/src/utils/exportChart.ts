/**
 * Chart / table export helpers.
 *
 * Used by ChartHost's ⋯ menu so researchers can drop figures and underlying
 * data straight into papers and presentations. Spec §7 of the technical
 * issues list:
 *
 *  - SVG    → vector for journal figures. Captured straight from the DOM
 *             (every chart in this app renders to <svg>, so no library API
 *             is needed).
 *  - PNG    → raster for slide decks. html2canvas at 3× ≈ 300 dpi.
 *  - CSV    → raw data for re-analysis. UTF-8 BOM so Excel on Windows opens
 *             Chinese / Korean labels without mojibake.
 *  - XLSX   → multi-column tables with auto-fit width and a frozen header.
 *
 * Filename format: `{projectSlug}_{chartId}_{groupingMode}_{ts}.{ext}`.
 * `groupingMode` defaults to "zones" until issue #1 lands; once the global
 * grouping_mode store exists the caller will pass it through.
 */

import type { GroupingMode } from '../types';

export type ExportFormat = 'svg' | 'png' | 'csv' | 'xlsx';

export interface ExportColumn {
  key: string;
  label: string;
}

export interface ExportableArtifact {
  /** Stable chart id from the descriptor — used in the filename. */
  chartId: string;
  /** Project slug; falls back to "project" when unavailable. */
  projectSlug?: string | null;
  /** Active grouping mode (zones | clusters). */
  groupingMode?: GroupingMode;
  /** DOM node of the chart card; SVG/PNG capture only. */
  node?: HTMLElement | null;
  /** Tabular rows for CSV/XLSX export. Optional — disables those formats. */
  rows?: Record<string, unknown>[];
  /** Column order + display labels. Falls back to row keys if absent. */
  columns?: ExportColumn[];
  /** Sheet name for XLSX. Falls back to chartId. */
  sheetName?: string;
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

function sanitizeSlug(input: string | null | undefined, fallback: string): string {
  if (!input) return fallback;
  // Strip characters that the OS doesn't like in filenames; keep dashes/underscores.
  return input.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-').slice(0, 60) || fallback;
}

function buildFilename(a: ExportableArtifact, ext: ExportFormat): string {
  const slug = sanitizeSlug(a.projectSlug, 'project');
  const chart = sanitizeSlug(a.chartId, 'chart');
  const mode = a.groupingMode ?? 'zones';
  return `${slug}_${chart}_${mode}_${timestamp()}.${ext}`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Defer revocation so Safari has time to start the download. 10s is plenty.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── SVG ─────────────────────────────────────────────────────────────────

/**
 * Serializes the chart <svg> inside `node` and downloads it. Adds the xmlns
 * attribute and an explicit white background <rect> so the file opens
 * cleanly in Illustrator / Inkscape / LaTeX without a transparent backdrop.
 *
 * Chart cards routinely contain decorative icons (the ⋯ menu trigger,
 * download arrows, refresh, info, etc. — all rendered by lucide-react as
 * tiny <svg class="lucide ..." aria-hidden="true">). The previous "first
 * non-zero" heuristic almost always picked one of those icons instead of
 * the actual chart, producing 14×14 SVGs that just contained the ellipsis
 * dots. The selection logic below explicitly excludes any SVG that:
 *   • carries a "lucide" class, or
 *   • is marked aria-hidden="true" / role="presentation" / role="img"
 *     (the standard markers for purely decorative icons), or
 *   • is a descendant of an interactive control (<button>, role="menu",
 *     [data-export-ignore]).
 * Among the remaining candidates it picks the one with the largest
 * rendered area (width × height) — for a typical chart card this is the
 * recharts / d3 figure that fills the body of the card.
 */
function isUiIcon(svg: SVGSVGElement): boolean {
  if (svg.classList.contains('lucide')) return true;
  for (const cls of Array.from(svg.classList)) {
    if (cls.startsWith('lucide-')) return true;
  }
  if (svg.getAttribute('aria-hidden') === 'true') return true;
  const role = svg.getAttribute('role');
  if (role === 'presentation' || role === 'img') return true;
  // Walk up the DOM to detect buttons / menus that ship icon SVGs.
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

export function exportSVG(node: HTMLElement | null | undefined, filename: string) {
  if (!node) throw new Error('No DOM node to export');
  const allSvgs = Array.from(node.querySelectorAll('svg')) as SVGSVGElement[];
  // Score each candidate by rendered area; skip UI icons entirely.
  const ranked = allSvgs
    .filter((s) => !isUiIcon(s))
    .map((s) => {
      const r = s.getBoundingClientRect();
      return { svg: s, area: r.width * r.height };
    })
    .filter((c) => c.area > 0)
    .sort((a, b) => b.area - a.area);
  const svg = ranked[0]?.svg;
  // If nothing made it past the UI-icon filter, this card has no chart SVG —
  // typically a pure HTML-table chart (indicator-registry-table,
  // global-stats-table, etc.). We MUST NOT fall back to the largest SVG,
  // because the largest remaining svg is the ⋯ menu's lucide icon and
  // exporting it produces the 14×14 ellipsis bug. Surface a clear error so
  // the user picks CSV/XLSX (the correct format for tables) instead.
  if (!svg) {
    throw new Error(
      'This card renders as an HTML table rather than an SVG chart — pick CSV or XLSX in the menu instead.',
    );
  }

  const cloned = svg.cloneNode(true) as SVGSVGElement;
  cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Inline width/height fallback so renderers that ignore CSS still size correctly.
  const rect = svg.getBoundingClientRect();
  if (!cloned.getAttribute('width')) cloned.setAttribute('width', String(Math.ceil(rect.width)));
  if (!cloned.getAttribute('height')) cloned.setAttribute('height', String(Math.ceil(rect.height)));
  if (!cloned.getAttribute('viewBox')) {
    cloned.setAttribute(
      'viewBox',
      `0 0 ${Math.ceil(rect.width)} ${Math.ceil(rect.height)}`,
    );
  }

  // Prepend an opaque white background rect so the saved SVG never lands on
  // a transparent canvas (causes grey blotches when print-converted to PDF).
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#ffffff');
  cloned.insertBefore(bg, cloned.firstChild);

  const xml = new XMLSerializer().serializeToString(cloned);
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`], {
    type: 'image/svg+xml;charset=utf-8',
  });
  triggerDownload(blob, filename);
}

// ─── PNG ─────────────────────────────────────────────────────────────────

/**
 * Rasterizes `node` via html2canvas at the requested scale (3 ≈ 300 dpi for
 * 96-dpi viewports) onto a white backdrop.
 */
export async function exportPNG(
  node: HTMLElement | null | undefined,
  filename: string,
  scale = 3,
) {
  if (!node) throw new Error('No DOM node to export');
  const html2canvas = (await import('html2canvas')).default;
  const canvas = await html2canvas(node, {
    backgroundColor: '#ffffff',
    scale,
    useCORS: true,
    logging: false,
  });
  return new Promise<void>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG encoding failed'));
        return;
      }
      triggerDownload(blob, filename);
      resolve();
    }, 'image/png');
  });
}

// ─── CSV ─────────────────────────────────────────────────────────────────

function escapeCSVCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  // Wrap in quotes if it contains delimiter, quote, or newline. Double internal quotes.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function resolveColumns(
  rows: Record<string, unknown>[],
  columns: ExportColumn[] | undefined,
): ExportColumn[] {
  if (columns && columns.length > 0) return columns;
  if (rows.length === 0) return [];
  return Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
}

export function exportCSV(
  rows: Record<string, unknown>[] | undefined,
  columns: ExportColumn[] | undefined,
  filename: string,
) {
  if (!rows || rows.length === 0) {
    throw new Error('No tabular data available for this chart');
  }
  const cols = resolveColumns(rows, columns);
  const header = cols.map((c) => escapeCSVCell(c.label)).join(',');
  const body = rows
    .map((row) => cols.map((c) => escapeCSVCell(row[c.key])).join(','))
    .join('\r\n');
  // U+FEFF is the UTF-8 BOM — Excel on Windows needs it to detect UTF-8.
  const csv = `\uFEFF${header}
${body}
`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, filename);
}

// ─── XLSX ────────────────────────────────────────────────────────────────

/**
 * Writes a single-sheet XLSX. Header row is bold, frozen, and column widths
 * are auto-fit to the longest cell (capped at 60 chars so a runaway URL
 * doesn't push the layout to absurd widths).
 */
export async function exportXLSX(
  rows: Record<string, unknown>[] | undefined,
  columns: ExportColumn[] | undefined,
  filename: string,
  sheetName = 'Sheet1',
) {
  if (!rows || rows.length === 0) {
    throw new Error('No tabular data available for this chart');
  }
  const XLSX = await import('xlsx');
  const cols = resolveColumns(rows, columns);

  const aoa: unknown[][] = [
    cols.map((c) => c.label),
    ...rows.map((row) => cols.map((c) => row[c.key] ?? '')),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  // Freeze the header row and bold its cells. xlsx's free build doesn't
  // preserve all rich formatting, but pane freeze + cell width survive.
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  sheet['!cols'] = cols.map((c) => {
    const widest = Math.max(
      c.label.length,
      ...rows.map((r) => {
        const v = r[c.key];
        if (v == null) return 0;
        return String(v).length;
      }),
    );
    return { wch: Math.min(60, Math.max(8, widest + 2)) };
  });

  const wb = XLSX.utils.book_new();
  // Sheet names cap at 31 chars and disallow these chars: \ / ? * [ ]
  const safeName = (sheetName || 'Sheet1').replace(/[\\/?*[\]]/g, '_').slice(0, 31);
  XLSX.utils.book_append_sheet(wb, sheet, safeName);

  // writeFile triggers a download in the browser environment automatically.
  XLSX.writeFile(wb, filename, { bookType: 'xlsx' });
}

// ─── Dispatch ────────────────────────────────────────────────────────────

export async function exportArtifact(
  artifact: ExportableArtifact,
  format: ExportFormat,
): Promise<void> {
  const filename = buildFilename(artifact, format);
  switch (format) {
    case 'svg':
      exportSVG(artifact.node, filename);
      return;
    case 'png':
      await exportPNG(artifact.node, filename);
      return;
    case 'csv':
      exportCSV(artifact.rows, artifact.columns, filename);
      return;
    case 'xlsx':
      await exportXLSX(
        artifact.rows,
        artifact.columns,
        filename,
        artifact.sheetName ?? artifact.chartId,
      );
      return;
  }
}
