import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from machinewright.canonical import canonical_json
from machinewright.export_jobs import ExportJobKind, run_export_job
from machinewright.lib.bom import generate_structured_bom
from machinewright.lib.procurement import (
    OrderStatus,
    ProcurementFile,
    load_procurement,
    parse_procurement,
    part_name,
    resolve_line_id,
    save_procurement,
    serialize_procurement,
    sourcing_lines,
    sourcing_totals,
    sync_procurement,
    update_entry,
)
from machinewright.main import app
from tests.test_export_jobs import Slab, _design

runner = CliRunner()


@pytest.fixture
def purchased_design():
    return _design(
        [
            ("screw-a", Slab(5, 5, 10, "OFF_THE_SHELF")),
            ("screw-b", Slab(5, 5, 10, "OFF_THE_SHELF")),
            ("nut", Slab(8, 8, 4, "OFF_THE_SHELF")),
            ("bracket", Slab(40, 40, 3, "ALUMINUM_6061")),
        ]
    )


def _bom_for_project(design, root: Path):
    bom = generate_structured_bom(design.graph)
    output = root / ".machinewright" / "output"
    output.mkdir(parents=True)
    (output / "assembly-abc.bom.json").write_text(canonical_json(bom), encoding="utf-8")
    return bom


def test_missing_file_is_empty_and_round_trips(tmp_path: Path):
    assert load_procurement(tmp_path) == ProcurementFile()
    data = update_entry(
        ProcurementFile(), "sha256:abc", supplier="McMaster", unit_cost=0.5, spares=2
    )
    save_procurement(tmp_path, data)
    assert load_procurement(tmp_path).lines == data.lines
    assert not list(tmp_path.glob(".bom-procurement.json.*"))  # no scratch left behind


def test_departed_empty_entries_are_dropped_and_lines_are_ordered():
    data = update_entry(ProcurementFile(), "b", supplier="x")
    data = update_entry(data, "a", supplier="y")
    data = update_entry(data, "empty")
    written = json.loads(serialize_procurement(data))
    assert [row["line_id"] for row in written["lines"]] == ["a", "b"]


def test_reads_files_written_by_early_app_versions(tmp_path: Path):
    (tmp_path / "bom-procurement.json").write_text(
        json.dumps(
            {"currency": "EUR", "lines": {"k": {"supplier": "s", "unitCost": 1.5}}}
        )
    )
    data = load_procurement(tmp_path)
    assert data.currency == "EUR" and data.lines["k"].unit_cost == 1.5


def test_sync_prefills_readable_records_with_needs(purchased_design, tmp_path: Path):
    bom = generate_structured_bom(purchased_design.graph)
    purchased = [line for line in bom.lines if line.material_process == "PURCHASED"]
    assert purchased, "fixture should include a purchased part"
    synced = sync_procurement(bom, ProcurementFile())
    save_procurement(tmp_path, synced)

    document = json.loads((tmp_path / "bom-procurement.json").read_text())
    assert "instructions" in document
    assert len(document["lines"]) == len(purchased)
    row = document["lines"][0]
    assert row["part"] and row["needs"] == ["supplier", "sku", "unit_cost"]
    assert list(row)[0] == "part"  # readable header first, hash last
    assert list(row)[-1] == "line_id"

    # Recorded sourcing survives a re-sync; the line stops needing what it has.
    first = row["line_id"]
    filled = update_entry(synced, first, supplier="McMaster", sku="1", unit_cost=1.0)
    again = json.loads(serialize_procurement(sync_procurement(bom, filled)))
    assert next(r for r in again["lines"] if r["line_id"] == first)["needs"] == []

    # A part that leaves the design is kept (it holds data) but flagged.
    gone = sync_procurement(bom.model_copy(update={"lines": ()}), filled)
    kept = json.loads(serialize_procurement(gone))["lines"]
    assert [r["line_id"] for r in kept] == [first] and kept[0]["in_design"] is False
    assert kept[0]["needs"] == []


