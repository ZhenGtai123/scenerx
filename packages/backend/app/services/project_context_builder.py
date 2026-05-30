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
    for r in relations:
        fz = r.get("from_zone")
        tz = r.get("to_zone")
        rtype = r.get("relation_type", "?")
        direction = r.get("direction", "single")
        arrow = "<->" if direction == "bidirectional" else "->"
        lines.append(
            f"- {name_by_id.get(fz, fz)} {arrow} {name_by_id.get(tz, tz)}  ({rtype})"
        )
    lines.append(
        "Interpretive rule: when reasoning across zones, treat 'adjacent / nearby / "
        "connected' edges as permission for correlation claims; 'contains' as a "
        "parent-child hierarchy; 'distant' as an explicit exclusion that should "
        "block spurious spatial-pattern conclusions."
    )
    return "\n".join(lines)


def build_project_header(
    project_context: ProjectContext,
    *,
    include_target_dimensions: bool = False,
    brief_max_chars: int = 500,
) -> str:
    """Render the canonical Project section used at the top of LLM prompts.

    `include_target_dimensions` adds the "Target dimensions" row (Agent A
    needs it for direction inference; Agent B does not).

    When a zone-to-zone relation graph is present on the project context
    (v6.x), a "Zone-to-Zone Relations" block is appended so Agent A reads
    it as an interpretive constraint on cross-zone claims.
    """
    name = project_context.project.get("name", "N/A")
    climate = project_context.context.get("climate", {}).get("koppen_zone_id", "N/A")
    setting = project_context.context.get("urban_form", {}).get("space_type_id", "N/A")
    brief = (project_context.performance_query.get("design_brief", "") or "")[:brief_max_chars]

    lines = [
        "## Project",
        f"- Name: {name}",
        f"- Climate: {climate}",
        f"- Setting: {setting}",
        f"- Design brief: {brief}",
    ]
    if include_target_dimensions:
        dims = project_context.performance_query.get("dimensions", [])
        lines.append(f"- Target dimensions: {json.dumps(dims)}")

    graph_block = _render_zone_graph(project_context)
    if graph_block:
        lines.append("")
        lines.append(graph_block)
    return "\n".join(lines)
