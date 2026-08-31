from pathlib import Path

from machinewright import ExportFormat, ExportRequest, canonical_json, export_artifacts
from machinewright.lib.bom import generate_structured_bom
from tests.fixtures.simple_assembly import SimpleAssembly


def test_resolved_graph_connections_queries_and_bom_are_stable():
    first = SimpleAssembly().resolve(root_id="fixture").graph
    second = SimpleAssembly().resolve(root_id="fixture").graph
    assert first.graph_digest == second.graph_digest
    assert canonical_json(first) == canonical_json(second)
    assert len(first.nodes) == 6
    assert len(first.connections) == 4
    assert first.children("fixture") == (
        "fixture/base_plate",
        "fixture/pin_pair",
        "fixture/top_pin",
    )
    assert first.neighbors("fixture/base_plate") == ("fixture/top_pin",)
    assert first.connected_subgraph("fixture/base_plate") == (
        "fixture/base_plate",
        "fixture/top_pin",
    )
    bom = generate_structured_bom(first)
    assert sum(line.quantity for line in bom.lines) == 4
    assert bom.graph_digest == first.graph_digest
    assert bom.content_digest == generate_structured_bom(second).content_digest


def test_headless_graph_export_returns_digests(tmp_path: Path):
    result = export_artifacts(
        SimpleAssembly(),
        tmp_path,
        ExportRequest(
            formats=(
                ExportFormat.HARDWARE_GRAPH_JSON,
                ExportFormat.HARDWARE_GRAPH_DOT,
                ExportFormat.BOM_JSON,
                ExportFormat.MANIFEST_JSON,
            ),
            basename="fixture",
        ),
    )
    assert [item.kind for item in result.artifacts] == [
        ExportFormat.HARDWARE_GRAPH_JSON,
        ExportFormat.HARDWARE_GRAPH_DOT,
        ExportFormat.BOM_JSON,
        ExportFormat.MANIFEST_JSON,
    ]
    assert all(Path(item.path).is_file() for item in result.artifacts)
    assert all(item.digest.startswith("sha256:") for item in result.artifacts)
