import json
from pathlib import Path

import cadquery
import numpy as np
import pytest

from machinewright import MATERIALS, AssemblyBuilder, AssemblyDefinition, PartDefinition
from machinewright.export_jobs import (
    ExportCancelledError,
    ExportJobKind,
    run_export_job,
)
from machinewright.export_service import CancellationToken
from machinewright.lib.layout import _candidate_orientations
from machinewright.lib.part_export import PartExportOptions, export_parts
from machinewright.lib.printing import plan as plan_module
from machinewright.lib.printing.export import export_print_plan, plan_print
from machinewright.lib.printing.profile import PlanSettings, PrinterProfile


class Slab(PartDefinition):
    def __init__(self, x: float, y: float, z: float, material_key: str):
        self.x, self.y, self.z = x, y, z
        self.material = MATERIALS[material_key]

    def geometry(self) -> cadquery.Workplane:
        return cadquery.Workplane("XY").box(
            self.x, self.y, self.z, centered=(True, True, False)
        )


def _design(parts: list[tuple[str, Slab]]):
    class Assembly(AssemblyDefinition):
        def define(self, builder: AssemblyBuilder) -> None:
            for key, part in parts:
                builder.part(key, part)

    return Assembly().resolve(root_id="test")


@pytest.fixture
def mixed_design():
    return _design(
        [
            ("pla-a", Slab(30, 20, 5, "PLA")),
            ("pla-b", Slab(30, 20, 5, "PLA")),
            ("petg-a", Slab(25, 25, 8, "PETG")),
            ("bracket", Slab(40, 40, 3, "ALUMINUM_6061")),
        ]
    )


def _rect_overlap(a, b) -> bool:
    return not (
        a.x + a.width <= b.x
        or b.x + b.width <= a.x
        or a.y + a.depth <= b.y
        or b.y + b.depth <= a.y
    )


def test_plates_never_mix_materials_and_skip_non_printed(mixed_design):
    plan = plan_print(mixed_design, PrinterProfile(), PlanSettings())

    assert sorted(p.material for p in plan.plates) == ["PETG", "PLA"]
    printed = {part.instance_key for plate in plan.plates for part in plate.parts}
    assert printed == {"pla-a", "pla-b", "petg-a"}


def test_parts_stay_on_bed_without_overlap(mixed_design):
    printer = PrinterProfile(bed_x=100, bed_y=100, bed_margin=5)
    plan = plan_print(mixed_design, printer, PlanSettings(part_spacing=4))

    for plate in plan.plates:
        for part in plate.parts:
            assert part.x >= printer.bed_margin - 1e-6
            assert part.y >= printer.bed_margin - 1e-6
            assert part.x + part.width <= printer.bed_x - printer.bed_margin + 1e-6
            assert part.y + part.depth <= printer.bed_y - printer.bed_margin + 1e-6
        for i, a in enumerate(plate.parts):
            for b in plate.parts[i + 1 :]:
                assert not _rect_overlap(a, b)


def test_full_bed_spills_onto_more_plates():
    design = _design([(f"p{i}", Slab(40, 40, 5, "PLA")) for i in range(3)])
    plan = plan_print(
        design,
        PrinterProfile(bed_x=60, bed_y=60, bed_margin=5),
        PlanSettings(part_spacing=2),
    )

    assert len(plan.plates) == 3
    assert sum(len(p.parts) for p in plan.plates) == 3


def test_oversize_part_is_reported_not_dropped():
    design = _design(
        [("big", Slab(300, 300, 5, "PLA")), ("ok", Slab(20, 20, 5, "PLA"))]
    )
    plan = plan_print(design, PrinterProfile(bed_x=200, bed_y=200), PlanSettings())

    assert [s.instance_key for s in plan.skipped] == ["big"]
    assert "does not fit" in plan.skipped[0].reason
    assert [p.instance_key for plate in plan.plates for p in plate.parts] == ["ok"]


def test_too_tall_part_is_skipped():
    design = _design([("tower", Slab(10, 10, 100, "PLA"))])
    plan = plan_print(
        design, PrinterProfile(max_z=50), PlanSettings(optimize_orientation=False)
    )

    assert "exceeds printer limit" in plan.skipped[0].reason


def test_upright_slab_is_laid_flat():
    # Authored 4 x 20 x 20 (standing on its thin edge): best orientation is flat.
    design = _design([("wall", Slab(4, 20, 20, "PLA"))])
    plan = plan_print(design, PrinterProfile(), PlanSettings())

    assert plan.plates[0].parts[0].height == pytest.approx(4)


def test_orientation_matrices_match_occ_candidates():
    shape = cadquery.Workplane("XY").box(10, 20, 30).val()
    vertices, _ = plan_module._tessellate(shape, 0.1, 0.1)
    for rotation, candidate in zip(
        plan_module._ORIENTATIONS, _candidate_orientations(shape), strict=True
    ):
        rotated = vertices @ rotation.T
        box = candidate.BoundingBox()
        assert np.ptp(rotated[:, 2]) == pytest.approx(box.zlen, abs=1e-6)
        assert np.ptp(rotated[:, 0]) == pytest.approx(box.xlen, abs=1e-6)


