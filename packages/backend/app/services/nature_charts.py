"""
Nature-style chart redraw service — publication-grade.

Generates SVGs that match the typography, palette, and layout discipline
of the paper's manuscript figures (Fig 1-6 in the repo). The output is
designed to drop directly into a Nature / Landscape & Urban Planning
submission without further editing.

Every chart follows the same skeleton:
  1) Bold single-line title at top (8.8 pt).
  2) Italic subtitle in muted grey (6.2 pt) — one-sentence description.
  3) Hairline rule beneath the title.
  4) Chart body with tight margins, Liberation Sans throughout.
  5) Mini-caption at the bottom giving sample size / scale info.

Colour discipline:
  * Categorical clusters / zones → elite muted palette (NAVY, TERRACOT,
    SAGE, BURGUNDY, OLIVE, SLATE, INDIGO, MUSTARD, TEAL). Frontend uses
    saturated Chakra primaries for legibility on screen; the paper
    figures use desaturated tones to read as a coherent figure suite
    rather than UI screenshots.
  * Sequential (value maps, per-indicator means) → MATLAB parula.
  * Diverging (z-scores, correlations) → ColorBrewer RdBu.
  * Magnitude (mean |z|) → ColorBrewer YlOrRd.

Entry point: `render_all(zone_analysis_result)` returns a dict mapping
chart_id → SVG string. The API layer ZIPs those into the bundle.
"""

from __future__ import annotations

import io
import logging
import math
from typing import Any, Optional

import matplotlib
matplotlib.use("Agg")  # headless backend
import matplotlib.pyplot as plt
import matplotlib as mpl
from matplotlib.patches import Rectangle, FancyBboxPatch
from matplotlib.colors import LinearSegmentedColormap, Normalize
import numpy as np

from app.models.analysis import ZoneAnalysisResult

logger = logging.getLogger(__name__)


# ============================================================================
# Elite muted palette — matches packages/manuscript/nature_figures_v5.py
# ============================================================================

NAVY     = "#1F3A56"
TERRACOT = "#A05537"
SAGE     = "#5C6E58"
BURGUNDY = "#7C2A36"
OLIVE    = "#8A7F35"
SLATE    = "#4A5568"
INDIGO   = "#3A4A78"
MUSTARD  = "#C29A3A"
TEAL     = "#386674"

# Nature-grade neutrals: kept tonally close but slightly cooler so colored
# elements pop without competing with the type stack. INK is the body-text
# tone; SOFT is for axis spines / tick lines (one shade lighter so the
# typography reads as the figure's primary anchor); MUTE for secondary
# labels; HAIR for ultra-light dividers.
INK   = "#1A1A1A"
SOFT  = "#4A4A4A"
LINE  = "#4A4A4A"
MUTE  = "#7A7A7A"
HAIR  = "#E2E2E2"
SHADE = "#F5F3EE"
ACCENT = TERRACOT   # one accent color reused across all "selected/highlight" marks

CATEGORICAL = [NAVY, TERRACOT, SAGE, BURGUNDY, OLIVE, SLATE,
               INDIGO, MUSTARD, TEAL, "#5C6F88", "#7A6E58", "#A88438"]

# Parula (MATLAB R2014b+) — 11-stop sample matches frontend palette.ts
_PARULA_STOPS = [
    (62/255,  38/255, 168/255),
    (71/255,  92/255, 248/255),
    (27/255, 159/255, 245/255),
    (19/255, 198/255, 197/255),
    (49/255, 215/255, 144/255),
    (142/255, 220/255,  88/255),
    (221/255, 218/255,  68/255),
    (253/255, 199/255,  60/255),
    (254/255, 159/255,  53/255),
    (248/255, 116/255,  53/255),
    (241/255,  75/255,  47/255),
]
PARULA = LinearSegmentedColormap.from_list("parula", _PARULA_STOPS)

_RDBU = [
    ( 33/255, 102/255, 172/255),
    (146/255, 197/255, 222/255),
    (247/255, 247/255, 247/255),
    (244/255, 165/255, 130/255),
    (178/255,  24/255,  43/255),
]
RDBU = LinearSegmentedColormap.from_list("rdbu_div", _RDBU)

_YLORRD = [
    (255/255, 255/255, 178/255),
    (254/255, 204/255,  92/255),
    (253/255, 141/255,  60/255),
    (240/255,  59/255,  32/255),
    (189/255,   0/255,  38/255),
]
YLORRD = LinearSegmentedColormap.from_list("ylorrd", _YLORRD)


def _apply_rc() -> None:
    """Publication-grade matplotlib defaults — calibrated to the typography
    of recent Nature / Nature-* figures.

    Key conventions enforced globally:
      * Sans-serif (Helvetica-substitute) throughout.
      * Body / axis text at 6.5 pt; tick labels 6 pt.
      * Spines + tick marks in SOFT (#4A4A4A) — NOT pure black — so the
        figure's coloured elements remain the visual anchor.
      * No top/right spines; no decorative legend frame; consistent 300 DPI
        output for raster fallbacks.
      * Idempotent — safe to call repeatedly on module reload.
    """
    mpl.rcParams.update({
        # v4.3 — Times New Roman across the board to match the paper body
        # text. On servers that lack the proprietary Microsoft font we fall
        # back through Liberation Serif (metric-compatible open-source),
        # Nimbus Roman, DejaVu Serif, and finally generic serif.
        "font.family":            "serif",
        "font.serif":             ["Times New Roman", "Liberation Serif",
                                   "Times", "Nimbus Roman No9 L",
                                   "DejaVu Serif", "serif"],
        "font.size":              6.6,
        "axes.linewidth":         0.4,
        "axes.edgecolor":         SOFT,
        "axes.labelcolor":        INK,
        "axes.titlesize":         7.6,
        "axes.titleweight":       "regular",
        "axes.titlepad":          5,
        "axes.labelsize":         6.6,
        "axes.spines.top":        False,
        "axes.spines.right":      False,
        "axes.grid":              False,
        "grid.color":             HAIR,
        "grid.linewidth":         0.3,
        "grid.alpha":             0.7,
        "grid.linestyle":         "-",
        "xtick.color":            SOFT,
        "ytick.color":            SOFT,
        "xtick.labelcolor":       INK,
        "ytick.labelcolor":       INK,
        "xtick.labelsize":        6.0,
        "ytick.labelsize":        6.0,
        "xtick.major.width":      0.4,
        "ytick.major.width":      0.4,
        "xtick.major.size":       2.2,
        "ytick.major.size":       2.2,
        "xtick.direction":        "out",
        "ytick.direction":        "out",
        "legend.fontsize":        6.2,
        "legend.title_fontsize":  6.2,
        "legend.frameon":         False,
        "legend.borderpad":       0.0,
        "legend.handletextpad":   0.5,
        "legend.columnspacing":   1.4,
        "legend.handlelength":    1.2,
        "figure.facecolor":       "white",
        "axes.facecolor":         "white",
        "savefig.facecolor":      "white",
        "savefig.dpi":            300,
        "savefig.bbox":           "tight",
        "savefig.pad_inches":     0.05,
        "pdf.fonttype":           42,
        "ps.fonttype":            42,
        "svg.fonttype":           "none",
        "lines.linewidth":        0.9,
        "lines.solid_capstyle":   "round",
        "patch.linewidth":        0.4,
        "patch.edgecolor":        "white",
    })


_apply_rc()


def _fig_to_svg(fig) -> str:
    """Serialise a matplotlib figure to a UTF-8 SVG string and close it."""
    buf = io.StringIO()
    fig.savefig(buf, format="svg")
    plt.close(fig)
    return buf.getvalue()


def _category_color(idx: int) -> str:
    return CATEGORICAL[idx % len(CATEGORICAL)]


def _decorate(fig, ax_or_axes, title: str, subtitle: str = "", caption: str = "",
              suptitle_y: float = 0.985, hairline: bool = True) -> None:
    """Apply the unified Nature-grade header skeleton to a figure.

    Type hierarchy (top to bottom):
      • TITLE      — 7.6 pt semibold, INK, left-aligned at x = 0.02
      • SUBTITLE   — 6.0 pt regular italic, MUTE, one line below
      • HAIRLINE   — 0.3 pt #E2E2E2, full-width separator
      • <figure body>
      • CAPTION    — 5.4 pt italic, MUTE, left-aligned at the bottom-left
                     (carries the Fig N. / Table N. / Suppl. Fig N. label)

    These weights match Nature's running-text body (7 pt body, 6 pt axis,
    5 pt caption) and the rule between header and body is the lightest
    visual element on the figure so it never competes with the data.
    """
    # Liberation Sans only ships Regular + Bold (no semibold variant), so
    # `fontweight="semibold"` would silently fall back to Regular and look
    # underweighted next to the body type. Use "bold" explicitly.
    fig.suptitle(title, x=0.02, y=suptitle_y, ha="left",
                 fontsize=7.6, fontweight="bold", color=INK)
    if subtitle:
        fig.text(0.02, suptitle_y - 0.038, subtitle,
                 ha="left", fontsize=6.0, color=MUTE, style="italic",
                 transform=fig.transFigure)
    if hairline:
        fig.add_artist(plt.Line2D(
            [0.02, 0.98],
            [suptitle_y - 0.052 if subtitle else suptitle_y - 0.022] * 2,
            transform=fig.transFigure, color=HAIR, linewidth=0.3,
        ))
    if caption:
        fig.text(0.02, 0.008, caption, ha="left",
                 fontsize=5.4, color=MUTE, style="italic",
                 transform=fig.transFigure)


# ---------------------------------------------------------------------------
# Unified legend + panel-label helpers (used across every chart for visual parity)
# ---------------------------------------------------------------------------

def _legend(target, handles, labels, *, ncol=None, anchor=(0.5, -0.18),
            title: Optional[str] = None) -> None:
    """Drop a Nature-style legend underneath the supplied target (ax OR fig).

    Always:
      • upper-centre anchor relative to the plot, no frame
      • 6.2 pt regular, 1.4 columnspacing, 0.5 handletextpad
      • columns auto-fit to the entry count (capped at 6)
    """
    if ncol is None:
        ncol = min(6, max(1, len(handles)))
    leg = target.legend(
        handles, labels,
        loc="upper center", bbox_to_anchor=anchor,
        ncol=ncol, fontsize=6.2, frameon=False,
        columnspacing=1.4, handletextpad=0.5, handlelength=1.2,
        title=title, title_fontsize=6.2,
    )
    if leg is not None and leg.get_title() is not None:
        leg.get_title().set_color(MUTE)
    return leg


def _panel_label(ax, letter: str, dx: float = -0.02, dy: float = 1.02) -> None:
    """Stamp a bold lower-case panel label (`a`, `b`, …) at the top-left of
    an axes — Nature multi-panel convention. Use only for figures that have
    >1 subplot of equal weight."""
    ax.text(dx, dy, letter, transform=ax.transAxes,
            ha="right", va="bottom",
            fontsize=8.0, fontweight="bold", color=INK)


# ---------------------------------------------------------------------------
# Standard label helper — convert "IND_GVI" / "GVI" → "Green View Index"
# so every chart uses the formal indicator name registered in the
# IndicatorDefinition catalogue (no more bare prefixes or stripped IDs).
# ---------------------------------------------------------------------------

def _ind_name(zar, ind_id: str) -> str:
    """Return the CODE form for an indicator id.

    v4.9 policy: charts show the full `IND_XXX` code (e.g. IND_GVI,
    IND_BVI, IND_WAT). The indicator-registry table (Fig 2) pairs
    each code with its full descriptive name (Green View Index, etc.)
    -- that's the single "key" figure.

    Behaviour:
      "IND_GVI"           -> "IND_GVI"
      "GVI"               -> "IND_GVI"           (auto-prefixed)
      "Green View Index"  -> "Green View Index"   (formal name, unchanged)
    """
    if not ind_id:
        return ind_id
    # Already a formal full name? (contains a space + not the IND_ prefix)
    if " " in ind_id and not ind_id.startswith("IND_"):
        return ind_id
    if ind_id.startswith("IND_"):
        return ind_id
    return f"IND_{ind_id}"


def _ind_long_name(zar, ind_id: str) -> str:
    """Return the full descriptive name for an indicator id. Used ONLY
    by the indicator-registry table (Fig 2); every other chart calls
    `_ind_name` for the short code form."""
    if not ind_id:
        return ind_id
    defs = (zar.indicator_definitions or {}) if zar is not None else {}
    d = defs.get(ind_id)
    if d is None:
        return ind_id
    name = (getattr(d, "name", None)
            if hasattr(d, "name")
            else (d.get("name") if isinstance(d, dict) else None))
    return name or ind_id


