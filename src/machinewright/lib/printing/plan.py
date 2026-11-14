"""Print-run planning: which printed parts go on which plate, and how.

Planning is pure geometry and fast, so the app can show the plate layout
interactively before the user exports. Output is plate-layout STLs meant to be
loaded into a real slicer; nothing here slices or generates G-code.

Rules the planner enforces:

* Only parts whose material process is PRINTED are planned.
* Plates never mix materials — different filaments cannot share a run.
* Each part is laid on its least-overhanging axis-aligned face, then packed
  onto the bed (rotating 90 degrees about Z when that helps), spilling onto
  additional plates when a bed fills up.
* Parts that cannot fit the printer at all are reported, never silently dropped.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
import math
from typing import Any

import cadquery
import numpy as np
from pydantic import BaseModel

from machinewright.hardware_graph import PartNode, ResolvedDesign
from machinewright.lib.layout import _candidate_orientations
from machinewright.lib.materials import Process
from machinewright.lib.printing.profile import PlanSettings, PrinterProfile


class PlanPart(BaseModel):
    node_id: str
    instance_key: str
    definition_id: str
    # Lower-left corner of the footprint on the bed, in mm from the bed's
    # front-left corner.
    x: float
    y: float
    width: float
    depth: float
    height: float
    rotated: bool
    orientation: int


class PlanPlate(BaseModel):
    index: int
    material: str
    max_height: float
    parts: list[PlanPart]
    stl_file: str | None = None


class SkippedPart(BaseModel):
    node_id: str
    instance_key: str
    reason: str


class PrintPlan(BaseModel):
    printer: str
    bed_x: float
    bed_y: float
    max_z: float
    origin: str
    plates: list[PlanPlate]
    skipped: list[SkippedPart]
    warnings: list[str]


@dataclass
class PlacedPart:
    node: PartNode
    shape: cadquery.Shape  # oriented + rotated, bounding box min corner at origin
    orientation: int
    rotated: bool
    width: float
    depth: float
    height: float
    x: float = 0.0
    y: float = 0.0


@dataclass
class PlateRun:
    index: int
    material: str
    parts: list[PlacedPart] = field(default_factory=list)


@dataclass
class _Shelf:
    y: float
    height: float
    cursor: float = 0.0


@dataclass
class _Bin:
    shelves: list[_Shelf] = field(default_factory=list)
    parts: list[PlacedPart] = field(default_factory=list)

    @property
    def next_y(self) -> float:
        return 0.0 if not self.shelves else self.shelves[-1].y + self.shelves[-1].height


def _tessellate(
    shape: cadquery.Shape, tolerance: float, angular_tolerance: float
) -> tuple[np.ndarray, np.ndarray]:
    vertices, triangles = shape.tessellate(tolerance, angular_tolerance)
    points = np.array([[v.x, v.y, v.z] for v in vertices], dtype=float)
    return points, np.array(triangles, dtype=np.int64).reshape(-1, 3)


def _normalized(shape: cadquery.Shape) -> cadquery.Shape:
    bbox = shape.BoundingBox()
    return shape.translate((-bbox.xmin, -bbox.ymin, -bbox.zmin))


# Surfaces tilted further than this from vertical-down-free (i.e. facing the
# bed more steeply than 45 degrees) need support or print poorly.
_OVERHANG_NORMAL_Z = -math.cos(math.radians(45.0))
_BED_CONTACT_Z = 0.05  # mm: triangles this close to the bed are the resting face
_AREA_QUANTUM = 5.0  # mm^2: cost differences below this are noise
_HEIGHT_PENALTY_MM = 100.0  # each 100 mm of height doubles the overhang cost


def _axis_rotation(axis: int, degrees: float) -> np.ndarray:
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    if axis == 0:
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


# Mirrors `layout._candidate_orientations` (same order) as vertex rotations, so
# one tessellation scores all six orientations.
_ORIENTATIONS = (
    np.eye(3),
    _axis_rotation(0, 90),
    _axis_rotation(0, 180),
    _axis_rotation(0, 270),
    _axis_rotation(1, 90),
    _axis_rotation(1, 270),
)


def _overhang_area(triangles: np.ndarray) -> float:
    """Area of triangles (n, 3, 3) overhanging steeper than 45 degrees.

    Works on the tessellation so curved faces count (a disc standing on its
    edge overhangs along the lower rim, which a planar-faces-only test misses).
    """
    cross = np.cross(
        triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    )
    norm = np.linalg.norm(cross, axis=1)
    normal_z = np.divide(cross[:, 2], norm, out=np.zeros(len(norm)), where=norm > 1e-12)
    zmin = triangles[:, :, 2].min()
    resting = triangles[:, :, 2].max(axis=1) < zmin + _BED_CONTACT_Z
    overhanging = (normal_z < _OVERHANG_NORMAL_Z) & ~resting
    return float(0.5 * norm[overhanging].sum())


def _best_orientation_index(shape: cadquery.Shape) -> int:
    """Pick the orientation with the lowest overhang cost.

    Cost is overhang area scaled up by height, so a marginally smaller overhang
    never justifies a much taller (slower, less stable) print. Ties go to the
    lowest height, then the as-designed orientation.
    """
    vertices, faces = _tessellate(shape, tolerance=0.3, angular_tolerance=0.4)
    if len(faces) == 0:
        return 0
    scores = []
    for rotation in _ORIENTATIONS:
        triangles = (vertices @ rotation.T)[faces]
        height = float(np.ptp(triangles[:, :, 2]))
        cost = _overhang_area(triangles) * (1 + height / _HEIGHT_PENALTY_MM)
        scores.append((round(cost / _AREA_QUANTUM), round(height, 3)))
    return scores.index(min(scores))


def usable_area(printer: PrinterProfile) -> tuple[float, float]:
    inset = printer.bed_margin
    return printer.bed_x - 2 * inset, printer.bed_y - 2 * inset


def _pack(  # noqa: C901 - shelf first-fit with rotation
    parts: list[PlacedPart], width: float, depth: float, spacing: float
) -> list[_Bin]:
    bins: list[_Bin] = []
    parts = sorted(parts, key=lambda p: (-p.depth, -p.width, p.node.node_id))
    for part in parts:
        options = [(part.width, part.depth, False)]
        if abs(part.width - part.depth) > 1e-6:
            options.append((part.depth, part.width, True))
        placed = False
        # 1) first fit into an existing shelf.
        for plate in bins:
            candidates = []
            for shelf in plate.shelves:
                for w, d, flip in options:
                    start = shelf.cursor
                    if d <= shelf.height + 1e-9 and start + w <= width + 1e-9:
                        candidates.append((shelf.height - d, shelf, w, d, flip))
                if candidates:
                    break
            if candidates:
                _, shelf, w, d, flip = min(candidates, key=lambda c: c[0])
                _place(plate, shelf, part, w, d, flip, spacing)
                placed = True
                break
        if placed:
            continue
        # 2) open a new shelf on an existing plate, 3) open a new plate.
        for slot in [*bins, None]:
            target = slot if slot is not None else _Bin()
            y = target.next_y + (spacing if target.shelves else 0.0)
            fits = [
                (d, w, d, flip)
                for w, d, flip in options
                if w <= width + 1e-9 and y + d <= depth + 1e-9
            ]
            if not fits:
                continue
            _, w, d, flip = min(fits, key=lambda c: c[0])
            shelf = _Shelf(y=y, height=d)
            target.shelves.append(shelf)
            if slot is None:
                bins.append(target)
            _place(target, shelf, part, w, d, flip, spacing)
            break
    return bins


def _place(
    plate: _Bin,
    shelf: _Shelf,
    part: PlacedPart,
    w: float,
    d: float,
    flip: bool,
    spacing: float,
) -> None:
    if flip:
        part.shape = _normalized(part.shape.rotate((0, 0, 0), (0, 0, 1), 90))
        part.width, part.depth = w, d
        part.rotated = True
    part.x = shelf.cursor
    part.y = shelf.y
    shelf.cursor += w + spacing
    plate.parts.append(part)


def build_plan(  # noqa: C901 - collect, validate, group, pack
    design: ResolvedDesign,
    printer: PrinterProfile,
    settings: PlanSettings,
    *,
    check: Callable[[], None] | None = None,
    progress: Callable[[str, int, int, str], None] | None = None,
    positions: Mapping[str, tuple[float, float]] | None = None,
) -> tuple[PrintPlan, list[PlateRun]]:
    """Plan every printed part in `design` onto one or more plates.

    `progress(stage, completed, total, message)` is called once per printed part
    ("orient") and once when packing starts ("pack"). Each plate's parts are
    centered on the bed. `positions` (node id -> footprint lower-left corner in
    bed coordinates, as in `PlanPart.x/y`) overrides the packed position of those
    parts, for layouts the user adjusted by hand; overlaps and parts off the
    usable bed are reported in `warnings`.
    """
    warnings: list[str] = []
    skipped: list[SkippedPart] = []
    width, depth = usable_area(printer)
    if width <= 0 or depth <= 0:
        raise ValueError("bed margin leaves no usable print area")

    orientation_cache: dict[str, int] = {}
    groups: dict[str, list[PlacedPart]] = {}
    printed: list[tuple[PartNode, Any]] = []
    for node in design.graph.nodes:
        if not isinstance(node, PartNode):
            continue
        material = design.materials.get(node.node_id)
        if material is None or material.process != Process.PRINTED:
            continue
        printed.append((node, material))
    for number, (node, material) in enumerate(printed):
        if check:
            check()
        if progress:
            progress(
                "orient",
                number,
                len(printed),
                f"Orienting {node.instance_key} ({number + 1}/{len(printed)})",
            )
        local = design.geometries[node.node_id]
        if settings.optimize_orientation:
            if node.geometry_digest not in orientation_cache:
                orientation_cache[node.geometry_digest] = _best_orientation_index(local)
            index = orientation_cache[node.geometry_digest]
        else:
            index = 0
        shape = _normalized(_candidate_orientations(local)[index])
        bbox = shape.BoundingBox()
        if bbox.zlen > printer.max_z + 1e-6:
            skipped.append(
                SkippedPart(
                    node_id=node.node_id,
                    instance_key=node.instance_key,
                    reason=(
                        f"Height {bbox.zlen:.1f} mm exceeds printer limit "
                        f"{printer.max_z:.1f} mm in its best orientation"
                    ),
                )
            )
            continue
        fits = (bbox.xlen <= width and bbox.ylen <= depth) or (
            bbox.ylen <= width and bbox.xlen <= depth
        )
        if not fits:
            skipped.append(
                SkippedPart(
                    node_id=node.node_id,
                    instance_key=node.instance_key,
                    reason=(
                        f"Footprint {bbox.xlen:.1f} x {bbox.ylen:.1f} mm does not fit "
                        f"the {width:.1f} x {depth:.1f} mm usable bed"
                    ),
                )
            )
            continue
        groups.setdefault(material.name, []).append(
            PlacedPart(
                node=node,
                shape=shape,
                orientation=index,
                rotated=False,
                width=bbox.xlen,
                depth=bbox.ylen,
                height=bbox.zlen,
            )
        )

    if progress:
        progress("pack", len(printed), len(printed), "Packing plates")
    runs: list[PlateRun] = []
    plates: list[PlanPlate] = []
    for material_name in sorted(groups):
        for packed in _pack(groups[material_name], width, depth, settings.part_spacing):
            _center(packed.parts, width, depth)
            for part in packed.parts:
                if positions and part.node.node_id in positions:
                    px, py = positions[part.node.node_id]
                    part.x, part.y = px - printer.bed_margin, py - printer.bed_margin
            run = PlateRun(
                index=len(runs) + 1, material=material_name, parts=packed.parts
            )
            if positions:
                warnings.extend(_layout_warnings(run, width, depth))
            runs.append(run)
            plates.append(_summarize(run, printer))
    plan = PrintPlan(
        printer=printer.name,
        bed_x=printer.bed_x,
        bed_y=printer.bed_y,
        max_z=printer.max_z,
        origin=printer.origin,
        plates=plates,
        skipped=skipped,
        warnings=warnings,
    )
    return plan, runs


def _center(parts: list[PlacedPart], width: float, depth: float) -> None:
    """Shift a packed plate so its parts' bounding box is centered in the usable area."""
    if not parts:
        return
    dx = (width - max(p.x + p.width for p in parts) + min(p.x for p in parts)) / 2
    dy = (depth - max(p.y + p.depth for p in parts) + min(p.y for p in parts)) / 2
    dx -= min(p.x for p in parts)
    dy -= min(p.y for p in parts)
    for part in parts:
        part.x += dx
        part.y += dy


