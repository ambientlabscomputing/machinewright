import hashlib
import json
from pathlib import Path
import struct
import subprocess

from typer.testing import CliRunner

from machinewright import EvaluationCache, ExportFormat, ExportRequest, evaluate_project
from machinewright.main import app as cli_app
from machinewright.protocol import machinewright_worker_pb2 as protocol

ROOT = Path(__file__).parents[1]
INPUTS = json.loads((ROOT / "examples/inputs/reference.json").read_text())
INPUTS_PATH = ROOT / "examples/inputs/reference.json"
REQUEST = ExportRequest(
    formats=(ExportFormat.HARDWARE_GRAPH_JSON, ExportFormat.MANIFEST_JSON)
)
cli_runner = CliRunner()


def test_direct_evaluation_is_portable_and_maps_source(tmp_path: Path):
    first = evaluate_project(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        tmp_path / "first",
        request=REQUEST,
    )
    second = evaluate_project(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        tmp_path / "second",
        request=REQUEST,
    )
    assert first.snapshot.graph_digest == second.snapshot.graph_digest
    assert (
        first.snapshot.artifact_manifest_digest
        == second.snapshot.artifact_manifest_digest
    )
    assert first.snapshot.source_mappings
    assert first.snapshot.dependencies[0].conservative
    assert {mesh.graph_node_id for mesh in first.snapshot.meshes} == set(
        node.node_id for node in first.snapshot.graph.nodes if node.kind == "part"
    )
    manifest = next(
        item for item in first.artifacts if item.kind == ExportFormat.MANIFEST_JSON
    )
    payload = json.loads(Path(manifest.path).read_text())
    assert all("path" not in item for item in payload["artifacts"])


def test_viewport_mesh_bounds_reflect_each_nodes_world_transform(tmp_path: Path):
    """Regression: `_write_meshes` must place each part at its node transform
    before tessellating, the same way the authoritative STEP/STL export
    already does via `.located(...)`. Before this fix, three `DowelPin`
    instances sharing identical local geometry but distinct z-translations
    (20/30/40mm) all tessellated at their local, untransformed origin and
    rendered coincident in the application's three.js viewport instead of
    stacked -- invisible to graph/artifact digest checks, which never
    depend on the interactive mesh preview, only to someone looking at the
    actual viewport.
    """
    outcome = evaluate_project(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        tmp_path,
        request=REQUEST,
    )
    meshes_by_node = {mesh.graph_node_id: mesh for mesh in outcome.snapshot.meshes}
    pin_nodes = [
        node
        for node in outcome.snapshot.graph.nodes
        if node.kind == "part" and "pin" in node.instance_key
    ]
    assert len(pin_nodes) >= 2
    world_z_by_node = {
        node.node_id: float(node.transform.translation_mm[2]) for node in pin_nodes
    }
    assert len({round(z) for z in world_z_by_node.values()}) == len(pin_nodes), (
        "fixture assumption: pin nodes must have distinct world z-translations"
    )
    for node_id, world_z in world_z_by_node.items():
        bounds = meshes_by_node[node_id].bounds
        mesh_z_min, mesh_z_max = bounds[2], bounds[5]
        assert mesh_z_min <= world_z <= mesh_z_max, (
            f"{node_id} mesh bounds {bounds} do not contain its world z={world_z}"
        )
    bounds_by_node = {
        node_id: meshes_by_node[node_id].bounds for node_id in world_z_by_node
    }
    assert len({bounds for bounds in bounds_by_node.values()}) == len(bounds_by_node), (
        "distinct world transforms must not collapse onto identical mesh bounds"
    )


def test_cache_restores_serialized_results_and_artifacts(tmp_path: Path):
    cache = EvaluationCache(tmp_path / "cache")
    first = evaluate_project(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        tmp_path / "first",
        request=REQUEST,
        cache=cache,
    )
    second = evaluate_project(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        tmp_path / "second",
        request=REQUEST,
        cache=cache,
    )
    assert not first.cache_hit
    assert second.cache_hit
    assert Path(second.snapshot_path).is_file()
    assert all(Path(item.path).is_file() for item in second.artifacts)


def test_full_artifact_bundle_is_deterministic(tmp_path: Path):
    first = evaluate_project(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        tmp_path / "first",
    )
    second = evaluate_project(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        tmp_path / "second",
    )
    assert (
        first.snapshot.artifact_manifest_digest
        == second.snapshot.artifact_manifest_digest
    )
    assert {item.kind: item.digest for item in first.artifacts} == {
        item.kind: item.digest for item in second.artifacts
    }


