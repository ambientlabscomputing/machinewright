"""
Operations that key off Material.process (see lib/materials.py): finding
every part in an assembly tagged for a given process, and arranging
those parts into a single exportable layout (the concrete motivating
case: collect everything marked PRINTED and pack it onto a print bed).
"""

import cadquery

from machinewright.assemblies.base import _walk_assembly
from machinewright.lib.materials import Process


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


def layout_for_printing(
    assy: cadquery.Assembly,
    process: Process = Process.PRINTED,
    spacing: float = 5.0,
    bed_size: tuple[float, float] | None = None,
) -> cadquery.Workplane:
    """
    Collects every part in `assy` matching `process`, drops each so its
    bounding box sits flush on Z=0 (no rotation -- "as designed"
    orientation is kept), and shelf-packs them into rows: sorted by
    footprint (bounding-box X*Y) descending, placed left-to-right with
    `spacing` between parts, wrapping to a new row when the next part
    would exceed bed_size[0] (unbounded if bed_size is None), with rows
    stacked along Y separated by `spacing`.

    Returns a single combined Workplane -- the same shape the existing
    export commands already expect. Raises ValueError if no parts match.
    """
    shapes = collect_by_process(assy, process)
    if not shapes:
        raise ValueError(f"No parts found for process {process}")

    dropped = []
    for shape in shapes:
        bbox = shape.BoundingBox()
        dropped.append(shape.translate((0, 0, -bbox.zmin)))

    dropped.sort(
        key=lambda shape: shape.BoundingBox().xlen * shape.BoundingBox().ylen,
        reverse=True,
    )

    bed_width = bed_size[0] if bed_size is not None else float("inf")

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
