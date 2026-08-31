import cadquery

from machinewright.lib.materials import MATERIALS
from machinewright.objects.base import PartDefinition
from machinewright.registry import register_object


@register_object
class DowelPin(PartDefinition):
    material = MATERIALS["OFF_THE_SHELF"]

    def __init__(self, diameter: float, length: float):
        self.diameter = diameter
        self.length = length

    def geometry(self) -> cadquery.Workplane:
        return cadquery.Workplane("XY").circle(self.diameter / 2).extrude(self.length)