def test_worker_negotiates_versioned_protocol():
    request = protocol.WorkerRequest(
        hello=protocol.Hello(protocol_version=1, capabilities=["evaluation.v1"])
    )
    payload = request.SerializeToString()
    shutdown = protocol.WorkerRequest(shutdown=protocol.Shutdown()).SerializeToString()
    process = subprocess.run(
        ["uv", "run", "machinewright-worker"],
        input=struct.pack("<I", len(payload))
        + payload
        + struct.pack("<I", len(shutdown))
        + shutdown,
        capture_output=True,
        check=True,
    )
    size = struct.unpack("<I", process.stdout[:4])[0]
    event = protocol.WorkerEvent()
    event.ParseFromString(process.stdout[4 : 4 + size])
    assert event.capabilities.protocol_version == 1
    assert "source_overlays.v1" in event.capabilities.capabilities


def test_protocol_fixture_round_trips_python_binding():
    fixture = bytes.fromhex(
        (ROOT / "proto/fixtures/hello-request.hex").read_text(encoding="utf-8")
    )
    request = protocol.WorkerRequest.FromString(fixture)
    assert request.hello.protocol_version == 1
    assert list(request.hello.capabilities) == ["evaluation.v1", "progress.v1"]
    assert request.SerializeToString() == fixture


def _parse_worker_events(payload: bytes) -> list[protocol.WorkerEvent]:
    events = []
    offset = 0
    while offset < len(payload):
        size = struct.unpack("<I", payload[offset : offset + 4])[0]
        offset += 4
        event = protocol.WorkerEvent()
        event.ParseFromString(payload[offset : offset + size])
        events.append(event)
        offset += size
    return events


def test_worker_evaluates_project_and_returns_immutable_snapshot(tmp_path: Path):
    evaluate = protocol.WorkerRequest(
        evaluate=protocol.EvaluateProject(
            session_id="test-session",
            generation=7,
            project_root=str(ROOT),
            template_id="machinewright.reference.simple",
            template_version="1.0.0",
            inputs_json=json.dumps(INPUTS).encode(),
            output_directory=str(tmp_path),
            overlays=[
                protocol.SourceOverlay(
                    relative_path="examples/reference_project.py",
                    content=(ROOT / "examples/reference_project.py").read_bytes(),
                )
            ],
        )
    ).SerializeToString()
    shutdown = protocol.WorkerRequest(shutdown=protocol.Shutdown()).SerializeToString()
    process = subprocess.run(
        ["uv", "run", "machinewright-worker"],
        input=struct.pack("<I", len(evaluate))
        + evaluate
        + struct.pack("<I", len(shutdown))
        + shutdown,
        capture_output=True,
        check=True,
    )
    events = _parse_worker_events(process.stdout)
    completed = next(event.completed for event in events if event.HasField("completed"))
    schema_event = next(
        event.input_schema for event in events if event.HasField("input_schema")
    )
    assert schema_event.session_id == "test-session"
    assert schema_event.generation == 7
    schema = json.loads(schema_event.schema_json)
    assert (
        schema["properties"]["requirements"]["properties"]["payload_kg"]["type"]
        == "number"
    )
    assert next(
        i for i, event in enumerate(events) if event.HasField("input_schema")
    ) < next(i for i, event in enumerate(events) if event.HasField("completed"))
    assert completed.generation == 7
    assert Path(completed.snapshot_path).is_file()
    # R11b: the worker reports digests of what it actually read so a caller
    # that independently reads the project tree can detect a divergence.
    evaluated = {
        item.relative_path: item.digest for item in completed.evaluated_sources
    }
    assert "examples/reference_project.py" in evaluated
    expected_digest = (
        "sha256:"
        + hashlib.sha256(
            (ROOT / "examples/reference_project.py").read_bytes()
        ).hexdigest()
    )
    assert evaluated["examples/reference_project.py"] == expected_digest


