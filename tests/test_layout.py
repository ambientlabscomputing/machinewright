import cadquery
import pytest

from machinewright.lib.layout import _best_orientation, _overhang_area


def _box(width: float, depth: float, height: float) -> cadquery.Workplane:
    return cadquery.Workplane("XY").box(
        width, depth, height, centered=(True, True, False)
    )


def _plate_with_cbore_facing_up() -> cadquery.Shape:
    workplane = cadquery.Workplane("XY").box(20, 20, 4, centered=(True, True, False))
    return (
        workplane.faces(">Z").workplane().pushPoints([(5, 5)]).cboreHole(3, 6, 2).val()
    )


def test_overhang_area_is_zero_for_simple_box():
    assert _overhang_area(_box(10, 10, 5).val()) == pytest.approx(0)


def test_best_orientation_reduces_counterbore_overhang():
    good = _plate_with_cbore_facing_up()
    bad = good.rotate((0, 0, 0), (1, 0, 0), 180)
    chosen = _best_orientation(bad)
    assert _overhang_area(chosen) == pytest.approx(_overhang_area(good))
    assert _overhang_area(chosen) < _overhang_area(bad)


def test_best_orientation_corrects_sideways_part():
    flat = _box(20, 20, 4).val()
    sideways = flat.rotate((0, 0, 0), (1, 0, 0), 90)
    assert _best_orientation(sideways).BoundingBox().zlen == pytest.approx(4)
