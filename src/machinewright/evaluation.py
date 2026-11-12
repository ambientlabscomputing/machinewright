"""Headless evaluation shared by the CLI, worker, CI, and native application."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
import hashlib
import importlib
from importlib.metadata import PackageNotFoundError, version
import inspect
import itertools
import json
from pathlib import Path
import shutil
import struct
import sys
import tempfile
from typing import Any, Literal

from pydantic import Field, PydanticInvalidForJsonSchema

from machinewright.canonical import canonical_json, content_digest
from machinewright.contracts import Contract
from machinewright.diagnostics import Diagnostic
from machinewright.export_service import (
    ArtifactResult,
    CancellationToken,
    ExportFormat,
    ExportRequest,
    export_artifacts,
)
from machinewright.hardware_graph import PartNode, ResolvedDesign, ResolvedHardwareGraph
from machinewright.project import ProjectConfig, load_project
from machinewright.templates import (
    EvidenceRequirement,
    MachineTemplate,
    Observable,
    get_machine_template,
)


class SourceSpan(Contract):
    path: str
    source_digest: str
    start_byte: int = Field(ge=0)
    end_byte: int = Field(ge=0)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)


class SourceMapping(Contract):
    source_id: str
    node_ids: tuple[str, ...]
    span: SourceSpan


class DependencyRecord(Contract):
    dependency_id: str
    kind: str
    source_ids: tuple[str, ...] = ()
    target_ids: tuple[str, ...] = ()
    conservative: bool = False


class MeshReference(Contract):
    encoding: Literal["mwm1", "mwm2"] = "mwm2"
    graph_node_id: str
    digest: str
    name: str
    byte_size: int
    vertex_count: int
    triangle_count: int
    bounds: tuple[float, float, float, float, float, float] | None = None


class EvaluationProvenance(Contract):
    template_id: str
    template_version: str
    template_source_digest: str
    project_source_digest: str
    environment_digest: str
    input_digest: str
    asset_digest: str
    python_version: str
    machinewright_version: str


class EvaluationSnapshot(Contract):
    generation: int = Field(ge=0)
    graph_digest: str
    artifact_manifest_digest: str
    graph: ResolvedHardwareGraph
    source_mappings: tuple[SourceMapping, ...] = ()
    dependencies: tuple[DependencyRecord, ...] = ()
    diagnostics: tuple[Diagnostic, ...] = ()
    meshes: tuple[MeshReference, ...] = ()
    observables: tuple[Observable, ...] = ()
    evidence_requirements: tuple[EvidenceRequirement, ...] = ()
    control_configuration: dict[str, Any] = Field(default_factory=dict)
    provenance: EvaluationProvenance


class EvaluationOutcome(Contract):
    snapshot: EvaluationSnapshot
    snapshot_path: str
    artifacts: tuple[ArtifactResult, ...]
    cache_hit: bool = False


def _file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _tree_digest(paths: list[Path], root: Path) -> str:
    payload = {
        path.relative_to(root).as_posix(): _file_digest(path)
        for path in sorted(paths)
        if path.is_file()
    }
    return content_digest(payload)


def _source_span(value: Any, root: Path) -> SourceSpan | None:
    try:
        path = Path(inspect.getsourcefile(value) or "").resolve()
        lines, start_line = inspect.getsourcelines(value)
    except (OSError, TypeError):
        return None
    if not path.is_relative_to(root):
        return None
    source = path.read_text(encoding="utf-8")
    source_lines = source.splitlines(keepends=True)
    start_byte = len("".join(source_lines[: start_line - 1]).encode("utf-8"))
    end_byte = start_byte + len("".join(lines).encode("utf-8"))
    return SourceSpan(
        path=path.relative_to(root).as_posix(),
        source_digest=_file_digest(path),
        start_byte=start_byte,
        end_byte=end_byte,
        start_line=start_line,
        end_line=start_line + len(lines) - 1,
    )


def _line_span(path: Path, line: int, root: Path) -> SourceSpan | None:
    path = path.resolve()
    if not path.is_file() or not path.is_relative_to(root):
        return None
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    if line < 1 or line > len(lines):
        return None
    start = len("".join(lines[: line - 1]).encode("utf-8"))
    return SourceSpan(
        path=path.relative_to(root).as_posix(),
        source_digest=_file_digest(path),
        start_byte=start,
        end_byte=start + len(lines[line - 1].encode("utf-8")),
        start_line=line,
        end_line=line,
    )


def _source_mappings(
    template: MachineTemplate, design: ResolvedDesign, root: Path
) -> tuple[SourceMapping, ...]:
    graph = design.graph
    mappings: list[SourceMapping] = []
    for node_id, (path, line) in sorted(design.source_hints.items()):
        span = _line_span(Path(path), line, root)
        if span is not None:
            mappings.append(
                SourceMapping(
                    source_id=f"node:{node_id}", node_ids=(node_id,), span=span
                )
            )
    by_definition: dict[str, list[str]] = {}
    for node in graph.nodes:
        by_definition.setdefault(node.definition_id, []).append(node.node_id)
    for definition_id, node_ids in sorted(by_definition.items()):
        module_name, _, attribute = definition_id.rpartition(".")
        try:
            value = getattr(importlib.import_module(module_name), attribute)
        except (AttributeError, ImportError):
            continue
        span = _source_span(value, root)
        if span is not None:
            mappings.append(
                SourceMapping(
                    source_id=f"definition:{definition_id}",
                    node_ids=tuple(sorted(node_ids)),
                    span=span,
                )
            )
    # The whole-template mapping is broadest (it covers every node) and is
    # therefore emitted last: a consumer that takes the first mapping
    # matching a given node id should land on the narrowest one available.
    function_span = _source_span(template.function, root)
    if function_span is not None:
        mappings.append(
            SourceMapping(
                source_id=f"template:{template.template_id}@{template.version}",
                node_ids=tuple(node.node_id for node in graph.nodes),
                span=function_span,
            )
        )
    return tuple(mappings)


def _vertex_normals(
    positions: list[tuple[float, float, float]], triangles: list[tuple[int, int, int]]
) -> list[list[float]]:
    normals = [[0.0, 0.0, 0.0] for _ in positions]
    for triangle in triangles:
        a, b, c = (positions[index] for index in triangle)
        ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        face_normal = (
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        )
        for index in triangle:
            for axis in range(3):
                normals[index][axis] += face_normal[axis]
    for vertex_normal in normals:
        length = sum(value * value for value in vertex_normal) ** 0.5
        if length:
            for axis in range(3):
                vertex_normal[axis] /= length
        else:
            vertex_normal[2] = 1.0
    return normals


def _mesh_bounds(
    positions: list[tuple[float, float, float]],
) -> tuple[float, float, float, float, float, float]:
    if not positions:
        return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    return (
        min(point[0] for point in positions),
        min(point[1] for point in positions),
        min(point[2] for point in positions),
        max(point[0] for point in positions),
        max(point[1] for point in positions),
        max(point[2] for point in positions),
    )


def _write_meshes(design: ResolvedDesign, destination: Path) -> tuple[MeshReference, ...]:
    mesh_dir = destination / "meshes"
    mesh_dir.mkdir(parents=True, exist_ok=True)
    references: list[MeshReference] = []
    # `design.geometries` holds each part's local/canonical shape; nodes at a
    # non-identity transform must be placed in world space before tessellating,
    # the same way `ResolvedDesign.cad(exploded=True)` does via `.located(...)`,
    # or every part with the same local geometry renders coincident regardless
    # of its actual position in the assembly.
    transforms = {
        node.node_id: node.transform
        for node in design.graph.nodes
        if isinstance(node, PartNode)
    }
    for node_id, shape in sorted(design.geometries.items()):
        transform = transforms.get(node_id)
        located_shape = shape.located(transform.location()) if transform is not None else shape
        vertices, triangles = located_shape.tessellate(0.1, 0.1)
        positions = [
            (float(vertex.x), float(vertex.y), float(vertex.z)) for vertex in vertices
        ]
        normals = _vertex_normals(positions, triangles)
        bounds = _mesh_bounds(positions)
        payload = bytearray(b"MWM2")
        payload.extend(struct.pack("<II", len(vertices), len(triangles)))
        payload.extend(struct.pack("<ffffff", *bounds))
        for position, normal in zip(positions, normals, strict=True):
            payload.extend(struct.pack("<ffffff", *position, *normal))
        for triangle in triangles:
            payload.extend(struct.pack("<III", *triangle))
        digest = "sha256:" + hashlib.sha256(payload).hexdigest()
        name = f"{digest.removeprefix('sha256:')}.mwm"
        path = mesh_dir / name
        if not path.exists():
            path.write_bytes(payload)
        references.append(
            MeshReference(
                encoding="mwm2",
                graph_node_id=node_id,
                digest=digest,
                name=f"meshes/{name}",
                byte_size=len(payload),
                vertex_count=len(vertices),
                triangle_count=len(triangles),
                bounds=bounds,
            )
        )
    return tuple(references)


def _load_callable(dotted: str) -> Any:
    module_name, separator, attribute_path = dotted.partition(":")
    if not separator:
        raise ValueError(
            f"template callable must use module:attribute syntax: {dotted}"
        )
    value: Any = importlib.import_module(module_name)
    for attribute in attribute_path.split("."):
        value = getattr(value, attribute)
    return value


def load_declared_templates(root: Path, config: ProjectConfig) -> None:
    source = root / "src"
    import_roots = (root, source) if source.is_dir() else (root,)
    for import_root in import_roots:
        if str(import_root) not in sys.path:
            sys.path.insert(0, str(import_root))
    for entry in config.templates:
        value = _load_callable(entry.callable)
        declared = getattr(value, "__machinewright_template__", None)
        if declared is None:
            raise ValueError(
                f"{entry.callable} is not decorated with @machine_template"
            )
        if (declared.template_id, declared.version) != (entry.id, entry.version):
            raise ValueError(f"metadata mismatch for template {entry.callable}")


class EvaluationCache:
    def __init__(self, root: Path):
        self.root = root

    def restore(self, key: str, destination: Path) -> EvaluationOutcome | None:
        cached = self.root / key.removeprefix("sha256:")
        outcome_path = cached / "outcome.json"
        if not outcome_path.is_file():
            return None
        for item in cached.iterdir():
            if item.name == "outcome.json":
                continue
            target = destination / item.name
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)
        payload = json.loads(outcome_path.read_text(encoding="utf-8"))
        payload["cache_hit"] = True
        payload["snapshot_path"] = str(destination / "evaluation-snapshot.json")
        payload["artifacts"] = [
            {**artifact, "path": str(destination / Path(artifact["path"]).name)}
            for artifact in payload["artifacts"]
        ]
        return EvaluationOutcome.model_validate(payload, strict=False)

    def store(self, key: str, destination: Path, outcome: EvaluationOutcome) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / key.removeprefix("sha256:")
        if target.exists():
            return
        temporary = Path(tempfile.mkdtemp(prefix="machinewright-cache-", dir=self.root))
        try:
            for item in destination.iterdir():
                if item.is_dir():
                    shutil.copytree(item, temporary / item.name)
                else:
                    shutil.copy2(item, temporary / item.name)
            portable = outcome.model_dump(mode="json")
            portable["snapshot_path"] = "evaluation-snapshot.json"
            for artifact in portable["artifacts"]:
                artifact["path"] = Path(artifact["path"]).name
            (temporary / "outcome.json").write_text(
                canonical_json(portable) + "\n", encoding="utf-8"
            )
            temporary.replace(target)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)


def evaluate_project(
    project_root: Path,
    template_id: str,
    template_version: str,
    inputs: Mapping[str, Any],
    output_directory: Path,
    *,
    generation: int = 0,
    request: ExportRequest | None = None,
    cancellation: CancellationToken | None = None,
    progress: Callable[[Any], None] | None = None,
    cache: EvaluationCache | None = None,
    on_input_schema: Callable[[dict[str, Any]], None] | None = None,
) -> EvaluationOutcome:
    root, config = load_project(project_root)
    load_declared_templates(root, config)
    template = get_machine_template(template_id, template_version)
    if on_input_schema is not None:
        try:
            schema = template.input_schema()
        except PydanticInvalidForJsonSchema:
            pass
        else:
            on_input_schema(schema)
    source_files = list(root.rglob("*.py")) + [root / "machinewright.toml"]
    project_source_digest = _tree_digest(source_files, root)
    environment_digest = _file_digest(root / config.environment_lock)
    asset_files = [
        item
        for pattern in config.assets
        for item in root.glob(pattern)
        if item.is_file()
    ]
    asset_digest = _tree_digest(asset_files, root)
    cache_key = content_digest(
        {
            "template": [template_id, template_version],
            # Revision 1 cached part-local meshes; revision 2 cached snapshots
            # without PartNode.material_process.
            "viewport_mesh_revision": 3,
            "inputs": inputs,
            "project_source_digest": project_source_digest,
            "environment_digest": environment_digest,
            "asset_digest": asset_digest,
            "request": request or ExportRequest(),
        }
    )
    output_directory.mkdir(parents=True, exist_ok=True)
    if template.cacheable and cache is not None:
        restored = cache.restore(cache_key, output_directory)
        if restored is not None:
            return restored

    result = template.evaluate(inputs)
    export_request = request or ExportRequest()
    artifacts = export_artifacts(
        result.design,
        output_directory,
        export_request,
        progress=progress,
        cancellation=cancellation,
    ).artifacts
    manifest = next(
        item for item in artifacts if item.kind == ExportFormat.MANIFEST_JSON
    )
    mappings = _source_mappings(template, result.design, root)
    template_span = _source_span(template.function, root)
    template_source_digest = (
        template_span.source_digest
        if template_span is not None
        else project_source_digest
    )
    dependencies = (
        DependencyRecord(
            dependency_id=f"template:{template_id}@{template_version}",
            kind="python_function",
            source_ids=tuple(item.source_id for item in mappings),
            target_ids=tuple(node.node_id for node in result.design.graph.nodes),
            conservative=True,
        ),
    )
    provenance = EvaluationProvenance(
        template_id=template_id,
        template_version=template_version,
        template_source_digest=template_source_digest,
        project_source_digest=project_source_digest,
        environment_digest=environment_digest,
        input_digest=content_digest(inputs),
        asset_digest=asset_digest,
        python_version=sys.version.split()[0],
        machinewright_version=_machinewright_version(),
    )
    snapshot = EvaluationSnapshot(
        generation=generation,
        graph_digest=result.design.graph.graph_digest,
        artifact_manifest_digest=manifest.digest,
        graph=result.design.graph,
        source_mappings=mappings,
        dependencies=dependencies,
        diagnostics=result.diagnostics,
        meshes=_write_meshes(result.design, output_directory),
        observables=result.observables,
        evidence_requirements=result.evidence_requirements,
        control_configuration=dict(result.control_configuration or {}),
        provenance=provenance,
    )
    snapshot_path = output_directory / "evaluation-snapshot.json"
    snapshot_path.write_text(canonical_json(snapshot) + "\n", encoding="utf-8")
    outcome = EvaluationOutcome(
        snapshot=snapshot,
        snapshot_path=str(snapshot_path),
        artifacts=artifacts,
    )
    if template.cacheable and cache is not None:
        cache.store(cache_key, output_directory, outcome)
    return outcome


@dataclass(frozen=True)
class SweepCoordinate:
    """One axis value of a sweep point: a dotted input path and its value."""

    parameter_path: str
    value: float


@dataclass(frozen=True)
class SweepPoint:
    """One evaluation point in a 1D or 2D sweep, addressed by `index`."""

    index: int
    coordinates: tuple[SweepCoordinate, ...]


def linear_sweep_points(
    parameter: str, start: float, stop: float, points: int
) -> tuple[SweepPoint, ...]:
    """The 1D sweep semantics of the reference `project sweep` CLI, factored out for reuse."""
    if points < 2:
        raise ValueError("points must be at least 2")
    return tuple(
        SweepPoint(
            index=index,
            coordinates=(
                SweepCoordinate(
                    parameter, start + (stop - start) * index / (points - 1)
                ),
            ),
        )
        for index in range(points)
    )


def grid_sweep_points(
    axes: Sequence[tuple[str, float, float, int]],
) -> tuple[SweepPoint, ...]:
    """A 2D (or N-D) sweep as the full cartesian product of independently linear axes.

    `axes` is a sequence of `(parameter_path, start, stop, points)`. Point
    indices are assigned in row-major order over the axes as given, so the
    last axis varies fastest — matching how the CLI writes `point-XXXX`
    directories in a stable, deterministic order.
    """
    if len(axes) < 1:
        raise ValueError("at least one sweep axis is required")
    axis_values: list[list[SweepCoordinate]] = []
    for parameter, start, stop, count in axes:
        if count < 2:
            raise ValueError("points must be at least 2")
        axis_values.append(
            [
                SweepCoordinate(parameter, start + (stop - start) * index / (count - 1))
                for index in range(count)
            ]
        )
    return tuple(
        SweepPoint(index=index, coordinates=tuple(combination))
        for index, combination in enumerate(itertools.product(*axis_values))
    )


def apply_sweep_coordinates(
    baseline_inputs: Mapping[str, Any], coordinates: Sequence[SweepCoordinate]
) -> dict[str, Any]:
    """Applies each coordinate's dotted `parameter_path` onto a copy of `baseline_inputs`."""
    point_inputs: dict[str, Any] = json.loads(json.dumps(baseline_inputs))
    for coordinate in coordinates:
        target = point_inputs
        segments = coordinate.parameter_path.split(".")
        for segment in segments[:-1]:
            child = target.setdefault(segment, {})
            if not isinstance(child, dict):
                raise ValueError(
                    f"{coordinate.parameter_path} does not address an object field"
                )
            target = child
        target[segments[-1]] = coordinate.value
    return point_inputs


