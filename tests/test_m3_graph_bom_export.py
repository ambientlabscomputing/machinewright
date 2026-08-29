from pathlib import Path

from machinewright import (
    ExportFormat,
    ExportRequest,
    export_artifacts,
    resolve_assembly,
)
from machinewright.lib.bom import generate_structured_bom
from tests.fixtures.simple_assembly import SimpleAssembly


def test_resolved_graph_and_bom_are_stable():
    first = resolve_assembly(SimpleAssembly().assemble())
    second = resolve_assembly(SimpleAssembly().assemble())
    assert first.content_digest == second.content_digest
    assert len(first.nodes) == 6
    bom = generate_structured_bom(first)
    assert sum(line.quantity for line in bom.lines) == 4
    assert bom.content_digest == generate_structured_bom(second).content_digest


def test_headless_json_export_returns_digests(tmp_path: Path):
    result = export_artifacts(
        SimpleAssembly(),
        tmp_path,
        ExportRequest(
            formats=(
                ExportFormat.ASSEMBLY_JSON,
                ExportFormat.BOM_JSON,
                ExportFormat.MANIFEST_JSON,
            ),
            basename="fixture",
        ),
    )
    assert [item.kind for item in result.artifacts] == [
        ExportFormat.ASSEMBLY_JSON,
        ExportFormat.BOM_JSON,
        ExportFormat.MANIFEST_JSON,
    ]
    assert all(Path(item.path).is_file() for item in result.artifacts)
    assert all(item.digest.startswith("sha256:") for item in result.artifacts)
