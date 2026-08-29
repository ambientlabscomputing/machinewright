"""
Material/color tracking for CADObject parts, plus operations that key off
it (see lib/layout.py). Not a real materials database -- MATERIALS is a
small starter catalog; consumers are expected to add their own entries or
construct Material directly.
"""

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

import cadquery
from cadquery.occ_impl.assembly import Material as CQMaterial

if TYPE_CHECKING:
    from machinewright.objects.base import CADObject


class Process(str, Enum):
    PRINTED = "PRINTED"
    MACHINED = "MACHINED"
    PURCHASED = "PURCHASED"
    SHEET = "SHEET"
    OTHER = "OTHER"


@dataclass(frozen=True)
class Material:
    name: str
    process: Process
    color: tuple[float, float, float] = (0.7, 0.7, 0.7)  # RGB, 0-1
    density: float | None = (
        None  # g/cm^3; None skips cadquery's native Material wrapper
    )


def attach(
    assy: cadquery.Assembly,
    part: "CADObject",
    loc: cadquery.Location | None = None,
    name: str | None = None,
    *,
    instance_key: str | None = None,
) -> cadquery.Assembly:
    """
    Adds `part` to `assy`, wiring its .material (if set) into cadquery's
    native color/material hooks (for STEP fidelity) and into our own
    metadata (for in-process filtering, see lib/layout.py, and BOM
    generation, see lib/bom.py). Use in place of
    assy.add(part.cad(), loc=..., name=...) inside assemble().

    Metadata always records the part's fully-qualified class and its
    instance attributes (a generic stand-in for "constructor params",
    since every CADObject subclass sets self.foo = foo for each param) --
    this is what lets the BOM group repeated instances of the same part
    into one line item and report their dimensions.
    """
    kwargs: dict = {"loc": loc, "name": name}
    part_class = f"{type(part).__module__}.{type(part).__qualname__}"
    stable_key = instance_key or name
    metadata: dict = {
        "part_class": part_class,
        "part_params": {k: v for k, v in vars(part).items() if k != "material"},
        "definition_id": part.definition_id or part_class,
        "definition_revision": part.definition_revision,
        "instance_key": stable_key,
        "manufacturer_part": part.manufacturer_part,
        "process_spec": part.process_spec,
        "finish_requirements": part.finish_requirements,
        "inspection_requirements": part.inspection_requirements,
        "interfaces": part.interfaces,
    }
    material = part.material
    if material is not None:
        kwargs["color"] = cadquery.Color(*material.color)
        metadata["material"] = material
        if material.density is not None:
            kwargs["material"] = CQMaterial(
                name=material.name, density=material.density
            )
    kwargs["metadata"] = metadata
    assy.add(part.cad(), **kwargs)
    return assy


MATERIALS: dict[str, Material] = {
    "PLA": Material(
        name="PLA", process=Process.PRINTED, color=(0.9, 0.9, 0.85), density=1.24
    ),
    "PETG": Material(
        name="PETG", process=Process.PRINTED, color=(0.85, 0.9, 0.95), density=1.27
    ),
    "PETG_CF": Material(
        name="PETG-CF", process=Process.PRINTED, color=(0.15, 0.15, 0.15), density=1.30
    ),
    "ALUMINUM_6061": Material(
        name="6061-T6 Aluminum",
        process=Process.MACHINED,
        color=(0.75, 0.75, 0.78),
        density=2.70,
    ),
    "OFF_THE_SHELF": Material(
        name="Off-the-shelf hardware", process=Process.PURCHASED, color=(0.6, 0.6, 0.65)
    ),
}