def test_export_writes_plate_stls_and_plan(mixed_design, tmp_path: Path):
    plan = export_print_plan(
        mixed_design, tmp_path, PrinterProfile(), PlanSettings(), basename="run"
    )

    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == [
        "run-plan.json",
        "run-plate-01-petg.stl",
        "run-plate-02-pla.stl",
    ]
    assert [p.stl_file for p in plan.plates] == names[1:]
    assert all((tmp_path / n).stat().st_size > 0 for n in names)
    saved = json.loads((tmp_path / "run-plan.json").read_text())
    assert saved["plates"][0]["stl_file"] == "run-plate-01-petg.stl"


def test_cancelled_export_leaves_no_files(mixed_design, tmp_path: Path):
    token = CancellationToken()
    token.cancel()

    with pytest.raises(ExportCancelledError):
        run_export_job(
            mixed_design,
            ExportJobKind.PRINT_PLAN,
            tmp_path,
            b"{}",
            cancellation=token,
        )

    assert list(tmp_path.iterdir()) == []


def test_plan_job_without_write_creates_nothing(mixed_design, tmp_path: Path):
    result = run_export_job(
        mixed_design,
        ExportJobKind.PRINT_PLAN,
        None,
        json.dumps({"write": False, "printer": {"bed_x": 150, "bed_y": 150}}),
    )

    assert result["bed_x"] == 150
    assert len(result["plates"]) == 2
    assert list(tmp_path.iterdir()) == []


def test_export_each_part_as_its_own_file(mixed_design, tmp_path: Path):
    result = export_parts(mixed_design, tmp_path, PartExportOptions(format="stl"))

    assert sorted(f.name for f in result.files) == [
        "bracket.stl",
        "petg-a.stl",
        "pla-a.stl",
        "pla-b.stl",
    ]
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
        f.name for f in result.files
    )


def test_export_selection_and_process_filter(mixed_design, tmp_path: Path):
    printed = export_parts(
        mixed_design, tmp_path / "printed", PartExportOptions(processes=["PRINTED"])
    )
    assert len(printed.files) == 3

    chosen = [
        n.node_id for n in mixed_design.graph.nodes if n.node_id.endswith("pla-b")
    ]
    one = export_parts(
        mixed_design,
        tmp_path / "one",
        PartExportOptions(format="step", node_ids=chosen),
    )
    assert [f.name for f in one.files] == ["pla-b.step"]
    assert (tmp_path / "one" / "pla-b.step").read_text().startswith("ISO-10303-21")


def test_combined_export_is_one_file(mixed_design, tmp_path: Path):
    result = export_parts(
        mixed_design, tmp_path, PartExportOptions(combine=True), basename="all"
    )

    assert [f.name for f in result.files] == ["all-parts.stl"]
    assert len(result.files[0].node_ids) == 4


def test_empty_selection_is_an_error(mixed_design, tmp_path: Path):
    with pytest.raises(ValueError, match="no parts matched"):
        export_parts(mixed_design, tmp_path, PartExportOptions(node_ids=["nope"]))


def test_live_print_export_reports_each_plate_as_it_lands(
    tmp_path: Path, mixed_design
) -> None:
    design = mixed_design
    events: list[tuple[str, int, int, str]] = []
    plan = export_print_plan(
        design,
        tmp_path,
        PrinterProfile(name="t", bed_x=120, bed_y=120, max_z=100),
        PlanSettings(),
        basename="live",
        progress=lambda *event: events.append(event),
        live=True,
    )
    stages = [stage for stage, *_ in events]
    assert "orient" in stages and "pack" in stages
    assert stages.index("layout") < stages.index("plate_ready")
    ready = [
        json.loads(message) for stage, _, _, message in events if stage == "plate_ready"
    ]
    assert [plate["stl_file"] for plate in ready] == [p.stl_file for p in plan.plates]
    for plate in ready:
        assert (tmp_path / plate["stl_file"]).stat().st_size > 0
    assert (tmp_path / "live-plan.json").exists()


def test_plates_are_centered_on_the_bed(mixed_design):
    printer = PrinterProfile(bed_x=200, bed_y=200, bed_margin=5)
    plan = plan_print(mixed_design, printer, PlanSettings())

    for plate in plan.plates:
        left = min(p.x for p in plate.parts)
        right = printer.bed_x - max(p.x + p.width for p in plate.parts)
        front = min(p.y for p in plate.parts)
        back = printer.bed_y - max(p.y + p.depth for p in plate.parts)
        assert left == pytest.approx(right, abs=1e-3)
        assert front == pytest.approx(back, abs=1e-3)


def test_manual_positions_override_the_packed_layout(mixed_design):
    printer = PrinterProfile(bed_x=200, bed_y=200, bed_margin=5)
    base = plan_print(mixed_design, printer, PlanSettings())
    target = base.plates[0].parts[0]

    moved = plan_print(
        mixed_design,
        printer,
        PlanSettings(),
        positions={target.node_id: (11.5, 22.5)},
    )

    part = next(
        p for pl in moved.plates for p in pl.parts if p.node_id == target.node_id
    )
    assert (part.x, part.y) == (11.5, 22.5)
    assert not [w for w in moved.warnings if "overlaps" in w]

    clash = plan_print(
        mixed_design,
        printer,
        PlanSettings(),
        positions={target.node_id: (500.0, 500.0)},
    )
    assert any("past the usable bed" in w for w in clash.warnings)
