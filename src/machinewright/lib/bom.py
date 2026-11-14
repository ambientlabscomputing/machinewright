"""Deterministic BOM projections from the resolved hardware graph."""

import csv
from decimal import Decimal
from pathlib import Path

from machinewright.canonical import canonical_json, content_digest
from machinewright.contracts import Contract
from machinewright.hardware_graph import PartNode, ResolvedHardwareGraph


class BOMLineV1(Contract):
    line_id: str
    definition_id: str
    definition_revision: str
    quantity: Decimal
    unit: str = "each"
    source_instances: tuple[str, ...]
    parameter_digest: str
    parameters: dict
    manufacturer_part: dict | None = None
    material: str | None = None
    # `lib.materials.Process` value of the part's material (PRINTED, PURCHASED, ...).
    material_process: str | None = None
    process: dict | None = None
    finishes: tuple[dict, ...] = ()
    inspections: tuple[dict, ...] = ()
    envelope_mm: tuple[Decimal, Decimal, Decimal]
    unit_volume_mm3: Decimal
    unit_mass_g: Decimal | None = None


class BOM(Contract):
    graph_digest: str
    lines: tuple[BOMLineV1, ...]

    @property
    def content_digest(self) -> str:
        return content_digest(self)


def generate_structured_bom(graph: ResolvedHardwareGraph) -> BOM:
    groups: dict[tuple[str, str, str], list[PartNode]] = {}
    for node in graph.nodes:
        if isinstance(node, PartNode):
            key = (node.definition_id, node.definition_revision, node.parameter_digest)
            groups.setdefault(key, []).append(node)
    lines: list[BOMLineV1] = []
    for key in sorted(groups):
        group = sorted(groups[key], key=lambda item: item.node_id)
        item = group[0]
        lines.append(
            BOMLineV1(
                line_id=content_digest(
                    {"definition": key[0], "revision": key[1], "parameters": key[2]}
                ),
                definition_id=item.definition_id,
                definition_revision=item.definition_revision,
                quantity=Decimal(len(group)),
                source_instances=tuple(node.node_id for node in group),
                parameter_digest=item.parameter_digest,
                parameters=item.parameters,
                manufacturer_part=(
                    item.manufacturer_part.model_dump(mode="json")
                    if item.manufacturer_part
                    else None
                ),
                material=item.material_name,
                material_process=item.material_process,
                process=item.process.model_dump(mode="json") if item.process else None,
                finishes=tuple(
                    value.model_dump(mode="json") for value in item.finishes
                ),
                inspections=tuple(
                    value.model_dump(mode="json") for value in item.inspections
                ),
                envelope_mm=item.geometry.envelope_mm,
                unit_volume_mm3=item.geometry.volume_mm3,
                unit_mass_g=item.geometry.mass_g,
            )
        )
    return BOM(graph_digest=graph.graph_digest, lines=tuple(lines))


def write_bom_json(graph: ResolvedHardwareGraph, location: str | Path) -> None:
    Path(location).write_text(
        canonical_json(generate_structured_bom(graph)) + "\n", encoding="utf-8"
    )


def write_bom_csv(graph: ResolvedHardwareGraph, location: str | Path) -> None:
    fields = (
        "definition_id",
        "definition_revision",
        "quantity",
        "unit",
        "material",
        "process",
        "envelope_mm",
        "unit_volume_mm3",
        "unit_mass_g",
        "parameters",
        "source_instances",
    )
    with Path(location).open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for line in generate_structured_bom(graph).lines:
            writer.writerow(
                {
                    "definition_id": line.definition_id,
                    "definition_revision": line.definition_revision,
                    "quantity": line.quantity,
                    "unit": line.unit,
                    "material": line.material or "",
                    "process": (line.process or {}).get("name", ""),
                    "envelope_mm": "x".join(str(value) for value in line.envelope_mm),
                    "unit_volume_mm3": line.unit_volume_mm3,
                    "unit_mass_g": line.unit_mass_g
                    if line.unit_mass_g is not None
                    else "",
                    "parameters": canonical_json(line.parameters),
                    "source_instances": ",".join(line.source_instances),
                }
            )
