"""Export individual parts (or a chosen subset) of a resolved design as STL/STEP."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import re
import shutil
from typing import Literal

import cadquery
from cadquery import exporters
from pydantic import BaseModel, ConfigDict

from machinewright.export_service import _normalize_step_metadata
from machinewright.hardware_graph import PartNode, ResolvedDesign

Progress = Callable[[str, int, int, str], None]


class PartExportOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    format: Literal["stl", "step"] = "stl"
    # Restrict to these graph node ids (e.g. the user's viewport selection);
    # None exports every part.
    node_ids: list[str] | None = None
    # Restrict to parts whose material process is in this list (e.g. ["PRINTED"]).
    processes: list[str] | None = None
    # One file containing every chosen part, instead of one file per part.
    combine: bool = False
    # "assembly" keeps each part where it sits in the design; "origin" exports
    # it in its own authored frame (what a machine shop or slicer wants).
    placement: Literal["assembly", "origin"] = "assembly"
    stl_tolerance: float = 0.05
    stl_angular_tolerance: float = 0.2


class ExportedFile(BaseModel):
    name: str
    node_ids: list[str]
    byte_size: int


class PartExportResult(BaseModel):
    files: list[ExportedFile]


def _file_stem(node: PartNode, root_id: str) -> str:
    relative = node.node_id.removeprefix(f"{root_id}/")
    return (
        re.sub(r"[^A-Za-z0-9_.-]+", "_", relative.replace("/", ".")).strip("._")
        or "part"
    )


def _select(design: ResolvedDesign, options: PartExportOptions) -> list[PartNode]:
    wanted = set(options.node_ids) if options.node_ids is not None else None
    chosen: list[PartNode] = []
    for node in design.graph.nodes:
        if not isinstance(node, PartNode):
            continue
        if wanted is not None and node.node_id not in wanted:
            continue
        if options.processes is not None:
            material = design.materials.get(node.node_id)
            process = getattr(getattr(material, "process", None), "value", None)
            if process not in options.processes:
                continue
        chosen.append(node)
    return chosen


def _shape(
    design: ResolvedDesign, node: PartNode, options: PartExportOptions
) -> cadquery.Shape:
    local = design.geometries[node.node_id]
    if options.placement == "origin":
        return local
    return local.located(node.transform.location())


def _write(shape: cadquery.Shape, path: Path, options: PartExportOptions) -> None:
    workplane = cadquery.Workplane(obj=shape)
    if options.format == "step":
        exporters.export(workplane, str(path), exportType=exporters.ExportTypes.STEP)  # type: ignore[arg-type]
        _normalize_step_metadata(path)
    else:
        exporters.export(
            workplane,
            str(path),
            exportType=exporters.ExportTypes.STL,  # type: ignore[arg-type]
            tolerance=options.stl_tolerance,
            angularTolerance=options.stl_angular_tolerance,
        )


def export_parts(
    design: ResolvedDesign,
    destination: str | Path,
    options: PartExportOptions,
    *,
    basename: str = "assembly",
    progress: Progress | None = None,
    check: Callable[[], None] | None = None,
) -> PartExportResult:
    """Write the chosen parts into `destination`; all-or-nothing."""
    parts = _select(design, options)
    if not parts:
        raise ValueError("no parts matched the export selection")
    destination = Path(destination)
    scratch = destination / f".{basename}.machinewright-parts-tmp"
    shutil.rmtree(scratch, ignore_errors=True)
    scratch.mkdir(parents=True)
    extension = options.format
    files: list[ExportedFile] = []
    try:
        if options.combine:
            jobs = [(f"{basename}-parts.{extension}", parts)]
        else:
            used: dict[str, int] = {}
            jobs = []
            for node in parts:
                stem = _file_stem(node, design.graph.root_id)
                used[stem] = used.get(stem, 0) + 1
                suffix = "" if used[stem] == 1 else f"-{used[stem]}"
                jobs.append((f"{stem}{suffix}.{extension}", [node]))
        for done, (name, nodes) in enumerate(jobs):
            if check:
                check()
            if progress:
                progress("parts", done, len(jobs), f"Exporting {name}")
            shapes = [_shape(design, node, options) for node in nodes]
            shape = (
                shapes[0]
                if len(shapes) == 1
                else cadquery.Compound.makeCompound(shapes)
            )
            _write(shape, scratch / name, options)
            files.append(
                ExportedFile(
                    name=name,
                    node_ids=[node.node_id for node in nodes],
                    byte_size=(scratch / name).stat().st_size,
                )
            )
        destination.mkdir(parents=True, exist_ok=True)
        for item in sorted(scratch.iterdir()):
            item.replace(destination / item.name)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return PartExportResult(files=files)
