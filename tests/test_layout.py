import cadquery
import pytest

from machinewright.lib.layout import (
    _best_orientation,
    _overhang_area,
    collect_by_process,
    layout_for_printing,
)
from machinewright.lib.materials import MATERIALS, Process


def _box(
    width: float, depth: float, height: float, z: float = 0.0
) -> cadquery.Workplane:
    return cadquery.Workplane("XY", origin=(0, 0, z)).box(
        width, depth, height, centered=(True, True, False)
    )


def _plate_with_cbore_facing_up() -> cadquery.Shape:
    """
    A flat plate with a counterbore cut from the top face, as-designed --
    the counterbore's shoulder faces up (safe: no overhang when resting
    on its flat bottom).
    """
    wp = cadquery.Workplane("XY").box(20, 20, 4, centered=(True, True, False))
    wp = wp.faces(">Z").workplane().pushPoints([(5, 5)]).cboreHole(3, 6, 2)
    return wp.val()


def _build_mixed_assembly() -> cadquery.Assembly:
    """
    Two PRINTED leaves (one nested inside a sub-assembly), one PURCHASED
    leaf, one leaf with no material at all.
    """
    printed = MATERIALS["PLA"]
    purchased = MATERIALS["OFF_THE_SHELF"]

    sub = cadquery.Assembly()
    sub.add(
        _box(10, 10, 5, z=0),
        loc=cadquery.Location(cadquery.Vector(0, 0, 0)),
        name="nested_printed",
        metadata={"material": printed},
    )

    parent = cadquery.Assembly()
    parent.add(
        _box(20, 5, 5, z=50),
        loc=cadquery.Location(),
        name="top_printed",
        metadata={"material": printed},
    )
    parent.add(
        _box(8, 8, 8, z=0),
        loc=cadquery.Location(cadquery.Vector(30, 0, 0)),
        name="purchased",
        metadata={"material": purchased},
    )
    parent.add(
        _box(5, 5, 5, z=0),
        loc=cadquery.Location(cadquery.Vector(60, 0, 0)),
        name="untagged",
    )
    parent.add(sub, loc=cadquery.Location(cadquery.Vector(0, 100, 0)), name="sub")

    return parent


def test_collect_by_process_filters_printed_only():
    assy = _build_mixed_assembly()

    shapes = collect_by_process(assy, Process.PRINTED)

    assert len(shapes) == 2


def test_collect_by_process_filters_purchased_only():
    assy = _build_mixed_assembly()

    shapes = collect_by_process(assy, Process.PURCHASED)

    assert len(shapes) == 1


def test_collect_by_process_empty_for_unused_process():
    assy = _build_mixed_assembly()

    shapes = collect_by_process(assy, Process.MACHINED)

    assert shapes == []


def test_layout_for_printing_drops_all_parts_to_z_zero():
    assy = _build_mixed_assembly()

    cad = layout_for_printing(assy, process=Process.PRINTED, spacing=5.0)

    compound = cad.val()
    for solid in compound.Solids():
        assert solid.BoundingBox().zmin == pytest.approx(0.0)


def _pairwise_xy_overlap(bboxes) -> bool:
    for i, a in enumerate(bboxes):
        for b in bboxes[i + 1 :]:
            overlap_x = a.xmin < b.xmax and b.xmin < a.xmax
            overlap_y = a.ymin < b.ymax and b.ymin < a.ymax
            if overlap_x and overlap_y:
                return True
    return False


def test_layout_for_printing_no_xy_overlap():
    assy = _build_mixed_assembly()

    cad = layout_for_printing(assy, process=Process.PRINTED, spacing=5.0)

    bboxes = [solid.BoundingBox() for solid in cad.val().Solids()]
    assert len(bboxes) == 2
    assert not _pairwise_xy_overlap(bboxes)


def test_layout_for_printing_wraps_rows_when_bed_width_is_narrow():
    assy = cadquery.Assembly()
    for i in range(3):
        assy.add(
            _box(20, 10, 5),
            loc=cadquery.Location(cadquery.Vector(i * 100, 0, 0)),
            name=f"part_{i}",
            metadata={"material": MATERIALS["PLA"]},
        )

    cad = layout_for_printing(
        assy, process=Process.PRINTED, spacing=5.0, bed_size=(45.0, 1000.0)
    )

    bboxes = [solid.BoundingBox() for solid in cad.val().Solids()]
    y_centers = sorted({round(bbox.center.y, 3) for bbox in bboxes})
    assert len(y_centers) >= 2
    assert not _pairwise_xy_overlap(bboxes)


