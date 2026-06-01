"""
Nature-style chart bundle export.

GET /api/projects/{project_id}/nature-bundle.zip

Reads the saved zone_analysis_result for the project, regenerates every
chart server-side via the nature_charts service (matplotlib + Liberation
Sans + the same palette the frontend uses), and streams the result back
as a ZIP. Identical structure to the client-side bundle so existing
paper templates and scripts can switch sources transparently.
"""

from __future__ import annotations

import io
import json
import logging
import re
import zipfile
from collections import defaultdict
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.db.project_store import get_project_store
from app.models.analysis import ZoneAnalysisResult, ImageRecord
from app.services import nature_charts

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["nature-export"])

_SLUG_RE = re.compile(r"[\\/:*?\"<>|\s]+")


def _slugify(s: Optional[str], fallback: str) -> str:
    if not s:
        return fallback
    cleaned = _SLUG_RE.sub("-", s).strip("-")
    return (cleaned[:60] or fallback)


def _timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M")


def _rebuild_image_records(project) -> list[ImageRecord]:
    """Backend mirror of the frontend ChartContext.rebuildImageRecords.

    image_records are no longer persisted in the project blob (they're O(images)
    derived data — see ProjectStore._strip_image_records), so rebuild them from
    uploaded_images[].metrics_results when an export needs them. For panorama
    projects metrics_results already reflects the active view (update_project
    swaps it on view switch), so the rebuilt records match what's displayed.
    """
    zones = {z.zone_id: z for z in (project.spatial_zones or [])}
    records: list[ImageRecord] = []
    for img in (project.uploaded_images or []):
        if not img.zone_id or not img.metrics_results:
            continue
        zone = zones.get(img.zone_id)
        if not zone:
            continue
        for key, value in img.metrics_results.items():
            if value is None:
                continue
            sep = key.find("__")
            indicator_id = key[:sep] if sep >= 0 else key
            layer = key[sep + 2:] if sep >= 0 else "full"
            records.append(ImageRecord(
                image_id=img.image_id,
                zone_id=img.zone_id,
                zone_name=zone.zone_name,
                indicator_id=indicator_id,
                layer=layer,
                value=value,
                lat=img.latitude,
                lng=img.longitude,
            ))
    return records


