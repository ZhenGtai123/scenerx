"""
Project context prompt builder.

Extracted from design_engine.py to give Stage 3 (Agent A diagnosis, Agent B
synthesis) and any future LLM caller a single, consistent way to render the
"## Project" header that grounds the prompt with project name, climate,
setting, and design brief.

The shape mirrors what the design engine was inlining at two call sites
before #20 — keep it that way unless every consumer changes together.
"""

from __future__ import annotations

import json
from typing import Optional

from app.models.analysis import ProjectContext


def _render_zone_graph(project_context: ProjectContext) -> Optional[str]:
    """Render the Stage 1 zone-to-zone relation graph as a prompt block.

    Returns None when no zones or no relations are declared (legacy
    independent-zone behaviour preserved). When present, the block is
    Agent A's authoritative source for how to interpret cross-zone
    correlations:
      - 'adjacent / nearby / connected'  → permission for cross-zone claims
      - 'contains'                       → parent-child hierarchy
      - 'distant'                        → explicit exclusion marker against
                                           spurious spatial-pattern claims
    """
    project_dict = project_context.project or {}
    zones = project_dict.get("spatial_zones") or []
    relations = project_dict.get("spatial_relations") or []
    if not zones or not relations:
        return None
    name_by_id = {z.get("zone_id"): (z.get("zone_name") or z.get("zone_id")) for z in zones}
    lines = ["## Zone-to-Zone Relations (Stage 1 declared graph)"]
    for r in relatio