"""Generate the versioned JSON Schema files shipped in the wheel."""

import json
from pathlib import Path

from machinewright.contracts import MotorRequirement, MotorSpec, Quantity, Tolerance
from machinewright.export_service import ExportRequest, ExportResult
from machinewright.hardware_graph import ResolvedHardwareGraph
from machinewright.lib.bom import BOM

MODELS = (
    Quantity,
    Tolerance,
    MotorSpec,
    MotorRequirement,
    ResolvedHardwareGraph,
    BOM,
    ExportRequest,
    ExportResult,
)


def main() -> None:
    destination = Path(__file__).parents[1] / "src" / "machinewright" / "schemas"
    destination.mkdir(exist_ok=True)
    for model in MODELS:
        path = destination / f"{model.__name__}-1.0.schema.json"
        path.write_text(
            json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
