from abc import abstractmethod

import cadquery

from machinewright.lib.cadq.exportable import Exportable
from machinewright.lib.materials import Material


class CADObject(Exportable):
    material: Material | None = None

    @abstractmethod
    def cad(self) -> cadquery.Workplane:
        """
        Returns the cadquery object with all parameters applied
        """
