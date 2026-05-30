/**
 * Centralised color palettes used by analysis-tab heatmaps + spatial maps.
 *
 * The default palettes mirror the existing red-blue / green-red coding for
 * familiarity. The colorblind-safe variants use Viridis (perceptually
 * uniform, friendly to most colour-vision deficiencies) and Cividis (a
 * blue-yellow alternative that also works for tritanopia).
 *
 * All gradients accept t in [0, 1] and return an `rgb(...)` string.
 */

type Triple = readonly [number, number, number];

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function pickFromStops(stops: readonly Triple[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const segments = stops.length - 1;
  const pos = clamped * segments;
  const idx = Math.min(Math.floor(pos), segments - 1);
  const local = pos - idx;
  const a = stops[idx];
  const b = stops[idx + 1];
  return `rgb(${lerp(a[0], b[0], local)}, ${lerp(a[1], b[1], local)}, ${lerp(a[2], b[2], local)})`;
}

// ---------------------------------------------------------------------------
// Diverging palettes (z-score / correlation maps): -1 → 0 → +1
// ---------------------------------------------------------------------------

const DIVERGING_RDBU: readonly Triple[] = [
  [33, 102, 172],   // strong negative — blue
  [146, 197, 222],
  [247, 247, 247],  // neutral — grey
  [244, 165, 130],
  [178, 24, 43],    // strong positive — red
];

// Cividis approximation — perceptually uniform, blue → yellow
const DIVERGING_CIVIDIS: readonly Triple[] = [
  [0, 32, 76],      // strong negative — deep blue
  [85, 91, 108],
  [122, 121, 117],  // neutral — olive grey
  [184, 162, 79],
  [253, 231, 55],   // strong positive — yellow
];

export function divergingColor(t: number, colorblind: boolean): string {
  // Normalise t from [-1, 1] to [0, 1].
  const norm = (Math.max(-1, Math.min(1, t)) + 1) / 2;
  return pickFromStops(colorblind ? DIVERGING_CIVIDIS : DIVERGING_RDBU, norm);
}

// ---------------------------------------------------------------------------
// Sequential / directional palettes (value heatmaps)
// ---------------------------------------------------------------------------

const VIRIDIS: readonly Triple[] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 144, 141],
  [94, 201, 98],
  [253, 231, 37],
];

// MATLAB parula colormap (R2014b+ default). Perceptually uniform, dark
// blue → cyan → green → yellow. The de-facto standard for value-map
// figures in journal articles in the engineering / urban-science space.
// 11-stop approximation sampled from MATLAB's own parula table — gives
// noticeably smoother transitions than a 5-stop fit.
const PARULA: readonly Triple[] = [
  [ 62,  38, 168],
  [ 71,  92, 248],
  [ 27, 159, 245],
  [ 19, 198, 197],
  [ 49, 215, 144],
  [142, 220,  88],
  [221, 218,  68],
  [253, 199,  60],
  [254, 159,  53],
  [248, 116,  53],
  [241,  75,  47],
];

export function parulaColor(t: number, colorblind = false): string {
  const clamped = Math.max(0, Math.min(1, t));
  // Colorblind path returns viridis — also perceptually uniform and
  // ranked as the safest sequential map in the d-VPAT / cb tests, with
  // the same dark-blue → yellow trajectory readers expect from parula.
  return pickFromStops(colorblind ? VIRIDIS : PARULA, clamped);
}

// Palette anchors deepened (PDF #6) so low-value points stay legible against a
// near-white spatial-map background. Starts shifted from #FAFCFA-ish to the
// PDF's #D4ECD4 / #F4D4D4 / #D4E2F4 anchors; ends darkened to ensure adequate
// contrast at the high end.
const INCREASE_GREEN: readonly Triple[] = [
  [212, 236, 212], // #D4ECD4
  [80, 168, 100],
  [20, 63, 30],    // #143F1E
];

const DECREASE_RED: readonly Triple[] = [
  [244, 212, 212], // #F4D4D4
  [220, 80, 80],
  [94, 11, 30],    // #5E0B1E
];

const NEUTRAL_BLUE: readonly Triple[] = [
  [212, 226, 244], // #D4E2F4
  [80, 130, 200],
  [11, 42, 94],    // #0B2A5E
];

export function directionalColor(
  t: number,
  direction: string,
  colorblind: boolean,
): string {
  const clamped = Math.max(0, Math.min(1, t));
  if (colorblind) {
    return pickFromStops(VIRIDIS, clamped);
  }
  const dir = (direction || 'NEUTRAL').toUpperCase();
  if (dir === 'INCREASE') return pickFromStops(INCREASE_GREEN, clamped);
  if (dir === 'DECREASE') return pickFromStops(DECREASE_RED, clamped);
  return pickFromStops(NEUTRAL_BLUE, clamped);
}

// ---------------------------------------------------------------------------
// Magnitude palettes (mean |z| etc., always non-negative)
// ---------------------------------------------------------------------------

const YL_OR_RD: readonly Triple[] = [
  [255, 255, 178],
  [254, 204, 92],
  [253, 141, 60],
  [240, 59, 32],
  [189, 0, 38],
];

export function magnitudeColor(t: number, colorblind: boolean): string {
  const clamped = Math.max(0, Math.min(1, t));
  return pickFromStops(colorblind ? VIRIDIS : YL_OR_RD, clamped);
}
