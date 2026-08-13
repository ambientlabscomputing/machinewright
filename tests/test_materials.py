import dataclasses

import cadquery
import pytest

from machinewright.lib.materials import MATERIALS, Material, Process, attach
from machinewright.objects.base import CADObject


class _FakePart(CADObject):
    def cad(self) -> cadquery.Workplane:
        return cadquery.Workplane("XY").box(1, 1, 1)


def test_material_is_frozen():
    material = Material(name="Test", process=Process.OTHER)
    with pytest.raises(dataclasses.FrozenInstanceError):
        material.name = "Changed"


def test_material_defaults():
    material = Material(name="Test", process=Process.OTHER)
    assert material.color == (0.7, 0.7, 0.7)
    assert material.density is None


def test_material_equality_by_value():
    a = Material(name="Test", process=Process.OTHER, color=(1, 0, 0), density=1.0)
    b = Material(name="Test", process=Process.OTHER, color=(1, 0, 0), density=1.0)
    assert a == b


def test_materials_catalog_processes():
    assert MATERIALS["PLA"].process == Process.PRINTED
    assert MATERIALS["PETG"].process == Process.PRINTED
    assert MATERIALS["PETG_CF"].process == Process.PRINTED
    assert MATERIALS["ALUMINUM_6061"].process == Process.MACHINED
    assert MATERIALS["OFF_THE_SHELF"].process == Process.PURCHASED


def test_off_the_shelf_has_no_density():
    assert MATERIALS["OFF_THE_SHELF"].density is None


def test_printed_materials_have_density():
    assert MATERIALS["PLA"].density is not None
    assert MATERIALS["PETG"].density is not None


def test_attach_with_material_sets_color_and_metadata():
    assy = cadquery.Assembly()
    part = _FakePart()
    part.material = MATERIALS["PLA"]

    attach(assy, part, name="widget")

    child = assy.children[0]
    assert child.name == "widget"
    assert child.metadata["material"] is part.material
    assert child.color.toTuple()[:3] == pytest.approx(MATERIALS["PLA"].color)


def test_attach_with_density_sets_native_cq_material():
    assy = cadquery.Assembly()
    part = _FakePart()
    part.material = MATERIALS["PLA"]

    attach(assy, part, name="widget")

    child = assy.children[0]
    assert child.material is not None
    assert child.material.name == "PLA"
    assert child.material.density == pytest.approx(1.24)


def test_attach_without_density_skips_native_cq_material():
    assy = cadquery.Assembly()
    part = _FakePart()
    part.material = MATERIALS["OFF_THE_SHELF"]

    attach(assy, part, name="widget")

    child = assy.children[0]
    assert child.material is None


def test_attach_with_no_material_passes_no_color_or_metadata():
    assy = cadquery.Assembly()
    part = _FakePart()
    assert part.material is None

    attach(assy, part, name="widget")

    child = assy.children[0]
    assert child.metadata == {}
    assert child.material is None