@router.get("/{project_id}/nature-bundle.zip")
def nature_bundle(project_id: str, view: str = "zones", view_id: str = ""):
    """Return a ZIP of nature-style chart SVGs.

    Query params:
      view = "zones"     -> use the original zone-level analysis (default)
      view = "clusters"  -> use the cluster-rebuilt analysis persisted
                            at `zone_analysis_result["cluster_view"]`.
                            Falls back to the top-level (and triggers the
                            safety-net rebuild) when cluster_view is absent.
      view_id (v4.x)     -> full multi-view id for within-zone clustering
                            drills: 'parent_zones', 'all_sub_clusters',
                            'within_zone:<zone_id>'. When present and the
                            corresponding sub-payload exists at
                            zone_analysis_result.analysis_views[view_id],
                            it's used as the rendering source so the
                            bundle's server-rendered nature SVGs and CSVs
                            reflect the exact drill the user is looking at
                            in the Reports page — not the composite. Takes
                            precedence over the legacy 'view' param when
                            both are set. Falls back gracefully to the
                            legacy path when the sub-payload is missing.
    """
    logger.info("nature-bundle: incoming request project_id=%s view=%s view_id=%s",
                project_id, view, view_id)
    view = (view or "zones").lower()
    view_id = (view_id or "").strip()
    store = get_project_store()
    project = store.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.zone_analysis_result:
        raise HTTPException(
            status_code=409,
            detail=(
                "No zone analysis result is stored for this project yet — "
                "run Stage 4 (Analysis Pipeline) before exporting the bundle."
            ),
        )
    zar_dict = project.zone_analysis_result
    # v4.x — Per-drill source resolution.
    # Priority:
    #   1. view_id matches an analysis_views entry → use that sub-payload
    #      (within-zone drill bundles get their own per-drill data instead
    #      of inheriting the composite).
    #   2. view=='clusters' AND cluster_view sub-payload exists → legacy
    #      single-zone Option C path.
    #   3. fallback to top-level zone_analysis_result.
    multi_views = zar_dict.get("analysis_views") if isinstance(zar_dict, dict) else None
    used_source = "top-level"
    if view_id and isinstance(multi_views, dict) and view_id in multi_views:
        sub = multi_views[view_id]
        if isinstance(sub, dict) and sub:
            # Merge top-level `clustering` + `segment_diagnostics` into the
            # sub-payload if the sub-payload doesn't carry its own — this
            # helps safety-net 1 below and keeps cluster-diagnostic charts
            # rendering when the per-drill ZAR was built without those
            # fields.
            for key in ("clustering", "segment_diagnostics"):
                if key in zar_dict and key not in sub:
                    sub[key] = zar_dict[key]
            zar_dict = sub
            used_source = f"analysis_views[{view_id}]"
            logger.info(
                "nature-bundle: rendering from %s (per-drill payload)",
                used_source,
            )
        else:
            logger.info(
                "nature-bundle: view_id=%s present in request but the entry "
                "in analysis_views is empty — falling back to top-level",
                view_id,
            )
    elif view == "clusters":
        # v4.7 — when caller asks for cluster view AND a saved cluster_view
        # sub-payload exists, load it as the zar so the bundle reflects the
        # 6-cluster pseudo-zones instead of the original 1-zone setup.
        sub = zar_dict.get("cluster_view") if isinstance(zar_dict, dict) else None
        if isinstance(sub, dict) and sub:
            # Merge the top-level `clustering` + `segment_diagnostics` into
            # the cluster sub-payload so safety-net 1 doesn't re-run on it.
            for key in ("clustering", "segment_diagnostics"):
                if key in zar_dict and key not in sub:
                    sub[key] = zar_dict[key]
            zar_dict = sub
            used_source = "cluster_view"
            logger.info("nature-bundle: loading cluster_view sub-payload")
        else:
            logger.info(
                "nature-bundle: view=clusters but no cluster_view payload — "
                "falling back to top-level analysis (safety-net will rebuild)"
            )
    try:
        zar = ZoneAnalysisResult.model_validate(zar_dict)
    except Exception as e:
        logger.exception("nature-bundle: failed to validate zone_analysis_result")
        raise HTTPException(status_code=500, detail=f"Invalid analysis state: {e}")

    # image_records are no longer persisted (derived data); rebuild them from
    # the project's per-image metrics so the safety-nets below (on-the-fly
    # clustering, cluster-as-zone rebuild) and the E-section charts still work.
    if not zar.image_records:
        zar.image_records = _rebuild_image_records(project)

    logger.info(
        "nature-bundle: project=%s zar OK (zones=%d, image_records=%d, has_clustering=%s)",
        project_id,
        len(zar.zone_diagnostics or []),
        len(zar.image_records or []),
        bool(zar.clustering and zar.clustering.archetype_profiles),
    )

    # v4.1 safety-net 1: if clustering wasn't persisted to DB, compute
    # it on the fly from zar.image_records so the 8 E-section charts can
    # render. Without this the bundle would silently skip them.
    if (not zar.clustering or not zar.clustering.archetype_profiles) and zar.image_records:
        try:
            from app.services.clustering_service import ClusteringService
            by_image: dict = defaultdict(dict)
            for r in zar.image_records:
                if r.layer != "full":
                    continue
                d = by_image[r.image_id]
                d["point_id"] = r.image_id
                if r.lat is not None:
                    d["lat"] = r.lat
                if r.lng is not None:
                    d["lng"] = r.lng
                if isinstance(r.value, (int, float)):
                    d[r.indicator_id] = r.value
            point_metrics = list(by_image.values())
            if len(point_metrics) >= 20:
                logger.info(
                    "nature-bundle: zar.clustering empty - running ClusteringService "
                    "on %d image points",
                    len(point_metrics),
                )
                out = ClusteringService().cluster(
                    point_metrics=point_metrics,
                    indicator_definitions=zar.indicator_definitions,
                    layer="full",
                )
                if out is not None:
                    clustering_result, seg_diag = out
                    zar.clustering = clustering_result
                    logger.info(
                        "nature-bundle: on-the-fly clustering OK (k=%d, n=%d)",
                        clustering_result.k,
                        len(clustering_result.point_ids_ordered),
                    )
        except Exception as e:
            logger.warning("nature-bundle: on-the-fly clustering failed: %s", e)

    # v4.1 safety-net 2: if clustering is now present (either persisted in DB
    # earlier or just computed by safety-net 1) but zone_diagnostics still
    # reflects the original single-zone (image_records.zone_id was never
    # rewritten to seg_N), rebuild the cluster-as-zone analysis here.
    # Without this, priority-heatmap / radar-profiles / zone-deviation-overview
    # / zone-indicator-matrix / correlation-heatmap / within-zone-image-distribution
    # all render with zero rows because their data lookup keys on cluster
    # IDs that aren't present in zone_diagnostics.
    # v4.8 — gate safety-net 2 on the user's view choice.
    # In zone view (default), NEVER rebuild as cluster-as-zone. The user
    # asked for the original zone analysis and that's what they get,
    # even if zone_count != cluster_k. In cluster view, fire the rebuild
    # only when the loaded payload isn't already a cluster-shaped one.
    if (view == "clusters"
            and zar.clustering and zar.clustering.archetype_profiles
            and zar.image_records):
        cluster_k = len(zar.clustering.archetype_profiles)
        zone_count = len(zar.zone_diagnostics or [])
        # Trigger rebuild when zone_diagnostics doesn't match the cluster count
        # (e.g. project shipped with 1 zone but clustering produced 6 archetypes),
        # OR when the per-zone indicator_status is empty (which is what makes
        # priority-heatmap render as a blank grid).
        # Trigger rebuild when ANY of these red flags is present:
        #   1. zone_count != cluster_k (e.g. project shipped with 1 zone but
        #      clustering produced 6 archetypes)
        #   2. NO zone has any indicator_status entries (priority-heatmap
        #      blank-grid case)
        #   3. zone names don't look like cluster IDs / "Cluster N" (suggests
        #      the diagnostics still reflect the user's original zones rather
        #      than the clustering output)
        zone_names = {d.zone_name for d in (zar.zone_diagnostics or [])}
        looks_like_clusters = any(
            (zn or "").lower().startswith(("cluster", "seg_", "archetype"))
            for zn in zone_names
        )
        needs_rebuild = (
            zone_count != cluster_k
            or not any((d.indicator_status or {}) for d in (zar.zone_diagnostics or []))
            or not looks_like_clusters
        )
        if needs_rebuild:
            try:
                from app.api.routes.analysis import _build_cluster_zone_analysis
                from app.api.deps import get_zone_analyzer
                logger.info(
                    "nature-bundle: zone_diagnostics (k=%d) does not match clustering "
                    "(k=%d) or indicator_status is empty — rebuilding cluster-as-zone",
                    zone_count, cluster_k,
                )
                cluster_zar = _build_cluster_zone_analysis(
                    project=project,
                    clustering_result=zar.clustering,
                    indicator_definitions=zar.indicator_definitions,
                    indicator_ids=list(zar.indicator_definitions.keys()),
                    analyzer=get_zone_analyzer(),
                )
                if cluster_zar is not None:
                    # Preserve any segment_diagnostics already attached
                    if zar.segment_diagnostics:
                        cluster_zar.segment_diagnostics = zar.segment_diagnostics
                    zar = cluster_zar
                    logger.info(
                        "nature-bundle: cluster-as-zone rebuilt "
                        "(zones=%d, image_records=%d)",
                        len(zar.zone_diagnostics or []),
                        len(zar.image_records or []),
                    )
            except Exception as e:
                logger.warning(
                    "nature-bundle: cluster-as-zone rebuild failed: %s", e
                )

    # v4.8 — folder naming follows the user's view choice exactly,
    # not just whether clustering data exists (a zone-view bundle
    # should be labelled "zones" even though clustering is also persisted).
    grouping_mode = view if view in ("zones", "clusters") else "zones"
    slug = _slugify(project.project_name, "project")
    folder = f"{slug}_nature_{grouping_mode}_{_timestamp()}"

    # v4.11 — compute effective UI mode (single_zone / multi_zone / cluster)
    # so render_all skips charts that aren't viable in this mode. A 1-zone
    # zone-view bundle now ships only the 7 single-zone-viable charts;
    # a multi-zone zone-view bundle ships 13; a cluster-view bundle ships 21.
    if view == "clusters":
        effective_mode = "cluster"
    else:
        effective_mode = "multi_zone" if len(zar.zone_diagnostics or []) >= 2 else "single_zone"
    logger.info(
        "nature-bundle: invoking render_all (matplotlib) view=%s mode=%s",
        view, effective_mode,
    )
    charts = nature_charts.render_all(zar, effective_mode=effective_mode)
    logger.info("nature-bundle: render_all produced %d / %d SVGs",
                len(charts), len(nature_charts.CHART_FUNCS))

    # v4.1 — pull every cached LLM "What this means" payload from
    # chart_summary_cache.sqlite for THIS project, so the bundle's
    # summaries/ folder is populated. Previously this folder shipped empty.
    summaries_by_chart: dict[str, dict] = {}
    try:
        import sqlite3 as _sqlite
        from app.core.config import get_settings as _get_settings
        cache_db = _get_settings().data_path / "chart_summary_cache.sqlite"
        if cache_db.exists():
            con = _sqlite.connect(str(cache_db))
            con.row_factory = _sqlite.Row
            # v4.3 — filter by grouping_mode so a cluster-view bundle
            # doesn't accidentally pick up zone-view summaries (the cache
            # stores both side-by-side; without this filter the most
            # recent one wins per chart_id regardless of mode).
            # If the `grouping_mode` column doesn't yet exist (old cache
            # DB pre-migration), fall back to the un-filtered query.
            has_mode_col = any(
                row[1] == "grouping_mode"
                for row in con.execute(
                    "PRAGMA table_info(chart_summary_cache)"
                ).fetchall()
            )
            if has_mode_col:
                rows = con.execute(
                    """
                    SELECT chart_id, summary, highlight_points_json,
                           summary_v2_json, model, created_at
                      FROM chart_summary_cache
                     WHERE project_id = ?
                       AND (grouping_mode = ? OR grouping_mode IS NULL)
                    """,
                    (project_id, grouping_mode),
                ).fetchall()
                logger.info(
                    "nature-bundle: summary cache filtered by grouping_mode=%s",
                    grouping_mode,
                )
            else:
                rows = con.execute(
                    """
                    SELECT chart_id, summary, highlight_points_json,
                           summary_v2_json, model, created_at
                      FROM chart_summary_cache
                     WHERE project_id = ?
                    """,
                    (project_id,),
                ).fetchall()
            con.close()
            for r in rows:
                cid = r["chart_id"]
                existing = summaries_by_chart.get(cid)
                if existing and existing.get("_created_at", 0) >= r["created_at"]:
                    continue
                payload: dict = {
                    "chart_id":   cid,
                    "model":      r["model"],
                    "created_at": r["created_at"],
                    "_created_at": r["created_at"],
                    "overall":    r["summary"],
                }
                try:
                    payload["highlight_points"] = json.loads(r["highlight_points_json"])
                except Exception:
                    payload["highlight_points"] = []
                if r["summary_v2_json"]:
                    try:
                        payload["v2"] = json.loads(r["summary_v2_json"])
                    except Exception:
                        pass
                summaries_by_chart[cid] = payload
            logger.info("nature-bundle: pulled %d cached summaries",
                        len(summaries_by_chart))
    except Exception as e:
        logger.warning("nature-bundle: summary cache lookup failed: %s", e)

    # Pack into an in-memory ZIP.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        manifest = []
        for chart_id, svg in charts.items():
            zf.writestr(f"{folder}/charts/{chart_id}.svg", svg)
            files = [f"charts/{chart_id}.svg"]
            sm = summaries_by_chart.get(chart_id)
            if sm:
                sm_clean = {k: v for k, v in sm.items() if not k.startswith("_")}
                zf.writestr(
                    f"{folder}/summaries/{chart_id}.json",
                    json.dumps(sm_clean, indent=2, ensure_ascii=False),
                )
            manifest.append({
                "chart_id": chart_id,
                "title":    nature_charts.CHART_TITLES.get(chart_id, chart_id),
                "files":    files,
            })

        # v4.11 — only flag a chart as "missing" if it WAS viable in this mode.
        # Cluster-only charts skipped in zone view aren't "missing", they're "n/a".
        viable_ids = [
            cid for cid in nature_charts.CHART_FUNCS
            if effective_mode in nature_charts.CHART_MODES.get(
                cid, {"single_zone", "multi_zone", "cluster"})
        ]
        missing = [cid for cid in viable_ids if cid not in charts]

        # v4.x — Per-drill AI report + design strategies bundled as flat MD
        # files so users opening the ZIP see immediately readable narrative
        # documents alongside the charts. The slot key is the explicit
        # `view_id` when present (within-zone drills: 'all_sub_clusters',
        # 'within_zone:zone_X', 'parent_zones'), else the legacy
        # `grouping_mode` slot ('zones' / 'clusters'). project.ai_reports and
        # project.design_strategy_results are already mirrored from the
        # active panorama bucket to top-level by projects.py mirror logic,
        # so we read them flat here. Missing entries are skipped (the bundle
        # is still useful as a chart-only deliverable).
        ai_reports_dict = getattr(project, "ai_reports", None) or {}
        strategy_dict = getattr(project, "design_strategy_results", None) or {}
        slot_key = view_id if view_id else grouping_mode
        ai_report_md = ai_reports_dict.get(slot_key) if isinstance(ai_reports_dict, dict) else None
        # Fallback chain: explicit slot → legacy single ai_report field.
        if not ai_report_md and slot_key != grouping_mode:
            ai_report_md = ai_reports_dict.get(grouping_mode) if isinstance(ai_reports_dict, dict) else None
        if not ai_report_md:
            ai_report_md = getattr(project, "ai_report", None)
        design_strategies = strategy_dict.get(slot_key) if isinstance(strategy_dict, dict) else None
        if not design_strategies and slot_key != grouping_mode:
            design_strategies = strategy_dict.get(grouping_mode) if isinstance(strategy_dict, dict) else None
        if not design_strategies:
            design_strategies = getattr(project, "design_strategy_result", None)

        report_files: list[str] = []
        if isinstance(ai_report_md, str) and ai_report_md.strip():
            # Wrap with a baseline header so the file is self-contained when
            # opened outside the bundle context.
            report_header = (
                f"# Analysis Report — {project.project_name}\n\n"
                f"- Panorama view: {getattr(project, 'active_panorama_view', None) or 'n/a'}\n"
                f"- View / drill: {slot_key}\n"
                f"- Source: {used_source}\n"
                f"- Generated: {datetime.now().isoformat()}\n\n"
                f"---\n\n"
            )
            zf.writestr(f"{folder}/report.md", report_header + ai_report_md)
            report_files.append("report.md")

        if isinstance(design_strategies, dict) and design_strategies:
            # Write JSON for machine consumption + a flattened Markdown for
            # human reading. The MD flattening covers the documented shape
            # (strategies[] with title / description / category / priority /
            # implementation_steps[]) — unknown keys still land in the JSON.
            zf.writestr(
                f"{folder}/design_strategies.json",
                json.dumps(design_strategies, indent=2, ensure_ascii=False),
            )
            md_lines = [f"# Design Strategies — {project.project_name}", ""]
            md_lines.append(f"- Panorama view: {getattr(project, 'active_panorama_view', None) or 'n/a'}")
            md_lines.append(f"- View / drill: {slot_key}")
            md_lines.append(f"- Generated: {datetime.now().isoformat()}")
            md_lines.append("")
            # v4.x — Walk the v6.0 DesignStrategyResult shape:
            #   { "zones": { zone_id: ZoneDesignOutput }, "metadata": {} }
            # Each ZoneDesignOutput carries:
            #   zone_name, mean_abs_z, overall_assessment,
            #   matched_ioms[], design_strategies[], implementation_sequence,
            #   synergies, diagnosis
            # Each DesignStrategy carries:
            #   priority, strategy_name, target_indicators[], spatial_location,
            #   intervention{}, expected_effects[], confidence,
            #   potential_tradeoffs, signatures[], pathway{},
            #   implementation_guidance, transferability_note
            # Fallback paths preserved for legacy flat shapes
            # ({strategies:[…]} or {items:[…]}) just in case an older payload
            # still surfaces here.
            zones_obj = design_strategies.get("zones")
            legacy_flat = design_strategies.get("strategies") or design_strategies.get("items") or []

            def _fmt_strategy(s: dict, idx: int) -> list[str]:
                out: list[str] = []
                name = s.get("strategy_name") or s.get("title") or s.get("name") or f"Strategy {idx}"
                out.append(f"### {idx}. {name}")
                if s.get("priority") is not None:
                    out.append(f"- Priority: {s['priority']}")
                if s.get("spatial_location"):
                    out.append(f"- Spatial location: {s['spatial_location']}")
                if s.get("confidence"):
                    out.append(f"- Confidence: {s['confidence']}")
                tgt = s.get("target_indicators")
                if isinstance(tgt, list) and tgt:
                    out.append(f"- Target indicators: {', '.join(str(t) for t in tgt)}")
                # Intervention is a dict in v6.0 — surface its description-ish keys.
                intv = s.get("intervention")
                if isinstance(intv, dict):
                    desc = intv.get("description") or intv.get("summary") or intv.get("action")
                    if desc:
                        out.append("")
                        out.append(f"**Intervention:** {desc}")
                if s.get("implementation_guidance"):
                    out.append("")
                    out.append(f"**Implementation guidance:** {s['implementation_guidance']}")
                # Expected effects: list of dicts with indicator/direction/magnitude.
                effects = s.get("expected_effects")
                if isinstance(effects, list) and effects:
                    out.append("")
                    out.append("**Expected effects:**")
                    for e in effects:
                        if isinstance(e, dict):
                            ind = e.get("indicator") or e.get("indicator_id") or "?"
                            direction = e.get("direction") or ""
                            magnitude = e.get("magnitude") or e.get("delta") or ""
                            bits = [str(ind)]
                            if direction:
                                bits.append(str(direction))
                            if magnitude:
                                bits.append(str(magnitude))
                            out.append(f"  - {' · '.join(bits)}")
                        else:
                            out.append(f"  - {e}")
                if s.get("potential_tradeoffs"):
                    out.append("")
                    out.append(f"**Trade-offs:** {s['potential_tradeoffs']}")
                if s.get("transferability_note"):
                    out.append(f"**Transferability:** {s['transferability_note']}")
                out.append("")
                return out

            wrote_any = False
            if isinstance(zones_obj, dict) and zones_obj:
                for zone_id, zone_out in zones_obj.items():
                    if not isinstance(zone_out, dict):
                        continue
                    zone_name = zone_out.get("zone_name") or zone_id
                    md_lines.append(f"## {zone_name}")
                    if isinstance(zone_out.get("mean_abs_z"), (int, float)):
                        md_lines.append(f"- Mean |z|: {zone_out['mean_abs_z']:.3f}")
                    if zone_out.get("overall_assessment"):
                        md_lines.append("")
                        md_lines.append(str(zone_out["overall_assessment"]))
                    z_strats = zone_out.get("design_strategies") or []
                    if isinstance(z_strats, list) and z_strats:
                        md_lines.append("")
                        for i, s in enumerate(z_strats, 1):
                            if isinstance(s, dict):
                                md_lines.extend(_fmt_strategy(s, i))
                                wrote_any = True
                    if zone_out.get("implementation_sequence"):
                        md_lines.append(f"**Implementation sequence:** {zone_out['implementation_sequence']}")
                    if zone_out.get("synergies"):
                        md_lines.append(f"**Synergies with other zones:** {zone_out['synergies']}")
                    md_lines.append("")
            elif isinstance(legacy_flat, list) and legacy_flat:
                # Legacy flat shape: emit at top level.
                for i, s in enumerate(legacy_flat, 1):
                    if isinstance(s, dict):
                        md_lines.extend(_fmt_strategy(s, i))
                        wrote_any = True
            if not wrote_any:
                md_lines.append(
                    "Strategies payload was present but no `design_strategies[]` "
                    "entries could be extracted; see `design_strategies.json` for "
                    "the raw structure."
                )
            zf.writestr(f"{folder}/design_strategies.md", "\n".join(md_lines))
            report_files.append("design_strategies.md")
            report_files.append("design_strategies.json")

        metadata = {
            "project_slug":      slug,
            "project_name":      project.project_name,
            "grouping_mode":     grouping_mode,
            "view_id":           view_id or None,
            "panorama_view":     getattr(project, "active_panorama_view", None),
            "data_source":       used_source,
            "generated_at":      datetime.now().isoformat(),
            "renderer":          "scenerx.nature_charts (matplotlib server-side)",
            "chart_count":       len(charts),
            "summary_count":     len(summaries_by_chart),
            "skipped_chart_ids": missing,
            "report_files":      report_files,
            "charts":            manifest,
        }
        zf.writestr(
            f"{folder}/metadata.json",
            json.dumps(metadata, indent=2, ensure_ascii=False),
        )
        panorama_label = getattr(project, "active_panorama_view", None) or "n/a"
        readme_lines = [
            "# SceneRx nature-grade bundle",
            "",
            f"- Project: {project.project_name}",
            f"- Panorama view: {panorama_label}",
            f"- View / drill: {slot_key}",
            f"- Grouping mode: {grouping_mode}",
            f"- Data source: {used_source}",
            f"- Generated: {metadata['generated_at']}",
            "",
            "## Baseline",
            "",
            "All z-scores and rankings inside this bundle were computed against the "
            f"`{slot_key}` baseline for panorama view `{panorama_label}`. Comparing "
            "this bundle's numbers directly with another bundle generated under a "
            "different view or drill will mis-represent magnitudes — the units "
            "are different baselines, not the same one.",
            "",
            "## Contents",
            "",
        ]
        if "report.md" in report_files:
            readme_lines.append(
                "- `report.md` — narrative analysis report (AI-authored, "
                "covers the per-zone diagnostics, indicator drill-down, and "
                "clustering interpretation that match the charts below)."
            )
        else:
            readme_lines.append(
                "- `report.md` — **NOT INCLUDED**. The AI Report for view "
                f"`{slot_key}` is missing. This usually means Design "
                "Strategies were (re-)generated after the AI Report, "
                "which by design invalidates the report (the report's "
                "narrative cites the strategies, so it goes stale on "
                "strategy edits). Open the Reports page → Design "
                "Strategies tab → click **Generate Report**, then "
                "re-export this bundle."
            )
        if "design_strategies.md" in report_files:
            readme_lines.append(
                "- `design_strategies.md` / `.json` — actionable design "
                "strategies derived from the AI Report."
            )
        else:
            readme_lines.append(
                "- `design_strategies.*` — _not included_. Generate them on "
                "the Design Strategies tab in the Reports page first."
            )
        readme_lines.extend([
            f"- `charts/` — {len(charts)} server-rendered nature-grade SVG figure(s).",
            f"- `summaries/` — {len(summaries_by_chart)} per-chart \"What this "
            "means\" JSON payload(s) (LLM authored, cached at chart hover time).",
            "- `metadata.json` — machine-readable manifest of every file in the bundle.",
            "",
            f"_{len(charts)} chart(s), {len(summaries_by_chart)} summary file(s), "
            f"{len(missing)} skipped chart id(s)._",
            "",
        ])
        readme = "\n".join(readme_lines)
        zf.writestr(f"{folder}/README.md", readme)

    buf.seek(0)
    filename = f"{folder}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
