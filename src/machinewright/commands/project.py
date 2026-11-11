"""Commands for portable Machinewright projects."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from typing import Any

import typer

from machinewright.canonical import canonical_json, content_digest
from machinewright.evaluation import (
    EvaluationCache,
    SweepPoint,
    evaluate_project,
    evaluate_sweep,
    grid_sweep_points,
    linear_sweep_points,
    load_declared_templates,
)
from machinewright.project import load_project
from machinewright.scaffold import create_project
from machinewright.templates import get_machine_template

project = typer.Typer()


def _inputs(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("template inputs must be a JSON object")
    return payload


@project.command("init")
def init(
    name: str,
    starter: str = "basic",
    output_dir: Path = Path("."),
) -> None:
    """Create a new machine design from a bundled starter."""
    try:
        destination = create_project(name, output_dir, starter)
    except (ValueError, OSError) as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(f"Created {destination}")
    typer.echo("Run uv sync in the new project, then follow its README to evaluate it.")


@project.command("validate")
def validate(root: Path = Path(".")) -> None:
    project_root, config = load_project(root)
    load_declared_templates(project_root, config)
    for entry in config.templates:
        get_machine_template(entry.id, entry.version).input_schema()
    typer.echo(f"valid: {config.project_id} ({len(config.templates)} templates)")


@project.command("schema")
def schema(
    template_id: str,
    template_version: str,
    output: Path,
    root: Path = Path("."),
) -> None:
    project_root, config = load_project(root)
    load_declared_templates(project_root, config)
    payload = get_machine_template(template_id, template_version).input_schema()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    typer.echo(str(output))


@project.command("evaluate")
def evaluate(
    template_id: str,
    template_version: str,
    inputs: Path,
    output: Path,
    root: Path = Path("."),
    cache_directory: Path | None = None,
) -> None:
    outcome = evaluate_project(
        root,
        template_id,
        template_version,
        _inputs(inputs),
        output,
        cache=EvaluationCache(cache_directory) if cache_directory else None,
    )
    typer.echo(canonical_json(outcome))


def _point_result(
    point: SweepPoint, outcome_or_error: Any, output: Path
) -> dict[str, Any]:
    if isinstance(outcome_or_error, Exception):
        return {
            "index": point.index,
            "status": "failed",
            "error": str(outcome_or_error),
        }
    outcome = outcome_or_error
    return {
        "index": point.index,
        "status": "succeeded",
        "snapshot": Path(outcome.snapshot_path).relative_to(output).as_posix(),
        "graph_digest": outcome.snapshot.graph_digest,
        "observables": [
            item.model_dump(mode="json") for item in outcome.snapshot.observables
        ],
    }


@project.command("sweep")
def sweep(
    template_id: str,
    template_version: str,
    inputs: Path,
    parameter: str,
    start: float,
    stop: float,
    points: int,
    output: Path,
    root: Path = Path("."),
) -> None:
    """Evaluate a 1D sweep over one dotted input parameter.

    This is the reference sweep semantics RFD-19 M3's native application
    mirrors when building sweep points, and stays runnable headlessly for CI
    reproducibility (hard requirement #10).
    """
    if points < 2:
        raise typer.BadParameter("points must be at least 2")
    baseline = _inputs(inputs)
    sweep_points = linear_sweep_points(parameter, start, stop, points)
    results: list[dict[str, Any]] = []
    for point, outcome_or_error in evaluate_sweep(
        root, template_id, template_version, baseline, sweep_points, output
    ):
        result = _point_result(point, outcome_or_error, output)
        result["value"] = point.coordinates[0].value
        results.append(result)
    output.mkdir(parents=True, exist_ok=True)
    summary = {"parameter": parameter, "points": results}
    summary_path = output / "sweep.json"
    summary_path.write_text(canonical_json(summary) + "\n", encoding="utf-8")
    typer.echo(str(summary_path))


@project.command("sweep2d")
def sweep2d(
    template_id: str,
    template_version: str,
    inputs: Path,
    parameter1: str,
    start1: float,
    stop1: float,
    points1: int,
    parameter2: str,
    start2: float,
    stop2: float,
    points2: int,
    output: Path,
    root: Path = Path("."),
) -> None:
    """Evaluate a 2D grid sweep over two dotted input parameters.

    Shares `evaluate_sweep`'s point-by-point semantics with `sweep`; the grid
    is the cartesian product of both axes, with `parameter2` varying fastest.
    """
    if points1 < 2 or points2 < 2:
        raise typer.BadParameter("points must be at least 2")
    baseline = _inputs(inputs)
    sweep_points = grid_sweep_points(
        [
            (parameter1, start1, stop1, points1),
            (parameter2, start2, stop2, points2),
        ]
    )
    results: list[dict[str, Any]] = []
    for point, outcome_or_error in evaluate_sweep(
        root, template_id, template_version, baseline, sweep_points, output
    ):
        result = _point_result(point, outcome_or_error, output)
        result["coordinates"] = {
            coordinate.parameter_path: coordinate.value
            for coordinate in point.coordinates
        }
        results.append(result)
    output.mkdir(parents=True, exist_ok=True)
    summary = {"parameters": [parameter1, parameter2], "points": results}
    summary_path = output / "sweep.json"
    summary_path.write_text(canonical_json(summary) + "\n", encoding="utf-8")
    typer.echo(str(summary_path))


def _verify_goldens(root: Path) -> None:
    project_root, config = load_project(root)
    with tempfile.TemporaryDirectory(prefix="machinewright-publish-") as temporary:
        scratch = Path(temporary)
        for golden in config.golden_evaluations:
            base = scratch / golden.name
            first = evaluate_project(
                project_root,
                golden.template_id,
                golden.template_version,
                _inputs(project_root / golden.inputs),
                base / "a",
            )
            second = evaluate_project(
                project_root,
                golden.template_id,
                golden.template_version,
                _inputs(project_root / golden.inputs),
                base / "b",
            )
            if first.snapshot.graph_digest != second.snapshot.graph_digest:
                raise RuntimeError(
                    f"golden {golden.name} produced different graph digests"
                )
            if (
                first.snapshot.artifact_manifest_digest
                != second.snapshot.artifact_manifest_digest
            ):
                raise RuntimeError(
                    f"golden {golden.name} produced different manifest digests"
                )
            if (
                golden.expected_graph_digest
                and first.snapshot.graph_digest != golden.expected_graph_digest
            ):
                raise RuntimeError(f"golden {golden.name} graph digest changed")
            if (
                golden.expected_manifest_digest
                and first.snapshot.artifact_manifest_digest
                != golden.expected_manifest_digest
            ):
                raise RuntimeError(f"golden {golden.name} manifest digest changed")


@project.command("package")
def package(root: Path = Path("."), output: Path = Path("dist")) -> None:
    project_root, _ = load_project(root)
    validate(project_root)
    _verify_goldens(project_root)
    destination = output.resolve()
    subprocess.run(
        ["uv", "build", "--out-dir", str(destination)], cwd=project_root, check=True
    )
    files = sorted(path for path in destination.iterdir() if path.is_file())
    manifest: dict[str, Any] = {
        "schema_version": "1.0",
        "artifacts": [
            {
                "name": path.name,
                "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for path in files
            if path.name != "machinewright-package-manifest.json"
        ],
    }
    manifest["logical_digest"] = content_digest(manifest)
    manifest_path = destination / "machinewright-package-manifest.json"
    manifest_path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")
    typer.echo(str(manifest_path))


@project.command("publish")
def publish(root: Path = Path("."), output: Path = Path("dist")) -> None:
    """Build a verified local publication bundle."""

    package(root, output)