def _ind_names(zar, ind_ids: list[str]) -> list[str]:
    """Vectorised version of `_ind_name` for axis-tick label lists."""
    return [_ind_name(zar, i) for i in ind_ids]


def _cluster_short(zone_name: str) -> str:
    """Convert the synthetic cluster zone-names (`Cluster 4`) into the
    compact `C4` form used on axis ticks. Leaves real user-zone names
    untouched."""
    if not zone_name:
        return zone_name
    if zone_name.startswith("Cluster "):
        tail = zone_name[8:].strip()
        if tail.isdigit():
            return f"C{tail}"
    return zone_name


def _cluster_shorts(zone_names: list[str]) -> list[str]:
    return [_cluster_short(z) for z in zone_names]



def _safe_dump(obj: Any) -> dict:
    if obj is None:
        return {}
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if isinstance(obj, dict):
        return obj
    return dict(obj)


def _pivot_image_records(zar: ZoneAnalysisResult) -> tuple[
    list[dict[str, Any]], set[str], set[str]
]:
    """ImageRecord is long-format (one row per image × indicator × layer).
    Pivot to per-image rows {image_id, zone_id, lat, lng, metrics: {…}}."""
    recs = zar.image_records or []
    by_image: dict[str, dict[str, Any]] = {}
    indicators: set[str] = set()
    layers: set[str] = set()
    for r in recs:
        img = by_image.setdefault(
            r.image_id,
            {
                "image_id": r.image_id,
                "zone_id": r.zone_id,
                "zone_name": r.zone_name,
                "lat": r.lat,
                "lng": r.lng,
                "metrics": {},
            },
        )
        if r.layer == "full":
            img["metrics"][r.indicator_id] = r.value
        img["metrics"][f"{r.indicator_id}__{r.layer}"] = r.value
        if r.lat is not None and img.get("lat") is None:
            img["lat"] = r.lat
        if r.lng is not None and img.get("lng") is None:
            img["lng"] = r.lng
        indicators.add(r.indicator_id)
        layers.add(r.layer)
    return list(by_image.values()), indicators, layers


# ============================================================================
# Chart 01 — Indicator Registry (A1, native table)
# ============================================================================

