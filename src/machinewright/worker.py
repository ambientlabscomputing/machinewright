"""Long-lived isolated evaluator using length-delimited Protobuf over stdio."""

from __future__ import annotations

import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
from pathlib import Path
import queue
import shutil
import struct
import sys
import tempfile
import threading
import traceback
from typing import BinaryIO

from machinewright.canonical import canonical_json
from machinewright.diagnostics import MachinewrightError
from machinewright.evaluation import (
    SweepCoordinate,
    SweepPoint,
    evaluate_project,
    evaluate_sweep_point,
)
from machinewright.export_jobs import (
    ExportCancelledError,
    ExportJobKind,
    evaluate_design,
    run_export_job,
)
from machinewright.export_service import CancellationToken, ExportProgress
from machinewright.project import load_project
from machinewright.protocol import machinewright_worker_pb2 as protocol
from machinewright.registry import clear_registry
from machinewright.templates import clear_machine_templates

PROTOCOL_VERSION = 1
CAPABILITIES = (
    "input_schema.v1",
    "evaluation.v1",
    "source_overlays.v1",
    "progress.v1",
    "cancellation.v1",
    "content_addressed_meshes.v1",
    "sweep_evaluation.v1",
    "export_jobs.v1",
)


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


_MaterializableRequest = (
    protocol.EvaluateProject | protocol.EvaluateSweepPoint | protocol.RunExportJob
)


def _verify_environment(request: _MaterializableRequest) -> None:
    if not request.environment_digest:
        return
    root, config = load_project(Path(request.project_root))
    actual = (
        "sha256:"
        + hashlib.sha256((root / config.environment_lock).read_bytes()).hexdigest()
    )
    if actual != request.environment_digest:
        raise RuntimeError(
            "environment lock changed after evaluation was requested: "
            f"expected {request.environment_digest}, found {actual}"
        )


def _read_exact(stream: BinaryIO, size: int) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = stream.read(size - len(chunks))
        if not chunk:
            return None
        chunks.extend(chunk)
    return bytes(chunks)


def read_request(stream: BinaryIO) -> protocol.WorkerRequest | None:
    header = _read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack("<I", header)[0]
    if size > 64 * 1024 * 1024:
        raise ValueError("worker message exceeds 64 MiB")
    payload = _read_exact(stream, size)
    if payload is None:
        raise EOFError("truncated worker message")
    message = protocol.WorkerRequest()
    message.ParseFromString(payload)
    return message


class EventWriter:
    def __init__(self, stream: BinaryIO):
        self.stream = stream
        self.lock = threading.Lock()

    def write(self, event: protocol.WorkerEvent) -> None:
        payload = event.SerializeToString()
        with self.lock:
            self.stream.write(struct.pack("<I", len(payload)))
            self.stream.write(payload)
            self.stream.flush()