def test_worker_processes_two_sequential_evaluations_in_one_process(tmp_path: Path):
    # Reproduces R1 from docs/m2-implementation-review-2026-09-10.md: a
    # long-lived worker must be able to evaluate the same overlaid project
    # more than once. Each evaluation with overlays materializes a fresh temp
    # project root, so the worker must evict modules/sys.path entries from
    # the *previous* root before importing declared templates again.
    #
    # Run against a real worker subprocess (like
    # test_worker_evaluates_project_and_returns_immutable_snapshot) rather
    # than an in-process Worker: a real worker starts with pristine
    # sys.modules/sys.path, matching production, whereas this test file's
    # other tests import the reference project directly in-process and would
    # otherwise leave stale module state behind for an in-process Worker to
    # trip over.
    valid_source = (ROOT / "examples/reference_project.py").read_bytes()
    broken_source = valid_source + b"\nthis is not valid python syntax(((\n"

    def evaluate_request(generation: int, source: bytes) -> bytes:
        return protocol.WorkerRequest(
            evaluate=protocol.EvaluateProject(
                session_id="test-session",
                generation=generation,
                project_root=str(ROOT),
                template_id="machinewright.reference.simple",
                template_version="1.0.0",
                inputs_json=json.dumps(INPUTS).encode(),
                output_directory=str(tmp_path / f"gen-{generation}"),
                overlays=[
                    protocol.SourceOverlay(
                        relative_path="examples/reference_project.py",
                        content=source,
                    )
                ],
            )
        ).SerializeToString()

    def framed(payload: bytes) -> bytes:
        return struct.pack("<I", len(payload)) + payload

    # success (gen 1) -> broken overlay (gen 2) -> corrected overlay (gen 3):
    # the crux of R1 is that the worker must keep working after being reused,
    # regardless of whether the intervening evaluation succeeded or failed.
    stdin = (
        framed(evaluate_request(1, valid_source))
        + framed(evaluate_request(2, broken_source))
        + framed(evaluate_request(3, valid_source))
        + framed(
            protocol.WorkerRequest(shutdown=protocol.Shutdown()).SerializeToString()
        )
    )
    process = subprocess.run(
        ["uv", "run", "machinewright-worker"],
        input=stdin,
        capture_output=True,
        check=True,
    )
    events = _parse_worker_events(process.stdout)
    completed = {
        event.completed.generation: event.completed
        for event in events
        if event.HasField("completed")
    }
    failed = {
        event.failed.generation: event.failed
        for event in events
        if event.HasField("failed")
    }
    assert set(completed) == {1, 3}, (process.stderr.decode(errors="replace"), failed)
    assert set(failed) == {2}
    assert Path(completed[1].snapshot_path).is_file()
    assert Path(completed[3].snapshot_path).is_file()
    assert completed[1].snapshot_path != completed[3].snapshot_path


def test_project_sweep_cli_produces_one_feasibility_flip_and_loadable_per_point_snapshots(
    tmp_path: Path,
):
    """`machinewright project sweep` is the reference semantics M3's native
    app mirrors for building sweep points (see
    `machinewright_analysis::Sweep::from_axis` in the Rust workspace) and,
    unlike the app, is already runnable headlessly for CI/reproducibility
    (RFD-19 hard requirement #10) — this had zero test coverage before M3."""
    output = tmp_path / "sweep"
    result = cli_runner.invoke(
        cli_app,
        [
            "project",
            "sweep",
            "machinewright.reference.simple",
            "1.0.0",
            str(INPUTS_PATH),
            "requirements.payload_kg",
            "3",
            "63",
            "21",
            str(output),
            "--root",
            str(ROOT),
        ],
    )
    assert result.exit_code == 0, result.output
    summary = json.loads((output / "sweep.json").read_text())
    assert summary["parameter"] == "requirements.payload_kg"
    points = summary["points"]
    assert len(points) == 21
    assert all(point["status"] == "succeeded" for point in points), points

    feasibility = [
        next(
            observable["feasible"]
            for observable in point["observables"]
            if observable["observable_id"] == "payload_margin"
        )
        for point in points
    ]
    # payload_margin = 50.0 - payload_kg is feasible up to payload_kg=50;
    # sweeping 3-63 in steps of 3 crosses that boundary exactly once
    # (feasible through payload_kg=48, infeasible from payload_kg=51). The
    # range starts above 0, not at it, since ReferenceInputs.payload_kg is
    # constrained to `gt=0`.
    flips = sum(
        1
        for before, after in zip(feasibility, feasibility[1:], strict=False)
        if before != after
    )
    assert flips == 1, feasibility

    for point in points:
        snapshot_path = output / point["snapshot"]
        assert snapshot_path.is_file()
        snapshot = json.loads(snapshot_path.read_text())
        assert snapshot["generation"] == point["index"] + 1