def test_merge_totals_and_unsourced(purchased_design):
    bom = generate_structured_bom(purchased_design.graph)
    everything = sourcing_lines(bom, ProcurementFile(), purchased_only=False)
    assert everything
    target = everything[0]
    data = update_entry(
        ProcurementFile(),
        target.line_id,
        supplier="Acme",
        unit_cost=2.5,
        spares=1,
        status=OrderStatus.ORDERED,
    )
    lines = sourcing_lines(bom, data, purchased_only=False)
    merged = next(line for line in lines if line.line_id == target.line_id)
    assert merged.order_quantity == merged.quantity + 1
    assert merged.extended_cost == 2.5 * merged.order_quantity
    assert merged.sourced
    totals = sourcing_totals(lines)
    assert totals.by_status["ordered"] == 1
    assert totals.unpriced == len(lines) - 1


def test_resolve_line_id_accepts_unique_prefixes(purchased_design):
    bom = generate_structured_bom(purchased_design.graph)
    full = bom.lines[0].line_id
    assert resolve_line_id(bom, full) == full
    assert resolve_line_id(bom, full.split(":")[1][:12]) == full
    try:
        resolve_line_id(bom, "nomatch")
    except KeyError:
        pass
    else:
        raise AssertionError("expected KeyError")


def test_cli_list_set_export_round_trip(purchased_design, tmp_path: Path):
    bom = _bom_for_project(purchased_design, tmp_path)
    line = bom.lines[0]
    short = line.line_id.split(":")[1][:12]

    result = runner.invoke(
        app,
        [
            "bom",
            "set",
            short,
            "--root",
            str(tmp_path),
            "--supplier",
            "Acme",
            "--unit-cost",
            "3",
            "--status",
            "ordered",
            "--bom",
            str(tmp_path / ".machinewright/output/assembly-abc.bom.json"),
        ],
    )
    assert result.exit_code == 0, result.output
    assert load_procurement(tmp_path).lines[line.line_id].supplier == "Acme"

    listed = runner.invoke(
        app, ["bom", "list", "--root", str(tmp_path), "--all", "--json"]
    )
    assert listed.exit_code == 0, listed.output
    payload = json.loads(listed.output)
    entry = next(item for item in payload["lines"] if item["line_id"] == line.line_id)
    assert entry["entry"]["status"] == "ordered"

    nothing = runner.invoke(app, ["bom", "set", short, "--root", str(tmp_path)])
    assert nothing.exit_code != 0

    out = tmp_path / "out" / "parts.csv"
    exported = runner.invoke(
        app, ["bom", "export", str(out), "--root", str(tmp_path), "--all"]
    )
    assert exported.exit_code == 0, exported.output
    assert "Acme" in out.read_text()


def test_cli_without_a_bom_explains_itself(tmp_path: Path):
    result = runner.invoke(app, ["bom", "list", "--root", str(tmp_path)])
    assert result.exit_code != 0


def test_sourcing_sync_job_prefills_the_file(purchased_design, tmp_path: Path):
    run_export_job(
        purchased_design,
        ExportJobKind.BOM_SOURCING,
        None,
        json.dumps({"project_root": str(tmp_path), "action": "sync"}),
    )
    assert json.loads((tmp_path / "bom-procurement.json").read_text())["lines"]


def test_sourcing_export_job_writes_csv(purchased_design, tmp_path: Path):
    project = tmp_path / "project"
    project.mkdir()
    save_procurement(project, update_entry(ProcurementFile(), "x", supplier="s"))
    result = run_export_job(
        purchased_design,
        ExportJobKind.BOM_SOURCING,
        tmp_path / "dest",
        json.dumps({"project_root": str(project)}),
        basename="demo",
    )
    assert (tmp_path / "dest" / result["file"]).exists()


def test_sample_file_round_trips_byte_for_byte():
    # The app's TypeScript (bomModel.ts) parses and rewrites this same file in its tests, so
    # the two writers cannot drift apart.
    sample = (Path(__file__).parent / "fixtures" / "procurement_sample.json").read_text(
        encoding="utf-8"
    )
    assert serialize_procurement(parse_procurement(sample)) == sample


def test_part_name_keeps_dotted_names_whole():
    assert part_name("parts.common.shim-5x8x0.25") == "shim-5x8x0.25"
    assert part_name("parts.motor.MagnetCap") == "MagnetCap"
    assert part_name("parts.structure.output-carrier-flange") == "output-carrier-flange"
    assert part_name("Slab") == "Slab"
