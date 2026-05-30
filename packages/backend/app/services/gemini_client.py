"""
Recommendation Service — Hybrid Architecture
Assessment (formerly Agent 1): deterministic Python computation of per-indicator cards
Agent 2 (Ranker & Selector):   LLM ranks, selects top indicators, outputs final JSON

Transferability is pre-computed in Python — never delegated to LLM.
"""

import json
import logging
import re
from collections import defaultdict, Counter

from app.models.indicator import (
    RecommendationRequest,
    RecommendationResponse,
    IndicatorRecommendation,
    EvidenceCitation,
    EvidenceSummary,
    TransferabilitySummary,
    IndicatorRelationship,
    RecommendationSummary,
)
from app.services.knowledge_base import KnowledgeBase
from app.services.llm_client import LLMClient
from app.services.transferability import enrich_evidence

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TIER_RANK = {"TIR_T1": 0, "TIR_T2": 1, "TIR_T3": 2}
_SIG_RANK = {"SIG_001": 0, "SIG_01": 1, "SIG_05": 2, "SIG_10": 3, "SIG_NS": 4, "SIG_NA": 5}
_TRANS_RANK = {"high": 0, "moderate": 1, "low": 2, "unknown": 3}

MAX_EVIDENCE_PER_INDICATOR = 5

# Recommendation eligibility is DATA-DRIVEN — there is intentionally no
# hardcoded id list here. The single source of truth is the codebook
# (Encoding_Dictionary.json -> A_indicators) `status` field, surfaced via
# KnowledgeBase.is_recommendable(). An indicator is offered by the recommender
# only when it exists in the codebook with status 'active' (a missing status
# defaults to 'active' for backward compatibility). Excluded cases:
#   - status 'future_development' (e.g. IND_SVF / IND_TVF and the panorama /
#     simulation / fisheye-defined metrics that a per-view street crop cannot
#     compute faithfully) — kept as future-development indicators;
#   - status 'unsupported';
#   - ids absent from the codebook entirely (e.g. legacy/phantom ids like
#     IND_GVI_ANG that linger in evidence but have no canonical definition).
# Users may still select excluded indicators manually; this only governs the
# evidence-driven recommendation candidate pool.
# See docs/per_view_indicator_change_proposal.md.


# ---------------------------------------------------------------------------
# Agent 2 prompt template (only LLM call remaining)
# ---------------------------------------------------------------------------

