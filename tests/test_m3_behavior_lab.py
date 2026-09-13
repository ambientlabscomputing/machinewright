"""RFD-19 M3 ("Hardware function laboratory") sweep-executor coverage.

Not to be confused with `tests/test_m3_contracts.py`, which is unrelated
prior art from an earlier, different "M3" (motor compatibility contracts).
"""

from __future__ import annotations

import json
from pathlib import Path
import struct
import subprocess

from typer.testing import CliRunner

from machinewright.evaluation import (
    SweepCoordinate,
    SweepPoint,
    apply_sweep_coordinates,
    evaluate_sweep,
    evaluate_sweep_point,
    grid_sweep_points,
    linear_sweep_points,
)
from machinewright.export_service import CancellationToken
from machinewright.main import app as cli_app
from machinewright.protocol import machinewright_worker_pb2 as protocol

ROOT = Path(__file__).parents[1]
INPUTS = json.loads((ROOT / "examples/inputs/reference.json").read_text())
INPUTS_PATH = ROOT / "examples/inputs/reference.json"
cli_runner = CliRunner()


def _framed(payload: bytes) -> bytes:
    return struct.pack("<I", len(payload)) + payload


def _run_worker(*requests: protocol.WorkerRequest) -> list[protocol.WorkerEvent]:
    stdin = b"".join(_framed(request.SerializeToString()) for request in requests)
    stdin += _framed(
        protocol.WorkerRequest(shutdown=protocol.Shutdown()).SerializeToString()
    )
    process = subprocess.run(
        ["uv", "run", "machinewright-worker"],
        input=stdin,
        capture_output=True,
        check=True,
    )
    events = []
    offset = 0
    payload = process.stdout
    while offset < len(payload):
        size = struct.unpack("<I", payload[offset : offset + 4])[0]
        offset += 4
        event = protocol.WorkerEvent()
        event.ParseFromString(payload[offset : offset + size])
        events.append(event)
        offset += size
    return events


def test_linear_sweep_points_matches_reference_cli_semantics():
    points = linear_sweep_points("requirements.payload_kg", 3.0, 63.0, 21)
    assert len(points) == 21
    assert points[0].coordinates == (SweepCoordinate("requirements.payload_kg", 3.0),)
    assert points[-1].coordinates[0].value == 63.0
    assert [point.index for point in points] == list(range(21))


def test_grid_sweep_points_is_row_major_cartesian_product():
    points = grid_sweep_points([("a", 0.0, 1.0, 2), ("b", 10.0, 20.0, 3)])
    assert len(points) == 6
    # `b` (the last axis) varies fastest.
    assert [point.coordinates[1].value for point in points] == [
        10.0,
        15.0,
        20.0,
        10.0,
        15.0,
        20.0,
    ]
    assert [point.coordinates[0].value for point in points] == [
        0.0,
        0.0,
        0.0,
        1.0,
        1.0,
        1.0,
    ]


def test_apply_sweep_coordinates_sets_nested_dotted_path_without_mutating_baseline():
    baseline = {"requirements": {"payload_kg": 10.0}}
    updated = apply_sweep_coordinates(
        baseline, (SweepCoordinate("requirements.payload_kg", 42.0),)
    )
    assert updated == {"requirements": {"payload_kg": 42.0}}
    assert baseline == {"requirements": {"payload_kg": 10.0}}


def test_evaluate_sweep_point_writes_an_independently_loadable_per_point_snapshot(
    tmp_path: Path,
):
    point = SweepPoint(
        index=4, coordinates=(SweepCoordinate("requirements.payload_kg", 25.0),)
    )
    outcome = evaluate_sweep_point(
        ROOT, "machinewright.reference.simple", "1.0.0", INPUTS, point, tmp_path
    )
    assert outcome.snapshot.generation == point.index + 1
    assert Path(outcome.snapshot_path).is_relative_to(tmp_path / "point-0004")
    margin = next(
        item
        for item in outcome.snapshot.observables
        if item.observable_id == "payload_margin"
    )
    assert margin.value == 25.0


