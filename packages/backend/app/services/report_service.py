"""
Report Service — Agent C (v6.0)
Synthesises Stages 1-3 into a comprehensive evidence-based design strategy report.
Uses LLM to generate a professional markdown report with I->SVCs->P traceability.

v6.0 Change: Stage 2 data is now purely descriptive (no status/priority/problems).
Agent A's direction decisions and rationale are included in Stage 3 data.
"""

import json
import logging
import re
import time
from datetime import datetime
from typing import Optional

from app.models.analysis import (
    ReportRequest,
    ReportResult,
    ZoneAnalysisResult,
    DesignStrategyResult,
    ProjectContext,
)
from app.services.knowledge_base import KnowledgeBase
from app.services.llm_client import LLMClient, suggest_model_upgrade

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Report prompt template
# ---------------------------------------------------------------------------

REPORT_PROMPT = """\
# SceneRx-AI — Agent C: Evidence-Based Design Strategy Report

## Identity
You are a senior landscape performance consultant producing a formal
evidence-based design strategy report. Your audience is a multidisciplinary
review panel comprising landscape architects, urban planners, heritage
conservation officers, and municipal decision-makers. The report must meet
the rigour of a peer-reviewed design evaluation while remaining actionable.

## Analytical Framework
This report follows the I-SVCs-P chain-reasoning framework:
- **I (Design Intervention)**: Physical modifications to landscape elements
- **SVCs (Spatial-Visual Characteristics)**: Measurable visual indicators
  quantified from eye-level imagery
- **P (Human-Centred Performance)**: Multidimensional outcomes across six
  domains (PRF_AES, PRF_RST, PRF_EMO, PRF_THR, PRF_USE, PRF_SOC)

## Citation Protocol (MANDATORY)
Every factual claim MUST include inline coded references in parentheses.
The reader must be able to trace any statement back to the knowledge base.

| Entity | Format | Example |
|--------|--------|---------|
| Indicator | (IND_XXX) | (IND_GVI) |
| Performance dimension | (PRF_XXX) | (PRF_THR) |
| Evidence record | (SVCs_P_Author_Year_N) | (SVCs_P_Zhao2024_1) |
| IOM operation | (I_SVCs_Author_Year_N) | (I_SVCs_Lei2024_2) |
| Signature ID | (SIG_XXX_XXX_XXX_XXX) | (SIG_ADD_VEG_FG_SIZ) |
| Operation type | (ACT_XXX) | (ACT_ADD) |
| Semantic layer | (OBJ_XXX) | (OBJ_VEG) |
| Spatial layer | (TER_XXX) | (TER_FG) |
| Morphological attribute | (VAR_XXX) | (VAR_SIZ) |
| Pathway type | (PTH_XXX) | (PTH_CMP) |
| Confidence grade | (GRD_X) | (GRD_B) |
| Climate zone | (KPN_XXX) | (KPN_CFA) |

When citing a design strategy, chain the full I-SVCs-P reasoning:
"[Intervention]: (ACT_ADD) (OBJ_VEG) at (TER_FG) modifying (VAR_SIZ)
-> [SVC effect]: increase (IND_GVI) by enhancing visible vegetation proportion
-> [Performance outcome]: improve (PRF_AES) via composition pathway (PTH_CMP),
supported by (SVCs_P_Jing2024_2), (GRD_B)."

## Quality Differentiation Protocol
When presenting evidence, always qualify its strength:
- "Strong inferential evidence (GRD_A)" — high confidence
- "Moderate evidence (GRD_B)" — reasonable confidence, local validation advised
- "Descriptive evidence only" — establishes association but not causal direction
- "Low transferability" — effect sizes may differ locally

## Report Structure

### 1. Executive Summary (300-400 words, 4 paragraphs)
P1: Project identity (name, climate, setting, target dimensions)
P2: Key diagnostic findings (N points, K archetypes, dominant pattern, most distinctive unit)
P3: Top 3 recommendations with full I->SVCs->P chain
P4: Principal caveat

### 2. Indicator Selection and Evidence Base
One subsection per indicator covering: identity, SVC matrix position, performance
linkage, evidence strength, transferability, relationships, target direction.
The Stage 1 payload now includes explicit fields you MUST use to answer
the four questions below in this section:
  Q1. Why these N indicators? Use `framework_mapping_brief` and the
      performance_link to justify each pick against the design brief.
  Q2. Which alternatives were considered and rejected? List the IDs from
      `considered_alternatives` with their `reject_reason`. If empty,
      acknowledge the omission.
  Q3. How strong is the evidence? Translate each indicator's
      `evidence_tier_distribution` (e.g. {{"TIR_T1": 5, "TIR_C": 1}}) into
      plain language and cite a few `evidence_ids`.
  Q4. Is transferability matched? Quote each `transferability_match_pct`
      and discuss any sub-50% indicator as a caveat.
End with a cross-indicator synthesis paragraph.

### 3. Spatial Diagnosis and Archetype Analysis
v4 / Module 10 — Section 3 is the data narrative hub. Each subsection MUST
open with a chart name + refCode reference (visible to the user on the
Reports page). Available refCodes:
  A1 Indicator Registry · A2 Data Quality
  B1 Zone Ranking · B2 Zone × Indicator · B3 Zone Profile Radar · B4 Zone Deviation Map
  C1 Indicator Distribution · C2 Per-Indicator Drill-Down · C3 Within-Zone Image Distribution · C4 Indicator Value Map
  D1 Global Stats · D2 Zone × Indicator Mean Matrix · D3 Indicator Correlation
  E1 Cluster Centroid Heatmap · E2 Per-Point Silhouette Plot · E3 HDBSCAN Condensed Tree · E4 Silhouette Score Curve
  E5 Ward Dendrogram · E6 Cluster Spatial Smoothing · E7 Cluster Radar Profiles · E8 Cluster Size Distribution
(E-codes are only available when clustering has been run; cite them only
in cluster-derived reports.)
You MAY NOT invent refCodes outside this list. Each claim MUST be traceable
to one or more of these charts.

3.1 Project-Level Overview — open with refs to A1, A2 and C1
3.2 Cross-Archetype Findings — open with refs to B1, B2, B3, B4
3.3 Per-Archetype Profiles — open with refs to C2, C3, C4
3.4 Indicator Relationships — open with refs to D1, D2, D3
(Single-zone fallback, see end of prompt: collapse 3.2 into Indicator
Distribution and Layer Profile (refs C1, C2, C3); collapse 3.3+3.4 into
Indicator Relationships (refs D1, D3).)

### 4. Design Strategies
Per spatial unit, ordered by priority. Section title varies by mode:
- Multi-zone, no clustering           → "4. Design Strategies — Per Zone"
- Multi-zone, within-zone clustering  → "4. Design Strategies — Per Sub-Zone"
- Single-zone, no clustering          → "4. Design Strategies — Single Spatial Unit"
- Single-zone, archetype clustering   → "4. Design Strategies — Per Archetype"

**CRITICAL — strategy provenance rule (applies to ALL modes above):**
The strategies you describe in Section 4 MUST be drawn directly from the
`stage3_data` payload below — you are NARRATING and INTEGRATING the
structured strategies that the upstream DesignEngine + IOM matching engine
already produced. Do NOT invent new strategies, do NOT change priority
ordering, do NOT replace the target_indicators or signature axes that
stage3_data attaches to each strategy. If stage3_data is empty for a unit,
state that explicitly instead of fabricating content.

**EXHAUSTIVE ENUMERATION — NO SHORTCUTS (CRITICAL):**
You MUST emit one full 4.X subsection per unit in `stage3_data` and one
full strategy entry per strategy inside each unit's `design_strategies`
list. Total subsection count = number of units in stage3_data. Total
strategy entries across Section 4 = sum of `len(unit.design_strategies)`
for every unit.

The following shortcuts are FORBIDDEN and will fail review:
  - "Segments X, Y, Z follow an identical diagnostic chain — see above"
  - "The remaining clusters share the same pattern as Cluster N"
  - "(Strategy profiles for Segments A, B, C are omitted for brevity)"
  - Any phrasing that bundles multiple units' strategies into one block,
    or any phrasing that states some units' strategies "follow" or
    "mirror" another unit without writing them out.
Even when two clusters share similar diagnoses, you MUST emit each one's
own 4.X.1 / 4.X.2 / 4.X.3 block in full. If the diagnoses are genuinely
near-identical, a one-sentence cross-reference is OK ("Diagnosis closely
parallels Cluster 3 — see 4.3 for the underlying mechanism") but the
4.X.2 strategy entries (target_indicators, signature, pathway, expected
effects, supporting IOMs, implementation guidance, "Diagnosed by:") must
still be written out for THIS cluster, with THIS cluster's actual values.

**Report length expectation:** Section 4 grows linearly with the unit
count. For a project with K=8 clusters and 3 strategies each, expect 24
strategy entries (3 per cluster × 8 clusters). For K=4 clusters, expect
12. Do not compress.

For each unit, include in the report:
4.X.1 Integrated diagnosis (from the unit's `diagnosis` field; expand into
      a paragraph that anchors to the actual chart numbers, not to invented
      observations).
4.X.2 Strategy entries. For every strategy in
      `stage3_data[unit].design_strategies`, render the entry below in
      the **EXACT same skeleton** — same field order, same labels, same
      number of bullets — regardless of project mode (single-zone vs.
      cluster vs. multi-zone). The reader should be able to scroll
      Section 4 and read every strategy at the same depth of detail;
      cluster-mode reports must NOT be terser than single-zone reports.
      Granularity target = the platform's Design Strategies tab card,
      which surfaces all of these fields on screen.

      v4.6 / Module 10.3.4 — MANDATORY per-strategy skeleton (verbatim
      labels, in this order; if a field is missing in `stage3_data`,
      write "—" or quote the missing field so the reader sees the gap
      explicitly):

      **Strategy N (Priority N · Grade <confidence> · <target_indicators[0]>) — <strategy_name>**

      - *Location:* <spatial_location>  (e.g. Foreground / Middleground /
        Background / Full layer)
      - *Intervention:* <intervention.object> × <intervention.variable> →
        <intervention.action>. <one-sentence intervention.description>.
      - *Signature:* `<signatures[0].operation>` × `<signatures[0].semantic>`
        × `<signatures[0].spatial>` × `<signatures[0].morphological>`
        (cite up to 3 signatures when present, comma-separated).
      - *Pathway:* one paragraph paraphrasing `pathway` — what mechanism
        actually delivers the indicator change, in plain language.
      - *Expected effects:* bullet list, one bullet per entry in
        `expected_effects`, formatted as
          `<indicator> <direction> <magnitude> (<note>)`.
      - *Tradeoffs:* paraphrase `potential_tradeoffs` (or
        `transferability_note` if tradeoffs are empty). State "—" only
        when both are empty.
      - *Implementation guidance:* paraphrase `implementation_guidance`
        in 1-3 sentences; do not pad with generic best-practice prose.
      - *Supporting IOMs:* comma-separated list from `supporting_ioms`
        (these are the IOM record IDs that ground the strategy in the
        knowledge base; cite the first 5 if there are more).
      - *Diagnosed by:* <2-4 chart refCodes>. e.g. "B2, C2, C3" in
        multi-zone mode, "C1, C3, D1" in single-zone mode,
        "E1, E2, C2" in cluster mode. RefCodes must come from
        Section 3's reference list AND be valid for this project's view
        (no B-codes in single-zone, no E-codes when clustering wasn't run).

      Do NOT collapse this skeleton into a flat one-line paragraph for
      cluster-mode units. The Strategies tab on the Reports page renders
      every cluster's strategies at this granularity; the report's
      Section 4 must mirror that 1:1.
4.X.3 Intra-unit synergies (from how the strategies in this unit interact
      — derive from the strategies' target_indicators and pathways; do not
      invent unrelated synergies).

### 5. Implementation Roadmap
5.1 Phasing (minimum 3 phases with timeframes)
5.2 Cross-unit coordination
5.3 Monitoring framework. Each row: indicator, target delta-z, interval,
    success criterion, AND v4 / Module 10.3.3 — "Reference chart:"
    listing the chart refCode(s) the user should monitor over time
    (typically C2, C3, or C4).

### 6. Evidence Quality Assessment and Limitations
The Stage 2 payload now exposes a `data_quality_flags` object that you MUST
discuss explicitly — do NOT speak in generalities. Address every populated
flag below with one or two concrete sentences.
6.1 Evidence strength profile table — derive from Stage 1 evidence_tier_distribution.
6.2 Transferability assessment table — climate, LCZ, setting, user group;
    use Stage 1 transferability_match_pct to mark each row.
6.3 Data quality flags (REQUIRED). For each flag that is non-trivial, state
    its value and explain how it constrains conclusions:
      - is_single_zone (cross-zone z-scores fall back to image-level)
      - n_zones / analysis_mode
      - indicators_with_nan (list the affected IDs)
      - layer_coverage_pct (how complete the FG/MG/BG split is)
      - low_confidence_evidence_ratio (share of recommended indicators whose
        evidence is dominated by descriptive / weakest-tier records — flag as
        a confidence caveat when > 0.3)
      - low_transferability_indicators (indicator IDs whose supporting
        evidence pool's transferability to this project is mostly low or
        unknown; cite each one explicitly as a context caveat)
6.4 Knowledge gaps and methodological caveats.

## Input Data

### Project Context
{project_context}

### Stage 1: Indicator Selection Results
{stage1_data}

### Stage 2: Spatial Analysis Results
{stage2_data}

### Stage 3: Design Strategy Results
{stage3_data}

### Encoding Dictionary Reference
{encoding_ref}

## Single-Zone Fallback (v4 / Module 11)

If `data_quality_flags.is_single_zone` is True, adapt the report:

### Section 3 (Spatial Diagnosis) — replace Per-Archetype Profiles with:
3.1 Project-Level Overview (n images, indicators measured, layer coverage)
3.2 Indicator Distribution and Layer Profile — describe each indicator's
    distribution across Full / Foreground / Middleground / Background using
    the `image_distribution_summary` block in the Stage 2 payload (N, mean,
    std, CV, min, Q1, median, Q3, max). DO NOT discuss archetypes,
    silhouette, or cross-archetype comparison — there are none.
3.3 Indicator Relationships — discuss `significant_correlations` only.

### Section 4 — title becomes "Design Strategies — Single Spatial Unit"
Render the single zone group as one block. STRATEGIES STILL COME FROM
`stage3_data` (the upstream DesignEngine output) — DO NOT invent
strategies from the design brief, and DO NOT replace the structured
output with free-form recommendations. The only adjustment vs.
multi-archetype mode is the section title and that there's a single
group instead of N. If `stage3_data` is empty, state this explicitly
rather than fabricating strategies. "Diagnosed by:" refCodes for this
mode must be drawn from {{C1, C2, C3, C4, D1, D3}} (no B-codes since no
cross-zone comparison; no E-codes since no clustering).

### Section 6.3 — REQUIRED single-zone disclaimer:
"This is a single-zone analysis (n_zones=1). Cross-zone z-score
standardization is mathematically undefined with one observation; the
diagnosis is therefore based on image-level descriptive statistics within
this zone. To enable cross-zone variance analysis, either define a second
spatial zone in the project setup or run KMeans archetype clustering
(Reports → Dual View)."

### Avoid mentioning archetypes / clustering / silhouette in single-zone mode.

## Final Instructions
1. Write the complete report following the structure above precisely.
2. Use markdown formatting: ## for main sections, ### for subsections.
3. Every factual claim must include at least one coded reference in parentheses.
4. Maintain a formal, analytical tone throughout.
5. When data is missing, state this explicitly rather than inventing content.
6. The report should be self-contained.
7. Honour the Single-Zone Fallback above when `is_single_zone` is True.
8. **Strategy provenance (CRITICAL)** — Section 4 strategies are NEVER
   invented. Every strategy you describe MUST originate from a record in
   `stage3_data[unit].design_strategies`. This rule applies in ALL FOUR
   modes: (a) single-zone no-clustering, (b) multi-zone no-clustering,
   (c) single-zone + archetype clustering, (d) multi-zone + within-zone
   clustering. If `stage3_data` is empty (e.g. DesignEngine produced no
   IOM matches), say so explicitly — do not paper over with fabricated
   strategies. The Strategies tab on the Reports page renders the same
   `stage3_data`; the AI report is the narrative version, not an
   independent source.
9. **Chart-grounding (CRITICAL)** — Every "Diagnosed by:" line in
   Section 4, and every monitoring entry in Section 5.3, MUST cite chart
   refCodes that are actually rendered in the user's current view:
     • single-zone, no clustering   → only A1, A2, C1–C4, D1
     • multi-zone, no clustering    → A1–A2, B1–B4, C1–C4, D1–D3
     • single-zone + clustering     → A1–A2, B1–B4 (cluster-derived),
                                       C1–C4, D1–D3, E1–E8
     • multi-zone + within-zone     → A1–A2, B1–B4 (sub-zone-derived),
                                       C1–C4, D1–D3, E1–E8
   Do not cite refCodes the user can't see. Cluster-only charts (E1–E8)
   may only be cited when `data_quality_flags.zone_source == 'cluster'`.
10. **Enumerate every cluster — no shortcuts (CRITICAL)** — The user-facing
   Strategies tab on the Reports page renders one accordion entry per
   unit in `stage3_data`, with N strategies inside each. The AI report's
   Section 4 is the prose mirror of that tab and MUST contain the same
   number of strategy entries. If `stage3_data` has 8 units with 3
   strategies each, Section 4 contains 24 strategy entries, organized
   into 8 subsections (4.1, 4.2, … 4.8). Do not collapse, summarize, or
   "follow same as above" any unit. The user comparing the report against
   the Strategies tab will catch any missing units immediately. Length
   budget: target ~180–260 words per strategy entry (the
   Location / Intervention / Signature / Pathway / Expected effects /
   Tradeoffs / Implementation / Supporting IOMs / Diagnosed-by skeleton
   is dense — keeping every bullet present is more important than
   keeping the entry short).
11. **Uniform Strategy skeleton (CRITICAL)** — The 9-bullet skeleton in
   4.X.2 above is the SAME for every project mode and every strategy.
   In particular: do NOT emit a richer block for single-zone single-
   spatial-unit projects and a leaner block for cluster-mode projects.
   If a stage3 field is empty, print "—" so the reader can see the gap;
   never silently omit a bullet. The skeleton's bullet order, labels,
   and italic emphasis are part of the contract — the report is read
   side-by-side with the Strategies tab, so the labels must match
   ("Location", "Intervention", "Signature", "Pathway", "Expected
   effects", "Tradeoffs", "Implementation guidance", "Supporting IOMs",
   "Diagnosed by").
"""


