"""On-demand export jobs run by the worker (or the CLI) against one evaluation.

Unlike `export_service`, which emits a fixed artifact bundle on *every*
evaluation, jobs run only when a user asks and write into a user-chosen folder.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from machinewright.evaluation import load_declared_templates
from machinewright.export_service import CancellationToken
from machinewright.hardware_graph import ResolvedDesign
from machinewright.lib.bom import generate_structured_bom
from machinewright.lib.part_export import PartExportOptions, export_parts
from machinewright.lib.printing.export import export_print_plan, plan_print
from machinewright.lib.printing.profile import PlanSettings, PrinterProfile
from machinewright.lib.procurement import (
    load_procurement,
    save_procurement,
    sourcing_lines,
    sync_procurement,
    write_sourcing_csv,
)
from machinewright.project import load_project
from machinewright.templates import get_machine_template


class ExportJobKind(StrEnum):
    PARTS = "parts"
    PRINT_PLAN = "print_plan"
    BOM_SOURCING = "bom_sourcing"


class ExportCancelledError(Exception):
    """Raised inside a job when its cancellation token fires."""


class BomSourcingOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    # Project root holding bom-procurement.json.
    project_root: str
    # "sync" prefills bom-procurement.json for the design; "csv" writes the sourcing CSV.
    action: Literal["csv", "sync"] = "csv"


class PrintPlanOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    printer: PrinterProfile = PrinterProfile()
    settings: PlanSettings = PlanSettings()
    # False plans the layout and returns it without writing any files.
    write: bool = True
    # Write straight into the destination, plate by plate, reporting each as it lands
    # (for a private working directory a viewer is watching); see export_print_plan.
    live: bool = False
    # Hand-adjusted layout: node id -> footprint lower-left corner (mm, bed coordinates,
    # as in the plan's part x/y). Unlisted parts keep their packed position.
    positions: dict[str, tuple[float, float]] = {}


Progress = Callable[[str, int, int, str], None]


def evaluate_design(
    project_root: Path,
    template_id: str,
    template_version: str,
    inputs: Mapping[str, Any],
) -> ResolvedDesign:
    root, config = load_project(project_root)
    load_declared_templates(root, config)
    return get_machine_template(template_id, template_version).evaluate(inputs).design


def run_export_job(
    design: ResolvedDesign,
    kind: ExportJobKind,
    destination: Path | None,
    options_json: bytes | str,
    *,
    basename: str = "assembly",
    progress: Progress | None = None,
    cancellation: CancellationToken | None = None,
) -> dict[str, Any]:
    """Run one export job and return a JSON-serializable result."""

    def check() -> None:
        if cancellation is not None and cancellation.cancelled:
            raise ExportCancelledError

    options_json = options_json or b"{}"
    if kind == ExportJobKind.PARTS:
        if destination is None:
            raise ValueError("parts export requires a destination directory")
        options = PartExportOptions.model_validate_json(options_json)
        result = export_parts(
            design,
            destination,
            options,
            basename=basename,
            progress=progress,
            check=check,
        )
        return result.model_dump(mode="json")
    if kind == ExportJobKind.BOM_SOURCING:
        sourcing = BomSourcingOptions.model_validate_json(options_json)
        structured = generate_structured_bom(design.graph)
        if sourcing.action == "sync":
            synced = sync_procurement(
                structured, load_procurement(sourcing.project_root)
            )
            save_procurement(sourcing.project_root, synced)
            return {"lines": len(synced.context)}
        if destination is None:
            raise ValueError("BOM export requires a destination directory")
        data = load_procurement(sourcing.project_root)
        lines = sourcing_lines(structured, data)
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / f"{basename}-purchased-parts.csv"
        write_sourcing_csv(lines, target, data.currency)
        return {"file": target.name, "lines": len(lines)}
    plan_options = PrintPlanOptions.model_validate_json(options_json)
    if plan_options.write:
        if destination is None:
            raise ValueError("print plan export requires a destination directory")
        plan = export_print_plan(
            design,
            destination,
            plan_options.printer,
            plan_options.settings,
            basename=basename,
            progress=progress,
            check=check,
            live=plan_options.live,
            positions=plan_options.positions,
        )
    else:
        plan = plan_print(
            design,
            plan_options.printer,
            plan_options.settings,
            check=check,
            positions=plan_options.positions,
        )
    return plan.model_dump(mode="json")
