from pathlib import Path

from typer.testing import CliRunner

from machinewright.main import app
from machinewright.objects.box import Box
from machinewright.registry import register_assembly, register_object
from tests.fixtures.simple_assembly import SimpleAssembly

runner = CliRunner()


def _run_export_step(
    key: str, location: Path, extra_args: list[str] | None = None
) -> None:
    result = runner.invoke(
        app,
        [
            "export",
            "step",
            f"assemblies.{key}",
            "--location",
            str(location),
            *(extra_args or []),
        ],
    )
    assert result.exit_code == 0, result.output


def test_export_step_preserves_assembly_part_color(clean_registry, tmp_path: Path):
    register_assembly(SimpleAssembly)
    key = f"{SimpleAssembly.__module__}.{SimpleAssembly.__qualname__}"
    location = tmp_path / "assembly.step"

    _run_export_step(key, location)

    content = location.read_text()
    assert "COLOUR_RGB" in content
    assert "PLA" in content


def test_export_step_exploded_still_preserves_color(clean_registry, tmp_path: Path):
    register_assembly(SimpleAssembly)
    key = f"{SimpleAssembly.__module__}.{SimpleAssembly.__qualname__}"
    location = tmp_path / "assembly_exploded.step"

    _run_export_step(key, location, extra_args=["--exploded"])

    content = location.read_text()
    assert "COLOUR_RGB" in content
    assert "PLA" in content


def test_export_step_object_still_works(clean_registry, tmp_path: Path):
    register_object(Box)
    key = f"{Box.__module__}.{Box.__qualname__}"
    location = tmp_path / "box.step"

    result = runner.invoke(
        app,
        [
            "export",
            "step",
            f"objects.{key}",
            "--params",
            '{"height": 5, "width": 5, "depth": 5}',
            "--location",
            str(location),
        ],
    )

    assert result.exit_code == 0, result.output
    assert location.exists()
    assert location.stat().st_size > 0
