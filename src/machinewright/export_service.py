"""Headless, deterministic multi-artifact export service."""

from __future__ import annotations

from collections.abc import Callable
from enum import StrEnum
import hashlib
from pathlib import Path
import shutil
import sys
import threading
import time

from cadquery import exporters
from pydantic import Field

from machinewright.assemblies.base import CADAssembly
from machinewright.assembly_graph import resolve_assembly
from machinewright.canonical import canonical_json
from machinewright.contracts import Contract
from machinewright.diagnostics import (
    Diagnostic,
    MachinewrightError,
    Severity,
    ValidationReport,
)
from machinewright.lib.bom import generate_structured_bom, write_bom_csv
from machinewright.lib.cadq import exports
from machinewright.lib.layout import layout_for_printing


class ExportFormat(StrEnum):
    STEP = "step"
    STL = "stl"
    PREVIEW_SVG = "preview_svg"
    PRINT_LAYOUT_STL = "print_layout_stl"
    BOM_JSON = "bom_json"
    BOM_CSV = "bom_csv"
    ASSEMBLY_JSON = "assembly_json"
    MANIFEST_JSON = "manifest_json"


class ExportLimits(Contract):
    max_elapsed_seconds: float = Field(default=300, gt=0)
    max_output_bytes: int = Field(default=1_000_000_000, gt=0)
    max_parts: int = Field(default=10_000, gt=0)
    max_memory_bytes: int | None = Field(default=None, gt=0)
    max_cpu_seconds: int | None = Field(default=None, gt=0)


