import csv
from pathlib import Path

from typer.testing import CliRunner

from machinewright.main import app
from machinewright.objects.box import Box
from machinewright.registry import register_assembly, register_object
from tests.fixtures.simple_assembly import SimpleAssembly

runner = CliRunner()


def test_bom_success(clean_registry, tmp_path: Path):
    register_assembly(SimpleAssembly)
    key = f"{SimpleAssembly.__module__}.{SimpleAssembly.__qualname__}"
    location = tmp_path / "bom.csv"

    result = runner.invoke(
        app, ["export", "bom", f"assemblies.{key}", "--location", str(location)]
    )

    assert result.exit_code == 0, result.output
    assert location.exists()

    with open(location, newline="") as f:
        rows = list(csv.DictReader(f))
    assert {row["part"] for row in rows} == {"Box", "DowelPin"}


def test_bom_rejects_non_assembly_identifier(clean_registry, tmp_path: Path):
    register_object(Box)
    key = f"{Box.__module__}.{Box.__qualname__}"
    location = tmp_path / "bom.csv"

    result = runner.invoke(
        app,
        [
            "export",
            "bom",
            f"objects.{key}",
            "--params",
            '{"height": 5, "width": 5, "depth": 5}',
            "--location",
            str(location),
        ],
    )

    assert result.exit_code == 1
    assert not location.exists()