def test_layout_for_printing_raises_when_no_parts_match():
    assy = cadquery.Assembly()
    assy.add(
        _box(5, 5, 5),
        loc=cadquery.Location(),
        name="purchased_only",
        metadata={"material": MATERIALS["OFF_THE_SHELF"]},
    )

    with pytest.raises(ValueError):
        layout_for_printing(assy, process=Process.PRINTED)


def test_overhang_area_is_zero_for_simple_box():
    shape = _box(10, 10, 5).val()
    assert _overhang_area(shape) == pytest.approx(0.0)


def test_overhang_area_zero_when_counterbore_faces_up():
    shape = _plate_with_cbore_facing_up()
    assert _overhang_area(shape) == pytest.approx(0.0)


def test_overhang_area_detects_downward_counterbore_shoulder():
    good = _plate_with_cbore_facing_up()
    bad = good.rotate((0, 0, 0), (1, 0, 0), 180)

    assert _overhang_area(bad) > _overhang_area(good)


def test_best_orientation_flips_to_reduce_overhang():
    good = _plate_with_cbore_facing_up()
    bad = good.rotate((0, 0, 0), (1, 0, 0), 180)

    chosen = _best_orientation(bad)

    assert _overhang_area(chosen) == pytest.approx(_overhang_area(good))
    assert _overhang_area(chosen) < _overhang_area(bad)


def test_best_orientation_keeps_already_good_orientation():
    good = _plate_with_cbore_facing_up()

    chosen = _best_orientation(good)

    assert _overhang_area(chosen) == pytest.approx(0.0)


def test_best_orientation_corrects_a_part_placed_on_its_side():
    """
    Simulates a part whose *assembly placement* leaves it standing on
    edge (e.g. a sub-assembly mounted 90 degrees off the top-level Z
    axis) -- not something a flip-only search can ever fix, since
    flipping keeps the same axis pointing down.
    """
    flat = _box(20, 20, 4).val()
    assert flat.BoundingBox().zlen == pytest.approx(4.0)

    sideways = flat.rotate((0, 0, 0), (1, 0, 0), 90)
    assert sideways.BoundingBox().zlen == pytest.approx(20.0)

    chosen = _best_orientation(sideways)

    assert chosen.BoundingBox().zlen == pytest.approx(4.0)


def test_layout_for_printing_optimizes_orientation_by_default():
    bad = _plate_with_cbore_facing_up().rotate((0, 0, 0), (1, 0, 0), 180)
    assy = cadquery.Assembly()
    assy.add(
        cadquery.Workplane(obj=bad),
        loc=cadquery.Location(),
        name="plate",
        metadata={"material": MATERIALS["PLA"]},
    )

    cad = layout_for_printing(assy, process=Process.PRINTED)

    solid = cad.val().Solids()[0]
    assert _overhang_area(solid) == pytest.approx(0.0)


def test_layout_for_printing_can_disable_orientation_optimization():
    bad = _plate_with_cbore_facing_up().rotate((0, 0, 0), (1, 0, 0), 180)
    bad_overhang = _overhang_area(bad)
    assy = cadquery.Assembly()
    assy.add(
        cadquery.Workplane(obj=bad),
        loc=cadquery.Location(),
        name="plate",
        metadata={"material": MATERIALS["PLA"]},
    )

    cad = layout_for_printing(assy, process=Process.PRINTED, optimize_orientation=False)

    solid = cad.val().Solids()[0]
    assert _overhang_area(solid) == pytest.approx(bad_overhang)


def test_layout_for_printing_auto_bed_width_avoids_a_single_long_row():
    assy = cadquery.Assembly()
    for i in range(9):
        assy.add(
            _box(20, 20, 5),
            loc=cadquery.Location(cadquery.Vector(i * 100, 0, 0)),
            name=f"part_{i}",
            metadata={"material": MATERIALS["PLA"]},
        )

    cad = layout_for_printing(assy, process=Process.PRINTED, spacing=5.0)

    bboxes = [solid.BoundingBox() for solid in cad.val().Solids()]
    y_centers = {round(bbox.center.y, 3) for bbox in bboxes}
    assert len(y_centers) > 1
    assert not _pairwise_xy_overlap(bboxes)
