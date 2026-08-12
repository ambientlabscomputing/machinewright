from abc import abstractmethod

import cadquery

from machinewright.lib.cadq.exportable import Exportable


class CADObject(Exportable):
    @abstractmethod
    def cad(self) -> cadquery.Workplane:
        """
        Returns the cadquery object with all parameters applied
        """
