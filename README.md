# Machinewright

A parametric CAD framework: hardware designed as composable, parametrized
code rather than drawn by hand.

- **`CADObject`** (`objects/base.py`) — a single part. Required
  constructor params are the design contract; `.cad()` returns the
  cadquery geometry.
- **`CADAssembly`** (`assemblies/base.py`) — composes `CADObject`s (and
  other assemblies) into a positioned `cadquery.Assembly`, deriving
  child params from system-level params rather than hardcoding them.
  Comes with a generic axial exploded view (`--exploded`,
  `--explode-nested` for exploding sub-assemblies' own internals too).
- **`objects/fasteners/`, `objects/bearings/`** — the reusable component
  library: generic, parametrized hardware (bolts, pins, bearings, ...)
  meant to be reused across designs, not tied to any one product. Add to
  these as real designs need new hardware types.
- **`registry.py`** + **`commands/`** — a CLI (`python -m
  machinewright.main`) that discovers every registered object/assembly
  and exports it to SVG, STEP, STL, or any other format cadquery
  supports.

## Usage

```bash
python -m machinewright.main objects list
python -m machinewright.main assemblies list
python -m machinewright.main export step "objects.shoulderbolt" --params '{"thread_size":"M3","shoulder_diameter":4,"shoulder_length":12,"thread_length":3}' --location out.step
```
