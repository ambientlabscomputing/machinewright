from abc import abstractmethod

import cadquery

from machinewright.lib.cadq.exportable import Exportable
from machinewright.lib.materials import Material


class CADObject(Exportable):
    material: Material | None = None
    definition_id: str | None = None
    definition_revision: str = "1"
    manufacturer_part = None
    process_spec = None
    finish_requirements: tuple = ()
    inspection_requirements: tuple = ()
    interfaces: tuple = ()

    @abstractmethod
    def cad(self) -> cadquery.Workplane:
        """
        Returns the cadquery object with all parameters applied
        """
