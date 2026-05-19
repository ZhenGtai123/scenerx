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
from app.models.analysis import ZoneAnalysisResult
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


@router.get("/{project_id}/nature-bundle.zip")
def nature_bundle(project_id: str, view: str = "zones"):
    """Return a ZIP of nature-style chart SVGs.

    Query params:
      view = "zones"     -> use the original zone-level analysis (default)
      view = "clusters"  -> use the cluster-rebuilt analysis persisted
                            at `zone_analysis_result["cluster_view"]`.
                            Falls back to the top-level (and triggers the
                            safety-net rebuild) when cluster_view is absent.
    """
    logger.info("nature-bundle: incoming request project_id=%s view=%s",
                project_id, view)
    view = (view or "zones").lower()
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
    # v4.7 — when caller asks for cluster view AND a saved cluster_view
    # sub-payload exists, load it as the zar so the bundle reflects the
    # 6-cluster pseudo-zones instead of the original 1-zone setup.
    zar_dict = project.zone_analysis_result
    if view == "clusters":
        sub = zar_dict.get("cluster_view") if isinstance(zar_dict, dict) else None
        if isinstance(sub, dict) and sub:
            # Merge the top-level `clustering` + `segment_diagnostics` into
            # the cluster sub-payload so safety-net 1 doesn't re-run on it.
            for key in ("clustering", "segment_diagnostics"):
                if key in zar_dict and key not in sub:
                    sub[key] = zar_dict[key]
            zar_dict = sub
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
        from app.core.config import settings as _settings
        cache_db = _settings.data_path / "chart_summary_cache.sqlite"
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

        metadata = {
            "project_slug":      slug,
            "project_name":      project.project_name,
            "grouping_mode":     grouping_mode,
            "generated_at":      datetime.now().isoformat(),
            "renderer":          "scenerx.nature_charts (matplotlib server-side)",
            "chart_count":       len(charts),
            "summary_count":     len(summaries_by_chart),
            "skipped_chart_ids": missing,
            "charts":            manifest,
        }
        zf.writestr(
            f"{folder}/metadata.json",
            json.dumps(metadata, indent=2, ensure_ascii=False),
        )
        readme = (
            f"# SceneRx nature-grade bundle\n\n"
            f"- Project: {project.project_name}\n"
            f"- Grouping mode: {grouping_mode}\n"
            f"- Generated: {metadata['generated_at']}\n"
            f"- {len(charts)} chart(s), {len(summaries_by_chart)} summary file(s),"
            f" {len(missing)} skipped\n"
        )
        zf.writestr(f"{folder}/README.md", readme)

    buf.seek(0)
    filename = f"{folder}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
