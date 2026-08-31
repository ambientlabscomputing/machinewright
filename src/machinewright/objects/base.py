from abc import abstractmethod
from typing import Any

import cadquery

from machinewright.contracts import (
    FinishRequirement,
    InspectionRequirement,
    ManufacturerPartIdentity,
    ProcessSpec,
)
from machinewright.lib.materials import Material


class PartDefinition:
    """A reusable leaf-part definition in a hardware graph."""

    material: Material | None = None
    definition_id: str | None = None
    definition_revision: str = "1"
    manufacturer_part: ManufacturerPartIdentity | None = None
    process_spec: ProcessSpec | None = None
    finish_requirements: tuple[FinishRequirement, ...] = ()
    inspection_requirements: tuple[InspectionRequirement, ...] = ()
    ports: tuple[Any, ...] = ()

    @abstractmethod
    def geometry(self) -> cadquery.Workplane:
        """Return this leaf part's resolved CadQuery geometry."""

    def describe(self) -> dict[str, Any]:
        """Return the canonical semantic description used by graph resolution."""
        part_class = f"{type(self).__module__}.{type(self).__qualname__}"
        return {
            "definition_id": self.definition_id or part_class,
            "definition_revision": self.definition_revision,
            "parameters": {
                key: value for key, value in vars(self).items() if key != "material"
            },
            "manufacturer_part": self.manufacturer_part,
            "material": self.material,
            "process": self.process_spec,
            "finishes": self.finish_requirements,
            "inspections": self.inspection_requirements,
            "ports": self.ports,
        }
