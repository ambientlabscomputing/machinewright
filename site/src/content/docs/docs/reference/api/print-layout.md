---
title: "Print layout"
description: "Plate layout helpers for printed parts."
sidebar:
  order: 10
---

Plate layout helpers for printed parts.

### `collect_by_process`

<p><em>function in <code>machinewright.lib.layout</code></em></p>

```python
def collect_by_process(
    design: ResolvedDesign,
    process: Process
) -> list[cadquery.Shape]
```

Recursively walks assy, returning world-located shapes for every leaf
part whose attached material has the given process. Leaves with no
material metadata are skipped, not an error.

### `layout_for_printing`

<p><em>function in <code>machinewright.lib.layout</code></em></p>

```python
def layout_for_printing(
    design: ResolvedDesign,
    process: Process = Process.PRINTED,
    spacing: float = 5.0,
    bed_size: tuple[float, float] | None = None,
    optimize_orientation: bool = True
) -> cadquery.Workplane
```

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
