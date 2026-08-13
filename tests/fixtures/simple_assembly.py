"""
Throwaway CADAssembly fixtures used only to exercise
CADAssembly.cad(exploded=...) end-to-end in tests. Not part of the real
built-in library -- register these locally within a test (via the
clean_registry fixture) rather than importing them anywhere production
code runs.
"""

import cadquery

from machinewright.assemblies.base import CADAssembly
from machinewright.lib.materials import MATERIALS, attach
from machinewright.objects.box import Box
from machinewright.objects.fasteners.dowel_pin import DowelPin


class NestedPinPair(CADAssembly):
    """
    Two dowel pins stacked along Z, meant to be nested inside another
    assembly. DowelPin already defaults to an off-the-shelf/purchased
    material, so these are left as-is.
    """

    def assemble(self) -> cadquery.Assembly:
        assy = cadquery.Assembly()
        attach(
            assy,
            DowelPin(diameter=3, length=5),
            loc=cadquery.Location(cadquery.Vector(0, 0, 0)),
            name="lower_pin",
        )
        attach(
            assy,
            DowelPin(diameter=3, length=5),
            loc=cadquery.Location(cadquery.Vector(0, 0, 10)),
            name="upper_pin",
        )
        return assy


class SimpleAssembly(CADAssembly):
    """
    A base plate and top plate (both tagged PLA/printed) sandwiching a
    nested pin-pair sub-assembly (purchased hardware).
    """

    def assemble(self) -> cadquery.Assembly:
        assy = cadquery.Assembly()

        base_plate = Box(height=2, width=20, depth=20)
        base_plate.material = MATERIALS["PLA"]
        attach(assy, base_plate, loc=cadquery.Location(cadquery.Vector(0, 0, 0)), name="base_plate")

        assy.add(
            NestedPinPair().assemble(),
            loc=cadquery.Location(cadquery.Vector(0, 0, 20)),
            name="pin_pair",
        )

        top_plate = Box(height=2, width=20, depth=20)
        top_plate.material = MATERIALS["PLA"]
        attach(assy, top_plate, loc=cadquery.Location(cadquery.Vector(0, 0, 40)), name="top_plate")

        return assy