def test_evaluate_sweep_stops_scheduling_further_points_once_cancelled(tmp_path: Path):
    points = linear_sweep_points("requirements.payload_kg", 3.0, 63.0, 10)
    cancellation = CancellationToken()
    seen: list[int] = []
    for point, outcome_or_error in evaluate_sweep(
        ROOT,
        "machinewright.reference.simple",
        "1.0.0",
        INPUTS,
        points,
        tmp_path,
        cancellation=cancellation,
    ):
        assert not isinstance(outcome_or_error, Exception)
        seen.append(point.index)
        if point.index == 2:
            cancellation.cancel()
    # Cancellation is advisory and checked *between* points: the point already
    # dispatched when `cancel()` was called still completes, but no further
    # point is scheduled after it.
    assert seen == [0, 1, 2]


def test_project_sweep2d_cli_writes_full_grid_summary(tmp_path: Path):
    """Exercises the `sweep2d` CLI's argument wiring, grid construction, and
    summary format end-to-end. Both axes target the reference template's one
    real input field (it has no second independent field) purely to prove
    the plumbing; `test_grid_sweep_points_is_row_major_cartesian_product`
    above is the real coverage of the grid math with two distinct axes."""
    output = tmp_path / "sweep2d"
    result = cli_runner.invoke(
        cli_app,
        [
            "project",
            "sweep2d",
            "machinewright.reference.simple",
            "1.0.0",
            str(INPUTS_PATH),
            "requirements.payload_kg",
            "3",
            "30",
            "3",
            "requirements.payload_kg",
            "40",
            "60",
            "2",
            str(output),
            "--root",
            str(ROOT),
        ],
    )
    assert result.exit_code == 0, result.output
    summary = json.loads((output / "sweep.json").read_text())
    assert summary["parameters"] == [
        "requirements.payload_kg",
        "requirements.payload_kg",
    ]
    points = summary["points"]
    assert len(points) == 6
    assert all(point["status"] == "succeeded" for point in points), points
    for point in points:
        snapshot_path = output / point["snapshot"]
        assert snapshot_path.is_file()


def test_worker_evaluates_sweep_point_and_returns_completed_event(tmp_path: Path):
    request = protocol.WorkerRequest(
        evaluate_sweep_point=protocol.EvaluateSweepPoint(
            session_id="test-session",
            sweep_id=1,
            point_index=3,
            coordinates=[
                protocol.SweepCoordinate(
                    parameter_path="requirements.payload_kg", value=22.0
                )
            ],
            project_root=str(ROOT),
            template_id="machinewright.reference.simple",
            template_version="1.0.0",
            baseline_inputs_json=json.dumps(INPUTS).encode(),
            output_directory=str(tmp_path),
        )
    )
    events = _run_worker(request)
    completed = next(
        event.sweep_point_completed
        for event in events
        if event.HasField("sweep_point_completed")
    )
    assert completed.sweep_id == 1
    assert completed.point_index == 3
    assert Path(completed.snapshot_path).is_file()
    snapshot = json.loads(Path(completed.snapshot_path).read_text())
    margin = next(
        item
        for item in snapshot["observables"]
        if item["observable_id"] == "payload_margin"
    )
    assert float(margin["value"]) == 28.0  # 50.0 - payload_kg (22.0)


def test_worker_cancel_sweep_before_point_starts_cancels_it(tmp_path: Path):
    # Mirrors `cancelled_before_start` coverage for single evaluations: a
    # `CancelSweep` that arrives before its `EvaluateSweepPoint` (both queued
    # in the same stdin batch, processed in order by the FIFO worker queue)
    # must still mark that point cancelled rather than letting it complete.
    cancel = protocol.WorkerRequest(
        cancel_sweep=protocol.CancelSweep(session_id="test-session", sweep_id=9)
    )
    evaluate = protocol.WorkerRequest(
        evaluate_sweep_point=protocol.EvaluateSweepPoint(
            session_id="test-session",
            sweep_id=9,
            point_index=0,
            coordinates=[
                protocol.SweepCoordinate(
                    parameter_path="requirements.payload_kg", value=10.0
                )
            ],
            project_root=str(ROOT),
            template_id="machinewright.reference.simple",
            template_version="1.0.0",
            baseline_inputs_json=json.dumps(INPUTS).encode(),
            output_directory=str(tmp_path),
        )
    )
    events = _run_worker(cancel, evaluate)
    assert any(event.HasField("sweep_point_cancelled") for event in events)
    assert not any(event.HasField("sweep_point_completed") for event in events)
