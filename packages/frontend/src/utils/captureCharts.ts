import type { ChartHostHandle } from '../components/analysisCharts/ChartHost';
import type { ChartDescriptor } from '../components/analysisCharts/registry';
import type { ChartContext } from '../components/analysisCharts/ChartContext';

export interface CapturedChart {
  chart_id: string;
  title: string;
  caption: string;
  dataURL: string;
  widthPx: number;
  heightPx: number;
}

interface CaptureArgs {
  charts: ChartDescriptor[];
  ctx: ChartContext;
  refs: Map<string, ChartHostHandle | null>;
  selectedIds?: Set<string>;
  captionFor?: (chartId: string) => string | null;
  matplotlibSvgs?: Map<string, string>;
}

async function svgStringToPng(
  svg: string,
  scale: number = 2,
): Promise<{ dataURL: string; widthPx: number; heightPx: number } | null> {
  try {
    const m_wh = svg.match(
      /<svg\b[^>]*?\bwidth\s*=\s*"([\d.]+)(?:pt|px)?"[^>]*?\bheight\s*=\s*"([\d.]+)(?:pt|px)?"/i,
    );
    const m_vb = svg.match(/\bviewBox\s*=\s*"([\d.\s]+)"/i);
    let w = m_wh ? parseFloat(m_wh[1]) : 720;
    let h = m_wh ? parseFloat(m_wh[2]) : 360;
    if (m_vb) {
      const parts = m_vb[1].trim().split(/\s+/).map(parseFloat);
      if (parts.length === 4 && !m_wh) { w = parts[2]; h = parts[3]; }
    }
    const wPx = Math.max(1, Math.round(w * scale));
    const hPx = Math.max(1, Math.round(h * scale));
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('SVG load failed'));
        el.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = wPx;
      canvas.height = hPx;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, wPx, hPx);
      ctx.drawImage(img, 0, 0, wPx, hPx);
      return { dataURL: canvas.toDataURL('image/png'), widthPx: wPx, heightPx: hPx };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    console.warn('svgStringToPng: rasterisation failed', e);
    return null;
  }
}

export async function captureChartsForReport({
  charts,
  ctx,
  refs,
  selectedIds,
  captionFor,
  matplotlibSvgs,
}: CaptureArgs): Promise<CapturedChart[]> {
  const out: CapturedChart[] = [];

  const wantsId = (id: string): boolean => {
    if (selectedIds) return selectedIds.has(id);
    return charts.find((c) => c.id === id)?.exportByDefault === true;
  };

  for (const chart of charts) {
    if (!wantsId(chart.id)) continue;
    if (!chart.isAvailable(ctx)) continue;

    const caption = captionFor?.(chart.id) ?? chart.description ?? '';

    const mplSvg = matplotlibSvgs?.get(chart.id);
    if (mplSvg) {
      const rast = await svgStringToPng(mplSvg);
      if (rast) {
        out.push({
          chart_id: chart.id,
          title: chart.title,
          caption,
          dataURL: rast.dataURL,
          widthPx: rast.widthPx,
          heightPx: rast.heightPx,
        });
        continue;
      }
    }

    const handle = refs.get(chart.id);
    if (!handle) continue;
    try {
      const result = await handle.capturePNG();
      if (!result) continue;
      out.push({
        chart_id: chart.id,
        title: chart.title,
        caption,
        dataURL: result.dataURL,
        widthPx: result.widthPx,
        heightPx: result.heightPx,
      });
    } catch (err) {
      console.warn(`Chart capture failed for ${chart.id}:`, err);
    }
  }

  return out;
}

export function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
