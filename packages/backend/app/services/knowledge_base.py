"""
Knowledge Base Service
Manages evidence-based indicator matching data
"""

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class KnowledgeBase:
    """Knowledge base for evidence-based indicator recommendation"""

    def __init__(self, knowledge_base_dir: str, filenames: dict[str, str] | None = None):
        self.knowledge_base_dir = Path(knowledge_base_dir)
        self.filenames = filenames or {}

        # Data stores
        self.evidence: list[dict] = []
        self.appendix: dict = {}
        self.context: dict = {}
        self.iom: list[dict] = []  # Intervention-Outcome Mapping

        # Indexes for fast lookup
        self._evidence_by_indicator: dict[str, list[dict]] = {}
        self._evidence_by_dimension: dict[str, list[dict]] = {}
        self._evidence_by_subdimension: dict[str, list[dict]] = {}
        self._evidence_by_id: dict[str, dict] = {}
        self._context_by_evidence: dict[str, dict] = {}

        self.loaded = False

    def load(self) -> bool:
        """Load all knowledge base files"""
        try:
            if not self.knowledge_base_dir.exists():
                logger.warning(f"Knowledge base directory not found: {self.knowledge_base_dir}")
                return False

            # Load each knowledge base file (configurable names, with warning on miss)
            file_map = {
                "evidence": self.filenames.get("evidence", "Evidence_final_v5_2_fixed.json"),
                "appendix": self.filenames.get("appendix", "Appendix_final_v5_2_fixed.json"),
                "context":  self.filenames.get("context",  "Context_final_v5_2_fixed.json"),
                "iom":      self.filenames.get("iom",      "IOM_final_v5_2_fixed.json"),
            }

            for key, filename in file_map.items():
                path = self.knowledge_base_dir / filename
                if not path.exists():
                    logger.warning(f"Knowledge base file not found: {path}")
                    continue
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                setattr(self, key, data)
                count = len(data) if isinstance(data, list) else len(data.keys()) if isinstance(data, dict) else 0
                logger.info(f"Loaded {key} ({count} entries) from {filename}")

            # Build indexes
            self._build_indexes()
            self.loaded = True
            return True

        except Exception as e:
            logger.error(f"Failed to load knowledge base: {e}")
            return False

    def _build_indexes(self) -> None:
        """Build indexes for fast lookup"""
        self._evidence_by_indicator = {}
        self._evidence_by_dimension = {}
        self._evidence_by_subdimension = {}
        self._evidence_by_id = {}
        self._context_by_evidence = {}

        for record in self.evidence:
            evidence_id = record.get('evidence_id', '')
            if evidence_id:
                self._evidence_by_id[evidence_id] = record

            indicator = record.get('indicator', {})
            indicator_id = indicator.get('indicator_id', '')
            if indicator_id:
                self._evidence_by_indicator.setdefault(indicator_id, []).append(record)

            performance = record.get('performance', {})
            dimension_id = performance.get('dimension_id', '')
            if dimension_id:
                self._evidence_by_dimension.setdefault(dimension_id, []).append(record)

            subdimension_id = performance.get('subdimension_id', '')
            if subdimension_id and subdimension_id not in ('PRS_NA', ''):
                self._evidence_by_subdimension.setdefault(subdimension_id, []).append(record)

        # Build context → evidence mapping
        #
        # Data shape (current files):
        #   Transferability_Context.json's `linked_records` point to IOM
        #   operation IDs (e.g. "I_SVCs_Zhao2024_1"), NOT directly to
        #   evidence IDs. The evidence linkage lives in
        #   I_SVCs_Operations.json where each record carries iom_id +
        #   linked_evidence_id, so going from a context to its applicable
        #   evidence requires a two-hop join:
        #
        #     context.linked_records  →  iom.iom_id  →  iom.linked_evidence_id
        #                                                       │
        #                                                       ▼
        #                                              evidence.evidence_id
        #
        # The original implementation expected `linked_records` to already
        # be evidence IDs (filtered on the `SVCs_P_` prefix) and therefore
        # built an empty `_context_by_evidence` dict for the current
        # dataset — which made `compute_transferability` return
        # overall="unknown" for every evidence record and produced
        # "0H / 0M / 0L" badges across the entire recommendation list.
        #
        # The direct-linkage branch is kept as a fall-through so older KB
        # dumps that inlined evidence IDs into `linked_records` continue to
        # work.
        iom_list = self.iom if isinstance(self.iom, list) else []
        iom_id_to_evidence_id: dict[str, str] = {}
        for op in iom_list:
            if not isinstance(op, dict):
                continue
            iom_id = op.get('iom_id', '')
            evd_id = op.get('linked_evidence_id', '')
            if iom_id and evd_id:
                iom_id_to_evidence_id[iom_id] = evd_id

        contexts = self.context if isinstance(self.context, list) else []
        ctx_links_resolved = 0
        for ctx in contexts:
            for rid in ctx.get('linked_records', []):
                if not isinstance(rid, str):
                    continue
                if rid.startswith('SVCs_P_'):
                    # Legacy/inline form — the linked record IS an evidence ID.
                    self._context_by_evidence[rid] = ctx
                    ctx_links_resolved += 1
                elif rid.startswith('I_SVCs_'):
                    # Current form — two-hop through IOM to resolve the
                    # evidence ID this context actually applies to.
                    evd_id = iom_id_to_evidence_id.get(rid)
                    if evd_id:
                        self._context_by_evidence[evd_id] = ctx
                        ctx_links_resolved += 1
        if contexts and not self._context_by_evidence:
            # Surface the failure loudly — without this the symptom is
            # silent and only shows up as "0H/0M/0L" badges in the UI.
            logger.warning(
                "KnowledgeBase: loaded %d contexts but none could be linked "
                "to evidence (iom_records=%d). Transferability will be "
                "'unknown' for every recommendation.",
                len(contexts), len(iom_list),
            )
        else:
            logger.info(
                "KnowledgeBase: linked %d context↔evidence pairs "
                "(via %d IOM records)",
                ctx_links_resolved, len(iom_list),
            )

    def get_evidence_by_id(self, evidence_id: str) -> dict | None:
        """Get a single evidence record by its ID (O(1) lookup)."""
        return self._evidence_by_id.get(evidence_id)

    def get_evidence_for_indicator(self, indicator_id: str) -> list[dict]:
        """Get all evidence records for an indicator"""
        return self._evidence_by_indicator.get(indicator_id, [])

    def get_evidence_for_dimension(self, dimension_id: str) -> list[dict]:
        """Get all evidence records for a performance dimension"""
        return self._evidence_by_dimension.get(dimension_id, [])

    def get_evidence_for_dimensions(self, dimension_ids: list[str]) -> list[dict]:
        """Get evidence records for multiple dimensions"""
        results = []
        seen_ids = set()
        for dim_id in dimension_ids:
            for record in self._evidence_by_dimension.get(dim_id, []):
                evidence_id = record.get('evidence_id', '')
                if evidence_id and evidence_id not in seen_ids:
                    results.append(record)
                    seen_ids.add(evidence_id)
        return results

    def retrieve_evidence(
        self,
        dimensions: list[str],
        subdimensions: list[str] | None = None,
    ) -> list[dict]:
        """Retrieve all evidence for target dimensions + subdimensions (no cap)."""
        evds, seen = [], set()
        for d in dimensions:
            for e in self._evidence_by_dimension.get(d, []):
                eid = e['evidence_id']
                if eid not in seen:
                    seen.add(eid)
                    evds.append(e)
        if subdimensions:
            for sd in subdimensions:
                for e in self._evidence_by_subdimension.get(sd, []):
                    eid = e['evidence_id']
                    if eid not in seen:
                        seen.add(eid)
                        evds.append(e)
        return evds

    @property
    def context_by_evidence(self) -> dict[str, dict]:
        return self._context_by_evidence

    _CODEBOOK_PRIORITY = [
        'A_indicators', 'A_categories',
        'C_performance', 'C_subdimensions', 'C_outcome_types', 'C_theories',
        'D_directions', 'D_significance', 'D_relationships',
        'D_effect_size_types', 'D_stat_tests',
        'B_methods', 'B_units', 'B_data_sources', 'B_tools',
        'E_study_design', 'E_sample_units', 'E_settings', 'E_countries',
        'K_climate', 'L_lcz', 'M_age_groups',
        'F_quality',
        'Z_semantic_layers', 'Z_spatial_layers', 'Z_morphological_attributes',
        'G_pathways', 'H_subtypes',
    ]

    def get_codebook_subset(self, max_chars: int = 40000) -> dict:
        """Extract a prompt-sized subset of the Encoding Dictionary."""
        out: dict = {}
        sz = 0
        for name in self._CODEBOOK_PRIORITY:
            table = self.appendix.get(name)
            if not table or not isinstance(table, dict):
                continue
            simplified = {}
            for code, entry in table.items():
                if not isinstance(entry, dict):
                    continue
                item: dict = {
                    "name": entry.get("name", code),
                    "definition": (entry.get("definition") or "")[:200],
                }
                if name == "A_indicators":
                    if entry.get("formula"):
                        item["formula"] = entry["formula"][:150]
                    if entry.get("category"):
                        item["category"] = entry["category"]
                simplified[code] = item
            chunk = len(json.dumps(simplified, ensure_ascii=False))
            if sz + chunk < max_chars:
                out[name] = simplified
                sz += chunk
        return out

    # Tables the LLM always needs for ranking / code expansion
    _ESSENTIAL_TABLES = {
        'A_indicators', 'A_categories',
        'C_performance', 'C_subdimensions',
        'D_directions', 'D_significance',
        'F_quality',
    }
    # Project-profile field → codebook table mapping
    _PROJECT_TABLES = {
        'koppen_zone_id': 'K_climate',
        'lcz_type_id': 'L_lcz',
        'space_type_id': 'E_settings',
        'age_group_id': 'M_age_groups',
    }

    def get_codebook_for_cards(
        self,
        project_ctx: dict | None = None,
        max_chars: int = 40000,
    ) -> dict:
        """Pruned codebook: only tables the LLM actually needs.

        Always includes essential tables (indicator defs, dimensions, directions,
        significance, quality tiers, categories).  Adds project-profile tables
        only when the corresponding field is set.  Skips everything else
        (B_methods, B_units, E_countries, D_stat_tests, …) to cut ~60 % tokens.
        """
        needed = set(self._ESSENTIAL_TABLES)
        if project_ctx:
            for field, table in self._PROJECT_TABLES.items():
                if project_ctx.get(field):
                    needed.add(table)

        out: dict = {}
        sz = 0
        # Iterate in priority order so the most important tables come first
        for name in self._CODEBOOK_PRIORITY:
            if name not in needed:
                continue
            table = self.appendix.get(name)
            if not table or not isinstance(table, dict):
                continue
            simplified = {}
            for code, entry in table.items():
                if not isinstance(entry, dict):
                    continue
                item: dict = {
                    "name": entry.get("name", code),
                    "definition": (entry.get("definition") or "")[:200],
                }
                if name == "A_indicators":
                    if entry.get("formula"):
                        item["formula"] = entry["formula"][:150]
                    if entry.get("category"):
                        item["category"] = entry["category"]
                simplified[code] = item
            chunk = len(json.dumps(simplified, ensure_ascii=False))
            if sz + chunk < max_chars:
                out[name] = simplified
                sz += chunk
        return out

    def get_codebook_section(self, section: str) -> Optional[list[dict]]:
        """Get a section from the codebook/appendix"""
        return self.appendix.get(section)

    def get_indicator_definitions(self) -> list[dict]:
        """Get indicator definitions from codebook.

        Appendix stores A_indicators as a dict keyed by indicator id
        ({"IND_GVI": {...}, ...}). The id is injected into each record
        so callers don't lose it when flattened to a list.
        """
        raw = self.appendix.get('A_indicators', [])
        if isinstance(raw, dict):
            return [{"id": k, **v} for k, v in raw.items() if isinstance(v, dict)]
        return raw if isinstance(raw, list) else []

    def is_recommendable(self, indicator_id: str) -> bool:
        """Whether an indicator may be offered by the recommender.

        Single source of truth = the codebook (Encoding_Dictionary.json ->
        A_indicators) `status` field. No hardcoded id list lives in the
        recommender; eligibility follows the data:

          - present with status 'active' (or no `status` field at all, which
            defaults to active for backward compatibility) -> recommendable
          - present with any other status (e.g. 'future_development',
            'unsupported') -> excluded; kept as a future/manual indicator
          - absent from the codebook entirely (e.g. legacy/phantom ids like
            IND_GVI_ANG that linger in evidence but have no canonical
            definition) -> not recommendable

        Excluding here governs only the evidence-driven recommendation
        candidate pool; users may still select excluded indicators manually.
        """
        indicators = self.appendix.get('A_indicators', {}) if isinstance(self.appendix, dict) else {}
        entry = indicators.get(indicator_id) if isinstance(indicators, dict) else None
        if not isinstance(entry, dict):
            return False
        return str(entry.get('status', 'active')).strip().lower() == 'active'

    def get_performance_dimensions(self) -> list[dict]:
        """Get performance dimensions from codebook. See get_indicator_definitions for shape note."""
        raw = self.appendix.get('C_performance', [])
        if isinstance(raw, dict):
            return [{"id": k, **v} for k, v in raw.items() if isinstance(v, dict)]
        return raw if isinstance(raw, list) else []

    def get_subdimensions(self) -> list[dict]:
        """Get subdimensions from codebook. See get_indicator_definitions for shape note."""
        raw = self.appendix.get('C_subdimensions', [])
        if isinstance(raw, dict):
            return [{"id": k, **v} for k, v in raw.items() if isinstance(v, dict)]
        return raw if isinstance(raw, list) else []

    def query_evidence(
        self,
        dimension_ids: list[str] = None,
        subdimension_ids: list[str] = None,
        indicator_ids: list[str] = None,
        country_id: str = None,
        space_type_id: str = None,
        min_confidence: str = None,
    ) -> list[dict]:
        """Query evidence with multiple filters"""
        results = self.evidence

        if dimension_ids:
            results = [
                r for r in results
                if r.get('performance', {}).get('dimension_id', '') in dimension_ids
            ]

        if subdimension_ids:
            results = [
                r for r in results
                if r.get('performance', {}).get('subdimension_id', '') in subdimension_ids
            ]

        if indicator_ids:
            results = [
                r for r in results
                if r.get('indicator', {}).get('indicator_id', '') in indicator_ids
            ]

        if country_id:
            results = [
                r for r in results
                if r.get('study_design', {}).get('country_id', '') == country_id
            ]

        if space_type_id:
            results = [
                r for r in results
                if r.get('study_design', {}).get('setting_type_id', '') == space_type_id
            ]

        if min_confidence:
            confidence_rank = {'CON_LOW': 0, 'CON_MED': 1, 'CON_HIG': 2}
            min_rank = confidence_rank.get(min_confidence, 0)
            results = [
                r for r in results
                if confidence_rank.get(
                    r.get('quality', {}).get('confidence_grade_id', 'CON_LOW'), 0
                ) >= min_rank
            ]

        return results

    def get_summary(self) -> dict:
        """Get knowledge base summary"""
        return {
            'loaded': self.loaded,
            'total_evidence': len(self.evidence),
            'indicators_with_evidence': len(self._evidence_by_indicator),
            'dimensions_with_evidence': len(self._evidence_by_dimension),
            'appendix_sections': list(self.appendix.keys()) if self.appendix else [],
            'iom_records': len(self.iom),
        }
