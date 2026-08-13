from pathlib import Path

from typer.testing import CliRunner

from machinewright.main import app
from machinewright.registry import register_assembly
from tests.fixtures.simple_assembly import NestedPinPair, SimpleAssembly

runner = CliRunner()


def test_print_layout_success(clean_registry, tmp_path: Path):
    register_assembly(SimpleAssembly)
    key = f"{SimpleAssembly.__module__}.{SimpleAssembly.__qualname__}"
    location = tmp_path / "layout.stl"

    result = runner.invoke(
        app, ["export", "print-layout", f"assemblies.{key}", "--location", str(location)]
    )

    assert result.exit_code == 0, result.output
    assert location.exists()
    assert location.stat().st_size > 0


def test_print_layout_no_matching_parts_exits_nonzero(clean_registry, tmp_path: Path):
    register_assembly(NestedPinPair)
    key = f"{NestedPinPair.__module__}.{NestedPinPair.__qualname__}"
    location = tmp_path / "layout.stl"

    result = runner.invoke(
        app, ["export", "print-layout", f"assemblies.{key}", "--location", str(location)]
    )

    assert result.exit_code == 1
    assert not location.exists()


def test_print_layout_rejects_non_assembly_identifier(clean_registry, tmp_path: Path):
    from machinewright.objects.box import Box
    from machinewright.registry import register_object

    register_object(Box)
    key = f"{Box.__module__}.{Box.__qualname__}"
    location = tmp_path / "layout.stl"

    result = runner.invoke(
        app,
        [
            "export",
            "print-layout",
            f"objects.{key}",
            "--params",
            '{"height": 5, "width": 5, "depth": 5}',
            "--location",
            str(location),
        ],
    )

    assert result.exit_code == 1