def _layout_warnings(run: PlateRun, width: float, depth: float) -> list[str]:
    """Problems in a hand-adjusted plate: parts off the usable bed or overlapping."""
    eps = 1e-6
    found: list[str] = []
    for part in run.parts:
        if (
            part.x < -eps
            or part.y < -eps
            or part.x + part.width > width + eps
            or part.y + part.depth > depth + eps
        ):
            found.append(
                f"Plate {run.index}: {part.node.instance_key} extends past the usable bed"
            )
    for i, a in enumerate(run.parts):
        for b in run.parts[i + 1 :]:
            if (
                a.x < b.x + b.width - eps
                and b.x < a.x + a.width - eps
                and a.y < b.y + b.depth - eps
                and b.y < a.y + a.depth - eps
            ):
                found.append(
                    f"Plate {run.index}: {a.node.instance_key} overlaps {b.node.instance_key}"
                )
    return found


def _summarize(run: PlateRun, printer: PrinterProfile) -> PlanPlate:
    inset = printer.bed_margin
    return PlanPlate(
        index=run.index,
        material=run.material,
        max_height=max((p.height for p in run.parts), default=0.0),
        parts=[
            PlanPart(
                node_id=p.node.node_id,
                instance_key=p.node.instance_key,
                definition_id=p.node.definition_id,
                x=round(inset + p.x, 4),
                y=round(inset + p.y, 4),
                width=round(p.width, 4),
                depth=round(p.depth, 4),
                height=round(p.height, 4),
                rotated=p.rotated,
                orientation=p.orientation,
            )
            for p in run.parts
        ],
    )