AGENT2_PROMPT = """\
# SceneRx-AI Stage 1 — Indicator Ranker & Selector

## Task
You receive pre-computed assessment cards (per-indicator evidence summaries)
plus the Encoding Dictionary and the project profile. Select the top
{max_recommendations} indicators and produce the final structured JSON output.

## Project Profile
- Name: {project_name}
- Climate: {project_climate}
- LCZ: {project_lcz}
- Setting: {project_setting}
- User groups: {project_users}
- Design brief: {design_brief}
- Target dimensions: {target_dims}
- Target subdimensions: {target_subdims}

## Encoding Dictionary ({cb_table_count} tables)
Use this to expand every code to {{code, name, definition}}.
```json
{codebook}
```

## Assessment Cards ({n_cards} indicators)
```json
{cards}
```

## Core Constraints
| ID | Constraint |
|----|-----------|
| C1 | Every recommended indicator MUST reference evidence_ids from the assessment cards. Do NOT invent. |
| C2 | Expand ALL codes to {{code, name, definition}} via the Encoding Dictionary. No bare codes. |
| C3 | Do NOT output numerical target values — only INCREASE / DECREASE. |
| C4 | Indicators with strength_score "C" should NOT be recommended unless no better alternatives exist. |
| C5 | Output valid JSON only. No markdown fences, no commentary outside the JSON. |
| C6 | Only use dimension/subdimension codes that exist in the Encoding Dictionary (C_performance, C_subdimensions). Do NOT invent codes. |

## Selection Rules
1. **Rank by**: (a) strength_score A > B > C, (b) transferability high > moderate > low > unknown,
   (c) subdimension relevance to target.
2. **Coverage**: at least one indicator per target dimension (where evidence exists).
3. **Diversity**: include both compositional (CAT_CMP) and configurational (CAT_CFG/CAT_CCG)
   if evidence supports them.
4. **Quality floor**: exclude indicators supported only by descriptive evidence (inferential_count = 0).
5. **Conflict flag**: if dominant_direction = DIR_MIX, note this in rationale.

## Output Schema
```json
{{
  "recommended_indicators": [
    {{
      "rank": 1,
      "indicator_id": "IND_XXX",
      "indicator_name": "Full name",
      "relevance_score": 0.95,
      "dimension_id": "PRF_XXX",
      "subdimension_id": "PRS_XXX",
      "evidence_summary": {{
        "evidence_ids": ["SVCs_P_XXX"],
        "inferential_count": 4,
        "descriptive_count": 1,
        "strength_score": "A",
        "strongest_tier": "TIR_T1",
        "best_significance": "SIG_001",
        "dominant_direction": "DIR_POS"
      }},
      "transferability_summary": {{
        "high_count": 2,
        "moderate_count": 1,
        "low_count": 0,
        "unknown_count": 2
      }},
      "relationship_direction": "INCREASE | DECREASE",
      "confidence": "high | medium | low",
      "rationale": "2-3 sentences"
    }}
  ],
  "indicator_relationships": [
    {{
      "indicator_a": "IND_A",
      "indicator_b": "IND_B",
      "relationship_type": "SYNERGISTIC | TRADE_OFF | INDEPENDENT",
      "explanation": "How they interact"
    }}
  ],
  "summary": {{
    "key_findings": ["Finding 1"],
    "evidence_gaps": ["Gap 1"],
    "transferability_caveats": ["Caveat 1"],
    "dimension_coverage": [
      {{"dimension_id": "PRF_XXX", "indicator_count": 0, "evidence_count": 0}}
    ]
  }}
}}
```

Output valid JSON only.
"""


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class RecommendationService:
    """Hybrid indicator recommendation service.

    Assessment cards are computed deterministically in Python.
    Only the ranking / selection / rationale step uses the LLM.
    """

    def __init__(self, llm: LLMClient):
        self.llm = llm

    @property
    def model(self) -> str:
        return self.llm.model

    def check_api_key(self) -> bool:
        return self.llm.check_connection()

    # -- Assessment card builder (replaces Agent 1 LLM call) ----------------

    @staticmethod
    def _build_assessment_cards(
        indicator_groups: dict[str, list[dict]],
    ) -> list[dict]:
        """Build per-indicator assessment cards deterministically."""
        cards: list[dict] = []

        for ind_id, evidence_list in indicator_groups.items():
            total = len(evidence_list)

            # --- counts ---
            inferential = sum(
                1 for e in evidence_list
                if not e.get("is_descriptive_statistic", True)
            )
            descriptive = total - inferential

            # --- directions ---
            dirs = [
                e.get("relationship", {}).get("direction_id", "")
                for e in evidence_list
            ]
            dir_counts = Counter(d for d in dirs if d)
            if not dir_counts:
                dominant_dir = "DIR_MIX"
            elif len(dir_counts) == 1:
                dominant_dir = dir_counts.most_common(1)[0][0]
            else:
                top2 = dir_counts.most_common(2)
                # If top direction has strict majority, use it; else MIX
                dominant_dir = (
                    top2[0][0]
                    if top2[0][1] > top2[1][1]
                    else "DIR_MIX"
                )

            # --- strongest tier ---
            tiers = [
                e.get("quality", {}).get("evidence_tier_id", "TIR_T3")
                for e in evidence_list
            ]
            strongest_tier = min(tiers, key=lambda t: _TIER_RANK.get(t, 9))

            # --- best significance ---
            sigs = [
                e.get("relationship", {}).get("statistical", {}).get("significance_id", "")
                or e.get("relationship", {}).get("significance_id", "")
                for e in evidence_list
            ]
            sigs = [s for s in sigs if s and s in _SIG_RANK]
            best_sig = min(sigs, key=lambda s: _SIG_RANK[s]) if sigs else "SIG_NA"

            # --- direct mapping ---
            has_direct = any(
                e.get("indicator", {}).get("framework_mapping_basis") == "direct"
                for e in evidence_list
            )

            # --- transferability counts ---
            trans_vals = [
                e.get("_transferability", {}).get("overall", "unknown")
                for e in evidence_list
            ]
            trans_counts = Counter(trans_vals)

            # --- dimensions / subdimensions ---
            dims = sorted({
                e.get("performance", {}).get("dimension_id", "")
                for e in evidence_list
            } - {""})
            subdims = sorted({
                e.get("performance", {}).get("subdimension_id", "")
                for e in evidence_list
            } - {""})

            # --- strength score (A / B / C) ---
            best_tier_rank = _TIER_RANK.get(strongest_tier, 9)
            best_sig_rank = _SIG_RANK.get(best_sig, 9)

            if (
                inferential >= 2
                and best_tier_rank <= 1        # T1 or T2
                and best_sig_rank <= 1         # SIG_001 or SIG_01
                and has_direct
            ):
                strength = "A"
            elif (
                inferential >= 1
                and best_tier_rank <= 1        # T2+
                and best_sig_rank <= 2         # SIG_05+
            ):
                strength = "B"
            else:
                strength = "C"

            # --- key evidence IDs (top by tier → significance → transferability) ---
            ranked = sorted(
                evidence_list,
                key=lambda e: (
                    _TIER_RANK.get(
                        e.get("quality", {}).get("evidence_tier_id", ""), 9
                    ),
                    _SIG_RANK.get(
                        (e.get("relationship", {}).get("statistical", {}).get("significance_id", "")
                         or e.get("relationship", {}).get("significance_id", "")),
                        9,
                    ),
                    _TRANS_RANK.get(
                        e.get("_transferability", {}).get("overall", "unknown"), 9
                    ),
                ),
            )
            key_ids = [e["evidence_id"] for e in ranked[:5]]

            # --- assessment note (template) ---
            note = (
                f"{inferential} inferential + {descriptive} descriptive records, "
                f"strength {strength}, {dominant_dir}, "
                f"transferability {trans_counts.get('high', 0)}H/"
                f"{trans_counts.get('moderate', 0)}M/"
                f"{trans_counts.get('low', 0)}L"
            )

            cards.append({
                "indicator_id": ind_id,
                "evidence_count": total,
                "inferential_count": inferential,
                "descriptive_count": descriptive,
                "dominant_direction": dominant_dir,
                "strongest_tier": strongest_tier,
                "best_significance": best_sig,
                "has_direct_mapping": has_direct,
                "transferability_summary": {
                    "high_count": trans_counts.get("high", 0),
                    "moderate_count": trans_counts.get("moderate", 0),
                    "low_count": trans_counts.get("low", 0),
                    "unknown_count": trans_counts.get("unknown", 0),
                },
                "dimensions_covered": dims,
                "subdimensions_covered": subdims,
                "strength_score": strength,
                "key_evidence_ids": key_ids,
                "assessment_note": note,
            })

        return cards

    # -- JSON parsing -------------------------------------------------------

    @staticmethod
    def _parse_json(text: str):
        """Extract JSON from LLM response with auto-repair."""
        text = text.strip()
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Auto-repair truncated JSON: strip back to the last complete object
        # then close all open brackets
        repaired = text
        # If truncated mid-string, close the string first
        in_str = repaired.count('"') % 2 == 1
        if in_str:
            repaired += '"'
        # Strip trailing partial tokens (comma, colon, partial key)
        repaired = re.sub(r'[,:\s]*"?[^"{}[\]]*$', '', repaired)
        # Close brackets/braces
        repaired += "]" * max(0, repaired.count("[") - repaired.count("]"))
        repaired += "}" * max(0, repaired.count("{") - repaired.count("}"))
        try:
            result = json.loads(repaired)
            logger.warning("JSON auto-repaired (truncation)")
            return result
        except json.JSONDecodeError:
            pass

        # Aggressive repair: find the last complete top-level object in an array
        last_obj = repaired.rfind("},")
        if last_obj == -1:
            last_obj = repaired.rfind("}")
        if last_obj > 0 and repaired.lstrip().startswith("["):
            truncated = repaired[:last_obj + 1] + "]"
            try:
                result = json.loads(truncated)
                logger.warning(
                    "JSON auto-repaired (truncated to last complete object, "
                    "kept %d/%d chars)", last_obj + 2, len(text),
                )
                return result
            except json.JSONDecodeError:
                pass

        # Fallback: regex extract
        obj_match = re.search(r'\{\s*"recommended_indicators"[\s\S]*\}', text)
        if obj_match:
            try:
                return json.loads(obj_match.group(0))
            except json.JSONDecodeError:
                pass

        arr_match = re.search(r'\[\s*\{[\s\S]*\}\s*\]', text)
        if arr_match:
            try:
                return json.loads(arr_match.group(0))
            except json.JSONDecodeError:
                pass

        logger.error("Failed to parse LLM response: %s", text[:500])
        return None

    # -- LLM call -----------------------------------------------------------

    async def _call_agent(self, prompt: str, tag: str):
        """Send prompt to LLM, return parsed JSON."""
        logger.info("%s — sending ~%d tokens", tag, len(prompt) // 4)
        raw = await self.llm.generate(prompt)
        if not raw:
            logger.error("%s — empty response", tag)
            return None
        logger.info("%s — received %d chars", tag, len(raw))
        return self._parse_json(raw)

    # -- Main pipeline ------------------------------------------------------

    async def recommend_indicators(
        self,
        request: RecommendationRequest,
        knowledge_base: KnowledgeBase,
    ) -> RecommendationResponse:
        """Hybrid recommendation pipeline.

        1. Retrieve & enrich evidence        (Python)
        2. Build assessment cards             (Python — replaces old Agent 1)
        3. LLM ranks, selects, writes output  (Agent 2)
        """
        try:
            if not self.llm.check_connection():
                return RecommendationResponse(
                    success=False,
                    error=f"LLM provider ({self.llm.provider}) not configured",
                )

            if not knowledge_base.loaded:
                knowledge_base.load()

            # ── 1. Retrieve evidence ──
            matched = knowledge_base.retrieve_evidence(
                request.performance_dimensions,
                request.subdimensions or None,
            )
            if not matched:
                return RecommendationResponse(
                    success=False,
                    error="No evidence found for the selected dimensions",
                )

            # ── 2. Pre-compute transferability (Python) ──
            project_ctx = {
                "koppen_zone_id": request.koppen_zone_id,
                "lcz_type_id": request.lcz_type_id,
                "space_type_id": request.space_type_id,
                "age_group_id": request.age_group_id,
            }
            matched = enrich_evidence(
                matched,
                knowledge_base.context_by_evidence,
                project_ctx,
            )

            # ── 3. Group by indicator ──
            indicator_groups: dict[str, list[dict]] = defaultdict(list)
            for e in matched:
                ind_id = e["indicator"]["indicator_id"]
                if not knowledge_base.is_recommendable(ind_id):
                    continue  # not 'active' in the codebook (future/unsupported/absent)
                indicator_groups[ind_id].append(e)

            logger.info(
                "Retrieved %d evidence → %d indicators (skipped %d excluded)",
                len(matched), len(indicator_groups),
                sum(1 for e in matched
                    if not knowledge_base.is_recommendable(e["indicator"]["indicator_id"])),
            )

            # ── 4. Build assessment cards (Python, instant) ──
            assessment_cards = self._build_assessment_cards(indicator_groups)
            logger.info(
                "Built %d assessment cards (Python)", len(assessment_cards),
            )

            # ── 5. LLM: Ranker & Selector ──
            cb_subset = knowledge_base.get_codebook_for_cards(project_ctx)

            agent2_prompt = AGENT2_PROMPT.format(
                project_name=request.project_name or "N/A",
                project_climate=request.koppen_zone_id or "N/A",
                project_lcz=request.lcz_type_id or "N/A",
                project_setting=request.space_type_id or "N/A",
                project_users=request.age_group_id or "N/A",
                design_brief=request.design_brief or "N/A",
                target_dims=json.dumps(request.performance_dimensions),
                target_subdims=json.dumps(request.subdimensions),
                codebook=json.dumps(cb_subset, ensure_ascii=False),
                cb_table_count=len(cb_subset),
                n_cards=len(assessment_cards),
                cards=json.dumps(assessment_cards, ensure_ascii=False),
                max_recommendations=request.max_recommendations,
            )

            result = await self._call_agent(agent2_prompt, "Ranker")
            if not isinstance(result, dict) or "recommended_indicators" not in result:
                logger.warning("Ranker returned unexpected format")
                return RecommendationResponse(
                    success=False,
                    error="LLM Ranker failed to produce valid output",
                )

            # ── 6. Parse into response models ──
            return self._build_response(result, len(matched))

        except Exception as e:
            logger.error("Recommendation error: %s", e, exc_info=True)
            return RecommendationResponse(success=False, error=str(e))

    # -- Streaming pipeline -------------------------------------------------

    async def recommend_indicators_stream(
        self,
        request: RecommendationRequest,
        knowledge_base: KnowledgeBase,
    ):
        """Same logic as recommend_indicators but yields SSE-style dicts.

        Event types:
          {"type": "status",  "message": "..."}
          {"type": "chunk",   "text": "..."}
          {"type": "result",  "data": { ... RecommendationResponse }}
          {"type": "error",   "message": "..."}
        """
        try:
            if not self.llm.check_connection():
                yield {"type": "error", "message": f"LLM provider ({self.llm.provider}) not configured"}
                return

            if not knowledge_base.loaded:
                knowledge_base.load()

            yield {"type": "status", "message": "Retrieving evidence…"}

            # ── 1-4: identical to non-streaming ──
            matched = knowledge_base.retrieve_evidence(
                request.performance_dimensions,
                request.subdimensions or None,
            )
            if not matched:
                yield {"type": "error", "message": "No evidence found for the selected dimensions"}
                return

            project_ctx = {
                "koppen_zone_id": request.koppen_zone_id,
                "lcz_type_id": request.lcz_type_id,
                "space_type_id": request.space_type_id,
                "age_group_id": request.age_group_id,
            }
            matched = enrich_evidence(matched, knowledge_base.context_by_evidence, project_ctx)

            indicator_groups: dict[str, list[dict]] = defaultdict(list)
            for e in matched:
                ind_id = e["indicator"]["indicator_id"]
                if not knowledge_base.is_recommendable(ind_id):
                    continue  # not 'active' in the codebook (future/unsupported/absent)
                indicator_groups[ind_id].append(e)

            assessment_cards = self._build_assessment_cards(indicator_groups)

            yield {
                "type": "status",
                "message": f"Built {len(assessment_cards)} assessment cards from {len(matched)} evidence records",
            }

            # ── 5. LLM (streamed) ──
            cb_subset = knowledge_base.get_codebook_for_cards(project_ctx)

            agent2_prompt = AGENT2_PROMPT.format(
                project_name=request.project_name or "N/A",
                project_climate=request.koppen_zone_id or "N/A",
                project_lcz=request.lcz_type_id or "N/A",
                project_setting=request.space_type_id or "N/A",
                project_users=request.age_group_id or "N/A",
                design_brief=request.design_brief or "N/A",
                target_dims=json.dumps(request.performance_dimensions),
                target_subdims=json.dumps(request.subdimensions),
                codebook=json.dumps(cb_subset, ensure_ascii=False),
                cb_table_count=len(cb_subset),
                n_cards=len(assessment_cards),
                cards=json.dumps(assessment_cards, ensure_ascii=False),
                max_recommendations=request.max_recommendations,
            )

            logger.info("Ranker (stream) — sending ~%d tokens", len(agent2_prompt) // 4)
            yield {"type": "status", "message": "LLM is generating recommendations…"}

            full_text = ""
            async for chunk in self.llm.generate_stream(agent2_prompt):
                full_text += chunk
                yield {"type": "chunk", "text": chunk}

            logger.info("Ranker (stream) — received %d chars", len(full_text))

            # ── 6. Parse ──
            result = self._parse_json(full_text)
            if not isinstance(result, dict) or "recommended_indicators" not in result:
                yield {"type": "error", "message": "LLM Ranker failed to produce valid output"}
                return

            response = self._build_response(result, len(matched))
            yield {"type": "result", "data": response.model_dump()}

        except Exception as e:
            logger.error("Streaming recommendation error: %s", e, exc_info=True)
            yield {"type": "error", "message": str(e)}

    # -- Response building --------------------------------------------------

    @staticmethod
    def _as_str(val) -> str:
        """Normalize LLM output: accept both 'CODE' and {'code': 'CODE', ...}."""
        if isinstance(val, dict):
            return val.get("code", val.get("id", str(val)))
        return str(val) if val is not None else ""

    @staticmethod
    def _as_name(val) -> str:
        """Normalize a *name* field. LLM sometimes wraps names in
        {code, name, definition} dicts because of the C2 prompt rule that
        requires expanding codes. For name fields we must prefer `name` and
        fall back to `code` only when `name` is absent — otherwise the UI
        shows the code (e.g. IND_XXX) instead of the full indicator name."""
        if isinstance(val, dict):
            return val.get("name") or val.get("code") or val.get("id") or ""
        return str(val) if val is not None else ""

    def _build_response(self, result: dict, evidence_count: int) -> RecommendationResponse:
        raw_recs = result.get("recommended_indicators", [])
        logger.info("_build_response: %d raw recommended_indicators", len(raw_recs))

        _s = self._as_str
        _n = self._as_name

        recommendations: list[IndicatorRecommendation] = []
        for item in raw_recs:
            try:
                es_raw = item.get("evidence_summary", {})
                ts_raw = item.get("transferability_summary", {})

                # If indicator_name came back empty or as the raw code (because
                # the LLM wrapped it in a dict), try to recover the name from
                # the indicator_id dict — the LLM expands that to
                # {code, name, definition} per prompt rule C2.
                name_val = _n(item.get("indicator_name", ""))
                ind_id_raw = item.get("indicator_id", "")
                ind_id_val = _s(ind_id_raw)
                if (not name_val or name_val == ind_id_val) and isinstance(ind_id_raw, dict):
                    fallback = ind_id_raw.get("name")
                    if fallback:
                        name_val = fallback

                rec = IndicatorRecommendation(
                    indicator_id=ind_id_val,
                    indicator_name=name_val,
                    relevance_score=float(item.get("relevance_score", 0)),
                    rationale=_s(item.get("rationale", "")),
                    evidence_ids=es_raw.get("evidence_ids", []),
                    rank=item.get("rank", 0),
                    relationship_direction=_s(item.get("relationship_direction", "")),
                    confidence=_s(item.get("confidence", "")),
                    strength_score=_s(es_raw.get("strength_score", "")),
                    dimension_id=_s(item.get("dimension_id", "")),
                    subdimension_id=_s(item.get("subdimension_id", "")),
                    evidence_summary=EvidenceSummary(
                        evidence_ids=es_raw.get("evidence_ids", []),
                        inferential_count=es_raw.get("inferential_count", 0),
                        descriptive_count=es_raw.get("descriptive_count", 0),
                        strength_score=_s(es_raw.get("strength_score", "")),
                        strongest_tier=_s(es_raw.get("strongest_tier", "")),
                        best_significance=_s(es_raw.get("best_significance", "")),
                        dominant_direction=_s(es_raw.get("dominant_direction", "")),
                    ) if es_raw else None,
                    transferability_summary=TransferabilitySummary(
                        high_count=ts_raw.get("high_count", 0),
                        moderate_count=ts_raw.get("moderate_count", 0),
                        low_count=ts_raw.get("low_count", 0),
                        unknown_count=ts_raw.get("unknown_count", 0),
                    ) if ts_raw else None,
                )
                recommendations.append(rec)
            except Exception as e:
                logger.warning(
                    "Failed to parse recommendation item: %s | item=%s",
                    e, json.dumps(item, ensure_ascii=False)[:300],
                )

        relationships: list[IndicatorRelationship] = []
        for rr in result.get("indicator_relationships", []):
            try:
                relationships.append(IndicatorRelationship(
                    indicator_a=_s(rr.get("indicator_a", "")),
                    indicator_b=_s(rr.get("indicator_b", "")),
                    relationship_type=_s(rr.get("relationship_type", "")),
                    explanation=_s(rr.get("explanation", "")),
                ))
            except Exception as e:
                logger.warning("Failed to parse relationship: %s", e)

        summary: RecommendationSummary | None = None
        raw_summary = result.get("summary")
        if raw_summary and isinstance(raw_summary, dict):
            summary = RecommendationSummary(
                key_findings=raw_summary.get("key_findings", []),
                evidence_gaps=raw_summary.get("evidence_gaps", []),
                transferability_caveats=raw_summary.get("transferability_caveats", []),
                dimension_coverage=raw_summary.get("dimension_coverage", []),
            )

        return RecommendationResponse(
            success=True,
            recommendations=recommendations,
            indicator_relationships=relationships,
            summary=summary,
            total_evidence_reviewed=evidence_count,
            model_used=self.llm.model,
        )


# Backward-compatible alias
GeminiClient = RecommendationService