def chart_indicator_registry_table(zar: ZoneAnalysisResult) -> Optional[str]:
    defs = zar.indicator_definitions
    if not defs:
        return None
    rows = []
    for ind_id, d in defs.items():
        d_dict = _safe_dump(d)
        rows.append([
            ind_id,
            d_dict.get("name", ind_id),
            d_dict.get("unit", "")[:12],
            d_dict.get("target_direction", "NEUTRAL"),
            (d_dict.get("category") or "")[:20],
        ])
    rows.sort(key=lambda r: r[0])

    fig_h = max(2.4, 0.30 * len(rows) + 1.0)
    fig = plt.figure(figsize=(7.4, fig_h))
    ax = fig.add_axes([0.02, 0.02, 0.96, 0.84])
    ax.axis("off")
    headers = ["Indicator code", "Name", "Unit", "Direction", "Category"]
    table = ax.table(
        cellText=rows, colLabels=headers,
        cellLoc="left", colLoc="left", loc="upper left",
        colWidths=[0.16, 0.40, 0.10, 0.12, 0.22],
    )
    table.auto_set_font_size(False)
    table.set_fontsize(6.2)
    table.scale(1.0, 1.22)
    for (r, c), cell in table.get_celld().items():
        cell.set_linewidth(0.0)
        if r == 0:
            cell.set_facecolor("white")
            cell.set_text_props(weight="bold", color=INK, fontsize=6.6)
            cell.set_height(cell.get_height() * 1.1)
            # bottom rule on header
            cell.visible_edges = "B"
        else:
            cell.visible_edges = ""
            cell.set_facecolor("white" if r % 2 == 1 else SHADE)
            if c == 3:
                col = {"INCREASE": "#2F855A", "DECREASE": "#9B2C2C",
                       "NEUTRAL": MUTE}.get(rows[r - 1][3], INK)
                cell.set_text_props(color=col, weight="bold")
            elif c == 0:
                cell.set_text_props(weight="bold", color=NAVY,
                                    family="Times New Roman")

    _decorate(
        fig, ax,
        title="Indicator registry",
        subtitle=f"n = {len(rows)} indicators · units, direction, category for every variable used by the analysis",
        caption=f"Table 5. INCREASE = larger is better; DECREASE = smaller is better; NEUTRAL = direction depends on design intent.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 02 — Data Quality table (A2)
# ============================================================================

def chart_data_quality_table(zar: ZoneAnalysisResult) -> Optional[str]:
    rows_raw = zar.data_quality or []
    if not rows_raw:
        return None
    rows = []
    for r in rows_raw:
        d = _safe_dump(r)
        rows.append([
            d.get("indicator_id", ""),
            f"{d.get('total_images', '') or '—'}",
            f"{d.get('fg_coverage_pct') or 0:.1f}%" if d.get("fg_coverage_pct") is not None else "—",
            f"{d.get('mg_coverage_pct') or 0:.1f}%" if d.get("mg_coverage_pct") is not None else "—",
            f"{d.get('bg_coverage_pct') or 0:.1f}%" if d.get("bg_coverage_pct") is not None else "—",
            ("normal" if d.get("is_normal") else "skewed") if d.get("is_normal") is not None else "—",
            d.get("correlation_method", ""),
        ])
    fig_h = max(2.4, 0.30 * len(rows) + 1.0)
    fig = plt.figure(figsize=(7.4, fig_h))
    ax = fig.add_axes([0.02, 0.02, 0.96, 0.84])
    ax.axis("off")
    headers = ["Indicator", "n images", "FG cov.", "MG cov.", "BG cov.", "Normality", "Corr. method"]
    table = ax.table(
        cellText=rows, colLabels=headers,
        cellLoc="center", colLoc="center", loc="upper left",
        colWidths=[0.18, 0.10, 0.12, 0.12, 0.12, 0.13, 0.18],
    )
    table.auto_set_font_size(False); table.set_fontsize(6.2); table.scale(1.0, 1.22)
    for (r, c), cell in table.get_celld().items():
        cell.set_linewidth(0.0)
        if r == 0:
            cell.set_facecolor("white")
            cell.set_text_props(weight="bold", color=INK, fontsize=6.6)
            cell.set_height(cell.get_height() * 1.1)
            cell.visible_edges = "B"
        else:
            cell.visible_edges = ""
            cell.set_facecolor("white" if r % 2 == 1 else SHADE)
            if c == 0:
                cell.set_text_props(weight="bold", color=NAVY,
                                    family="Times New Roman")
            elif c == 5:
                txt = rows[r - 1][5]
                col = {"normal": "#2F855A", "skewed": "#9B2C2C"}.get(txt, MUTE)
                cell.set_text_props(color=col, weight="bold")

    _decorate(
        fig, ax,
        title="Data quality",
        subtitle="Coverage by layer · normality of full-layer distribution · correlation method picked per indicator",
        caption="Table 6. 'normal' = Shapiro-Wilk p > 0.05; otherwise non-parametric (Spearman) correlations are used downstream.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 03 — Zone Ranking — overall deviation (B1)
# ============================================================================

def chart_zone_deviation_overview(zar: ZoneAnalysisResult) -> Optional[str]:
    diags = zar.zone_diagnostics or []
    if not diags:
        return None
    diags_sorted = sorted(diags, key=lambda d: -d.mean_abs_z)
    labels = [_cluster_short(d.zone_name) for d in diags_sorted]
    values = [d.mean_abs_z for d in diags_sorted]

    fig_h = max(2.4, 0.36 * len(labels) + 1.4)
    fig, ax = plt.subplots(figsize=(7.0, fig_h))
    fig.subplots_adjust(left=0.18, right=0.94, top=0.86, bottom=0.18)
    ys = np.arange(len(labels))
    colours = [_category_color(i) for i in range(len(labels))]
    ax.barh(ys, values, color=colours, edgecolor="white", linewidth=0.5, height=0.7)
    ax.set_yticks(ys); ax.set_yticklabels(labels, fontsize=6.4)
    ax.invert_yaxis()
    ax.set_xlabel("Mean |z| across indicators × layers", fontsize=6.6)
    # value labels on bar tips
    span = max(values) if values else 1.0
    for y, v in zip(ys, values):
        ax.text(v + span * 0.015, y, f"{v:.2f}",
                va="center", ha="left", fontsize=6.0, color=INK)
    ax.spines["bottom"].set_color(LINE)
    ax.spines["left"].set_color(LINE)
    ax.grid(axis="x", color=HAIR, linewidth=0.4, alpha=0.7)

    _decorate(
        fig, ax,
        title="Zone ranking — overall deviation",
        subtitle="Mean absolute z-score per zone, ordered most distinctive first",
        caption=f"Suppl. Fig 1. n = {len(labels)} zones · higher = more distinctive across the indicator set.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 04 — Zone × Indicator priority heatmap (B2)
# ============================================================================

def chart_priority_heatmap(zar: ZoneAnalysisResult) -> Optional[str]:
    diags = zar.zone_diagnostics or []
    if not diags:
        return None
    indicators: list[str] = []; seen = set()
    for d in diags:
        for ind_id in d.indicator_status.keys():
            if ind_id not in seen:
                seen.add(ind_id); indicators.append(ind_id)
    if not indicators:
        return None
    # v4.3 — indicator_status is a NESTED dict: {ind_id: {layer: {"value", "z_score", ...}}}.
    # Read z_score from the "full" layer (the per-image-aggregated zone summary).
    # Falls back gracefully to other layers if "full" is missing.
    def _read_z(cell: dict) -> float:
        if not isinstance(cell, dict) or not cell:
            return float("nan")
        # Direct hit (legacy flat layout)
        z = cell.get("z_score")
        if isinstance(z, (int, float)):
            return float(z)
        # Nested layout — prefer "full", then any other layer
        for layer in ("full", "foreground", "middleground", "background"):
            entry = cell.get(layer)
            if isinstance(entry, dict):
                zv = entry.get("z_score")
                if isinstance(zv, (int, float)):
                    return float(zv)
        return float("nan")

    rows = []
    for d in diags:
        row = []
        for ind in indicators:
            cell = d.indicator_status.get(ind) or {}
            row.append(_read_z(cell))
        rows.append(row)
    M = np.array(rows, dtype=float)

    fig_w = max(6.4, 0.42 * len(indicators) + 2.4)
    fig_h = max(2.8, 0.36 * len(diags) + 1.6)
    fig, ax = plt.subplots(figsize=(fig_w, fig_h))
    fig.subplots_adjust(left=0.16, right=0.90, top=0.85, bottom=0.20)
    im = ax.imshow(M, cmap=RDBU, vmin=-3, vmax=3, aspect="auto",
                    interpolation="nearest")
    ax.set_xticks(range(len(indicators)))
    ax.set_xticklabels(_ind_names(zar, indicators), rotation=35, ha="right", fontsize=6.0)
    ax.set_yticks(range(len(diags)))
    ax.set_yticklabels([_cluster_short(d.zone_name) for d in diags], fontsize=6.2)
    # v4.2 — significance via z-score magnitude (z=1.96 ≈ p<0.05, z=2.58 ≈ p<0.01).
    # Star convention matches the correlation-heatmap legend (Fig 18).
    for r in range(M.shape[0]):
        for c in range(M.shape[1]):
            v = M[r, c]
            if np.isnan(v):
                continue
            stars = ""
            if   abs(v) >= 2.58: stars = "***"
            elif abs(v) >= 1.96: stars = "**"
            elif abs(v) >= 1.64: stars = "*"
            txt = f"{v:+.1f}" + (f"\n{stars}" if stars else "")
            ax.text(c, r, txt, ha="center", va="center",
                    fontsize=5.2,
                    color=("white" if abs(v) > 1.6 else INK))
    cbar = fig.colorbar(im, ax=ax, fraction=0.025, pad=0.025, aspect=22)
    cbar.set_label("z-score (σ)", fontsize=6.4)
    cbar.ax.tick_params(labelsize=5.8)
    cbar.outline.set_visible(False)

    _decorate(
        fig, ax,
        title="Zone × Indicator priority heatmap",
        subtitle="Per-cell z-score against the across-zone mean · stars: *** |z|≥2.58  ** |z|≥1.96  * |z|≥1.64",
        caption=f"Fig 16. n = {len(diags)} zones × {len(indicators)} indicators · diverging RdBu, centred at 0.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 05 — Zone profile radar — by layer (B3)
# ============================================================================

def chart_radar_profiles(zar: ZoneAnalysisResult) -> Optional[str]:
    """B3 — Zone profile radar by layer.

    v4.5: data source is `radar_profiles_by_layer`, which is built from
    `df.rank(pct=True) * 100` — i.e. PERCENTILE RANK 0-100 per indicator,
    NOT z-scores. v4.4 mislabelled the radial axis as 'sigma' and the
    peak-vertex annotation came out as nonsense like '+100.0 sigma'.

    New radial scale: 0 / 25 / 50 / 75 / 100 with on-ring numeric labels,
    a 50-line marking the median rank, every vertex carries a marker,
    and the highest / lowest percentile per layer is annotated.
    """
    profs_by_layer = zar.radar_profiles_by_layer
    if not profs_by_layer:
        return None
    layers = [l for l in ("full", "foreground", "middleground", "background")
              if l in profs_by_layer]
    if not layers:
        return None
    indicators: list[str] = []; seen = set()
    for layer in layers:
        for zid, prof in profs_by_layer[layer].items():
            for k in prof.keys():
                if k not in seen:
                    seen.add(k); indicators.append(k)
    if len(indicators) < 3:
        return None
    indicators.sort()
    zone_ids = list(profs_by_layer[layers[0]].keys())
    z_lookup = {d.zone_id: d.zone_name for d in (zar.zone_diagnostics or [])}

    # Radial axis: percentile rank 0-100
    r_min, r_max = 0.0, 100.0
    rings = [0, 25, 50, 75, 100]

    n = len(layers)
    if n >= 4:
        nrows, ncols = 2, 2
    elif n == 3:
        nrows, ncols = 1, 3
    elif n == 2:
        nrows, ncols = 1, 2
    else:
        nrows, ncols = 1, 1
    fig = plt.figure(figsize=(4.6 * ncols + 0.6, 4.2 * nrows + 0.8))
    fig.subplots_adjust(left=0.07, right=0.95, top=0.86, bottom=0.12,
                        wspace=0.55, hspace=0.60)

    angles = np.linspace(0, 2 * math.pi, len(indicators), endpoint=False).tolist()
    angles_closed = angles + [angles[0]]
    spoke_names = _ind_names(zar, indicators)

    for _pi, layer in enumerate(layers):
        ax = fig.add_subplot(nrows, ncols, _pi + 1, projection="polar")
        prof = profs_by_layer[layer]

        # ── median (50%) reference line ─────────────────────────────────
        median_ring = [50.0] * (len(indicators) + 1)
        ax.plot(angles_closed, median_ring, color=MUTE, linewidth=0.6,
                linestyle=(0, (2, 2)), alpha=0.6, zorder=1)

        # Plot each zone
        for i, zid in enumerate(zone_ids):
            row = prof.get(zid, {})
            vals = [float(row.get(ind, 0.0)) if isinstance(row.get(ind), (int, float)) else 0.0
                    for ind in indicators]
            vals_closed = vals + [vals[0]]
            colour = _category_color(i)
            ax.plot(angles_closed, vals_closed, color=colour, linewidth=1.0,
                    marker="o", markersize=2.6,
                    markeredgecolor="white", markeredgewidth=0.4, zorder=3)
            ax.fill(angles_closed, vals_closed, color=colour, alpha=0.10,
                    zorder=2)

        # ── Spoke labels — angle-aware alignment ────────────────────────
        ax.set_xticks(angles)
        ax.set_xticklabels([])  # custom drawing below
        for ang, name in zip(angles, spoke_names):
            deg = math.degrees(ang) % 360
            if 95 < deg < 265:
                ha = "right"
            elif deg < 85 or deg > 275:
                ha = "left"
            else:
                ha = "center"
            ax.text(ang, r_max * 1.16, name, ha=ha, va="center",
                    fontsize=5.4, color=MUTE, family="Times New Roman")

        # ── Radial axis: 0 / 25 / 50 / 75 / 100 ─────────────────────────
        ax.set_ylim(r_min, r_max)
        ax.set_yticks(rings)
        ax.set_yticklabels([str(r) for r in rings],
                           fontsize=4.8, color=MUTE)
        ax.set_rlabel_position(108)  # spoke-clear angle for the labels

        # v4.6 - peak/trough "pct = N" callouts removed: with 0-100 rings
        # already drawn the values were redundant clutter on the polygons.

        ax.set_title(layer.capitalize(), fontsize=7.2, color=INK, pad=10,
                     fontweight="bold")
        _panel_label(ax, "abcd"[_pi])
        ax.spines["polar"].set_color(HAIR)
        ax.spines["polar"].set_linewidth(0.4)
        ax.grid(color=HAIR, linewidth=0.3, alpha=0.7)

    # Shared legend at bottom
    handles = [plt.Line2D([0], [0], color=_category_color(i), lw=1.2,
                          label=_cluster_short(z_lookup.get(zid, zid)))
               for i, zid in enumerate(zone_ids)]
    fig.legend(handles=handles, loc="lower center",
               ncol=min(4, len(zone_ids)),
               bbox_to_anchor=(0.5, 0.0),
               fontsize=6.4, frameon=False,
               columnspacing=1.4, handletextpad=0.5)

    _decorate(
        fig, fig.axes,
        title="Zone profile radar — by layer",
        subtitle=("Per-zone PERCENTILE RANK (0-100) across each visual-depth "
                  "layer; dashed ring = median rank (50); peak / trough labelled"),
        caption=(f"Fig 17. n = {len(zone_ids)} zones x {len(indicators)} "
                 f"indicators x {n} layers. Percentile rank computed within "
                 f"each indicator (rank-pct x 100)."),
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 06 — Spatial z-deviation map (B4)
# ============================================================================

def chart_spatial_z_deviation(zar: ZoneAnalysisResult) -> Optional[str]:
    pts, indicators, _ = _pivot_image_records(zar)
    pts = [p for p in pts if p.get("lat") is not None and p.get("lng") is not None]
    if not pts or not indicators:
        return None
    indicators = sorted(indicators)
    layers = ["full", "foreground", "middleground", "background"]
    fig, axes = plt.subplots(1, 4, figsize=(9.6, 2.8))
    fig.subplots_adjust(left=0.05, right=0.92, top=0.80, bottom=0.22, wspace=0.25)
    lats = np.array([p["lat"] for p in pts])
    lngs = np.array([p["lng"] for p in pts])
    # Per-layer mean |z|.
    global_vmax = 0.0
    layer_arrs = {}
    for layer in layers:
        suffix = "" if layer == "full" else f"__{layer}"
        vals_per_pt = []
        for p in pts:
            zs = []
            for ind in indicators:
                key = f"{ind}{suffix}" if suffix else ind
                v = p["metrics"].get(key)
                if isinstance(v, (int, float)):
                    arr = np.array([
                        q["metrics"].get(key) for q in pts
                        if isinstance(q["metrics"].get(key), (int, float))
                    ], dtype=float)
                    if arr.size >= 3:
                        m, s = arr.mean(), arr.std() or 1.0
                        zs.append(abs((v - m) / s))
            vals_per_pt.append(float(np.mean(zs)) if zs else np.nan)
        layer_arrs[layer] = np.array(vals_per_pt, dtype=float)
        if np.isfinite(layer_arrs[layer]).any():
            global_vmax = max(global_vmax,
                              float(np.nanpercentile(layer_arrs[layer], 95)))
    if global_vmax == 0:
        global_vmax = 1.0
    norm = Normalize(0, global_vmax)

    for _pi, (ax, layer) in enumerate(zip(axes, layers)):
        v_arr = layer_arrs[layer]
        ax.scatter(lngs, lats, c=v_arr, cmap=PARULA, norm=norm,
                   s=7, edgecolor="white", linewidth=0.15)
        ax.set_title(layer.capitalize(), fontsize=7.4, color=INK, pad=4,
                     fontweight="bold")
        _panel_label(ax, "abcd"[_pi])
        ax.tick_params(labelsize=5.4)
        ax.set_xlabel("Longitude", fontsize=6.0)
        if ax is axes[0]:
            ax.set_ylabel("Latitude", fontsize=6.0)
        ax.set_aspect("equal", adjustable="datalim")
        ax.spines["bottom"].set_color(LINE); ax.spines["left"].set_color(LINE)

    cax = fig.add_axes([0.93, 0.24, 0.012, 0.55])
    sm = plt.cm.ScalarMappable(cmap=PARULA, norm=norm); sm.set_array([])
    cb = fig.colorbar(sm, cax=cax)
    cb.set_label("Mean |z| (σ)", fontsize=6.0)
    cb.ax.tick_params(labelsize=5.4)
    cb.outline.set_visible(False)

    _decorate(
        fig, axes,
        title="Spatial deviation map — geographic, by layer",
        subtitle="Each point = an image, coloured by its mean absolute z-score across all selected indicators",
        caption=f"Suppl. Fig 2. n = {len(pts)} GPS-located images · 4 layers · YlOrRd ramp clamped to p5-p95.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 07 — Distribution violin (C1)
# ============================================================================

def chart_distribution_violin(zar: ZoneAnalysisResult) -> Optional[str]:
    """C1 — Indicator distribution (global baseline, per-indicator small multiples).

    v4.4 — matches the platform's C1 layout exactly: one subplot PER
    INDICATOR, within each subplot the four layers (Full / FG / MG / BG)
    are categorical x-values, y-axis is the indicator's native scale.
    Each layer shows a violin + median line + mean diamond + n label.

    Previously (v4.3 and earlier) packed every indicator into the same
    panel sharing one y-axis, which squashed small-range indicators
    (e.g. Fractal Dimension 1.0-2.0) next to large-range ones (Building
    View Index 0-100). This grid layout removes the squash because each
    indicator gets its own y-axis.
    """
    pts, indicators, _ = _pivot_image_records(zar)
    if not pts or not indicators:
        return None
    indicators = sorted(indicators)
    n_ind = len(indicators)
    layers = ["full", "foreground", "middleground", "background"]
    layer_short = ["Full", "FG", "MG", "BG"]

    # Grid: 3 cols, ceil(n_ind / 3) rows  (matches platform's responsive grid)
    ncols = 3
    nrows = (n_ind + ncols - 1) // ncols
    cell_w, cell_h = 3.0, 2.3
    fig, axes = plt.subplots(nrows, ncols,
                              figsize=(cell_w * ncols + 0.5, cell_h * nrows + 0.8),
                              squeeze=False)
    fig.subplots_adjust(left=0.06, right=0.97, top=0.92 - 0.012 * nrows,
                        bottom=0.07, wspace=0.40, hspace=0.55)

    for idx, ind in enumerate(indicators):
        ax = axes[idx // ncols][idx % ncols]
        data, ns = [], []
        for layer in layers:
            suffix = "" if layer == "full" else f"__{layer}"
            key = f"{ind}{suffix}" if suffix else ind
            vals = [p["metrics"].get(key) for p in pts
                    if isinstance(p["metrics"].get(key), (int, float))]
            data.append(np.array(vals, dtype=float) if vals else np.array([np.nan]))
            ns.append(len(vals))
        # Draw 4 violins
        nonempty_positions = [i + 1 for i, d in enumerate(data) if d.size > 0 and np.isfinite(d).any()]
        nonempty_data = [data[i] for i in range(len(data)) if data[i].size > 0 and np.isfinite(data[i]).any()]
        if not nonempty_data:
            ax.set_visible(False)
            continue
        parts = ax.violinplot(nonempty_data, positions=nonempty_positions,
                              showmeans=False, showextrema=False,
                              showmedians=True, widths=0.75)
        for j, body in enumerate(parts["bodies"]):
            body.set_facecolor(_category_color(nonempty_positions[j] - 1))
            body.set_alpha(0.40)
            body.set_edgecolor(_category_color(nonempty_positions[j] - 1))
            body.set_linewidth(0.5)
        if "cmedians" in parts:
            parts["cmedians"].set_color(INK)
            parts["cmedians"].set_linewidth(0.7)

        # Mean diamond overlay
        for i, d in enumerate(data):
            d_finite = d[np.isfinite(d)] if d.size > 0 else d
            if d_finite.size > 0:
                ax.scatter([i + 1], [float(np.mean(d_finite))],
                           marker="D", s=14, c="white",
                           edgecolors=_category_color(i), linewidths=0.6,
                           zorder=4)

        ax.set_xticks(range(1, len(layers) + 1))
        ax.set_xticklabels([f"{lbl}\nn={n}" for lbl, n in zip(layer_short, ns)],
                            fontsize=5.4, color=MUTE)
        nm = _ind_name(zar, ind)
        ax.set_title(f"{nm}", fontsize=6.6, color=INK,
                     fontweight="bold", pad=3)
        ax.tick_params(axis="y", labelsize=5.4)
        ax.spines["bottom"].set_color(LINE)
        ax.spines["left"].set_color(LINE)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.grid(axis="y", color=HAIR, linewidth=0.3, alpha=0.7, zorder=0)
        ax.set_axisbelow(True)

    # Hide unused cells in the last row
    for k in range(n_ind, nrows * ncols):
        axes[k // ncols][k % ncols].set_visible(False)

    _decorate(
        fig, axes,
        title="Indicator distribution — image-level, all images pooled",
        subtitle=("Per-indicator small multiples; within each panel, four layers "
                  "(Full / FG / MG / BG) - violin + median bar + mean diamond"),
        caption=f"Suppl. Fig 3. n = {len(pts)} images x {n_ind} indicators x 4 layers (independent y-axes).",
    )
    return _fig_to_svg(fig)


# Chart 08 — Indicator deep-dive (C2)
# ============================================================================

def chart_indicator_deep_dive(zar: ZoneAnalysisResult) -> Optional[str]:
    """C2 — Per-Indicator drill-down (compact multi-column grid, no leader labels).

    v4.10 — compact layout: n_ind / 2 rows × 2 cols (drops down to 1 col
    only when n_ind <= 3). Each cell is a small Zone × Layer profile
    line plot. Vertex values are NOT separately labelled — the y-axis
    ticks already carry the scale, and overlapping leader callouts made
    earlier revs unreadable. Independent y-axis per panel so different
    indicator scales (Fractal Dimension 1-2 vs Building View Index 0-100)
    don't squash each other.
    """
    stats = zar.zone_statistics or []
    if not stats:
        return None
    by_ind: dict[str, dict[str, dict[str, float]]] = {}
    for s in stats:
        by_ind.setdefault(s.indicator_id, {}).setdefault(s.zone_id, {})[s.layer] = (
            s.mean if isinstance(s.mean, (int, float)) else float("nan")
        )
    indicators = sorted(by_ind.keys())
    if not indicators:
        return None
    z_lookup = {d.zone_id: d.zone_name for d in (zar.zone_diagnostics or [])}
    layers       = ["full", "foreground", "middleground", "background"]
    layers_short = ["Full", "FG", "MG", "BG"]

    n_ind = len(indicators)
    # Compact grid: 2 cols when n_ind >= 4, else 1 col.
    ncols = 2 if n_ind >= 4 else 1
    nrows = (n_ind + ncols - 1) // ncols
    cell_w = 4.6 if ncols == 2 else 9.0
    cell_h = 1.7
    fig, axes = plt.subplots(
        nrows, ncols,
        figsize=(cell_w * ncols + 0.3, cell_h * nrows + 0.8),
        squeeze=False,
    )
    fig.subplots_adjust(left=0.10, right=0.97,
                        top=0.93 - 0.012 / max(1, nrows),
                        bottom=0.07, wspace=0.30, hspace=0.55)

    for idx, ind in enumerate(indicators):
        r, c = divmod(idx, ncols)
        ax = axes[r][c]

        # Sort zones by full-layer mean desc (consistent ordering across charts)
        zone_full = []
        for zid, lyr_vals in by_ind[ind].items():
            v = lyr_vals.get("full")
            zone_full.append((zid, v if isinstance(v, (int, float)) and not np.isnan(v) else None))
        zone_full.sort(key=lambda kv: (kv[1] is None, -(kv[1] or 0)))
        zone_order = [zid for zid, _ in zone_full]

        for i, zid in enumerate(zone_order):
            layer_vals = by_ind[ind].get(zid, {})
            vals = [layer_vals.get(l, np.nan) for l in layers]
            colour = _category_color(i)
            ax.plot(layers_short, vals,
                    marker="o", markersize=3.4, linewidth=0.9,
                    color=colour,
                    markeredgecolor="white", markeredgewidth=0.4,
                    label=_cluster_short(z_lookup.get(zid, zid)))

        ax.set_title(_ind_name(zar, ind), fontsize=6.6, color=NAVY,
                     fontweight="bold", pad=3, family="Times New Roman")
        ax.tick_params(axis="x", labelsize=5.4)
        ax.tick_params(axis="y", labelsize=5.0)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.spines["bottom"].set_color(LINE)
        ax.spines["left"].set_color(LINE)
        ax.grid(axis="y", color=HAIR, linewidth=0.3, alpha=0.5)
        ax.set_axisbelow(True)

    # Hide unused cells (when n_ind is odd in a 2-col layout)
    for k in range(n_ind, nrows * ncols):
        r, c = divmod(k, ncols)
        axes[r][c].set_visible(False)

    handles, labels = axes[0][0].get_legend_handles_labels()
    if handles:
        fig.legend(handles, labels, loc="lower center",
                   bbox_to_anchor=(0.5, -0.005),
                   ncol=min(6, len(handles)),
                   fontsize=6.0, frameon=False, columnspacing=1.6)

    _decorate(
        fig, axes,
        title="Per-indicator drill-down — by zone × layer",
        subtitle=("One compact panel per indicator; lines = zone means at "
                  "each visual-depth layer · independent y-axis per panel"),
        caption=f"Suppl. Fig 4. n = {n_ind} indicators × {len(z_lookup)} zones.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 09 — Within-zone image distribution (C3)
# ============================================================================

def chart_within_zone_image_distribution(zar: ZoneAnalysisResult) -> Optional[str]:
    """C3 — INDICATOR × LAYER grid (was full-layer only pre-v4.1).

    Matches the frontend ``WithinZoneImageDistribution`` 4-panel grid:
    for each indicator, four panels (Full / FG / MG / BG) with K
    side-by-side box-whiskers (one per zone).  This unifies the chart
    type between the platform UI and the bundle SVG export.
    """
    pts, indicators, _ = _pivot_image_records(zar)
    if not pts or not zar.zone_diagnostics:
        return None
    zones = list(zar.zone_diagnostics)
    indicators = sorted(indicators)
    if not indicators:
        return None

    layers = ["full", "foreground", "middleground", "background"]
    n_ind = len(indicators)
    fig, axes = plt.subplots(n_ind, 4, figsize=(11.2, 1.75 * n_ind + 1.4),
                              squeeze=False)
    fig.subplots_adjust(left=0.08, right=0.98, top=0.95, bottom=0.06,
                        wspace=0.18, hspace=0.55)
    for row_idx, ind in enumerate(indicators):
        for col_idx, layer in enumerate(layers):
            ax = axes[row_idx, col_idx]
            suffix = "" if layer == "full" else f"__{layer}"
            key = f"{ind}{suffix}" if suffix else ind
            data, labels = [], []
            for i, z in enumerate(zones):
                vals = [p["metrics"].get(key) for p in pts
                        if p["zone_id"] == z.zone_id
                        and isinstance(p["metrics"].get(key), (int, float))]
                if vals:
                    data.append(np.array(vals, dtype=float))
                    labels.append(f"C{i}")
            if not data:
                ax.set_visible(False); continue
            bp = ax.boxplot(data, patch_artist=True, widths=0.62,
                            showfliers=False)
            for i, patch in enumerate(bp["boxes"]):
                patch.set_facecolor(_category_color(i)); patch.set_alpha(0.65)
                patch.set_edgecolor(INK); patch.set_linewidth(0.35)
            for w in bp["whiskers"]: w.set_color(INK); w.set_linewidth(0.35)
            for c in bp["caps"]: c.set_color(INK); c.set_linewidth(0.35)
            for m in bp["medians"]: m.set_color(INK); m.set_linewidth(0.7)
            if row_idx == 0:
                ax.set_title(layer.capitalize(), fontsize=7.0, color=INK,
                             pad=2, fontweight="bold")
            if col_idx == 0:
                ax.text(-0.32, 0.5, _ind_name(zar, ind),
                        transform=ax.transAxes, ha="right", va="center",
                        fontsize=6.4, fontweight="bold", color=NAVY,
                        family="Times New Roman")
            ax.set_xticks(range(1, len(labels) + 1))
            ax.set_xticklabels(labels, fontsize=4.8)
            ax.tick_params(axis="y", labelsize=5.0)
            ax.spines["bottom"].set_color(LINE); ax.spines["left"].set_color(LINE)
            ax.grid(axis="y", color=HAIR, linewidth=0.3, alpha=0.5)
    # Bottom legend for zone colour mapping
    handles = [plt.Rectangle((0, 0), 1, 1, color=_category_color(i), alpha=0.65)
               for i in range(len(zones))]
    fig.legend(handles,
               [_cluster_short(z.zone_name) for z in zones],
               loc="lower center", bbox_to_anchor=(0.5, 0.005),
               ncol=min(3, len(zones)),
               fontsize=6.4, frameon=False, columnspacing=1.4)

    _decorate(
        fig, axes,
        title="Within-zone image distribution — by indicator × layer",
        subtitle="Per-indicator 4-panel grid (Full / FG / MG / BG); each panel = K side-by-side box-whiskers",
        caption=f"Suppl. Fig 5. {n_ind} indicators × 4 layers × {len(zones)} zones · whiskers = 1.5 × IQR.",
        suptitle_y=0.992,
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 10 — Indicator value spatial grid (C4)
# ============================================================================

def chart_value_spatial_grid(zar: ZoneAnalysisResult) -> Optional[str]:
    pts, indicators, _ = _pivot_image_records(zar)
    pts = [p for p in pts if p.get("lat") is not None and p.get("lng") is not None]
    if not pts or not indicators:
        return None
    # v4.3 — render ALL indicators (was hard-capped at 6 for plot height,
    # but the figure naturally grows tall and that's the correct supplementary
    # behaviour). For very long projects the figure can hit ~25 pt rows;
    # at that point we let matplotlib decide.
    indicators = sorted(indicators)
    layers = ["full", "foreground", "middleground", "background"]
    n_ind = len(indicators)
    # Cap row height to keep the SVG from becoming unwieldy when n_ind > 12.
    row_h = 1.9 if n_ind <= 8 else max(1.2, 1.9 * 8 / n_ind)
    fig, axes = plt.subplots(n_ind, 4, figsize=(9.6, row_h * n_ind + 0.6),
                              squeeze=False)
    fig.subplots_adjust(left=0.10, right=0.91, top=0.93 - 0.025 / n_ind,
                        bottom=0.06, wspace=0.12, hspace=0.35)
    lats = np.array([p["lat"] for p in pts])
    lngs = np.array([p["lng"] for p in pts])
    for row_idx, ind in enumerate(indicators):
        # Per-indicator vmin/vmax so each row's parula ramp is fully utilised.
        all_vals = []
        for layer in layers:
            suffix = "" if layer == "full" else f"__{layer}"
            key = f"{ind}{suffix}" if suffix else ind
            for p in pts:
                v = p["metrics"].get(key)
                if isinstance(v, (int, float)):
                    all_vals.append(v)
        if not all_vals:
            for col in range(4):
                axes[row_idx, col].set_visible(False)
            continue
        v_lo = float(np.percentile(all_vals, 5))
        v_hi = float(np.percentile(all_vals, 95))
        if v_hi <= v_lo:
            v_hi = v_lo + 1
        norm = Normalize(v_lo, v_hi)
        for col_idx, layer in enumerate(layers):
            ax = axes[row_idx, col_idx]
            suffix = "" if layer == "full" else f"__{layer}"
            key = f"{ind}{suffix}" if suffix else ind
            vals = np.array([
                p["metrics"].get(key) if isinstance(p["metrics"].get(key), (int, float))
                else np.nan
                for p in pts
            ], dtype=float)
            valid = np.isfinite(vals)
            if not valid.any():
                ax.set_visible(False); continue
            ax.scatter(lngs[valid], lats[valid], c=vals[valid],
                       cmap=PARULA, norm=norm,
                       s=5, edgecolor="white", linewidth=0.12)
            if row_idx == 0:
                ax.set_title(layer.capitalize(), fontsize=7.4, color=INK,
                             pad=2, fontweight="bold")
            if col_idx == 0:
                ax.text(-0.16, 0.5, _ind_name(zar, ind),
                        transform=ax.transAxes, ha="right", va="center",
                        fontsize=6.6, fontweight="bold", color=NAVY,
                        family="Times New Roman")
            # v4.2 — per-panel summary stats (mean / median / range) baked
            # into the top-left corner so every cell has explicit numerical
            # values, not just a colour ramp. ImageMagick can't read 1,233
            # individual GPS points, but it can read these three numbers.
            v_arr = vals[valid]
            n_pts = int(v_arr.size)
            mean_v = float(np.mean(v_arr))
            med_v  = float(np.median(v_arr))
            min_v  = float(np.min(v_arr))
            max_v  = float(np.max(v_arr))
            stats_txt = (
                f"n={n_pts}\n"
                f"μ={mean_v:.2f}\n"
                f"med={med_v:.2f}\n"
                f"min={min_v:.2f}\n"
                f"max={max_v:.2f}"
            )
            ax.text(0.02, 0.98, stats_txt,
                    transform=ax.transAxes, ha="left", va="top",
                    fontsize=4.4, color=INK,
                    family="Times New Roman",
                    bbox=dict(boxstyle="round,pad=0.2", fc="white",
                              ec=HAIR, lw=0.3, alpha=0.85))
            ax.set_xticks([]); ax.set_yticks([])
            ax.set_aspect("equal", adjustable="datalim")
            ax.spines["bottom"].set_color(HAIR)
            ax.spines["left"].set_color(HAIR)
            # Per-row colorbar on the last column.
            if col_idx == 3:
                cax = ax.inset_axes([1.04, 0.05, 0.04, 0.9])
                sm = plt.cm.ScalarMappable(cmap=PARULA, norm=norm); sm.set_array([])
                cb = fig.colorbar(sm, cax=cax)
                # Show three tick values (p5 / mid / p95) instead of just two
                v_mid = (v_lo + v_hi) / 2
                cb.set_ticks([v_lo, v_mid, v_hi])
                cb.set_ticklabels([f"{v_lo:.2g}", f"{v_mid:.2g}", f"{v_hi:.2g}"])
                cb.ax.tick_params(labelsize=5.0)
                cb.outline.set_visible(False)
                # Pull the actual measurement unit from IndicatorDefinition
                # (e.g. "%", "score", "ratio", "dimensionless") so each row's
                # colorbar reads e.g. "Green View Index (%)" instead of the
                # generic "value (p5-p95)".
                _def = (zar.indicator_definitions or {}).get(ind)
                _unit = ""
                if _def is not None:
                    if hasattr(_def, "unit"):
                        _unit = _def.unit or ""
                    elif isinstance(_def, dict):
                        _unit = _def.get("unit", "") or ""
                unit_str = f" ({_unit})" if _unit else " (p5-p95)"
                cb.set_label(f"value{unit_str}", fontsize=5.0, color=MUTE)

    _decorate(
        fig, axes,
        title="Indicator value map — geographic, by layer",
        subtitle="One row per indicator, four panels per row (Full / FG / MG / BG); colour = value (p5-p95) on MATLAB parula",
        caption=f"Suppl. Fig 6. n = {len(pts)} GPS-located images · {n_ind} indicators × 4 layers.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 11 — Global stats table (D1)
# ============================================================================

def chart_global_stats_table(zar: ZoneAnalysisResult) -> Optional[str]:
    """D1 — Global descriptive statistics table.

    v4.4 — column set rewritten to match the platform's `GlobalStatsTable`
    component exactly:

        Indicator | Full | FG | MG | BG | CV% | Shapiro p | K-W p

    where each layer cell carries `mean±std`, CV% is the full-layer
    coefficient of variation, and the two p-values are bolded red when
    < .05 (significant deviation from normality / significant
    cross-zone difference, respectively).

    Previously (v4.1-4.3) only emitted N/Mean/Std/Min/Max/CV for the FULL
    layer, missing the per-layer breakdown and the normality / KW tests
    the platform displays.
    """
    stats = zar.global_indicator_stats or []
    if not stats:
        return None

    def _fmt_p(p) -> str:
        if not isinstance(p, (int, float)) or np.isnan(p):
            return "—"
        if p < 0.001: return "<.001"
        if p < 0.01:  return f"{p:.3f}"
        return f"{p:.2f}"

    def _fmt_layer(layer_entry: dict) -> str:
        m = layer_entry.get("Mean") if layer_entry else None
        s = layer_entry.get("Std")  if layer_entry else None
        if isinstance(m, (int, float)) and isinstance(s, (int, float)):
            return f"{m:.1f}±{s:.1f}"
        return "—"

    headers = ["Indicator", "Full", "FG", "MG", "BG", "CV (%)",
               "Shapiro p", "K-W p"]
    layer_keys = ["full", "foreground", "middleground", "background"]
    rows: list[list[str]] = []
    sig_flags: list[tuple[bool, bool]] = []  # (shapiro_sig, kruskal_sig)
    for s in stats:
        d = _safe_dump(s)
        by_layer = d.get("by_layer", {}) or {}
        ind_id = d.get("indicator_id", "")
        ind_nm = _ind_name(zar, ind_id)
        row = [f"{ind_nm}" if ind_nm and ind_nm != ind_id else ind_id]
        for lk in layer_keys:
            row.append(_fmt_layer(by_layer.get(lk) or {}))
        cv = d.get("cv_full")
        row.append(f"{cv:.0f}" if isinstance(cv, (int, float)) else "—")
        shap = d.get("shapiro_p")
        krus = d.get("kruskal_p")
        row.append(_fmt_p(shap))
        row.append(_fmt_p(krus))
        rows.append(row)
        sig_flags.append((
            isinstance(shap, (int, float)) and shap < 0.05,
            isinstance(krus, (int, float)) and krus < 0.05,
        ))

    fig_h = max(2.6, 0.30 * len(rows) + 1.0)
    fig = plt.figure(figsize=(8.6, fig_h))
    ax = fig.add_axes([0.02, 0.02, 0.96, 0.84])
    ax.axis("off")
    col_widths = [0.24, 0.11, 0.11, 0.11, 0.11, 0.08, 0.12, 0.12]
    table = ax.table(cellText=rows, colLabels=headers,
                     cellLoc="center", colLoc="center", loc="upper left",
                     colWidths=col_widths)
    table.auto_set_font_size(False); table.set_fontsize(6.0); table.scale(1.0, 1.22)
    n_cols = len(headers)
    for (r, c), cell in table.get_celld().items():
        cell.set_linewidth(0.0)
        if r == 0:
            cell.set_facecolor("white")
            cell.set_text_props(weight="bold", color=INK, fontsize=6.4)
            cell.set_height(cell.get_height() * 1.1)
            cell.visible_edges = "B"
        else:
            cell.visible_edges = ""
            cell.set_facecolor("white" if r % 2 == 1 else SHADE)
            if c == 0:
                cell.set_text_props(weight="bold", color=NAVY,
                                    family="Times New Roman")
            # Highlight p-values < .05 (cols 6, 7)
            if r - 1 < len(sig_flags):
                shap_sig, krus_sig = sig_flags[r - 1]
                if c == 6 and shap_sig:
                    cell.set_text_props(weight="bold", color="#C8423B")
                elif c == 7 and krus_sig:
                    cell.set_text_props(weight="bold", color="#C8423B")
    _decorate(
        fig, ax,
        title="Global descriptive statistics",
        subtitle=("Mean ± Std per layer · CV % on full layer · "
                  "Shapiro-Wilk normality · Kruskal-Wallis cross-zone test"),
        caption=("Table 7. Bold red p-value = significant at α = 0.05. "
                 "CV = coefficient of variation (Std / |Mean|)."),
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 12 — Zone × Indicator mean matrix (D2)
# ============================================================================

def chart_zone_indicator_matrix(zar: ZoneAnalysisResult) -> Optional[str]:
    """D2 — TABLE form (was a heatmap pre-v4.1).

    Matches the frontend Chakra ``<Table>`` rendering: rows = zones,
    columns = indicators, cells = full-layer mean values, with a
    `Global Mean` reference row at the bottom rendered in burgundy.

    Why a table not a heatmap: cells with similar means are visually
    indistinguishable on a colormap, and the frontend already renders a
    table — so the bundle SVG now matches what users see on the
    platform.
    """
    stats = zar.zone_statistics or []
    if not stats:
        return None
    indicators = sorted({s.indicator_id for s in stats if s.layer == "full"})
    zones = list(dict.fromkeys((s.zone_id, s.zone_name) for s in stats if s.layer == "full"))
    if not indicators or not zones:
        return None
    M = np.full((len(zones), len(indicators)), np.nan)
    for s in stats:
        if s.layer != "full": continue
        try:
            zi = [z[0] for z in zones].index(s.zone_id)
            ii = indicators.index(s.indicator_id)
            M[zi, ii] = s.mean if s.mean is not None else np.nan
        except ValueError:
            continue
    global_mean = np.nanmean(M, axis=0)

    # Build the row text matrix (zones + Global Mean reference row)
    rows_text: list[list[str]] = []
    for zi, (_, zname) in enumerate(zones):
        rows_text.append([zname] +
                         [f"{M[zi, c]:.2f}" if not np.isnan(M[zi, c]) else "—"
                          for c in range(len(indicators))])
    rows_text.append(["Global Mean"] +
                     [f"{global_mean[c]:.2f}" if not np.isnan(global_mean[c]) else "—"
                      for c in range(len(indicators))])

    fig_w = max(7.4, 0.55 * len(indicators) + 2.0)
    fig_h = max(2.6, 0.32 * (len(zones) + 1) + 1.2)
    fig = plt.figure(figsize=(fig_w, fig_h))
    ax = fig.add_axes([0.02, 0.02, 0.96, 0.84]); ax.axis("off")
    short_inds = _ind_names(zar, indicators)
    table = ax.table(
        cellText=rows_text, colLabels=["Zone"] + short_inds,
        cellLoc="center", colLoc="center", loc="upper left",
    )
    table.auto_set_font_size(False); table.set_fontsize(6.2); table.scale(1.0, 1.28)
    for (r, c), cell in table.get_celld().items():
        cell.set_linewidth(0.0)
        if r == 0:
            cell.set_facecolor("white")
            cell.set_text_props(weight="bold", color=INK, fontsize=6.6)
            cell.set_height(cell.get_height() * 1.1)
            cell.visible_edges = "B"
        else:
            cell.visible_edges = ""
            is_global = (r == len(zones) + 1)
            cell.set_facecolor(SHADE if is_global else
                                ("white" if r % 2 == 1 else SHADE))
            if c == 0:
                cell.set_text_props(weight="bold", color=NAVY,
                                    family="Times New Roman")
                if is_global:
                    cell.set_text_props(weight="bold", color=BURGUNDY)
            elif is_global:
                cell.set_text_props(weight="bold", color=BURGUNDY)
    _decorate(
        fig, ax,
        title="Zone × Indicator mean matrix",
        subtitle="Full-layer mean per (zone, indicator) cell + Global Mean reference row",
        caption=f"Table 8. n = {len(zones)} zones × {len(indicators)} indicators · means in raw indicator units.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 13 — Correlation heatmap (D3)
# ============================================================================

def chart_correlation_heatmap(zar: ZoneAnalysisResult) -> Optional[str]:
    """D3 — Indicator correlation heatmap, by layer.

    v4.6 — switched 1x4 → 2x2 grid so panel tick labels (10 indicators
    rotated 45deg) don't bleed into the next panel. Each panel is now
    ~4.2-inch wide instead of ~2.8-inch."""
    corr = zar.correlation_by_layer or {}
    if not corr: return None
    layers = [l for l in ("full", "foreground", "middleground", "background")
              if l in corr]
    if not layers: return None
    n = len(layers)
    # 2x2 when all 4 layers present (gives each panel ~4.2-inch width)
    if n >= 4:
        nrows, ncols = 2, 2
    elif n == 3:
        nrows, ncols = 1, 3
    elif n == 2:
        nrows, ncols = 1, 2
    else:
        nrows, ncols = 1, 1

    fig, axes = plt.subplots(nrows, ncols,
                              figsize=(4.3 * ncols + 0.6, 4.0 * nrows + 0.6),
                              squeeze=False)
    fig.subplots_adjust(left=0.10, right=0.88, top=0.92, bottom=0.10,
                        wspace=0.55, hspace=0.55)
    axes_flat = list(axes.flat)
    pval_by_layer = zar.pvalue_by_layer or {}

    def _stars(p):
        if p is None: return ""
        if p < 0.001: return "***"
        if p < 0.01:  return "**"
        if p < 0.05:  return "*"
        return ""

    last_im = None
    for _pi, (ax, layer) in enumerate(zip(axes_flat, layers)):
        cm = corr[layer]
        pm = pval_by_layer.get(layer, {}) if isinstance(pval_by_layer, dict) else {}
        inds = sorted(cm.keys())
        M = np.array([[float(cm.get(a, {}).get(b, np.nan)) for b in inds]
                      for a in inds])
        im = ax.imshow(M, cmap=RDBU, vmin=-1, vmax=1, aspect="equal",
                       interpolation="nearest")
        last_im = im
        short = _ind_names(zar, inds)
        ax.set_xticks(range(len(inds)))
        ax.set_xticklabels(short, rotation=45, ha="right", fontsize=5.4)
        ax.set_yticks(range(len(inds)))
        ax.set_yticklabels(short, fontsize=5.4)
        for i in range(len(inds)):
            for j in range(len(inds)):
                v = M[i, j]
                if np.isnan(v):
                    continue
                p = pm.get(inds[i], {}).get(inds[j]) if isinstance(pm, dict) else None
                stars = _stars(p) if i != j else ""
                txt = f"{v:.2f}" + (f"\n{stars}" if stars else "")
                ax.text(j, i, txt, ha="center", va="center",
                        fontsize=4.4,
                        color=("white" if abs(v) > 0.55 else INK))
        ax.set_title(layer.capitalize(), fontsize=7.4, color=INK, pad=4,
                      fontweight="bold")
        _panel_label(ax, "abcd"[_pi])

    # Hide unused cells (e.g. layers < 4 in 2x2 grid)
    for k in range(n, nrows * ncols):
        axes_flat[k].set_visible(False)

    if last_im is not None:
        cax = fig.add_axes([0.91, 0.30, 0.012, 0.42])
        cb = fig.colorbar(last_im, cax=cax)
        cb.set_label("Pearson / Spearman r", fontsize=6.0)
        cb.ax.tick_params(labelsize=5.4); cb.outline.set_visible(False)

    _decorate(
        fig, axes,
        title="Indicator correlation — pairwise, by layer",
        subtitle=("One heatmap per visual-depth layer · RdBu diverging from "
                  "r = -1 to r = +1 · stars: *** p<0.001  ** p<0.01  * p<0.05"),
        caption="Fig 18. Pearson (default) or Spearman per indicator pair (see Table 6 for the method).",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 14 — Cluster centroid heatmap
# ============================================================================

def chart_cluster_centroid_heatmap(zar: ZoneAnalysisResult) -> Optional[str]:
    cl = zar.clustering
    if not cl or not cl.archetype_profiles: return None
    arche = cl.archetype_profiles
    indicators: list[str] = []; seen = set()
    for a in arche:
        for k in a.centroid_z_scores.keys():
            if k not in seen:
                seen.add(k); indicators.append(k)
    indicators.sort()
    M = np.array([[a.centroid_z_scores.get(i, np.nan) for i in indicators]
                  for a in arche], dtype=float)
    fig_w = max(6.4, 0.42 * len(indicators) + 2.6)
    fig_h = max(2.8, 0.42 * len(arche) + 1.4)
    fig, ax = plt.subplots(figsize=(fig_w, fig_h))
    fig.subplots_adjust(left=0.30, right=0.90, top=0.84, bottom=0.22)
    im = ax.imshow(M, cmap=RDBU, vmin=-3, vmax=3, aspect="auto",
                   interpolation="nearest")
    ax.set_xticks(range(len(indicators)))
    ax.set_xticklabels(_ind_names(zar, indicators), rotation=35, ha="right", fontsize=6.0)
    ax.set_yticks(range(len(arche)))
    ax.set_yticklabels(
        [f"C{a.archetype_id}" for a in arche],
        fontsize=6.0,
    )
    # v4.2 — same z-score-based significance convention as Fig 4 / Fig 18.
    for r in range(M.shape[0]):
        for c in range(M.shape[1]):
            v = M[r, c]
            if np.isnan(v):
                continue
            stars = ""
            if   abs(v) >= 2.58: stars = "***"
            elif abs(v) >= 1.96: stars = "**"
            elif abs(v) >= 1.64: stars = "*"
            txt = f"{v:+.1f}" + (f"\n{stars}" if stars else "")
            ax.text(c, r, txt, ha="center", va="center",
                    fontsize=5.2,
                    color=("white" if abs(v) > 1.6 else INK))
    cbar = fig.colorbar(im, ax=ax, fraction=0.025, pad=0.025, aspect=22)
    cbar.set_label("z-score (σ)", fontsize=6.2); cbar.ax.tick_params(labelsize=5.6)
    cbar.outline.set_visible(False)
    _decorate(
        fig, ax,
        title="Cluster centroid heatmap",
        subtitle="Mean z-score per (cluster, indicator) cell · stars: *** |z|≥2.58 (p≈0.01)  ** |z|≥1.96 (p≈0.05)  * |z|≥1.64 (p≈0.10)",
        caption=f"Suppl. Fig 7. n = {len(arche)} clusters × {len(indicators)} indicators · RdBu diverging.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 15 — Per-point silhouette
# ============================================================================

def chart_silhouette_per_point(zar: ZoneAnalysisResult) -> Optional[str]:
    cl = zar.clustering
    if not cl or not cl.silhouette_per_point or not cl.labels_smoothed:
        return None
    sils = np.array([s if s is not None else 0.0 for s in cl.silhouette_per_point])
    labels = np.array(cl.labels_smoothed)
    unique = sorted(np.unique(labels).tolist())
    fig_h = max(2.4, 0.04 * len(sils) + 1.4)
    fig, ax = plt.subplots(figsize=(7.0, min(fig_h, 6.5)))
    fig.subplots_adjust(left=0.10, right=0.96, top=0.84, bottom=0.16)
    y_lower = 0
    for lab in unique:
        idx = np.where(labels == lab)[0]
        layer_sil = np.sort(sils[idx])
        y_upper = y_lower + len(layer_sil)
        ys = np.arange(y_lower, y_upper)
        colour = _category_color(int(lab) if lab >= 0 else len(unique))
        ax.fill_betweenx(ys, 0, layer_sil, facecolor=colour, edgecolor="none",
                          alpha=0.88)
        ax.text(-0.04, y_lower + len(layer_sil) / 2,
                f"C{lab}" if lab >= 0 else "noise",
                ha="right", va="center", fontsize=6, color=INK)
        y_lower = y_upper + 4
    avg = float(np.mean(sils))
    ax.axvline(avg, color=INK, linestyle="--", linewidth=0.6)
    ax.text(avg, y_lower, f"mean = {avg:.2f}",
            ha="left", va="bottom", fontsize=6, color=INK)
    ax.set_yticks([])
    ax.set_xlabel("Silhouette coefficient", fontsize=6.6)
    ax.set_xlim(min(-0.4, sils.min() - 0.05),
                max(1.0, sils.max() + 0.05))
    ax.spines["bottom"].set_color(LINE); ax.spines["left"].set_color(LINE)
    _decorate(
        fig, ax,
        title="Per-point silhouette",
        subtitle="Within-cluster cohesion vs. between-cluster separation · sorted within each cluster",
        caption=f"Suppl. Fig 8. n = {len(sils)} points · {len(unique)} clusters · dashed line = grand mean.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 16 — Silhouette curve
# ============================================================================

def chart_silhouette_curve(zar: ZoneAnalysisResult) -> Optional[str]:
    """E4 — Silhouette curve.

    v4.1 fix: the previously-shipped chart highlighted ``argmax(silhouette)``
    as the "selected" K, which on this dataset is K=4 (silhouette ≈ 0.279).
    But the pipeline's *actual* winner is K=6 — picked by the multi-criterion
    vote (silhouette + Davies-Bouldin + Calinski-Harabasz). The chart now
    reads ``cl.k`` (the truly selected K stored on the clustering result)
    instead, so the figure matches what the rest of the UI shows.
    A separate marker also flags the silhouette argmax so users can see the
    disagreement between the two criteria.
    """
    cl = zar.clustering
    if not cl or not cl.silhouette_scores: return None
    rows = [r for r in cl.silhouette_scores if r.get("silhouette") is not None]
    if not rows: return None
    ks = [r["k"] for r in rows]
    ss = [r["silhouette"] for r in rows]

    fig, ax = plt.subplots(figsize=(6.4, 3.0))
    fig.subplots_adjust(left=0.10, right=0.96, top=0.80, bottom=0.18)
    ax.plot(ks, ss, marker="o", markersize=4.4, linewidth=1.0, color=NAVY,
            markeredgecolor="white", markeredgewidth=0.5)

    # The *actually selected* K from the clustering pipeline (multi-criterion).
    selected_k = int(cl.k) if cl.k else None
    sel_idx = ks.index(selected_k) if (selected_k is not None and selected_k in ks) else None

    # The K that maximises silhouette alone (often differs from the multi-criterion winner).
    peak_idx = int(np.argmax(ss))
    peak_k   = ks[peak_idx]

    if sel_idx is not None:
        ax.scatter([ks[sel_idx]], [ss[sel_idx]], s=140, facecolor="none",
                   edgecolor=ACCENT, linewidth=1.6,
                   label=f"selected K = {selected_k} (multi-criterion vote · silhouette = {ss[sel_idx]:.3f})")
        ax.axvline(selected_k, color=ACCENT, linestyle="--",
                   linewidth=0.6, alpha=0.55)

    if peak_idx != sel_idx:
        ax.scatter([peak_k], [ss[peak_idx]], s=80, facecolor="none",
                   edgecolor=MUTE, linewidth=1.0, linestyle=":",
                   label=f"silhouette peak K = {peak_k} (silhouette = {ss[peak_idx]:.3f})")

    # Annotate every point with its silhouette value
    for k, s in zip(ks, ss):
        ax.text(k, s + max(ss) * 0.03, f"{s:.3f}",
                ha="center", va="bottom", fontsize=6.2, color=INK)

    ax.set_xlabel("K (cluster count)", fontsize=7.0)
    ax.set_ylabel("Silhouette score", fontsize=7.0)
    ax.set_xticks(ks)
    ax.set_ylim(0, max(ss) * 1.30)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.20),
              fontsize=6.4, frameon=False, ncol=2, columnspacing=1.6,
              handletextpad=0.6)
    fig.subplots_adjust(bottom=0.32)
    ax.spines["bottom"].set_color(LINE); ax.spines["left"].set_color(LINE)
    ax.grid(axis="y", color=HAIR, linewidth=0.3, alpha=0.6)

    caption = (f"Fig 19. K = {min(ks)} … {max(ks)} · selected K = {selected_k} "
               f"(multi-criterion: silhouette + Davies-Bouldin + Calinski-Harabasz)")
    _decorate(
        fig, ax,
        title="Silhouette score curve (KMeans last-resort fallback)",
        subtitle="Mean silhouette as a function of K — the selected K is the multi-criterion vote winner, not the silhouette peak",
        caption=caption,
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 17 — Dendrogram (Ward hierarchical)
# ============================================================================

def chart_dendrogram(zar: ZoneAnalysisResult) -> Optional[str]:
    """E5 — Ward dendrogram. v4.2: adds (a) horizontal cut line at the
    0.7×max threshold with its numeric value, (b) per-branch leaf counts
    annotated under each coloured sub-tree, (c) total cluster count formed
    at the cut. v4.1: truncate_mode='lastp' p=160 for large n_leaves."""
    cl = zar.clustering
    if not cl or not cl.dendrogram_linkage: return None
    try:
        from scipy.cluster import hierarchy as scihc
    except ImportError:
        return None
    Z = np.array(cl.dendrogram_linkage)
    n_leaves = Z.shape[0] + 1
    max_d = float(np.max(Z[:, 2]))
    cut_d = 0.7 * max_d
    fig, ax = plt.subplots(figsize=(9.0, 3.4))
    fig.subplots_adjust(left=0.07, right=0.98, top=0.82, bottom=0.10)
    if n_leaves > 220:
        ddata = scihc.dendrogram(
            Z, ax=ax,
            color_threshold=cut_d,
            above_threshold_color=MUTE,
            truncate_mode="lastp",
            p=160,
            show_leaf_counts=False,
            no_labels=True,
        )
        caption = (f"Suppl. Fig 9. n = {n_leaves} leaves (top 160 nodes shown) · "
                   f"Ward's method · Euclidean · cut at d = {cut_d:.1f} "
                   f"(0.7 × max = {max_d:.1f}).")
    else:
        ddata = scihc.dendrogram(
            Z, ax=ax,
            color_threshold=cut_d,
            above_threshold_color=MUTE,
            no_labels=True,
        )
        caption = (f"Suppl. Fig 9. n = {n_leaves} leaves · Ward's method · "
                   f"Euclidean · cut at d = {cut_d:.1f} "
                   f"(0.7 × max = {max_d:.1f}).")
    ax.set_ylabel("Linkage distance (Ward)", fontsize=6.6)
    ax.tick_params(axis="x", which="both", bottom=False, labelbottom=False)
    ax.spines["bottom"].set_color(LINE); ax.spines["left"].set_color(LINE)

    # ── (a) horizontal cut line + its numeric label ────────────────────────
    ax.axhline(y=cut_d, color=INK, linestyle="--", linewidth=0.5,
               alpha=0.7, zorder=1)
    xlim = ax.get_xlim()
    ax.text(xlim[1] * 0.992, cut_d, f"  cut = {cut_d:.1f}",
            ha="right", va="bottom", fontsize=5.6, style="italic",
            color=INK, zorder=4,
            bbox=dict(boxstyle="round,pad=0.18", facecolor="white",
                      edgecolor="none", alpha=0.85))

    # ── (b) per-branch leaf counts under each coloured sub-tree ────────────
    # Map leaf x-position → final cluster id using fcluster at the cut.
    try:
        labels = scihc.fcluster(Z, t=cut_d, criterion="distance")
        # ddata['leaves'] = leaf indices in left-to-right plotted order.
        # When truncate_mode='lastp' is used, leaves are aggregated nodes,
        # not original observations, so we instead derive runs from the
        # color sequence of the link colours.
        link_colors = ddata.get("color_list", []) or []
        leaves = ddata.get("leaves", []) or []
        # icoord/dcoord give the (x, y) coords of every U-shape drawn.
        icoord = ddata.get("icoord", []) or []
        # Build cluster runs: contiguous leaf x-positions sharing a colour.
        # Each leaf is plotted at x = 5, 15, 25, ... so we use those slots.
        if leaves:
            # Determine each leaf's colour by walking icoord/color_list:
            # Easier: re-run fcluster on the *visible* leaves only when not
            # truncated; when truncated, fall back to colour runs.
            if n_leaves <= 220:
                # 1:1 mapping leaf → original observation id → fcluster label
                lbl_per_leaf = [int(labels[i]) for i in leaves]
            else:
                # Truncated mode: use the colour sequence of dcoord links.
                # Each visible leaf at index k inherits the colour of the
                # first link touching its x position (link_colors[k] for
                # k < len(link_colors)).
                lbl_per_leaf = []
                for k in range(len(leaves)):
                    c = link_colors[k] if k < len(link_colors) else MUTE
                    lbl_per_leaf.append(c)

            # Compute contiguous runs and their leaf counts.
            x_positions = [5 + i * 10 for i in range(len(leaves))]
            runs: list[tuple[float, float, int, object]] = []
            i = 0
            while i < len(leaves):
                j = i
                while j + 1 < len(leaves) and lbl_per_leaf[j + 1] == lbl_per_leaf[i]:
                    j += 1
                # When n_leaves > 220, each visible leaf actually represents
                # multiple original observations. Estimate the underlying
                # leaf count: total n_leaves split proportionally to the
                # visible-leaf span of each colour run.
                visible_count = j - i + 1
                if n_leaves > 220:
                    underlying = int(round(visible_count / len(leaves) * n_leaves))
                else:
                    underlying = visible_count
                runs.append((x_positions[i], x_positions[j], underlying, lbl_per_leaf[i]))
                i = j + 1

            # Annotate each run below the x-axis baseline.
            ymin, ymax = ax.get_ylim()
            y_anno = ymin - (ymax - ymin) * 0.04
            ax.set_ylim(ymin - (ymax - ymin) * 0.08, ymax)
            for (x0, x1, count, _c) in runs:
                if count < max(2, int(0.02 * n_leaves)):
                    continue  # skip noise singletons
                xm = (x0 + x1) / 2.0
                ax.text(xm, y_anno, f"n = {count}",
                        ha="center", va="top", fontsize=5.4,
                        color=MUTE, style="italic", zorder=4)

            # ── (c) total cluster count formed at the cut ──────────────────
            n_clusters = int(labels.max()) if labels.size else len(runs)
            ax.text(xlim[0] + (xlim[1] - xlim[0]) * 0.008,
                    cut_d + (ymax - ymin) * 0.012,
                    f"k = {n_clusters} clusters at cut",
                    ha="left", va="bottom", fontsize=5.8,
                    color=INK, style="italic",
                    bbox=dict(boxstyle="round,pad=0.20", facecolor="white",
                              edgecolor="none", alpha=0.85),
                    zorder=4)
    except Exception:
        pass  # annotations are best-effort; never break the chart

    _decorate(
        fig, ax,
        title="Ward hierarchical clustering dendrogram",
        subtitle="Bottom-up agglomeration of image profiles · colour breaks at 0.7 × max linkage distance",
        caption=caption,
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 18 — Cluster spatial smoothing
# ============================================================================

def chart_cluster_spatial_smoothing(zar: ZoneAnalysisResult) -> Optional[str]:
    cl = zar.clustering
    if not cl or not cl.labels_raw or not cl.labels_smoothed: return None
    if not cl.point_lats or not cl.point_lngs: return None
    fig, axes = plt.subplots(1, 2, figsize=(7.6, 3.0))
    fig.subplots_adjust(left=0.08, right=0.97, top=0.82, bottom=0.18, wspace=0.20)
    for _pi, (ax, labels, title) in enumerate(zip(
        axes, [cl.labels_raw, cl.labels_smoothed],
        ["Before smoothing", f"After KNN-{cl.spatial_smooth_k} smoothing"],
    )):
        unique = sorted(set(labels))
        counts = {lab: sum(1 for l in labels if l == lab) for lab in unique}
        for i, lab in enumerate(unique):
            mask = np.array([l == lab for l in labels])
            ax.scatter(np.array(cl.point_lngs)[mask],
                       np.array(cl.point_lats)[mask],
                       c=_category_color(i if lab >= 0 else len(unique)),
                       s=6, edgecolor="white", linewidth=0.15,
                       label=(f"C{lab} (n={counts[lab]})" if lab >= 0
                              else f"noise (n={counts[lab]})"))
        # Panel-level summary text inside the axis (n_changed computed once
        # at the figure level below — don't duplicate it inside the loop).
        ax.set_title(title, fontsize=7.4, color=INK, pad=4, fontweight="bold")
        _panel_label(ax, "ab"[_pi])
        ax.text(0.02, 0.97,
                f"n = {len(labels)} points",
                transform=ax.transAxes, ha="left", va="top",
                fontsize=5.6, color=INK,
                bbox=dict(boxstyle="round,pad=0.25", fc="white",
                          ec=HAIR, lw=0.3, alpha=0.85))
        ax.set_xlabel("Longitude", fontsize=6.2)
        ax.set_ylabel("Latitude", fontsize=6.2)
        ax.tick_params(labelsize=5.4)
        ax.set_aspect("equal", adjustable="datalim")
        ax.spines["bottom"].set_color(LINE); ax.spines["left"].set_color(LINE)
    # Reassignment summary at figure level
    n_changed = sum(1 for a, b in zip(cl.labels_raw, cl.labels_smoothed) if a != b)
    pct = 100.0 * n_changed / max(1, len(cl.labels_raw))
    fig.text(0.5, 0.91,
             f"KNN-{cl.spatial_smooth_k} smoothing reassigned "
             f"{n_changed} / {len(cl.labels_raw)} points ({pct:.1f}%)",
             ha="center", fontsize=5.8, color=MUTE, style="italic")
    handles, labels = axes[1].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center",
               bbox_to_anchor=(0.5, -0.04), ncol=min(8, len(labels)),
               fontsize=6.4, frameon=False, columnspacing=1.2)
    _decorate(
        fig, axes,
        title="Cluster spatial smoothing",
        subtitle="Raw (per-image) vs. KNN-smoothed cluster labels in geographic space",
        caption=f"Fig 20. k_nn = {cl.spatial_smooth_k} · {len(cl.labels_raw)} GPS-located points.",
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 19 — Archetype radar (z-scores per cluster)
# ============================================================================

def chart_archetype_radar(zar: ZoneAnalysisResult) -> Optional[str]:
    """E — Cluster radar profiles (raw centroid values).

    v4.5: radial-axis labels were previously sparse and pinned to one
    spoke. Now every tick ring carries its numeric label at an angle
    that doesn't collide with the strongest cluster polygon.

    Matches the platform's `ArchetypeRadarChart` semantically: radial
    axis is `centroid_values` (raw indicator values, not z-scores).
    """
    cl = zar.clustering
    if not cl or not cl.archetype_profiles:
        return None
    arche = cl.archetype_profiles
    indicators = sorted({k for a in arche for k in (a.centroid_values or {}).keys()})
    if len(indicators) < 3:
        return None
    angles = np.linspace(0, 2 * math.pi, len(indicators), endpoint=False).tolist()
    angles_closed = angles + [angles[0]]

    all_vals: list[float] = []
    for a in arche:
        for ind in indicators:
            v = (a.centroid_values or {}).get(ind)
            if isinstance(v, (int, float)) and np.isfinite(v):
                all_vals.append(float(v))
    if not all_vals:
        return None
    v_max = max(all_vals)
    v_min = min(all_vals)
    pad = (v_max - v_min) * 0.05 if v_max > v_min else 1.0
    r_min = min(0.0, v_min - pad)
    r_max = v_max + pad

    # Build 4-5 evenly-spaced ticks
    n_ticks = 5
    ticks = list(np.linspace(r_min, r_max, n_ticks))

    fig = plt.figure(figsize=(7.4, 5.4))
    fig.subplots_adjust(left=0.10, right=0.90, top=0.84, bottom=0.22)
    ax = fig.add_subplot(1, 1, 1, projection="polar")

    for i, a in enumerate(arche):
        vals = [float((a.centroid_values or {}).get(ind, 0.0)) for ind in indicators]
        vals_closed = vals + [vals[0]]
        colour = _category_color(i)
        peak_idx = int(np.argmax([abs(v) for v in vals]))
        peak_ind = _ind_name(zar, indicators[peak_idx])[:14]
        peak_val = vals[peak_idx]
        ax.plot(angles_closed, vals_closed, color=colour, linewidth=1.1,
                marker="o", markersize=2.8,
                markeredgecolor="white", markeredgewidth=0.4,
                label=f"C{a.archetype_id}  (peak: {peak_ind}={peak_val:.2g})")
        ax.fill(angles_closed, vals_closed, color=colour, alpha=0.10)

    # ── Spoke labels — angle-aware ──────────────────────────────────────
    spoke_names = _ind_names(zar, indicators)
    ax.set_xticks(angles)
    ax.set_xticklabels([])
    for ang, name in zip(angles, spoke_names):
        deg = math.degrees(ang) % 360
        if 95 < deg < 265:
            ha = "right"
        elif deg < 85 or deg > 275:
            ha = "left"
        else:
            ha = "center"
        ax.text(ang, r_max + (r_max - r_min) * 0.12,
                name, ha=ha, va="center",
                fontsize=6.0, color=MUTE, family="Times New Roman")

    # ── Radial axis: every tick labelled on-ring ────────────────────────
    ax.set_ylim(r_min, r_max)
    ax.set_yticks(ticks)
    ax.set_yticklabels([f"{t:.2g}" for t in ticks],
                       fontsize=5.4, color=MUTE)
    ax.set_rlabel_position(72)

    # Reinforce ring visibility — explicit thin circles at each tick
    for t in ticks:
        ax.plot(np.linspace(0, 2*math.pi, 120),
                [t] * 120, color=HAIR, linewidth=0.3, alpha=0.7, zorder=0)

    ax.spines["polar"].set_color(HAIR); ax.spines["polar"].set_linewidth(0.4)
    ax.grid(color=HAIR, linewidth=0.3, alpha=0.7)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, -0.28),
              fontsize=6.2, frameon=False, ncol=min(2, len(arche)),
              columnspacing=1.6, handletextpad=0.6)
    _decorate(
        fig, ax,
        title="Cluster radar profiles",
        subtitle=("Raw centroid indicator values per archetype "
                  "(matches platform Cluster Radar); rings labelled at every tick"),
        caption=(f"Fig 21. n = {len(arche)} archetypes x {len(indicators)} "
                 f"indicators · raw values · radial range "
                 f"{r_min:.2g} to {r_max:.2g}."),
    )
    return _fig_to_svg(fig)


# ============================================================================
# Chart 20 — Cluster size distribution
# ============================================================================

def chart_cluster_size_distribution(zar: ZoneAnalysisResult) -> Optional[str]:
    """E8 — VERTICAL bar chart (was horizontal pre-v4.1).

    Matches the frontend Recharts ``ClusterSizeChart`` rendering — the
    bundle SVG now mirrors what users see on the platform. X-axis ticks
    are wrapped to multiple lines so the long archetype labels stay
    readable.
    """
    cl = zar.clustering
    if not cl or not cl.archetype_profiles: return None
    # Keep archetype-id order (matches the spatial / centroid charts);
    # if you prefer the bars sorted by count just sort `arche` here.
    arche = sorted(cl.archetype_profiles, key=lambda a: a.archetype_id)
    labels = [a.archetype_label for a in arche]
    counts = [a.point_count for a in arche]
    cluster_ids = [a.archetype_id for a in arche]
    total = sum(counts)
    fig, ax = plt.subplots(figsize=(max(7.4, 1.3 * len(arche) + 4.0), 4.4))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.84, bottom=0.34)
    xs = np.arange(len(arche))
    colours = [_category_color(i) for i in cluster_ids]
    ax.bar(xs, counts, color=colours, edgecolor="white",
            linewidth=0.6, width=0.7)
    for x, sz in zip(xs, counts):
        ax.text(x, sz + max(counts) * 0.012,
                f"{sz}\n{100*sz/total:.1f}%",
                ha="center", va="bottom", fontsize=6.4, color=INK)
    # Two-line x-axis tick labels: cluster id + wrapped archetype label
    wrapped = []
    for cid, lbl in zip(cluster_ids, labels):
        parts = (lbl or "").split(" / ")
        wrapped.append(f"C{cid}\n" + "\n".join(parts))
    ax.set_xticks(xs)
    ax.set_xticklabels(wrapped, fontsize=6.0)
    ax.set_ylabel("Image count (points)", fontsize=7.0)
    ax.set_xlabel("Cluster archetype", fontsize=7.0)
    ax.set_ylim(0, max(counts) * 1.18)
    ax.spines["bottom"].set_color(LINE); ax.spines["left"].set_color(LINE)
    ax.grid(axis="y", color=HAIR, linewidth=0.3, alpha=0.6)
    # Legend (cluster-id colour key) — unified bottom-center style
    handles = [plt.Rectangle((0, 0), 1, 1, color=colours[i]) for i in range(len(arche))]
    ax.legend(handles, [f"C{cid}" for cid in cluster_ids],
              loc="upper center", bbox_to_anchor=(0.5, -0.18),
              fontsize=6.4, frameon=False, ncol=len(arche),
              columnspacing=1.6, handletextpad=0.6)
    _decorate(
        fig, ax,
        title="Cluster size distribution",
        subtitle="Image count per archetype · vertical bars · annotations show count + share",
        caption=f"Suppl. Fig 10. Total = {total} images across {len(arche)} clusters.",
    )
    return _fig_to_svg(fig)



# ============================================================================
# Chart 22 — cluster stability (v6.2 bootstrap validation)
# ============================================================================

def chart_cluster_stability(zar: ZoneAnalysisResult) -> Optional[str]:
    """Cluster validity — Hennig bootstrap per-cluster Jaccard stability.

    Honest robustness reporting. Each bar is a cluster's mean Jaccard
    similarity to its best match across 100 bootstrap resamples. Dashed
    reference lines follow Hennig (2007): >=0.85 highly stable,
    0.75-0.85 stable, 0.60-0.75 indicates a pattern, <0.60 unstable.
    The Hopkins clustering-tendency statistic and the gap-statistic K are
    reported in the caption so the reader can judge whether crisp
    clusters exist at all, rather than reading the K-partition as a claim
    of natural kinds.
    """
    cl = zar.clustering
    if not cl or not cl.cluster_stability:
        return None
    arch = {a.archetype_id: a for a in (cl.archetype_profiles or [])}
    items = sorted(cl.cluster_stability.items(), key=lambda kv: int(kv[0]))
    if not items:
        return None
    cids = [int(k) for k, _ in items]
    vals = [float(v) for _, v in items]
    labels = []
    for c in cids:
        lbl = (arch[c].archetype_label if c in arch else "") or ""
        labels.append(f"C{c}\n" + "\n".join(lbl.split(" / ")))

    def _tier_color(v: float) -> str:
        if v >= 0.85:
            return SAGE
        if v >= 0.75:
            return NAVY
        if v >= 0.60:
            return MUSTARD
        return BURGUNDY

    fig, ax = plt.subplots(figsize=(max(7.4, 1.2 * len(cids) + 3.6), 4.4))
    fig.subplots_adjust(left=0.09, right=0.97, top=0.82, bottom=0.32)
    xs = np.arange(len(cids))
    ax.bar(xs, vals, color=[_tier_color(v) for v in vals],
           edgecolor="white", linewidth=0.6, width=0.68)
    for x, v in zip(xs, vals):
        ax.text(x, v + 0.02, f"{v:.2f}", ha="center", va="bottom",
                fontsize=6.6, color=INK)
    for y, lab in ((0.85, "0.85 highly stable"), (0.75, "0.75 stable"),
                   (0.60, "0.60 pattern")):
        ax.axhline(y, color=MUTE, linewidth=0.4, linestyle="--", alpha=0.7)
        ax.text(len(cids) - 0.45, y + 0.01, lab, ha="right", va="bottom",
                fontsize=5.4, color=MUTE, style="italic")
    ax.set_xticks(xs)
    ax.set_xticklabels(labels, fontsize=6.0)
    ax.set_ylabel("Bootstrap Jaccard stability", fontsize=7.0)
    ax.set_xlabel("Cluster archetype", fontsize=7.0)
    ax.set_ylim(0, 1.06)
    ax.spines["bottom"].set_color(LINE)
    ax.spines["left"].set_color(LINE)
    ax.grid(axis="y", color=HAIR, linewidth=0.3, alpha=0.6)

    hop = cl.hopkins_statistic
    gap_k = next((g["k"] for g in (cl.gap_statistic or [])
                  if g.get("is_selected")), None)
    cap = "Suppl. Fig. Cluster stability — Hennig bootstrap, 100 resamples."
    if hop is not None:
        cap += f" Hopkins tendency = {hop:.2f} (0.5 = no structure)."
    if gap_k is not None:
        cap += f" Gap-statistic K = {gap_k}; adopted partition K = {cl.k}."
    _decorate(
        fig, ax,
        title="Cluster stability — bootstrap validation",
        subtitle="Per-cluster mean Jaccard over 100 bootstrap resamples · dashed lines = Hennig stability bands",
        caption=cap,
    )
    return _fig_to_svg(fig)


# ============================================================================
# Registry + public entry point
# ============================================================================


CHART_FUNCS: dict[str, Any] = {
    "indicator-registry-table":         chart_indicator_registry_table,
    "data-quality-table":               chart_data_quality_table,
    "zone-deviation-overview":          chart_zone_deviation_overview,
    "priority-heatmap":                 chart_priority_heatmap,
    "radar-profiles":                   chart_radar_profiles,
    "spatial-z-deviation":              chart_spatial_z_deviation,
    "distribution-violin":              chart_distribution_violin,
    "indicator-deep-dive":              chart_indicator_deep_dive,
    "within-zone-image-distribution":   chart_within_zone_image_distribution,
    "value-spatial-grid":               chart_value_spatial_grid,
    "global-stats-table":               chart_global_stats_table,
    "zone-indicator-matrix":            chart_zone_indicator_matrix,
    "correlation-heatmap":              chart_correlation_heatmap,
    "cluster-centroid-heatmap":         chart_cluster_centroid_heatmap,
    "silhouette-per-point":             chart_silhouette_per_point,
    "silhouette-curve":                 chart_silhouette_curve,
    "dendrogram":                       chart_dendrogram,
    "cluster-spatial-smoothing":        chart_cluster_spatial_smoothing,
    "archetype-radar":                  chart_archetype_radar,
    "cluster-size-distribution":        chart_cluster_size_distribution,
    "cluster-stability":                chart_cluster_stability,
}

CHART_TITLES = {
    "indicator-registry-table":         "Indicator registry",
    "data-quality-table":               "Data quality",
    "zone-deviation-overview":          "Zone ranking - overall deviation",
    "priority-heatmap":                 "Zone x Indicator priority heatmap",
    "radar-profiles":                   "Zone profile radar - by layer",
    "spatial-z-deviation":              "Spatial deviation map - geographic",
    "distribution-violin":              "Indicator distribution - image-level",
    "indicator-deep-dive":              "Per-indicator drill-down",
    "within-zone-image-distribution":   "Within-zone image distribution",
    "value-spatial-grid":               "Indicator value map - geographic",
    "global-stats-table":               "Global descriptive statistics",
    "zone-indicator-matrix":            "Zone x Indicator mean matrix",
    "correlation-heatmap":              "Indicator correlation - pairwise",
    "cluster-centroid-heatmap":         "Cluster centroid heatmap",
    "silhouette-per-point":             "Per-point silhouette",
    "silhouette-curve":                 "Silhouette score curve",
    "dendrogram":                       "Ward hierarchical dendrogram",
    "cluster-spatial-smoothing":        "Cluster spatial smoothing",
    "archetype-radar":                  "Cluster radar profiles",
    "cluster-size-distribution":        "Cluster size distribution",
    "cluster-stability":                "Cluster stability (bootstrap validation)",
}


# v4.11 — chart-mode gating. Each chart_id declares which UI modes it
# makes sense in, mirroring the frontend `viableInModes` array. The
# bundle endpoint filters CHART_FUNCS by the request's effective mode
# so a single-zone project's zone-view bundle doesn't ship empty
# zone-comparison charts and cluster-only charts only appear in
# cluster-view bundles.
CHART_MODES: dict[str, set[str]] = {
    "indicator-registry-table":       {"single_zone", "multi_zone", "cluster"},
    "data-quality-table":             {"single_zone", "multi_zone", "cluster"},
    "zone-deviation-overview":        {"multi_zone", "cluster"},
    "priority-heatmap":               {"multi_zone", "cluster"},
    "radar-profiles":                 {"multi_zone", "cluster"},
    "spatial-z-deviation":            {"multi_zone", "cluster"},
    "distribution-violin":            {"single_zone", "multi_zone", "cluster"},
    "indicator-deep-dive":            {"single_zone", "multi_zone", "cluster"},
    "within-zone-image-distribution": {"single_zone", "multi_zone", "cluster"},
    "value-spatial-grid":             {"single_zone", "multi_zone", "cluster"},
    "global-stats-table":             {"single_zone", "multi_zone", "cluster"},
    "zone-indicator-matrix":          {"multi_zone", "cluster"},
    "correlation-heatmap":            {"multi_zone", "cluster"},
    "cluster-centroid-heatmap":       {"cluster"},
    "silhouette-per-point":           {"cluster"},
    "silhouette-curve":               {"cluster"},
    "dendrogram":                     {"cluster"},
    "cluster-spatial-smoothing":      {"cluster"},
    "archetype-radar":                {"cluster"},
    "cluster-size-distribution":      {"cluster"},
    "cluster-stability":              {"cluster"},
}


def render_all(
    zar: ZoneAnalysisResult,
    effective_mode: str | None = None,
) -> dict[str, str]:
    """Render every chart we know how to draw. Returns a dict
    chart_id -> SVG string.

    Parameters
    ----------
    zar : ZoneAnalysisResult
        The analysis result to render against.
    effective_mode : "single_zone" | "multi_zone" | "cluster" | None
        Filter charts by this UI mode (matches the frontend
        `viableInModes`). When None, every chart is attempted (legacy
        behaviour). When set, charts whose CHART_MODES doesn't include
        the mode are skipped — this is how the bundle endpoint drops
        cluster-only charts from zone-view bundles and zone-comparison
        charts from single-zone bundles.

    Charts that return None (no applicable data) are silently dropped
    so the caller can still ship a partial bundle.
    """
    _apply_rc()
    out: dict[str, str] = {}
    for chart_id, fn in CHART_FUNCS.items():
        # Mode filter
        if effective_mode is not None:
            viable = CHART_MODES.get(chart_id, {"single_zone", "multi_zone", "cluster"})
            if effective_mode not in viable:
                continue
        try:
            svg = fn(zar)
        except Exception as e:
            logger.warning("nature_charts.render_all: %s raised %s", chart_id, e)
            svg = None
            # A chart that raised after plt.figure()/subplots() but before
            # _fig_to_svg() leaves its figure in pyplot's global registry; in
            # the long-lived server these accumulate. Drop any orphaned figures.
            plt.close("all")
        if svg:
            out[chart_id] = svg
    logger.info(
        "nature_charts.render_all produced %d / %d charts (mode=%s)",
        len(out), len(CHART_FUNCS), effective_mode or "all",
    )
    return out
