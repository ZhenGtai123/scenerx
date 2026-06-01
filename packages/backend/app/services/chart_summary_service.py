"""
Chart Summary Service — generates structured 4-section LLM interpretations
of analysis charts.

Each chart on the Analysis tab can request a "What this means →" summary.
The service is cache-first: results are persisted in a small SQLite table
keyed by (chart_id, project_id, payload_hash). Cache hits return
immediately; misses hit the configured LLMClient and write back.

#6 — output is now a structured ChartSummaryV2:

  * overall          — 1-2 sentence whole-chart interpretation
  * findings         — 2-3 key findings, each carrying inline evidence
                       (specific z-score / r value / indicator id)
  * local_breakdown  — one entry per grouping unit (zone or cluster), each
                       with at least one concrete number
  * implication      — 1-2 sentence design hand-off (feeds Stage 3)

Legacy {summary, highlight_points} are still emitted for older callers; they
are derived from the new fields so old chart cards keep working without
changes. When the LLM fails to produce valid v2 JSON twice, the service
falls back to a v1-style single-paragraph summary and marks `degraded=True`
so the frontend can show a "less structured" hint.

Cost note: prompts are still tight; v2 output stays under ~250 completion
tokens for the typical project. Use a cheap provider (Gemini Flash / GPT-4o
mini) — defaults inherit from get_llm_client().
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

from app.services.llm_client import LLMClient
from app.models.analysis import GroupingMode

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_DEFAULT_TEMPLATE = """\
You are reviewing a chart from an urban-greenspace analysis dashboard.
Your audience is a designer or planner without statistics training.

Chart: {chart_title} (id: {chart_id})
Chart description: {chart_description}
Grouping mode: {grouping_mode}
Grouping units (label list): {unit_labels}

Project context:
{project_context}

Chart data (truncated):
{payload}

Produce a structured 4-section interpretation. Constraints:
  1. `overall` is 1-2 sentences. Whole-chart picture; no per-unit detail.
  2. `findings` is 2-3 entries. Each `point` ≤ 25 words; `evidence` MUST cite
     at least one concrete value (z-score, correlation r, mean, percentage,
     count) or a named indicator/unit visible in the chart data.
  3. `local_breakdown` has exactly one entry per grouping unit listed above.
     Use that unit's label as `unit_label`. Each `interpretation` MUST
     include at least one specific number for that unit (z-score / mean /
     count). Skip units that have no data with a one-line note instead of
     fabricating numbers.
  4. `implication` is 1-2 sentences linking the chart to a concrete design
     direction (what to increase / decrease / preserve), aimed at Stage 3.
  5. Never invent indicator IDs or unit labels that are not in the chart
     data. Don't repeat the `overall` content verbatim inside any finding.

