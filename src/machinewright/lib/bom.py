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
from enum import Enum

import cadquery

from machinewright.assemblies.base import _walk_assembly
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
