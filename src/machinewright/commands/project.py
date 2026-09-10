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
    evaluate_project,
    load_declared_templates,
)
from machinewright.project import load_project
from machinewright.templates import get_machine_template

project = typer.Typer()


def _inputs(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("template inputs must be a JSON object")
    return payload


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
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
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
    if points < 2:
        raise typer.BadParameter("points must be at least 2")
    baseline = _inputs(inputs)
    results: list[dict[str, Any]] = []
    for index in range(points):
        value = start + (stop - start) * index / (points - 1)
        point_inputs = dict(baseline)
        target = point_inputs
        segments = parameter.split(".")
        for segment in segments[:-1]:
            child = target.setdefault(segment, {})
            if not isinstance(child, dict):
                raise typer.BadParameter(f"{parameter} does not address an object field")
            target = child
        target[segments[-1]] = value
        point_dir = output / f"point-{index:04d}"
        try:
            outcome = evaluate_project(
                root,
                template_id,
                template_version,
                point_inputs,
                point_dir,
                generation=index + 1,
            )
            results.append(
                {
                    "index": index,
                    "value": value,
                    "status": "succeeded",
                    "snapshot": Path(outcome.snapshot_path).relative_to(output).as_posix(),
                    "graph_digest": outcome.snapshot.graph_digest,
                    "observables": [
                        item.model_dump(mode="json") for item in outcome.snapshot.observables
                    ],
                }
            )
        except Exception as error:
            results.append(
                {"index": index, "value": value, "status": "failed", "error": str(error)}
            )
    output.mkdir(parents=True, exist_ok=True)
    summary = {"parameter": parameter, "points": results}
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
                raise RuntimeError(f"golden {golden.name} produced different graph digests")
            if first.snapshot.artifact_manifest_digest != second.snapshot.artifact_manifest_digest:
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