Respond ONLY with a single JSON object, no markdown fences, on one line:
{{"overall":"…","findings":[{{"point":"…","evidence":"…"}}, ...],"local_breakdown":[{{"unit_id":"…","unit_label":"…","interpretation":"…"}}, ...],"implication":"…"}}
"""


_CHART_TEMPLATE_HINTS: dict[str, str] = {
    "correlation-heatmap":
        "\nPay attention to the strongest positive/negative pairs (|r| ≥ 0.5).",
    "radar-profiles":
        "\nCall out which units differ most and on which indicators.",
    "spatial-overview":
        "\nNote whether values cluster spatially or spread evenly.",
    "indicator-deep-dive":
        "\nNote layer (FG/MG/BG) differences and any outlier units.",
    "priority-heatmap":
        "\nCall out the most-deviating cells (|z| ≥ 1) by unit + indicator.",
    "zone-deviation-overview":
        "\nRank by mean |z|; explain what makes the top unit distinctive.",
    "silhouette-curve":
        "\nIMPORTANT LOGIC for this chart:\n"
        "(1) If ANY K→silhouette data points are visible (e.g. K=2→0.45), "
        "that PROVES GMM (BIC-selected K) failed to find >=2 clusters and the "
        "KMeans fallback ran. Do NOT claim 'chart is empty' or 'GMM succeeded'.\n"
        "(2) The selected K is NOT necessarily the silhouette peak — it's a "
        "multi-criterion vote (silhouette + Davies-Bouldin + Calinski-"
        "Harabasz). Check the `is_selected` flag in payload. If silhouette "
        "peaks at K=2 but `is_selected=true` at K=4, explain that Davies-"
        "Bouldin and Calinski-Harabasz disagreed with silhouette and "
        "selected K=4 to avoid silhouette's known bias toward small K.\n"
        "(3) Interpret silhouette honestly: ≥0.5 strong, 0.25-0.5 weak/"
        "overlapping, ≤0.25 no real structure. If ALL K give silhouette "
        "≤0.25, the honest finding is 'this dataset does not have rich "
        "cluster structure beyond K=2' — do not pretend otherwise.\n"
        "(4) Design implication should be conservative: with weak silhouette "
        "the planner should treat archetypes as descriptive bins, not as "
        "fundamentally distinct landscape types.",
}


def _get_template(chart_id: str) -> str:
    base = _DEFAULT_TEMPLATE
    hint = _CHART_TEMPLATE_HINTS.get(chart_id, "")
    return base + hint if hint else base


# ---------------------------------------------------------------------------
# SQLite cache
# ---------------------------------------------------------------------------

_BASE_SCHEMA = """
CREATE TABLE IF NOT EXISTS chart_summary_cache (
    chart_id      TEXT NOT NULL,
    project_id    TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    summary       TEXT NOT NULL,
    highlight_points_json TEXT NOT NULL,
    model         TEXT,
    created_at    REAL NOT NULL,
    PRIMARY KEY (chart_id, project_id, payload_hash)
);
"""

# Migration columns — added on every connect via PRAGMA-style probe + ALTER.
# This keeps existing cached entries readable while letting us store v2
# structured output, a degraded flag, and (v4.3) the grouping_mode so
# callers can filter zone-vs-cluster summaries explicitly instead of
# reverse-engineering the payload_hash.
_V2_COLUMNS = [
    ("summary_v2_json", "TEXT"),
    ("degraded",        "INTEGER DEFAULT 0"),
    ("grouping_mode",   "TEXT"),
]


def _payload_hash(payload: dict[str, Any], grouping_mode: GroupingMode | None = None) -> str:
    """Stable hash of payload — sort keys so semantically identical payloads
    produce the same hash regardless of dict ordering. The grouping mode is
    folded in so a chart looked at under "zones" vs "clusters" produces
    different cache keys.
    """
    enriched = {"_payload": payload, "_mode": grouping_mode or "zones"}
    blob = json.dumps(enriched, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


class ChartSummaryService:
    def __init__(self, llm_client: LLMClient, cache_db_path: Path):
        self.llm = llm_client
        self.cache_db_path = cache_db_path
        self._ensure_schema()

    # ── cache helpers ────────────────────────────────────────────────
    def _connect(self) -> sqlite3.Connection:
        self.cache_db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.cache_db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(_BASE_SCHEMA)
            existing = {row[1] for row in conn.execute("PRAGMA table_info(chart_summary_cache)").fetchall()}
            for col_name, col_type in _V2_COLUMNS:
                if col_name not in existing:
                    try:
                        conn.execute(f"ALTER TABLE chart_summary_cache ADD COLUMN {col_name} {col_type}")
                    except sqlite3.OperationalError as e:
                        # TOCTOU race: the Reports page fires many chart-summary
                        # requests in parallel, each constructing this service in
                        # a FastAPI threadpool worker. Two workers can both read
                        # `existing` without the column, then both ALTER — the
                        # loser raises "duplicate column name". The migration is
                        # idempotent, so an already-present column is success.
                        if "duplicate column name" not in str(e).lower():
                            raise
            conn.commit()

    def _lookup(
        self,
        chart_id: str,
        project_id: str,
        payload_hash: str,
    ) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """SELECT summary, highlight_points_json, model,
                          summary_v2_json, degraded
                   FROM chart_summary_cache
                   WHERE chart_id = ? AND project_id = ? AND payload_hash = ?""",
                (chart_id, project_id, payload_hash),
            ).fetchone()
            if row is None:
                return None
            try:
                highlights = json.loads(row["highlight_points_json"])
            except json.JSONDecodeError:
                highlights = []
            v2: dict[str, Any] | None = None
            if row["summary_v2_json"]:
                try:
                    v2 = json.loads(row["summary_v2_json"])
                except json.JSONDecodeError:
                    v2 = None
            return {
                "summary": row["summary"],
                "highlight_points": highlights,
                "model": row["model"] or "",
                "summary_v2": v2,
                "degraded": bool(row["degraded"]),
            }

    def _store(
        self,
        chart_id: str,
        project_id: str,
        payload_hash: str,
        summary: str,
        highlight_points: list[str],
        summary_v2: dict[str, Any] | None,
        model: str,
        degraded: bool,
        grouping_mode: GroupingMode | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO chart_summary_cache
                   (chart_id, project_id, payload_hash, summary,
                    highlight_points_json, model, created_at,
                    summary_v2_json, degraded, grouping_mode)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    chart_id,
                    project_id,
                    payload_hash,
                    summary,
                    json.dumps(highlight_points),
                    model,
                    time.time(),
                    json.dumps(summary_v2) if summary_v2 else None,
                    1 if degraded else 0,
                    (grouping_mode or "zones"),
                ),
            )
            conn.commit()

    # ── public api ───────────────────────────────────────────────────
    def get_cached(
        self,
        chart_id: str,
        project_id: str,
        payload_hash: str,
    ) -> dict[str, Any] | None:
        return self._lookup(chart_id, project_id, payload_hash)

    async def generate(
        self,
        *,
        chart_id: str,
        chart_title: str,
        chart_description: str | None,
        project_id: str,
        payload: dict[str, Any],
        project_context: dict[str, Any] | None = None,
        grouping_mode: GroupingMode | None = "zones",
    ) -> dict[str, Any]:
        """Return a {summary, highlight_points, summary_v2, cached, model,
        degraded} dict. summary_v2 carries the structured 4-section output
        when the LLM produced parseable JSON; degraded=True marks responses
        where we fell back to free-text after two parse failures."""
        payload_hash = _payload_hash(payload, grouping_mode)
        cached = self._lookup(chart_id, project_id, payload_hash)
        if cached is not None:
            return {**cached, "cached": True}

        # Cap the payload string so the prompt stays small.
        payload_str = json.dumps(payload, default=str, sort_keys=True, ensure_ascii=False)
        if len(payload_str) > 6000:
            payload_str = payload_str[:6000] + "  ...[truncated]"

        ctx_str = (
            json.dumps(project_context, default=str, ensure_ascii=False)
            if project_context
            else "(none)"
        )

        # Extract grouping unit labels so the prompt can pin local_breakdown
        # entries to real names instead of inventing them.
        unit_labels = _extract_unit_labels(payload)

        prompt = _get_template(chart_id).format(
            chart_id=chart_id,
            chart_title=chart_title,
            chart_description=chart_description or "(none)",
            project_context=ctx_str,
            payload=payload_str,
            grouping_mode=grouping_mode or "zones",
            unit_labels=", ".join(unit_labels) if unit_labels else "(none — chart is project-global)",
        )

        # First LLM attempt
        v2: dict[str, Any] | None = None
        last_raw = ""
        last_error: str | None = None
        for attempt in (1, 2):
            try:
                raw = await self.llm.generate(prompt)
                last_raw = raw
            except Exception as exc:
                logger.warning("Chart summary LLM call failed for %s (attempt %d): %s", chart_id, attempt, exc)
                last_error = str(exc)
                continue

            v2 = _parse_v2(raw)
            if v2 is not None:
                # Post-validate: dedupe overall vs findings (≥0.85 token Jaccard
                # → drop the redundant finding) and clamp local_breakdown to
                # the unit_labels list so the LLM can't hallucinate extra
                # units. Both rules are tolerated as long as findings stays
                # non-empty afterwards.
                v2 = _post_validate_v2(v2, unit_labels)
                if v2 is not None:
                    break

        if v2 is not None:
            summary, highlights = _v2_to_legacy(v2)
            self._store(
                chart_id,
                project_id,
                payload_hash,
                summary,
                highlights,
                v2,
                getattr(self.llm, "model", ""),
                degraded=False,
            )
            return {
                "summary": summary,
                "highlight_points": highlights,
                "summary_v2": v2,
                "cached": False,
                "model": getattr(self.llm, "model", ""),
                "degraded": False,
            }

        # Both v2 attempts failed → fall back to a v1-style free-text parse
        # of whichever raw response we last got. The frontend renders the
        # `summary` paragraph and shows a "Structured view unavailable" hint.
        summary, highlights = _parse_v1_fallback(last_raw) if last_raw else ("", [])
        if not summary and last_error:
            return {
                "summary": "",
                "highlight_points": [],
                "summary_v2": None,
                "cached": False,
                "model": getattr(self.llm, "model", ""),
                "error": last_error,
                "degraded": True,
            }
        self._store(
            chart_id,
            project_id,
            payload_hash,
            summary,
            highlights,
            None,
            getattr(self.llm, "model", ""),
            degraded=True,
            grouping_mode=grouping_mode,
        )
        return {
            "summary": summary,
            "highlight_points": highlights,
            "summary_v2": None,
            "cached": False,
            "model": getattr(self.llm, "model", ""),
            "degraded": True,
        }


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def _strip_fences(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        # Drop optional ```json fence; keep content between the first pair.
        text = text.split("```", 2)[1] if text.count("```") >= 2 else text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return text


def _parse_v2(raw: str) -> dict[str, Any] | None:
    """Parse a strict v2 JSON object. Returns None when the response
    doesn't carry the four required top-level keys with the right types,
    so the caller can decide whether to retry or degrade."""
    text = _strip_fences(raw)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(text[start: end + 1])
    except json.JSONDecodeError:
        return None
    overall = obj.get("overall")
    findings = obj.get("findings")
    local = obj.get("local_breakdown")
    implication = obj.get("implication")
    if not isinstance(overall, str) or not overall.strip():
        return None
    if not isinstance(findings, list):
        return None
    if not isinstance(local, list):
        return None
    if not isinstance(implication, str):
        return None

    cleaned_findings: list[dict[str, str]] = []
    for f in findings[:5]:
        if not isinstance(f, dict):
            continue
        point = str(f.get("point", "")).strip()
        evidence = str(f.get("evidence", "")).strip()
        if not point:
            continue
        cleaned_findings.append({"point": point, "evidence": evidence})

    cleaned_local: list[dict[str, str]] = []
    for l in local[:50]:
        if not isinstance(l, dict):
            continue
        unit_id = str(l.get("unit_id", "")).strip()
        unit_label = str(l.get("unit_label", "")).strip()
        interpretation = str(l.get("interpretation", "")).strip()
        if not interpretation:
            continue
        cleaned_local.append({
            "unit_id": unit_id,
            "unit_label": unit_label or unit_id,
            "interpretation": interpretation,
        })

    if not cleaned_findings:
        # The schema is technically satisfied but findings was empty / all
        # malformed → treat as a parse failure so we retry.
        return None

    return {
        "overall": overall.strip(),
        "findings": cleaned_findings,
        "local_breakdown": cleaned_local,
        "implication": implication.strip(),
    }


def _parse_v1_fallback(raw: str) -> tuple[str, list[str]]:
    """Tolerant v1 parse: pull `summary` + `highlight_points` from a JSON
    object if present, otherwise treat the whole reply as a paragraph."""
    text = _strip_fences(raw)
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(text[start: end + 1])
            summary = str(obj.get("summary", "")).strip()
            highlights = obj.get("highlight_points") or []
            if not isinstance(highlights, list):
                highlights = [str(highlights)]
            highlights = [str(h).strip() for h in highlights if str(h).strip()][:3]
            if summary:
                return summary, highlights
        except json.JSONDecodeError:
            pass
    return text[:600].strip(), []


_TOKEN_RE = __import__("re").compile(r"[A-Za-z][A-Za-z0-9_-]+")


def _tokens(s: str) -> set[str]:
    """Lowercased tokenization for similarity comparison. Strips short tokens
    (≤2 chars) to avoid noise dominating the Jaccard score."""
    return {t.lower() for t in _TOKEN_RE.findall(s) if len(t) > 2}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _post_validate_v2(
    v2: dict[str, Any],
    unit_labels: list[str],
) -> dict[str, Any] | None:
    """Final clean-up after _parse_v2 accepts the JSON.

    1. Dedup `findings` against `overall` — if a finding's `point` overlaps
       overall too heavily (Jaccard ≥ 0.85 on tokenized words), drop it.
       The LLM sometimes restates the overall in the first finding, which
       turns the panel into noise.
    2. Trim `local_breakdown` so it never exceeds the project's actual
       grouping unit count. When unit_labels is empty (chart is global),
       local_breakdown is required to be empty as well — anything else is
       fabrication.
    3. If after pruning `findings` becomes empty, treat the response as
       unusable and return None so the caller retries / degrades.
    """
    overall_tokens = _tokens(v2.get("overall", ""))
    pruned_findings: list[dict[str, str]] = []
    for f in v2.get("findings", []):
        f_tokens = _tokens(f.get("point", ""))
        if _jaccard(overall_tokens, f_tokens) >= 0.85:
            continue
        pruned_findings.append(f)
    if not pruned_findings:
        return None

    if not unit_labels:
        local: list[dict[str, str]] = []
    else:
        # Prefer entries whose unit_id/unit_label matches one of the actual
        # unit names. Anything else is hallucinated and should be dropped.
        label_set = {l.lower() for l in unit_labels}
        local = []
        for lb in v2.get("local_breakdown", []):
            label = (lb.get("unit_label") or lb.get("unit_id") or "").lower()
            if label and label in label_set:
                local.append(lb)
        # Cap at the actual unit count.
        local = local[: len(unit_labels)]

    return {
        **v2,
        "findings": pruned_findings,
        "local_breakdown": local,
    }


def _v2_to_legacy(v2: dict[str, Any]) -> tuple[str, list[str]]:
    """Synthesize the legacy {summary, highlight_points} fields from v2 so
    older callers / cards that only know about v1 keep working."""
    overall = v2.get("overall", "")
    implication = v2.get("implication", "")
    summary_parts = [s for s in (overall, implication) if s]
    summary = " ".join(summary_parts).strip()
    findings = v2.get("findings") or []
    highlights: list[str] = []
    for f in findings[:3]:
        point = (f.get("point") or "").strip()
        if point:
            highlights.append(point)
    return summary, highlights


def _extract_unit_labels(payload: dict[str, Any]) -> list[str]:
    """Best-effort extraction of grouping unit labels from a chart payload
    so the prompt can pin local_breakdown entries to real names. We look at
    the most common shapes used by registry payloads:

      - top-level `zones` list with `zone` keys
      - top-level `rows` list with `zone` / `zone_name` keys
    """
    labels: list[str] = []
    seen: set[str] = set()

    def _push(s: Any) -> None:
        if not isinstance(s, str):
            return
        s = s.strip()
        if not s or s in seen:
            return
        seen.add(s)
        labels.append(s)

    for key in ("zones", "rows"):
        lst = payload.get(key)
        if not isinstance(lst, list):
            continue
        for entry in lst:
            if isinstance(entry, dict):
                _push(entry.get("zone"))
                _push(entry.get("zone_name"))
    return labels
