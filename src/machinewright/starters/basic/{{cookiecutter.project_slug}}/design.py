"""A base and cover with a shared width in millimetres."""

import cadquery
from pydantic import Field

from machinewright import (
    MATERIALS,
    AssemblyBuilder,
    AssemblyDefinition,
    HardwareResult,
    PartDefinition,
    Transform,
    machine_template,
)
from machinewright.contracts import Contract

TEMPLATE_ID = "{{ cookiecutter.project_slug }}.main"


class Requirements(Contract):
    plate_width_mm: float = Field(gt=0)


class Plate(PartDefinition):
    material = MATERIALS["PLA"]

    def __init__(self, width_mm: float):
        self.width_mm = width_mm

    def geometry(self) -> cadquery.Workplane:
        return cadquery.Workplane("XY").box(self.width_mm, 20, 4)


class Machine(AssemblyDefinition):
    def __init__(self, width_mm: float):
        self.width_mm = width_mm

    def define(self, builder: AssemblyBuilder) -> None:
        builder.part("base", Plate(self.width_mm))
        builder.part("cover", Plate(self.width_mm), transform=Transform.translated(z=12))


@machine_template(id=TEMPLATE_ID, version="0.1.0")
def machine(requirements: Requirements) -> HardwareResult:
    return HardwareResult(
        design=Machine(requirements.plate_width_mm).resolve(root_id=TEMPLATE_ID)
    )