class ExportRequest(Contract):
    formats: tuple[ExportFormat, ...] = tuple(ExportFormat)
    basename: str = Field(default="assembly", pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    limits: ExportLimits = Field(default_factory=ExportLimits)
    stl_tolerance: float = Field(default=0.1, gt=0)
    stl_angular_tolerance: float = Field(default=0.1, gt=0)


class ExportProgress(Contract):
    stage: str
    completed: int = Field(ge=0)
    total: int = Field(gt=0)
    message: str


class ArtifactResult(Contract):
    kind: ExportFormat
    media_type: str
    path: str
    byte_size: int
    digest: str


class ExportResult(Contract):
    assembly_digest: str
    artifacts: tuple[ArtifactResult, ...]


class CancellationToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()


_INFO = {
    ExportFormat.STEP: ("step", "model/step"),
    ExportFormat.STL: ("stl", "model/stl"),
    ExportFormat.PREVIEW_SVG: ("svg", "image/svg+xml"),
    ExportFormat.PRINT_LAYOUT_STL: ("print-layout.stl", "model/stl"),
    ExportFormat.BOM_JSON: ("bom.json", "application/json"),
    ExportFormat.BOM_CSV: ("bom.csv", "text/csv"),
    ExportFormat.ASSEMBLY_JSON: ("assembly.json", "application/json"),
    ExportFormat.MANIFEST_JSON: ("manifest.json", "application/json"),
}


def apply_linux_process_limits(limits: ExportLimits) -> None:
    """Apply hard limits to the current dedicated worker process on Linux."""
    if limits.max_memory_bytes is None and limits.max_cpu_seconds is None:
        return
    if sys.platform != "linux":
        raise MachinewrightError(
            "hard process limits require Linux",
            ValidationReport(
                diagnostics=(
                    Diagnostic(
                        code="export.limits_unsupported",
                        severity=Severity.ERROR,
                        message="memory and CPU limits are supported only in Linux worker processes",
                    ),
                )
            ),
        )
    import resource

    if limits.max_memory_bytes is not None:
        resource.setrlimit(
            resource.RLIMIT_AS, (limits.max_memory_bytes, limits.max_memory_bytes)
        )
    if limits.max_cpu_seconds is not None:
        resource.setrlimit(
            resource.RLIMIT_CPU, (limits.max_cpu_seconds, limits.max_cpu_seconds)
        )


def _digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            sha.update(chunk)
    return "sha256:" + sha.hexdigest()


def export_artifacts(  # noqa: C901 - one transactional artifact pipeline
    assembly: CADAssembly,
    output_directory: str | Path,
    request: ExportRequest | None = None,
    *,
    progress: Callable[[ExportProgress], None] | None = None,
    cancellation: CancellationToken | None = None,
) -> ExportResult:
    """Export requested artifacts, cleaning partial output on any failure.

    Memory and CPU limits are applied to the current process when requested, so
    callers should set them only in a dedicated Linux worker process. Elapsed
    time, part count, cancellation, and output bytes are enforced directly.
    """
    request = request or ExportRequest()
    apply_linux_process_limits(request.limits)
    cancellation = cancellation or CancellationToken()
    destination = Path(output_directory)
    scratch = destination / f".{request.basename}.machinewright-tmp"
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True)
    started = time.monotonic()
    raw = assembly.assemble()
    graph = resolve_assembly(raw, root_id=request.basename)
    part_count = sum(node.kind == "part" for node in graph.nodes)
    if part_count > request.limits.max_parts:
        shutil.rmtree(scratch, ignore_errors=True)
        raise MachinewrightError(
            "part limit exceeded",
            ValidationReport(
                diagnostics=(
                    Diagnostic(
                        code="export.part_limit",
                        severity=Severity.ERROR,
                        message="assembly exceeds maximum part count",
                    ),
                )
            ),
        )
    formats = tuple(dict.fromkeys(request.formats))
    artifacts: list[ArtifactResult] = []

    def checkpoint(index: int, kind: ExportFormat) -> Path:
        if cancellation.cancelled:
            raise MachinewrightError(
                "export cancelled",
                ValidationReport(
                    diagnostics=(
                        Diagnostic(
                            code="export.cancelled",
                            severity=Severity.ERROR,
                            message="export was cancelled",
                        ),
                    )
                ),
            )
        if time.monotonic() - started > request.limits.max_elapsed_seconds:
            raise MachinewrightError(
                "export timed out",
                ValidationReport(
                    diagnostics=(
                        Diagnostic(
                            code="export.timeout",
                            severity=Severity.ERROR,
                            message="export exceeded elapsed-time limit",
                        ),
                    )
                ),
            )
        if progress:
            progress(
                ExportProgress(
                    stage=kind.value,
                    completed=index,
                    total=len(formats),
                    message=f"Generating {kind.value}",
                )
            )
        suffix, _ = _INFO[kind]
        return (
            scratch
            / f"{request.basename}-{graph.content_digest.split(':')[1][:12]}.{suffix}"
        )

    try:
        for index, kind in enumerate(formats):
            path = checkpoint(index, kind)
            if kind == ExportFormat.STEP:
                raw.export(str(path), exportType=exporters.ExportTypes.STEP)  # type: ignore[arg-type]
            elif kind == ExportFormat.STL:
                exporters.export(
                    assembly.cad(),
                    str(path),
                    exportType=exporters.ExportTypes.STL,  # type: ignore[arg-type]
                    tolerance=request.stl_tolerance,
                    angularTolerance=request.stl_angular_tolerance,
                )
            elif kind == ExportFormat.PREVIEW_SVG:
                exports.svg(assembly.cad(), exports.SVGOpts(), str(path))
            elif kind == ExportFormat.PRINT_LAYOUT_STL:
                exporters.export(
                    layout_for_printing(raw),
                    str(path),
                    exportType=exporters.ExportTypes.STL,  # type: ignore[arg-type]
                    tolerance=request.stl_tolerance,
                    angularTolerance=request.stl_angular_tolerance,
                )
            elif kind == ExportFormat.BOM_JSON:
                path.write_text(
                    canonical_json(generate_structured_bom(graph)) + "\n",
                    encoding="utf-8",
                )
            elif kind == ExportFormat.BOM_CSV:
                write_bom_csv(raw, str(path))
            elif kind == ExportFormat.ASSEMBLY_JSON:
                path.write_text(canonical_json(graph) + "\n", encoding="utf-8")
            elif kind == ExportFormat.MANIFEST_JSON:
                manifest = {
                    "schema_version": "1.0",
                    "assembly_digest": graph.content_digest,
                    "artifacts": [item.model_dump(mode="json") for item in artifacts],
                    "limits": request.limits.model_dump(mode="json"),
                }
                path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")
            size = path.stat().st_size
            if (
                sum(item.byte_size for item in artifacts) + size
                > request.limits.max_output_bytes
            ):
                raise MachinewrightError(
                    "output limit exceeded",
                    ValidationReport(
                        diagnostics=(
                            Diagnostic(
                                code="export.output_limit",
                                severity=Severity.ERROR,
                                message="artifacts exceed maximum output bytes",
                            ),
                        )
                    ),
                )
            artifacts.append(
                ArtifactResult(
                    kind=kind,
                    media_type=_INFO[kind][1],
                    path=str(path),
                    byte_size=size,
                    digest=_digest(path),
                )
            )
        destination.mkdir(parents=True, exist_ok=True)
        final: list[ArtifactResult] = []
        for artifact in artifacts:
            source = Path(artifact.path)
            target = destination / source.name
            source.replace(target)
            final.append(artifact.model_copy(update={"path": str(target)}))
        if progress:
            progress(
                ExportProgress(
                    stage="complete",
                    completed=len(formats),
                    total=len(formats),
                    message="Export complete",
                )
            )
        return ExportResult(
            assembly_digest=graph.content_digest, artifacts=tuple(final)
        )
    except Exception:
        shutil.rmtree(scratch, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