def evaluate_sweep_point(
    project_root: Path,
    template_id: str,
    template_version: str,
    baseline_inputs: Mapping[str, Any],
    point: SweepPoint,
    output_directory: Path,
    *,
    cancellation: CancellationToken | None = None,
    progress: Callable[[Any], None] | None = None,
    cache: EvaluationCache | None = None,
) -> EvaluationOutcome:
    """Evaluates one sweep point, writing its snapshot under `output_directory/point-XXXX`.

    Each point gets its own generation (`point.index + 1`), matching the
    existing `project sweep` CLI so per-point snapshots stay independently
    loadable — RFD-19 M3's "load graph and geometry snapshots for selected
    evaluation points."
    """
    point_inputs = apply_sweep_coordinates(baseline_inputs, point.coordinates)
    point_dir = output_directory / f"point-{point.index:04d}"
    return evaluate_project(
        project_root,
        template_id,
        template_version,
        point_inputs,
        point_dir,
        generation=point.index + 1,
        cancellation=cancellation,
        progress=progress,
        cache=cache,
    )


def evaluate_sweep(
    project_root: Path,
    template_id: str,
    template_version: str,
    baseline_inputs: Mapping[str, Any],
    points: Sequence[SweepPoint],
    output_directory: Path,
    *,
    cancellation: CancellationToken | None = None,
    progress: Callable[[Any], None] | None = None,
    cache: EvaluationCache | None = None,
) -> Iterator[tuple[SweepPoint, EvaluationOutcome | Exception]]:
    """Evaluates `points` in order, yielding `(point, outcome_or_error)` as each completes.

    Cancellation is checked *between* points, not inside one: a single
    point's own `template.evaluate()` call is not preemptible today (only
    `export_artifacts()` observes the token), so a cancelled sweep stops
    scheduling further points rather than aborting whichever point is
    in-flight. This matches the advisory (non-synchronous) cancellation
    model the worker protocol already uses for single evaluations.
    """
    for point in points:
        if cancellation is not None and cancellation.cancelled:
            return
        try:
            outcome = evaluate_sweep_point(
                project_root,
                template_id,
                template_version,
                baseline_inputs,
                point,
                output_directory,
                cancellation=cancellation,
                progress=progress,
                cache=cache,
            )
            yield point, outcome
        except Exception as error:  # noqa: BLE001 - reported to the caller, not swallowed
            yield point, error


def _machinewright_version() -> str:
    try:
        return version("machinewright")
    except PackageNotFoundError:
        return "unknown"
