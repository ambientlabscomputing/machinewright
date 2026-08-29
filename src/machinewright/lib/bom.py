"""
Bill-of-materials generation: walks an assembly's leaf parts, groups
identical ones into line items (quantity > 1 for repeated hardware), and
exports the result as CSV. Reads the part_class/part_params/material
metadata attach() (see lib/materials.py) already threads into the
assembly tree, so richer BOM data is "free" for any assembly built with
attach() -- no separate BOM-specific authoring step.
"""

import csv
from dataclasses import asdict, dataclass
from decimal import Decimal
from enum import Enum

import cadquery

from machinewright.assemblies.base import _walk_assembly
from machinewright.assembly_graph import PartNode, ResolvedAssembly, resolve_assembly
from machinewright.canonical import canonical_json, content_digest
from machinewright.contracts import Contract
from machinewright.lib.materials import Material

_ROUNDING = 4


@dataclass
class BomLine:
    part: str
    quantity: int
    material: str
    process: str
    length_mm: float
    width_mm: float
    height_mm: float
    unit_volume_mm3: float
    total_volume_mm3: float
    unit_mass_g: float | None
    total_mass_g: float | None
    params: str
    references: str


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
    process: dict | None = None
    finishes: tuple[dict, ...] = ()
    inspections: tuple[dict, ...] = ()
    envelope_mm: tuple[Decimal, Decimal, Decimal]
    unit_volume_mm3: Decimal
    unit_mass_g: Decimal | None = None


class BOM(Contract):
    assembly_digest: str
    lines: tuple[BOMLineV1, ...]

    @property
    def content_digest(self) -> str:
        return content_digest(self)


def generate_structured_bom(source: cadquery.Assembly | ResolvedAssembly) -> BOM:
    """Generate a deterministic, manufacturing-aware JSON BOM."""
    graph = (
        resolve_assembly(source) if isinstance(source, cadquery.Assembly) else source
    )
    groups: dict[tuple[str, str, str], list[PartNode]] = {}
    for node in graph.nodes:
        if isinstance(node, PartNode):
            key = (node.definition_id, node.definition_revision, node.parameter_digest)
            groups.setdefault(key, []).append(node)
    lines: list[BOMLineV1] = []
    for key in sorted(groups):
        group = sorted(groups[key], key=lambda item: item.node_id)
        item = group[0]
        line_id = content_digest(
            {"definition": key[0], "revision": key[1], "parameters": key[2]}
        )
        lines.append(
            BOMLineV1(
                line_id=line_id,
                definition_id=item.definition_id,
                definition_revision=item.definition_revision,
                quantity=Decimal(len(group)),
                source_instances=tuple(node.node_id for node in group),
                parameter_digest=item.parameter_digest,
                parameters=item.parameters,
                manufacturer_part=item.manufacturer_part.model_dump(mode="json")
                if item.manufacturer_part
                else None,
                material=item.material_name,
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
    return BOM(assembly_digest=graph.content_digest, lines=tuple(lines))


def write_bom_json(source: cadquery.Assembly | ResolvedAssembly, location: str) -> None:
    with open(location, "w", encoding="utf-8") as output:
        output.write(canonical_json(generate_structured_bom(source)))
        output.write("\n")


def _format_value(value) -> str:
    if isinstance(value, Enum):
        return str(value.value)
    return str(value)


def _fingerprint(shape: cadquery.Shape, metadata: dict, name: str) -> tuple:
    """
    Two leaves are "the same part" (grouped into one BomLine) if they
    share a part_class and identical params/material -- the case
    attach() sets up. Parts added without attach() (no part_class in
    metadata) fall back to a geometry fingerprint: same name-with-
    trailing-digits-stripped, bounding box, and material.
    """
    part_class = metadata.get("part_class")
    material: Material | None = metadata.get("material")
    material_key = material.name if material is not None else None

    if part_class is not None:
        params = metadata.get("part_params", {})
        params_key = tuple(sorted((k, repr(v)) for k, v in params.items()))
        return ("class", part_class, params_key, material_key)

    bbox = shape.BoundingBox()
    fallback_name = name.rstrip("0123456789") or name
    return (
        "geometry",
        fallback_name,
        round(bbox.xlen, _ROUNDING),
        round(bbox.ylen, _ROUNDING),
        round(bbox.zlen, _ROUNDING),
        material_key,
    )


def _display_name(part_class: str | None, fallback_name: str) -> str:
    if part_class is not None:
        return part_class.rsplit(".", 1)[-1]
    return fallback_name.rstrip("0123456789") or fallback_name


def generate_bom(assy: cadquery.Assembly) -> list[BomLine]:
    """
    Walks every leaf part in `assy` and groups instances of the same part
    (see _fingerprint) into one BomLine each, with quantity = how many
    instances were found. Order follows first appearance in the tree.
    """
    groups: dict[tuple, dict] = {}
    order: list[tuple] = []

    for shape, metadata, _world_loc, name in _walk_assembly(assy):
        key = _fingerprint(shape, metadata, name)
        if key not in groups:
            order.append(key)
            groups[key] = {
                "shape": shape,
                "metadata": metadata,
                "count": 0,
                "names": [],
            }
        groups[key]["count"] += 1
        groups[key]["names"].append(name)

    lines = []
    for key in order:
        group = groups[key]
        shape: cadquery.Shape = group["shape"]
        metadata: dict = group["metadata"]
        count: int = group["count"]

        material: Material | None = metadata.get("material")
        part_class = metadata.get("part_class")
        params = metadata.get("part_params", {})

        bbox = shape.BoundingBox()
        unit_volume = shape.Volume()
        unit_mass = (
            unit_volume / 1000 * material.density
            if material is not None and material.density is not None
            else None
        )

        lines.append(
            BomLine(
                part=_display_name(part_class, group["names"][0]),
                quantity=count,
                material=material.name if material is not None else "",
                process=material.process.value if material is not None else "",
                length_mm=round(bbox.xlen, _ROUNDING),
                width_mm=round(bbox.ylen, _ROUNDING),
                height_mm=round(bbox.zlen, _ROUNDING),
                unit_volume_mm3=round(unit_volume, _ROUNDING),
                total_volume_mm3=round(unit_volume * count, _ROUNDING),
                unit_mass_g=round(unit_mass, _ROUNDING)
                if unit_mass is not None
                else None,
                total_mass_g=(
                    round(unit_mass * count, _ROUNDING)
                    if unit_mass is not None
                    else None
                ),
                params=", ".join(f"{k}={_format_value(v)}" for k, v in params.items()),
                references=", ".join(group["names"]),
            )
        )

    return lines


def write_bom_csv(assy: cadquery.Assembly, location: str) -> None:
    """Writes generate_bom(assy) to `location` as CSV, one row per line item."""
    lines = generate_bom(assy)
    fieldnames = list(BomLine.__dataclass_fields__)
    with open(location, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for line in lines:
            writer.writerow(asdict(line))
