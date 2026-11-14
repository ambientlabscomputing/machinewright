"""Write print-plate layouts as STL files for loading into a real slicer."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
import re
import shutil

import cadquery
from cadquery import exporters

from machinewright.hardware_graph import ResolvedDesign
from machinewright.lib.printing.plan import PlateRun, PrintPlan, build_plan
from machinewright.lib.printing.profile import PlanSettings, PrinterProfile

# Slicer-friendly mesh density: far smaller files than OCC's default, still
# well under typical FDM resolution.
_STL_TOLERANCE = 0.05
_STL_ANGULAR_TOLERANCE = 0.2

Progress = Callable[[str, int, int, str], None]


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower() or "material"


def plan_print(
    design: ResolvedDesign,
    printer: PrinterProfile,
    settings: PlanSettings,
    *,
    check: Callable[[], None] | None = None,
    positions: Mapping[str, tuple[float, float]] | None = None,
) -> PrintPlan:
    """Plan only: orientation, material grouping, and plate layout (no files)."""
    plan, _ = build_plan(design, printer, settings, check=check, positions=positions)
    return plan


def _plate_shape(run: PlateRun, printer: PrinterProfile) -> cadquery.Workplane:
    """All of a plate's parts, positioned in bed coordinates (z = 0 is the bed)."""
    dx = printer.bed_margin - (printer.bed_x / 2 if printer.origin == "center" else 0.0)
    dy = printer.bed_margin - (printer.bed_y / 2 if printer.origin == "center" else 0.0)
    shapes = [part.shape.translate((dx + part.x, dy + part.y, 0)) for part in run.parts]
    return cadquery.Workplane(obj=cadquery.Compound.makeCompound(shapes))


def export_print_plan(
    design: ResolvedDesign,
    destination: str | Path,
    printer: PrinterProfile,
    settings: PlanSettings,
    *,
    basename: str = "print",
    progress: Progress | None = None,
    check: Callable[[], None] | None = None,
    live: bool = False,
    positions: Mapping[str, tuple[float, float]] | None = None,
) -> PrintPlan:
    """Write `<basename>-plate-NN-<material>.stl` per plate plus a plan JSON.

    By default files land in `destination` only once every plate succeeded, so a
    cancelled or failed run never leaves a half-written set behind.

    Progress stages: "orient" per part, "pack", "layout" (message = the plan as
    JSON, every plate's `stl_file` still null), "plate" before each plate is
    written, and — with `live=True` — "plate_ready" after each one (message = that
    plate as JSON). Live mode writes straight into `destination` (clearing the
    previous set first) so a viewer can load each plate as it appears; it is meant
    for a private working directory, and a cancelled run leaves a partial set.
    """
    plan, runs = build_plan(
        design, printer, settings, check=check, progress=progress, positions=positions
    )
    destination = Path(destination)
    if progress:
        progress("layout", 0, len(runs), plan.model_dump_json())
    if live:
        return _write_live(plan, runs, destination, printer, basename, progress, check)
    if not runs:
        return plan
    scratch = destination / f".{basename}.machinewright-print-tmp"
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True)
    try:
        for done, (run, plate) in enumerate(zip(runs, plan.plates, strict=True)):
            if check:
                check()
            if progress:
                progress(
                    "plate",
                    done,
                    len(runs),
                    f"Writing plate {run.index} ({run.material})",
                )
            name = _plate_name(run, basename)
            exporters.export(
                _plate_shape(run, printer),
                str(scratch / name),
                exportType=exporters.ExportTypes.STL,  # type: ignore[arg-type]
                tolerance=_STL_TOLERANCE,
                angularTolerance=_STL_ANGULAR_TOLERANCE,
            )
            plate.stl_file = name
        (scratch / f"{basename}-plan.json").write_text(
            plan.model_dump_json(indent=2) + "\n", encoding="utf-8"
        )
        destination.mkdir(parents=True, exist_ok=True)
        for item in sorted(scratch.iterdir()):
            item.replace(destination / item.name)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return plan


def _plate_name(run: PlateRun, basename: str) -> str:
    return f"{basename}-plate-{run.index:02d}-{_slug(run.material)}.stl"


def _write_live(
    plan: PrintPlan,
    runs: list[PlateRun],
    destination: Path,
    printer: PrinterProfile,
    basename: str,
    progress: Progress | None,
    check: Callable[[], None] | None,
) -> PrintPlan:
    destination.mkdir(parents=True, exist_ok=True)
    for stale in [
        *destination.glob(f"{basename}-plate-*.stl"),
        destination / f"{basename}-plan.json",
    ]:
        stale.unlink(missing_ok=True)
    for done, (run, plate) in enumerate(zip(runs, plan.plates, strict=True)):
        if check:
            check()
        if progress:
            progress(
                "plate", done, len(runs), f"Writing plate {run.index} ({run.material})"
            )
        name = _plate_name(run, basename)
        exporters.export(
            _plate_shape(run, printer),
            str(destination / name),
            exportType=exporters.ExportTypes.STL,  # type: ignore[arg-type]
            tolerance=_STL_TOLERANCE,
            angularTolerance=_STL_ANGULAR_TOLERANCE,
        )
        plate.stl_file = name
        if progress:
            progress("plate_ready", done + 1, len(runs), plate.model_dump_json())
    (destination / f"{basename}-plan.json").write_text(
        plan.model_dump_json(indent=2) + "\n", encoding="utf-8"
    )
    return plan
