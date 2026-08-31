import cadquery

from machinewright.objects.base import PartDefinition
from machinewright.registry import register_object


@register_object
class Box(PartDefinition):
    def __init__(self, height: float, width: float, depth: float):
        self.height = height
        self.width = width
        self.depth = depth

    def geometry(self) -> cadquery.Workplane:
        return cadquery.Workplane("XY").box(
            length=self.depth,
            width=self.width,
            height=self.height,
        )
