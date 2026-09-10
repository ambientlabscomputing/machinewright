import json
from pathlib import Path
import struct
import subprocess

from machinewright import EvaluationCache, ExportFormat, ExportRequest, evaluate_project
from machinewright.protocol import machinewright_worker_pb2 as protocol

ROOT = Path(__file__).parents[1]
INPUTS = json.loads((ROOT / "examples/inputs/reference.json").read_text())
REQUEST = ExportRequest(
    formats=(ExportFormat.HARDWARE_GRAPH_JSON, ExportFormat.MANIFEST_JSON)
)


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
    assert first.snapshot.artifact_manifest_digest == second.snapshot.artifact_manifest_digest
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
    assert first.snapshot.artifact_manifest_digest == second.snapshot.artifact_manifest_digest
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
    events = []
    offset = 0
    while offset < len(process.stdout):
        size = struct.unpack("<I", process.stdout[offset : offset + 4])[0]
        offset += 4
        event = protocol.WorkerEvent()
        event.ParseFromString(process.stdout[offset : offset + size])
        events.append(event)
        offset += size
    completed = next(event.completed for event in events if event.HasField("completed"))
    assert completed.generation == 7
    assert Path(completed.snapshot_path).is_file()
