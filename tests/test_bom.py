import csv

import cadquery
import pytest

from machinewright.lib.bom import generate_bom, write_bom_csv
from machinewright.lib.materials import MATERIALS, attach
from machinewright.objects.box import Box
from machinewright.objects.fasteners.dowel_pin import DowelPin
from tests.fixtures.simple_assembly import SimpleAssembly


def test_generate_bom_groups_identical_parts_by_class_params_and_material():
    assy = SimpleAssembly().assemble()

    lines = generate_bom(assy)

    by_part = {line.part: line for line in lines}
    assert set(by_part) == {"Box", "DowelPin"}
    assert by_part["Box"].quantity == 2
    assert by_part["DowelPin"].quantity == 2


def test_generate_bom_reports_material_and_process():
    assy = SimpleAssembly().assemble()

    lines = generate_bom(assy)
    by_part = {line.part: line for line in lines}

    assert by_part["Box"].material == "PLA"
    assert by_part["Box"].process == "PRINTED"
    assert by_part["DowelPin"].material == "Off-the-shelf hardware"
    assert by_part["DowelPin"].process == "PURCHASED"


def test_generate_bom_reports_dimensions_and_volume():
    assy = SimpleAssembly().assemble()

    lines = generate_bom(assy)
    by_part = {line.part: line for line in lines}

    box_line = by_part["Box"]
    assert box_line.length_mm == pytest.approx(20.0)
    assert box_line.width_mm == pytest.approx(20.0)
    assert box_line.height_mm == pytest.approx(2.0)
    assert box_line.unit_volume_mm3 == pytest.approx(20 * 20 * 2)
    assert box_line.total_volume_mm3 == pytest.approx(box_line.unit_volume_mm3 * 2)


def test_generate_bom_computes_mass_when_density_available():
    assy = SimpleAssembly().assemble()

    lines = generate_bom(assy)
    by_part = {line.part: line for line in lines}

    box_line = by_part["Box"]
    expected_unit_mass = (box_line.unit_volume_mm3 / 1000) * MATERIALS["PLA"].density
    assert box_line.unit_mass_g == pytest.approx(expected_unit_mass)
    assert box_line.total_mass_g == pytest.approx(expected_unit_mass * 2)


def test_generate_bom_leaves_mass_none_when_no_density():
    assy = SimpleAssembly().assemble()

    lines = generate_bom(assy)
    by_part = {line.part: line for line in lines}

    dowel_line = by_part["DowelPin"]
    assert dowel_line.unit_mass_g is None
    assert dowel_line.total_mass_g is None


def test_generate_bom_records_params_and_references():
    assy = SimpleAssembly().assemble()

    lines = generate_bom(assy)
    by_part = {line.part: line for line in lines}

    dowel_line = by_part["DowelPin"]
    assert "diameter=3" in dowel_line.params
    assert "length=5" in dowel_line.params
    assert dowel_line.references == "lower_pin, upper_pin"


def test_generate_bom_keeps_different_params_as_separate_lines():
    assy = cadquery.Assembly()
    attach(assy, DowelPin(diameter=3, length=5), name="small_pin")
    attach(assy, DowelPin(diameter=5, length=10), name="big_pin")

    lines = generate_bom(assy)

    assert len(lines) == 2
    assert {line.quantity for line in lines} == {1}


def test_generate_bom_falls_back_to_geometry_when_no_part_class():
    assy = cadquery.Assembly()
    assy.add(cadquery.Workplane("XY").box(5, 5, 5), name="raw1")
    assy.add(cadquery.Workplane("XY").box(5, 5, 5), name="raw2")
    assy.add(cadquery.Workplane("XY").box(9, 9, 9), name="other1")

    lines = generate_bom(assy)

    assert len(lines) == 2
    quantities = sorted(line.quantity for line in lines)
    assert quantities == [1, 2]


def test_generate_bom_handles_parts_with_no_material():
    assy = cadquery.Assembly()
    attach(assy, Box(height=1, width=1, depth=1), name="untagged")

    lines = generate_bom(assy)

    assert len(lines) == 1
    assert lines[0].material == ""
    assert lines[0].process == ""


def test_write_bom_csv_round_trips_through_csv(tmp_path):
    assy = SimpleAssembly().assemble()
    location = tmp_path / "bom.csv"

    write_bom_csv(assy, str(location))

    with open(location, newline="") as f:
        rows = list(csv.DictReader(f))

    assert len(rows) == 2
    parts = {row["part"] for row in rows}
    assert parts == {"Box", "DowelPin"}
    box_row = next(row for row in rows if row["part"] == "Box")
    assert box_row["quantity"] == "2"
    assert box_row["material"] == "PLA"