def _materialize_overlay(request: _MaterializableRequest) -> tuple[Path, Path | None]:
    root = Path(request.project_root).resolve()
    if not request.overlays:
        return root, None
    temporary = Path(tempfile.mkdtemp(prefix="machinewright-overlay-"))
    snapshot = temporary / "project"
    shutil.copytree(
        root,
        snapshot,
        ignore=shutil.ignore_patterns(
            ".git", ".venv", ".mypy_cache", ".pytest_cache", "target", "dist"
        ),
    )
    snapshot = snapshot.resolve()
    for overlay in request.overlays:
        relative = Path(overlay.relative_path)
        target = (snapshot / relative).resolve()
        if relative.is_absolute() or not target.is_relative_to(snapshot):
            raise ValueError(f"overlay path escapes project: {overlay.relative_path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(overlay.content)
    return snapshot, temporary


def _evaluated_source_digests(project_root: Path) -> list[protocol.SourceDigest]:
    ignored = {".git", ".venv", ".mypy_cache", ".pytest_cache", "target", "dist"}
    digests = []
    for path in sorted(project_root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in ignored for part in path.relative_to(project_root).parts):
            continue
        relative = path.relative_to(project_root).as_posix()
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        digests.append(protocol.SourceDigest(relative_path=relative, digest=digest))
    return digests


def _clear_modules(project_root: Path) -> None:
    for name, module in tuple(sys.modules.items()):
        source = getattr(module, "__file__", None)
        if source is None:
            continue
        try:
            relative = Path(source).resolve().relative_to(project_root)
            belongs = not any(
                part in {".venv", "site-packages", "dist-packages"}
                for part in relative.parts
            )
        except OSError:
            belongs = False
        except ValueError:
            belongs = False
        if belongs and not name.startswith("machinewright"):
            sys.modules.pop(name, None)
    # Mirrors the import roots `load_declared_templates` inserts (project_root
    # and project_root/src); those entries point at a temp overlay root that
    # is about to be discarded, so leaving them in sys.path would let a later
    # `import_module` resolve names against a deleted directory.
    for import_root in (project_root, project_root / "src"):
        entry = str(import_root)
        while entry in sys.path:
            sys.path.remove(entry)
    clear_registry()
    clear_machine_templates()


class Worker:
    def __init__(self, writer: EventWriter):
        self.writer = writer
        self.cancellations: dict[tuple[str, int], CancellationToken] = {}
        self.cancelled_before_start: set[tuple[str, int]] = set()
        # Sweep points are keyed by (session_id, sweep_id, point_index) since a
        # sweep spans many points rather than one generation. `CancelSweep`
        # only carries (session_id, sweep_id) — it cancels whichever point of
        # that sweep is currently in flight on this worker and marks the
        # sweep so any point dispatched to this worker afterwards is
        # cancelled immediately too, mirroring `cancelled_before_start` above.
        self.sweep_cancellations: dict[tuple[str, int, int], CancellationToken] = {}
        self.cancelled_sweeps: set[tuple[str, int]] = set()
        # Export jobs are keyed by (session_id, job_id); cancellation is
        # advisory and checked between files/plates inside the job.
        self.export_cancellations: dict[tuple[str, int], CancellationToken] = {}
        self.cancelled_exports: set[tuple[str, int]] = set()
        self.lock = threading.Lock()
        # The project root actually materialized (and imported from) by the
        # previous evaluation, so the next call can evict its modules/sys.path
        # entries instead of the fixed original project_root, which is never
        # what gets imported when overlays are present.
        self._last_project_root: Path | None = None

    def evaluate(self, request: protocol.EvaluateProject) -> None:
        token = CancellationToken()
        key = (request.session_id, request.generation)
        with self.lock:
            self.cancellations[key] = token
            if key in self.cancelled_before_start:
                token.cancel()
                self.cancelled_before_start.remove(key)
        # CadQuery/Open CASCADE evaluation must stay on the worker process's
        # main thread. Some native CAD operations crash when invoked from a
        # Python-created background thread.
        self._evaluate(request, token)

    def cancel(self, request: protocol.CancelEvaluation) -> None:
        with self.lock:
            token = self.cancellations.get((request.session_id, request.generation))
            if token is None:
                self.cancelled_before_start.add(
                    (request.session_id, request.generation)
                )
            else:
                token.cancel()

    def evaluate_sweep_point(self, request: protocol.EvaluateSweepPoint) -> None:
        token = CancellationToken()
        sweep_key = (request.session_id, request.sweep_id)
        point_key = (request.session_id, request.sweep_id, request.point_index)
        with self.lock:
            self.sweep_cancellations[point_key] = token
            if sweep_key in self.cancelled_sweeps:
                token.cancel()
        # Same constraint as `evaluate()`: CAD evaluation must stay on this
        # process's main thread.
        self._evaluate_sweep_point(request, token)

    def cancel_sweep(self, request: protocol.CancelSweep) -> None:
        sweep_key = (request.session_id, request.sweep_id)
        with self.lock:
            self.cancelled_sweeps.add(sweep_key)
            for key, token in self.sweep_cancellations.items():
                if key[0] == request.session_id and key[1] == request.sweep_id:
                    token.cancel()

    def _evaluate_sweep_point(
        self, request: protocol.EvaluateSweepPoint, token: CancellationToken
    ) -> None:
        temporary: Path | None = None
        project_root: Path | None = None
        session_id = request.session_id
        sweep_id = request.sweep_id
        point_index = request.point_index
        point_key = (session_id, sweep_id, point_index)
        try:
            _verify_environment(request)
            if self._last_project_root is not None:
                _clear_modules(self._last_project_root)
            project_root, temporary = _materialize_overlay(request)
            baseline_inputs = json.loads(request.baseline_inputs_json)
            point = SweepPoint(
                index=request.point_index,
                coordinates=tuple(
                    SweepCoordinate(coordinate.parameter_path, coordinate.value)
                    for coordinate in request.coordinates
                ),
            )
            outcome = evaluate_sweep_point(
                project_root,
                request.template_id,
                request.template_version,
                baseline_inputs,
                point,
                Path(request.output_directory),
                cancellation=token,
            )
            if token.cancelled:
                self.writer.write(
                    protocol.WorkerEvent(
                        sweep_point_cancelled=protocol.SweepPointCancelled(
                            session_id=session_id,
                            sweep_id=sweep_id,
                            point_index=point_index,
                        )
                    )
                )
            else:
                self.writer.write(
                    protocol.WorkerEvent(
                        sweep_point_completed=protocol.SweepPointCompleted(
                            session_id=session_id,
                            sweep_id=sweep_id,
                            point_index=point_index,
                            snapshot_path=outcome.snapshot_path,
                            graph_digest=outcome.snapshot.graph_digest,
                            artifact_manifest_digest=outcome.snapshot.artifact_manifest_digest,
                        )
                    )
                )
        except Exception as error:
            event = protocol.WorkerEvent()
            if token.cancelled:
                event.sweep_point_cancelled.CopyFrom(
                    protocol.SweepPointCancelled(
                        session_id=session_id,
                        sweep_id=sweep_id,
                        point_index=point_index,
                    )
                )
            else:
                event.sweep_point_failed.CopyFrom(
                    protocol.SweepPointFailed(
                        session_id=session_id,
                        sweep_id=sweep_id,
                        point_index=point_index,
                        code="sweep_point.failed",
                        message=str(error),
                    )
                )
            self.writer.write(event)
        finally:
            with self.lock:
                self.sweep_cancellations.pop(point_key, None)
            if project_root is not None:
                self._last_project_root = project_root
            if temporary is not None:
                shutil.rmtree(temporary, ignore_errors=True)

    def _evaluate(
        self, request: protocol.EvaluateProject, token: CancellationToken
    ) -> None:
        temporary: Path | None = None
        project_root: Path | None = None
        key = (request.session_id, request.generation)

        def progress(item: ExportProgress) -> None:
            self.writer.write(
                protocol.WorkerEvent(
                    progress=protocol.EvaluationProgress(
                        session_id=request.session_id,
                        generation=request.generation,
                        stage=item.stage,
                        completed=item.completed,
                        total=item.total,
                        message=item.message,
                    )
                )
            )

        try:
            _verify_environment(request)
            if self._last_project_root is not None:
                _clear_modules(self._last_project_root)
            project_root, temporary = _materialize_overlay(request)
            inputs = json.loads(request.inputs_json)
            outcome = evaluate_project(
                project_root,
                request.template_id,
                request.template_version,
                inputs,
                Path(request.output_directory),
                generation=request.generation,
                cancellation=token,
                progress=progress,
                on_input_schema=lambda schema: self.writer.write(
                    protocol.WorkerEvent(
                        input_schema=protocol.EvaluationInputSchema(
                            session_id=request.session_id,
                            generation=request.generation,
                            schema_json=canonical_json(schema).encode(),
                        )
                    )
                ),
            )
            if token.cancelled:
                self.writer.write(
                    protocol.WorkerEvent(
                        cancelled=protocol.EvaluationCancelled(
                            session_id=request.session_id, generation=request.generation
                        )
                    )
                )
            else:
                self.writer.write(
                    protocol.WorkerEvent(
                        completed=protocol.EvaluationCompleted(
                            session_id=request.session_id,
                            generation=request.generation,
                            snapshot_path=outcome.snapshot_path,
                            graph_digest=outcome.snapshot.graph_digest,
                            artifact_manifest_digest=outcome.snapshot.artifact_manifest_digest,
                            evaluated_sources=_evaluated_source_digests(project_root),
                        )
                    )
                )
        except Exception as error:
            diagnostics = []
            if isinstance(error, MachinewrightError):
                diagnostics = [
                    item.model_dump(mode="json") for item in error.report.diagnostics
                ]
            code = "evaluation.cancelled" if token.cancelled else "evaluation.failed"
            event = protocol.WorkerEvent()
            if token.cancelled:
                event.cancelled.CopyFrom(
                    protocol.EvaluationCancelled(
                        session_id=request.session_id, generation=request.generation
                    )
                )
            else:
                event.failed.CopyFrom(
                    protocol.EvaluationFailed(
                        session_id=request.session_id,
                        generation=request.generation,
                        code=code,
                        message=str(error),
                        traceback=traceback.format_exc(),
                        diagnostics_json=canonical_json(diagnostics).encode(),
                    )
                )
            self.writer.write(event)
        finally:
            with self.lock:
                self.cancellations.pop(key, None)
            if project_root is not None:
                self._last_project_root = project_root
            if temporary is not None:
                shutil.rmtree(temporary, ignore_errors=True)

    def run_export(self, request: protocol.RunExportJob) -> None:
        key = (request.session_id, request.job_id)
        token = CancellationToken()
        with self.lock:
            self.export_cancellations[key] = token
            if key in self.cancelled_exports:
                token.cancel()
                self.cancelled_exports.discard(key)
        # Same constraint as `evaluate()`: CAD work stays on the main thread.
        self._run_export(request, token)

    def cancel_export(self, request: protocol.CancelExportJob) -> None:
        key = (request.session_id, request.job_id)
        with self.lock:
            token = self.export_cancellations.get(key)
            if token is None:
                self.cancelled_exports.add(key)
            else:
                token.cancel()

    def _run_export(
        self, request: protocol.RunExportJob, token: CancellationToken
    ) -> None:
        temporary: Path | None = None
        project_root: Path | None = None
        key = (request.session_id, request.job_id)

        def progress(stage: str, completed: int, total: int, message: str) -> None:
            self.writer.write(
                protocol.WorkerEvent(
                    export_progress=protocol.ExportJobProgress(
                        session_id=request.session_id,
                        job_id=request.job_id,
                        stage=stage,
                        completed=completed,
                        total=max(total, 1),
                        message=message,
                    )
                )
            )

        try:
            _verify_environment(request)
            if self._last_project_root is not None:
                _clear_modules(self._last_project_root)
            project_root, temporary = _materialize_overlay(request)
            design = evaluate_design(
                project_root,
                request.template_id,
                request.template_version,
                json.loads(request.inputs_json),
            )
            if token.cancelled:
                raise ExportCancelledError
            destination = (
                Path(request.output_directory) if request.output_directory else None
            )
            result = run_export_job(
                design,
                ExportJobKind(request.kind),
                destination,
                request.options_json,
                basename=request.basename or "assembly",
                progress=progress,
                cancellation=token,
            )
            self.writer.write(
                protocol.WorkerEvent(
                    export_completed=protocol.ExportJobCompleted(
                        session_id=request.session_id,
                        job_id=request.job_id,
                        output_directory=request.output_directory,
                        # Plain JSON, not canonical_json: that encodes floats as
                        # strings for content-addressing, which we don't need here.
                        result_json=json.dumps(result).encode(),
                    )
                )
            )
        except ExportCancelledError:
            self.writer.write(
                protocol.WorkerEvent(
                    export_cancelled=protocol.ExportJobCancelled(
                        session_id=request.session_id, job_id=request.job_id
                    )
                )
            )
        except Exception as error:
            self.writer.write(
                protocol.WorkerEvent(
                    export_failed=protocol.ExportJobFailed(
                        session_id=request.session_id,
                        job_id=request.job_id,
                        code="export.failed",
                        message=str(error),
                        traceback=traceback.format_exc(),
                    )
                )
            )
        finally:
            with self.lock:
                self.export_cancellations.pop(key, None)
            if project_root is not None:
                self._last_project_root = project_root
            if temporary is not None:
                shutil.rmtree(temporary, ignore_errors=True)

    def shutdown(self) -> None:
        with self.lock:
            for token in self.cancellations.values():
                token.cancel()
            for token in self.sweep_cancellations.values():
                token.cancel()
            for token in self.export_cancellations.values():
                token.cancel()


def main() -> None:  # noqa: C901 - protocol dispatch loop
    # VTK's lazy module initialization is not safe when another Python thread
    # is already running on macOS.  Load the CAD stack before starting the
    # protocol reader so later template imports reuse fully initialized modules.
    __import__("cadquery")
    __import__("vtkmodules.util.data_model")
    writer = EventWriter(sys.stdout.buffer)
    worker = Worker(writer)
    commands: queue.Queue[tuple[str, object | None]] = queue.Queue()

    def read_commands() -> None:
        while request := read_request(sys.stdin.buffer):
            kind = request.WhichOneof("request")
            if kind == "hello":
                commands.put(("hello", request.hello))
            elif kind == "evaluate":
                commands.put(("evaluate", request.evaluate))
            elif kind == "cancel":
                worker.cancel(request.cancel)
            elif kind == "evaluate_sweep_point":
                commands.put(("evaluate_sweep_point", request.evaluate_sweep_point))
            elif kind == "cancel_sweep":
                worker.cancel_sweep(request.cancel_sweep)
            elif kind == "run_export_job":
                commands.put(("run_export_job", request.run_export_job))
            elif kind == "cancel_export_job":
                worker.cancel_export(request.cancel_export_job)
            elif kind == "shutdown":
                commands.put(("shutdown", None))
                return
        commands.put(("shutdown", None))

    reader = threading.Thread(
        target=read_commands, name="machinewright-protocol", daemon=True
    )
    reader.start()
    try:
        while True:
            kind, value = commands.get()
            if kind == "hello":
                hello = value
                assert isinstance(hello, protocol.Hello)
                if hello.protocol_version != PROTOCOL_VERSION:
                    writer.write(
                        protocol.WorkerEvent(
                            failed=protocol.EvaluationFailed(
                                code="protocol.unsupported",
                                message=(
                                    "unsupported worker protocol "
                                    f"{hello.protocol_version}; expected {PROTOCOL_VERSION}"
                                ),
                            )
                        )
                    )
                else:
                    writer.write(
                        protocol.WorkerEvent(
                            capabilities=protocol.CapabilityReport(
                                protocol_version=PROTOCOL_VERSION,
                                capabilities=CAPABILITIES,
                                python_version=sys.version.split()[0],
                                interpreter=sys.executable,
                                machinewright_version=_package_version("machinewright"),
                                cad_backend_version=_package_version("cadquery-ocp"),
                                transports=("stdio",),
                            )
                        )
                    )
            elif kind == "evaluate":
                evaluate = value
                assert isinstance(evaluate, protocol.EvaluateProject)
                worker.evaluate(evaluate)
            elif kind == "evaluate_sweep_point":
                evaluate_sweep_point_request = value
                assert isinstance(
                    evaluate_sweep_point_request, protocol.EvaluateSweepPoint
                )
                worker.evaluate_sweep_point(evaluate_sweep_point_request)
            elif kind == "run_export_job":
                export_request = value
                assert isinstance(export_request, protocol.RunExportJob)
                worker.run_export(export_request)
            elif kind == "shutdown":
                break
    finally:
        worker.shutdown()


if __name__ == "__main__":
    main()
