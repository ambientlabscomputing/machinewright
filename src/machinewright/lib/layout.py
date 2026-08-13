"""
Operations that key off Material.process (see lib/materials.py): finding
every part in an assembly tagged for a given process, and arranging
those parts into a single exportable layout (the concrete motivating
case: collect everything marked PRINTED and pack it onto a print bed).
"""

import math

import cadquery

from machinewright.assemblies.base import _walk_assembly
from machinewright.lib.materials import Process

_RESTING_FACE_EPSILON = 1e-3  # mm, tolerance for "this face is the one touching the bed"
_DOWNWARD_NORMAL_THRESHOLD = -0.99  # dot with (0,0,-1); planar faces only, near-exact match


def collect_by_process(assy: cadquery.Assembly, process: Process) -> list[cadquery.Shape]:
    """
    Recursively walks assy, returning world-located shapes for every leaf
    part whose attached material has the given process. Leaves with no
    material metadata are skipped, not an error.
    """
    return [
        shape.located(world_loc)
        for shape, metadata, world_loc, _name in _walk_assembly(assy)
        if (material := metadata.get("material")) is not None and material.process == process
    ]


def _overhang_area(shape: cadquery.Shape) -> float:
    """
    Sum of the areas of planar, downward-facing faces that aren't the
    face resting on the bed (i.e. faces that would print in mid-air and
    need support material) -- e.g. the shoulder of a counterbore facing
    down instead of up. Curved faces are skipped: a cylinder wall's
    normal varies across the face, so a single sampled normal can't
    classify it as "facing down" or not.
    """
    zmin = shape.BoundingBox().zmin
    total = 0.0
    for face in shape.Faces():
        if face.geomType() != "PLANE":
            continue
        if face.normalAt().z > _DOWNWARD_NORMAL_THRESHOLD:
            continue
        if abs(face.Center().z - zmin) < _RESTING_FACE_EPSILON:
            continue  # this is the face resting on the bed, not an overhang
        total += face.Area()
    return total


def _candidate_orientations(shape: cadquery.Shape) -> list[cadquery.Shape]:
    """
    The 6 axis-aligned "which face is down" orientations reachable from
    `shape`'s current placement: as-is, and each 90/180/270 degree
    rotation about the world X and Y axes needed to bring a different
    pair of faces to the top/bottom. This matters because a part's
    placement *in its assembly* (not just how it was authored) can leave
    it sitting on its side -- e.g. a sub-assembly mounted 90 degrees off
    the top-level Z axis -- which a flip-only search can never correct
    since flipping keeps the same axis pointing down.
    """
    return [
        shape,
        shape.rotate((0, 0, 0), (1, 0, 0), 90),
        shape.rotate((0, 0, 0), (1, 0, 0), 180),
        shape.rotate((0, 0, 0), (1, 0, 0), 270),
        shape.rotate((0, 0, 0), (0, 1, 0), 90),
        shape.rotate((0, 0, 0), (0, 1, 0), 270),
    ]


def _best_orientation(shape: cadquery.Shape) -> cadquery.Shape:
    """
    Tries all 6 axis-aligned orientations (see _candidate_orientations)
    and keeps whichever has the least overhang area, breaking ties by
    the shortest bounding-box height (preferring a part lying on its
    flattest face over one standing on edge when both happen to have
    zero overhang). Ties on both keep the as-placed orientation, since
    it's first in the candidate list and Python's min() is stable.
    """

    def score(candidate: cadquery.Shape) -> tuple[float, float]:
        return _overhang_area(candidate), candidate.BoundingBox().zlen

    return min(_candidate_orientations(shape), key=score)


def layout_for_printing(
    assy: cadquery.Assembly,
    process: Process = Process.PRINTED,
    spacing: float = 5.0,
    bed_size: tuple[float, float] | None = None,
    optimize_orientation: bool = True,
) -> cadquery.Workplane:
    """
    Collects every part in `assy` matching `process`.

    If `optimize_orientation` is True (default), each part is tried in
    all 6 axis-aligned orientations (see _candidate_orientations),
    keeping whichever has the least overhanging (unsupported) area,
    tie-broken by the shortest bounding-box height -- this both avoids
    overhangs like a counterbore shoulder facing down, and corrects a
    part that's sitting on its side because of how it was placed in the
    assembly rather than lying on its flattest face.

    Each part is then dropped so its bounding box sits flush on Z=0, and
    shelf-packed into rows: sorted by footprint (bounding-box X*Y)
    descending, placed left-to-right with `spacing` between parts,
    wrapping to a new row when the next part would exceed the target bed
    width, with rows stacked along Y separated by `spacing`. If
    `bed_size` isn't given, a target width is auto-computed from the
    total footprint area to aim for a roughly square layout instead of
    one long row -- pass `bed_size` explicitly to match a real printer's
    bed instead.

    Returns a single combined Workplane -- the same shape the existing
    export commands already expect. Raises ValueError if no parts match.
    """
    shapes = collect_by_process(assy, process)
    if not shapes:
        raise ValueError(f"No parts found for process {process}")

    if optimize_orientation:
        shapes = [_best_orientation(shape) for shape in shapes]

    dropped = []
    for shape in shapes:
        bbox = shape.BoundingBox()
        dropped.append(shape.translate((0, 0, -bbox.zmin)))

    dropped.sort(
        key=lambda shape: shape.BoundingBox().xlen * shape.BoundingBox().ylen,
        reverse=True,
    )

    if bed_size is not None:
        bed_width = bed_size[0]
    else:
        total_area = sum(
            shape.BoundingBox().xlen * shape.BoundingBox().ylen for shape in dropped
        )
        bed_width = math.sqrt(total_area) * 1.2  # margin for packing/spacing inefficiency

    cursor_x = 0.0
    cursor_y = 0.0
    row_height = 0.0
    placed = []
    for shape in dropped:
        bbox = shape.BoundingBox()
        width, depth = bbox.xlen, bbox.ylen

        if cursor_x > 0 and cursor_x + width > bed_width:
            cursor_y += row_height + spacing
            cursor_x = 0.0
            row_height = 0.0

        placed.append(shape.translate((cursor_x - bbox.xmin, cursor_y - bbox.ymin, 0)))

        cursor_x += width + spacing
        row_height = max(row_height, depth)

    compound = cadquery.Compound.makeCompound(placed)
    return cadquery.Workplane(obj=compound)
