import json
from pathlib import Path

from typer.testing import CliRunner

from machinewright.canonical import canonical_json
from machinewright.export_jobs import ExportJobKind, run_export_job
from machinewright.lib.bom import generate_structured_bom
from machinewright.lib.procurement import (
    OrderStatus,
    ProcurementFile,
    load_procurement,
    resolve_line_id,
    save_procurement,
    serialize_procurement,
    sourcing_lines,
    sourcing_totals,
    update_entry,
)
from machinewright.main import app

runner = CliRunner()


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
    assert load_procurement(tmp_path) == data
    assert not list(tmp_path.glob(".bom-procurement.json.*"))  # no scratch left behind


def test_default_entries_are_omitted_and_keys_sorted():
    data = update_entry(ProcurementFile(), "b", supplier="x")
    data = update_entry(data, "a", supplier="y")
    data = update_entry(data, "empty")
    written = json.loads(serialize_procurement(data))
    assert list(written["lines"]) == ["a", "b"]


def test_reads_files_written_by_early_app_versions(tmp_path: Path):
    (tmp_path / "bom-procurement.json").write_text(
        json.dumps(
            {"currency": "EUR", "lines": {"k": {"supplier": "s", "unitCost": 1.5}}}
        )
    )
    data = load_procurement(tmp_path)
    assert data.currency == "EUR" and data.lines["k"].unit_cost == 1.5


def test_merge_totals_and_unsourced(mixed_design):
    bom = generate_structured_bom(mixed_design.graph)
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


def test_resolve_line_id_accepts_unique_prefixes(mixed_design):
    bom = generate_structured_bom(mixed_design.graph)
    full = bom.lines[0].line_id
    assert resolve_line_id(bom, full) == full
    assert resolve_line_id(bom, full.split(":")[1][:12]) == full
    try:
        resolve_line_id(bom, "nomatch")
    except KeyError:
        pass
    else:
        raise AssertionError("expected KeyError")


def test_cli_list_set_export_round_trip(mixed_design, tmp_path: Path):
    bom = _bom_for_project(mixed_design, tmp_path)
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


def test_sourcing_export_job_writes_csv(mixed_design, tmp_path: Path):
    project = tmp_path / "project"
    project.mkdir()
    save_procurement(project, update_entry(ProcurementFile(), "x", supplier="s"))
    result = run_export_job(
        mixed_design,
        ExportJobKind.BOM_SOURCING,
        tmp_path / "dest",
        json.dumps({"project_root": str(project)}),
        basename="demo",
    )
    assert (tmp_path / "dest" / result["file"]).exists()
