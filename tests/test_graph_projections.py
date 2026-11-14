import csv

import pytest

from machinewright import MATERIALS, Process
from machinewright.hardware_graph import PartNode
from machinewright.lib.bom import generate_structured_bom, write_bom_csv
from machinewright.lib.layout import collect_by_process, layout_for_printing
from tests.fixtures.simple_assembly import SimpleAssembly


def test_material_and_bom_metadata_come_from_graph(tmp_path):
    design = SimpleAssembly().resolve()
    graph = design.graph
    base = next(
        node
        for node in graph.nodes
        if isinstance(node, PartNode) and node.instance_key == "base_plate"
    )
    assert base.material_name == MATERIALS["PLA"].name
    bom = generate_structured_bom(graph)
    assert bom.graph_digest == graph.graph_digest
    location = tmp_path / "bom.csv"
    write_bom_csv(graph, location)
    with location.open(newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    assert sum(int(row["quantity"]) for row in rows) == 4


def test_print_layout_collects_graph_selected_geometry():
    design = SimpleAssembly().resolve()
    shapes = collect_by_process(design, Process.PRINTED)
    assert len(shapes) == 1
    assert layout_for_printing(design).val().Volume() > 0


def test_normal_and_exploded_cad_are_graph_projections():
    assembly = SimpleAssembly()
    normal = assembly.cad().val()
    exploded = assembly.cad(exploded=True, spacing=50, nested=True).val()
    assert normal.Volume() == pytest.approx(exploded.Volume())
    assert exploded.BoundingBox().zlen > normal.BoundingBox().zlen


def test_bom_lines_carry_the_material_process() -> None:
    import cadquery

    from machinewright import (
        MATERIALS,
        AssemblyBuilder,
        AssemblyDefinition,
        PartDefinition,
    )
    from machinewright.lib.bom import generate_structured_bom

    class Bolt(PartDefinition):
        material = MATERIALS["OFF_THE_SHELF"]

        def geometry(self) -> cadquery.Workplane:
            return cadquery.Workplane("XY").box(3, 3, 10)

    class Assembly(AssemblyDefinition):
        def define(self, builder: AssemblyBuilder) -> None:
            builder.part("bolt", Bolt())

    bom = generate_structured_bom(Assembly().resolve(root_id="t").graph)
    assert [line.material_process for line in bom.lines] == ["PURCHASED"]
