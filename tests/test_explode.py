import cadquery
import pytest

from machinewright.assemblies.base import _explode_assembly


def _box_at(z: float) -> tuple[cadquery.Workplane, cadquery.Location]:
    return cadquery.Workplane("XY").box(2, 2, 2), cadquery.Location(
        cadquery.Vector(0, 0, z)
    )


def _z_center(child) -> float:
    return child.obj.val().located(child.loc).BoundingBox().center.z


def test_explode_flat_children_are_ranked_and_spaced_along_axis():
    assy = cadquery.Assembly()
    for name, z in [("a", 0), ("b", 10), ("c", 20)]:
        wp, loc = _box_at(z)
        assy.add(wp, loc=loc, name=name)

    exploded = _explode_assembly(
        assy, spacing=5.0, axis_vec=cadquery.Vector(0, 0, 1), nested=False
    )

    centers = {child.name: _z_center(child) for child in exploded.children}
    assert centers["a"] == pytest.approx(0.0)
    assert centers["b"] == pytest.approx(5.0)
    assert centers["c"] == pytest.approx(10.0)


def test_explode_groups_children_sharing_a_position():
    assy = cadquery.Assembly()
    wp_a, loc_a = _box_at(0)
    wp_b, loc_b = _box_at(0)
    wp_c, loc_c = _box_at(10)
    assy.add(wp_a, loc=loc_a, name="ring_a")
    assy.add(wp_b, loc=loc_b, name="ring_b")
    assy.add(wp_c, loc=loc_c, name="cap")

    exploded = _explode_assembly(
        assy, spacing=5.0, axis_vec=cadquery.Vector(0, 0, 1), nested=False
    )

    centers = {child.name: _z_center(child) for child in exploded.children}
    assert centers["ring_a"] == pytest.approx(centers["ring_b"])
    assert centers["cap"] == pytest.approx(centers["ring_a"] + 5.0)


def test_explode_nested_true_recurses_into_sub_assembly():
    sub = cadquery.Assembly()
    inner_a, inner_a_loc = _box_at(0)
    inner_b, inner_b_loc = _box_at(10)
    sub.add(inner_a, loc=inner_a_loc, name="inner_a")
    sub.add(inner_b, loc=inner_b_loc, name="inner_b")

    parent = cadquery.Assembly()
    leaf, leaf_loc = _box_at(20)
    parent.add(leaf, loc=leaf_loc, name="leaf")
    parent.add(sub, loc=cadquery.Location(cadquery.Vector(0, 0, 100)), name="sub")

    exploded = _explode_assembly(
        parent, spacing=5.0, axis_vec=cadquery.Vector(0, 0, 1), nested=True
    )

    sub_child = next(c for c in exploded.children if c.name == "sub")
    assert sub_child.obj is None
    inner_centers = {
        c.name: c.obj.val().located(c.loc * sub_child.loc).BoundingBox().center.z
        for c in sub_child.children
    }
    assert inner_centers["inner_b"] > inner_centers["inner_a"]


def test_explode_nested_false_treats_sub_assembly_as_rigid_block():
    sub = cadquery.Assembly()
    inner_a, inner_a_loc = _box_at(0)
    inner_b, inner_b_loc = _box_at(10)
    sub.add(inner_a, loc=inner_a_loc, name="inner_a")
    sub.add(inner_b, loc=inner_b_loc, name="inner_b")

    parent = cadquery.Assembly()
    leaf, leaf_loc = _box_at(20)
    parent.add(leaf, loc=leaf_loc, name="leaf")
    parent.add(sub, loc=cadquery.Location(cadquery.Vector(0, 0, 100)), name="sub")

    exploded = _explode_assembly(
        parent, spacing=5.0, axis_vec=cadquery.Vector(0, 0, 1), nested=False
    )

    sub_child = next(c for c in exploded.children if c.name == "sub")
    assert sub_child.obj is None
    assert [c.name for c in sub_child.children] == ["inner_a", "inner_b"]
