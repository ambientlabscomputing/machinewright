"""Generate the versioned JSON Schema files shipped in the wheel."""

import json
from pathlib import Path

from machinewright.contracts import (
    DutyCycleRating,
    MotorOperatingPoint,
    MotorRequirement,
    MotorSpec,
    Quantity,
    Tolerance,
)
from machinewright.evaluation import EvaluationSnapshot
from machinewright.export_service import ExportRequest, ExportResult
from machinewright.hardware_graph import ResolvedHardwareGraph
from machinewright.lib.bom import BOM
from machinewright.lib.procurement import ProcurementDocument
from machinewright.project import ProjectConfig
from machinewright.templates import EvidenceRequirement, Observable

MODELS = (
    Quantity,
    Tolerance,
    MotorSpec,
    MotorRequirement,
    MotorOperatingPoint,
    DutyCycleRating,
    ResolvedHardwareGraph,
    BOM,
    ProcurementDocument,
    ExportRequest,
    ExportResult,
    EvaluationSnapshot,
    ProjectConfig,
    Observable,
    EvidenceRequirement,
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
