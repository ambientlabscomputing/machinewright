"""Semantic golden-test helpers that avoid byte-level CAD comparisons."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, cast

import cadquery

from machinewright.assembly_graph import PartNode, resolve_assembly
from machinewright.canonical import canonical_value, content_digest
from machinewright.lib.bom import generate_structured_bom


def semantic_snapshot(assembly: cadquery.Assembly) -> dict[str, Any]:
    graph = resolve_assembly(assembly)
    parts = [node for node in graph.nodes if isinstance(node, PartNode)]
    return cast(
        dict[str, Any],
        canonical_value(
            {
                "part_count": len(parts),
                "geometry": [
                    {
                        "definition_id": node.definition_id,
                        "envelope_mm": node.geometry.envelope_mm,
                        "volume_mm3": node.geometry.volume_mm3,
                        "mass_g": node.geometry.mass_g,
                    }
                    for node in parts
                ],
                "interfaces": [
                    {"node_id": node.node_id, "interfaces": node.interfaces}
                    for node in parts
                ],
                "assembly_digest": graph.content_digest,
                "bom_digest": generate_structured_bom(graph).content_digest,
            }
        ),
    )


def assert_semantic_snapshot(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    if canonical_value(actual) != canonical_value(expected):
        raise AssertionError(f"semantic snapshot mismatch: {actual!r} != {expected!r}")


def assert_decimal_close(
    actual: Decimal, expected: Decimal, tolerance: Decimal
) -> None:
    if abs(actual - expected) > tolerance:
        raise AssertionError(
            f"{actual} differs from {expected} by more than {tolerance}"
        )


def semantic_digest(assembly: cadquery.Assembly) -> str:
    return content_digest(semantic_snapshot(assembly))