# ---------------------------------------------------------------------------
# Report Service
# ---------------------------------------------------------------------------

class ReportService:
    """Agent C: comprehensive report synthesis across Stages 1-3."""

    def __init__(self, knowledge_base: KnowledgeBase, llm_client: LLMClient):
        self.kb = knowledge_base
        self.llm = llm_client

    async def generate_report(self, request: ReportRequest) -> ReportResult:
        """Generate comprehensive evidence-based design strategy report."""
        t0 = time.time()

        # Pre-flight: warn the LLM up front when single-zone analysis has yielded
        # all-zero deviations (image-level fallback active but no within-zone
        # variance to discuss). The flag is later embedded in stage2_data so the
        # prompt can surface it as a caveat in Section 6 instead of returning
        # generic boilerplate.
        za = request.zone_analysis
        # v6.2 — honor the requested view. The zone-view payload can carry
        # segment_diagnostics (clustering persists the archetypes at the top
        # level of zone_analysis_result for chart rendering). Drop it unless
        # this request is for a cluster-derived view so the Stage 2 prompt
        # summary lists the user's real zones, not the cluster archetypes.
        if request.grouping_mode != "clusters" and za.segment_diagnostics:
            za = za.model_copy(update={"segment_diagnostics": None})
        is_image_level = (za.analysis_mode or "zone_level") == "image_level"
        all_zero_deviation = bool(
            za.zone_diagnostics
            and all(d.mean_abs_z == 0 for d in za.zone_diagnostics)
        )

        # Prepare compact data summaries
        project_context = json.dumps(
            request.project_context.model_dump(), ensure_ascii=False, indent=2
        )
        stage1_data = self._prepare_stage1(request.stage1_recommendations)
        stage2_data = self._prepare_stage2(
            za, request.stage1_recommendations
        )
        stage3_data = self._prepare_stage3(request.design_strategies)
        encoding_ref = json.dumps(
            self.kb.get_codebook_subset(max_chars=20000), ensure_ascii=False, indent=2
        )

        # Build final prompt
        prompt = REPORT_PROMPT.format(
            project_context=project_context,
            stage1_data=stage1_data,
            stage2_data=stage2_data,
            stage3_data=stage3_data,
            encoding_ref=encoding_ref,
        )

        logger.info("Agent C: report prompt ~%d chars (~%d tokens)", len(prompt), len(prompt) // 4)

        # Call LLM
        report_text = await self.llm.generate(prompt)
        elapsed = time.time() - t0

        # v4 / Module 13 — capture truncation flag from the LLM client. This
        # is set as a side-effect of the generate() call (see LLMClient
        # docstring). When the response was truncated by the output-token
        # cap, we surface it in the metadata so the frontend can render an
        # "incomplete report" warning + an upgrade suggestion.
        truncated = bool(getattr(self.llm, "last_truncated", False))
        finish_reason = getattr(self.llm, "last_finish_reason", None)
        output_tokens = getattr(self.llm, "last_output_tokens", None)
        current_model = getattr(self.llm, "model", "") or ""
        if truncated:
            recommended_model, rationale = suggest_model_upgrade(current_model)
            truncation_warning = {
                "truncated": True,
                "finish_reason": finish_reason,
                "output_tokens": output_tokens,
                "current_model": current_model,
                "recommended_model": recommended_model,
                "rationale": rationale,
                "user_message": (
                    f"The AI report was cut off because it hit the output-token "
                    f"cap of the current model ({current_model}). The trailing "
                    f"sections (typically later clusters in Section 4) are "
                    f"missing or incomplete. "
                    + (
                        f"Switch to {recommended_model} — {rationale} Then "
                        f"regenerate the report."
                        if recommended_model
                        else rationale
                    )
                ),
            }
            logger.warning(
                "Agent C: report truncated by output-token cap (model=%s, "
                "finish_reason=%s, output_tokens=%s)",
                current_model, finish_reason, output_tokens,
            )
        else:
            truncation_warning = None

        # Quality metrics
        coded_refs = re.findall(r'\([A-Z]{2,5}_[A-Za-z0-9_]+\)', report_text)
        sections = re.findall(r'^#{1,3} ', report_text, re.MULTILINE)
        chain_refs = report_text.count('->')

        metadata = {
            "version": "6.0",
            "generated_at": datetime.now().isoformat(),
            "model": current_model or "current",
            "elapsed_seconds": round(elapsed, 1),
            "word_count": len(report_text.split()),
            "char_count": len(report_text),
            "coded_references": len(coded_refs),
            "unique_references": len(set(coded_refs)),
            "section_count": len(sections),
            "chain_reasoning_count": chain_refs,
            "analysis_mode": za.analysis_mode or "zone_level",
            "data_quality_warning": (
                "Single-zone analysis returned no cross-zone variance — "
                "add a second zone or run sub-zone clustering for richer diagnostics."
                if is_image_level and all_zero_deviation else None
            ),
            # v4 / Module 13 — present only when truncation was actually
            # detected. Frontend reads this and renders an orange Alert card
            # with the recommended model.
            "truncation_warning": truncation_warning,
            "sections_present": {
                "executive_summary": "Executive Summary" in report_text or "## 1" in report_text,
                "indicator_selection": "Indicator Selection" in report_text or "## 2" in report_text,
                "spatial_diagnosis": "Spatial Diagnosis" in report_text or "## 3" in report_text,
                "design_strategies": "Design Strategies" in report_text or "## 4" in report_text,
                "implementation": "Implementation" in report_text or "## 5" in report_text,
                "limitations": "Limitation" in report_text or "## 6" in report_text,
            },
        }

        logger.info(
            "Agent C: report generated — %d words, %d refs, %.1fs",
            metadata["word_count"], metadata["coded_references"], elapsed,
        )

        return ReportResult(
            content=report_text,
            format=request.format,
            metadata=metadata,
        )

    # ------------------------------------------------------------------
    # Data preparation helpers
    # ------------------------------------------------------------------

    def _prepare_stage1(self, recommendations: Optional[list[dict]]) -> str:
        """Compact Stage 1 indicator recommendations for prompt.

        v2.0 (6.B(2)): expanded with rationale fields the report prompt's
        Section 2 needs to answer the four questions:
          1. Why these N indicators?
          2. Which alternatives were considered and why rejected?
          3. How strong is the evidence (tier distribution)?
          4. Is transferability matched?
        """
        if not recommendations:
            return "Stage 1 results not available."

        compact = []
        for rec in recommendations[:15]:
            evidence_summary = rec.get("evidence_summary") or {}
            transfer_summary = rec.get("transferability_summary") or {}

            evidence_ids = (
                rec.get("evidence_ids")
                or evidence_summary.get("supporting_evidence_ids")
                or []
            )
            tier_dist = (
                rec.get("evidence_tier_distribution")
                or evidence_summary.get("tier_distribution")
                or {}
            )
            considered = rec.get("considered_alternatives") or []
            framework_brief = rec.get("framework_mapping_brief") or rec.get(
                "framework_mapping", ""
            )
            transfer_pct = (
                rec.get("transferability_match_pct")
                if rec.get("transferability_match_pct") is not None
                else transfer_summary.get("match_pct")
            )

            compact.append({
                "rank": rec.get("rank"),
                "indicator_id": rec.get("indicator_id", rec.get("indicator", {}).get("id", "")),
                "indicator_name": rec.get("indicator_name", rec.get("indicator", {}).get("name", "")),
                "performance_link": rec.get("performance_link", {}),
                "evidence_summary": evidence_summary,
                # 6.B(2) — explicit rationale fields
                "evidence_ids": evidence_ids[:8],
                "evidence_tier_distribution": tier_dist,
                "considered_alternatives": considered[:6],
                "framework_mapping_brief": framework_brief,
                "transferability_match_pct": transfer_pct,
                "transferability_summary": transfer_summary,
                "target_direction": rec.get("target_direction", {}),
                "rationale": (rec.get("rationale", "") or "")[:300],
            })
        return json.dumps(compact, ensure_ascii=False, indent=2)

    def _prepare_stage2(
        self,
        zone_analysis: ZoneAnalysisResult,
        recommendations: Optional[list[dict]] = None,
    ) -> str:
        """Compact Stage 2 zone analysis for prompt (v6.0 descriptive)."""
        meta = zone_analysis.computation_metadata
        summary: dict = {
            "version": "v6.0-descriptive",
            "has_clustering": meta.has_clustering if meta else False,
            "n_indicators": meta.n_indicators if meta else 0,
            "n_zones": meta.n_zones if meta else 0,
            "n_segments": meta.n_segments if meta else 0,
        }

        # Indicator definitions (compact)
        ind_defs = {}
        for ind_id, d in (zone_analysis.indicator_definitions or {}).items():
            ind_defs[ind_id] = {
                "name": d.name,
                "target_direction": d.target_direction,
                "unit": d.unit,
            }
        summary["indicator_definitions"] = ind_defs

        # Diagnosis units (v6.0: descriptive only — no status/problems)
        units = zone_analysis.segment_diagnostics or zone_analysis.zone_diagnostics or []
        summary["diagnosis_units"] = []
        for u in units:
            unit_data = {
                "id": u.zone_id,
                "name": u.zone_name,
                "mean_abs_z": round(u.mean_abs_z, 2) if u.mean_abs_z else 0,
                "rank": u.rank,
                "point_count": u.point_count,
                "indicator_status": {},
            }
            for ind_id, data in (u.indicator_status or {}).items():
                if isinstance(data, dict):
                    full = data.get("full", data)
                    unit_data["indicator_status"][ind_id] = {
                        "value": full.get("value", full.get("mean")),
                        "z_score": full.get("z_score"),
                        "target_direction": full.get("target_direction", ""),
                    }
            summary["diagnosis_units"].append(unit_data)

        # Clustering info
        if zone_analysis.clustering:
            c = zone_analysis.clustering
            summary["clustering"] = {
                "k": c.k,
                "silhouette_score": c.silhouette_score,
                "archetypes": [
                    {
                        "id": a.archetype_id,
                        "label": a.archetype_label,
                        "point_count": a.point_count,
                        "centroid_z_scores": a.centroid_z_scores,
                    }
                    for a in (c.archetype_profiles or [])
                ],
            }

        # Layer statistics (compact). Both Mean and Std can legitimately be
        # None (e.g. single-zone projects where some indicators have zero
        # variance and the analyser can't compute Std). dict.get() falls back
        # to 0 only when the key is missing, NOT when it's explicitly None,
        # so we have to coerce here or round() blows up with TypeError.
        def _round_or_zero(v: object, digits: int = 4) -> float:
            if v is None or isinstance(v, bool):
                return 0.0
            try:
                return round(float(v), digits)
            except (TypeError, ValueError):
                return 0.0

        if zone_analysis.layer_statistics:
            ls_compact = {}
            for ind_id, stats in zone_analysis.layer_statistics.items():
                ls_compact[ind_id] = {
                    layer: {
                        "Mean": _round_or_zero(s.get("Mean"), 4),
                        "Std": _round_or_zero(s.get("Std"), 4),
                    }
                    for layer, s in stats.items()
                    if isinstance(s, dict) and "Mean" in s
                }
            summary["layer_statistics"] = ls_compact

        # v7.0 global indicator statistics (CV, normality, layer comparison)
        if zone_analysis.global_indicator_stats:
            summary["global_indicator_stats"] = [
                {
                    "indicator_id": s.indicator_id,
                    "cv_full_pct": s.cv_full,
                    "shapiro_p": s.shapiro_p,
                    "is_normal": s.shapiro_p > 0.05 if s.shapiro_p is not None else None,
                    "kruskal_p": s.kruskal_p,
                    "layers_differ": s.kruskal_p < 0.05 if s.kruskal_p is not None else None,
                }
                for s in zone_analysis.global_indicator_stats
            ]

        # v7.0 analysis mode
        summary["analysis_mode"] = zone_analysis.analysis_mode or "zone_level"
        summary["zone_source"] = zone_analysis.zone_source

        # 6.B(3) — explicit data quality flags fed into Agent C §6
        summary["data_quality_flags"] = self._compute_data_quality_flags(
            zone_analysis, recommendations
        )

        # v4 / Module 11.2.2 — single-zone enrichment.
        # When the project has only one grouping unit, attach an image-level
        # descriptive-statistics block per indicator × layer so Agent C has
        # something to write Section 3.2 against (cross-zone z-scores are
        # mathematically undefined and would give the LLM nothing to discuss).
        flags = summary["data_quality_flags"]
        if flags.get("is_single_zone"):
            summary["image_distribution_summary"] = self._compute_image_distribution_summary(
                zone_analysis,
            )
            summary["analysis_basis"] = "image-level descriptive (single-zone fallback)"

        # Significant correlations
        sig_pairs = []
        corr = zone_analysis.correlation_by_layer or {}
        pval = zone_analysis.pvalue_by_layer or {}
        if "full" in corr:
            corr_full = corr["full"]
            pval_full = pval.get("full", {})
            for ind1 in corr_full:
                for ind2 in corr_full.get(ind1, {}):
                    if ind1 < ind2:
                        r = corr_full[ind1].get(ind2)
                        p = pval_full.get(ind1, {}).get(ind2, 1.0)
                        if r is not None and abs(r) > 0.3:
                            sig_pairs.append({
                                "pair": f"{ind1} <-> {ind2}",
                                "r": round(r, 3),
                                "p": round(p, 4) if isinstance(p, (int, float)) else p,
                            })
            summary["significant_correlations"] = sorted(sig_pairs, key=lambda x: -abs(x["r"]))

        return json.dumps(summary, ensure_ascii=False, indent=2)

    @staticmethod
    def _compute_image_distribution_summary(
        zone_analysis: ZoneAnalysisResult,
    ) -> dict:
        """v4 / Module 11.2.2 — per-indicator × per-layer image-level
        five-number summary (N, mean, std, CV, min, Q1, median, Q3, max).
        Used as fallback diagnostic material when n_zones <= 1 (single-zone
        projects), where cross-zone z-scores are undefined."""
        summary: dict = {}
        records = getattr(zone_analysis, "image_records", None) or []
        if not records:
            return summary
        # Group by (indicator_id, layer)
        from collections import defaultdict
        buckets: dict = defaultdict(list)
        for r in records:
            ind = getattr(r, "indicator_id", None)
            layer = getattr(r, "layer", None)
            value = getattr(r, "value", None)
            if ind is None or layer is None or value is None:
                continue
            buckets[(ind, layer)].append(float(value))
        for (ind, layer), vals in buckets.items():
            if not vals:
                continue
            vals_sorted = sorted(vals)
            n = len(vals_sorted)
            mean = sum(vals_sorted) / n
            variance = sum((v - mean) ** 2 for v in vals_sorted) / n if n > 0 else 0.0
            std = variance ** 0.5
            def quantile(p: float) -> float:
                idx = p * (n - 1)
                lo = int(idx)
                hi = min(n - 1, lo + 1)
                if lo == hi:
                    return vals_sorted[lo]
                f = idx - lo
                return vals_sorted[lo] * (1 - f) + vals_sorted[hi] * f
            cv = (std / abs(mean) * 100.0) if mean else 0.0
            ind_summary = summary.setdefault(ind, {})
            ind_summary[layer] = {
                "N": n,
                "mean": round(mean, 4),
                "std": round(std, 4),
                "cv_pct": round(cv, 2),
                "min": round(vals_sorted[0], 4),
                "q1": round(quantile(0.25), 4),
                "median": round(quantile(0.5), 4),
                "q3": round(quantile(0.75), 4),
                "max": round(vals_sorted[-1], 4),
            }
        return summary

    @staticmethod
    def _compute_data_quality_flags(
        zone_analysis: ZoneAnalysisResult,
        recommendations: Optional[list[dict]] = None,
    ) -> dict:
        """Surface explicit quality signals so Agent C §6 can discuss them.

        Flags exposed to the prompt:
          - is_single_zone (n_zones <= 1)
          - n_zones, analysis_mode
          - indicators_with_nan (ids of indicators missing valid means)
          - layer_coverage_pct (mean FG/MG/BG coverage)
          - low_confidence_evidence_ratio (share of recommendations whose
            supporting evidence is dominated by descriptive/Tier-3 records)
          - low_transferability_indicators (indicators whose evidence pool's
            climate/setting/age coverage is mostly low-or-unknown for this
            project — replaces the doc's per-zone framing because zone context
            in this data model is project-level, not per-zone)
        """
        flags: dict = {
            "is_single_zone": False,
            "n_zones": 0,
            "indicators_with_nan": [],
            "layer_coverage_pct": None,
            "low_confidence_evidence_ratio": None,
            "low_transferability_indicators": [],
        }

        meta = zone_analysis.computation_metadata
        n_zones = meta.n_zones if meta else 0
        flags["n_zones"] = n_zones
        flags["is_single_zone"] = n_zones <= 1
        flags["analysis_mode"] = zone_analysis.analysis_mode or "zone_level"

        # Indicators with NaN means in the full layer
        nan_indicators: list[str] = []
        for s in zone_analysis.global_indicator_stats or []:
            full = (s.by_layer or {}).get("full", {}) if hasattr(s, "by_layer") else {}
            mean_val = full.get("Mean") if isinstance(full, dict) else None
            n_val = full.get("N") if isinstance(full, dict) else None
            if mean_val is None or n_val in (None, 0):
                nan_indicators.append(s.indicator_id)
        flags["indicators_with_nan"] = nan_indicators

        # Mean FG/MG/BG coverage across indicators
        if zone_analysis.data_quality:
            coverages: list[float] = []
            for row in zone_analysis.data_quality:
                fg = getattr(row, "fg_coverage_pct", None) or 0.0
                mg = getattr(row, "mg_coverage_pct", None) or 0.0
                bg = getattr(row, "bg_coverage_pct", None) or 0.0
                coverages.append((fg + mg + bg) / 3.0)
            if coverages:
                flags["layer_coverage_pct"] = round(sum(coverages) / len(coverages), 1)

        # Recommendation-derived flags
        if recommendations:
            low_conf = 0
            low_transfer: list[str] = []
            counted = 0
            for rec in recommendations:
                ev = rec.get("evidence_summary") or {}
                ts = rec.get("transferability_summary") or {}
                ind_id = rec.get("indicator_id") or rec.get("indicator", {}).get("id", "")

                inf = ev.get("inferential_count", 0) or 0
                desc = ev.get("descriptive_count", 0) or 0
                strongest = (ev.get("strongest_tier") or "").upper()
                # Low-confidence indicator: no inferential records, OR best tier
                # is the weakest, OR descriptive evidence outweighs inferential
                is_low_conf = (
                    inf == 0
                    or strongest in ("TIR_T3", "TIR_C", "")
                    or (desc > 0 and desc >= inf * 2)
                )
                if inf or desc:
                    counted += 1
                    if is_low_conf:
                        low_conf += 1

                hi = ts.get("high_count", 0) or 0
                mod = ts.get("moderate_count", 0) or 0
                lo = ts.get("low_count", 0) or 0
                unk = ts.get("unknown_count", 0) or 0
                # Low-transferability indicator: weak/unknown evidence outnumbers
                # the high+moderate-transferability evidence
                if (lo + unk) > (hi + mod) and ind_id:
                    low_transfer.append(ind_id)

            if counted:
                flags["low_confidence_evidence_ratio"] = round(low_conf / counted, 2)
            flags["low_transferability_indicators"] = low_transfer

        return flags

    def _prepare_stage3(self, design_result: Optional[DesignStrategyResult]) -> str:
        """Compact Stage 3 design strategies for prompt (v6.0)."""
        if not design_result:
            return "Stage 3 results not available."

        summary = {}
        for uid, zone in design_result.zones.items():
            unit_data = {
                "unit_name": zone.zone_name,
                "mean_abs_z": zone.mean_abs_z,
                "diagnosis": zone.diagnosis,
                "overall_assessment": zone.overall_assessment,
                "n_iom_matches": len(zone.matched_ioms),
                "top_ioms": [],
                "design_strategies": [],
            }
            # Top 5 IOMs
            for m in zone.matched_ioms[:5]:
                unit_data["top_ioms"].append({
                    "iom_id": m.iom_id,
                    "indicator": m.indicator_id,
                    "direction": m.direction,
                    "score": m.score,
                    "operation_description": m.operation.get("description", "")[:200],
                    "confidence": m.confidence_expanded.get("grade", ""),
                    "transferability": m.transferability.get("overall", "unknown"),
                    "is_descriptive": m.is_descriptive,
                    "signatures": [
                        {
                            "sig_id": s.get("sig_id", ""),
                            "operation": s.get("operation", {}).get("id", ""),
                            "semantic": s.get("semantic_layer", {}).get("id", ""),
                            "spatial": s.get("spatial_layer", {}).get("id", ""),
                            "morphological": s.get("morphological_layer", {}).get("id", ""),
                        }
                        for s in m.signatures[:3]
                    ],
                })
            # All strategies. EVERY field the Design Strategies tab shows
            # on screen is included here so Section 4 of the report can
            # match the tab's granularity 1:1 — same Location / Intervention
            # (Object × Variable × Action) / Signatures / Pathway / Expected
            # Effects / Tradeoffs / Implementation Guidance / Supporting IOMs.
            for s in zone.design_strategies:
                unit_data["design_strategies"].append({
                    "priority": s.priority,
                    "strategy_name": s.strategy_name,
                    "target_indicators": s.target_indicators,
                    # Location + Intervention — the platform Design Strategies
                    # card surfaces these explicitly (Location: Background /
                    # Object: Built Structure / Variable: Shape / Action: Modify).
                    "spatial_location": s.spatial_location,
                    "intervention": s.intervention,
                    "signatures": s.signatures[:3],
                    "pathway": s.pathway,
                    # Grade / confidence chip ("GRADE A - STRONG" in the UI).
                    "confidence": s.confidence,
                    # Tradeoffs (rendered as a yellow caution row in the UI)
                    # and transferability — both must flow into the report
                    # so a reviewer reading the prose sees the same caveats
                    # that someone clicking through the Strategies tab does.
                    "potential_tradeoffs": s.potential_tradeoffs,
                    "transferability_note": s.transferability_note,
                    "boundary_effects": s.boundary_effects,
                    "expected_effects": s.expected_effects,
                    "supporting_ioms": s.supporting_ioms,
                    "implementation_guidance": s.implementation_guidance,
                })
            summary[uid] = unit_data

        return json.dumps(summary, ensure_ascii=False, indent=2)
