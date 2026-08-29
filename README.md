# Machinewright

A parametric CAD framework: hardware designed as composable, parametrized
code rather than drawn by hand.

Machinewright 0.2 adds the generic RFD-18 M3 substrate: explicit-unit hardware
specifications, tolerances, typed interfaces and motor requirements,
content-addressed assembly graphs, structured JSON BOMs, and a cancellable
headless artifact exporter. These contracts intentionally contain no Jog
qualification, supplier, pricing, or release policy.

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
  these as real designs need new hardware types. New built-ins are
  imported directly from their module path (e.g. `from
  machinewright.objects.fasteners.shoulder_bolt import ShoulderBolt`) —
  there's no separate re-export index to keep in sync.
- **`registry.py`** + **`commands/`** — the `machinewright` CLI, which
  discovers every registered object/assembly and exports it to SVG, STEP,
  STL, or any other format cadquery supports.
- **`lib/materials.py`** — `Material`/`Process` tracking on `CADObject`
  parts (set as a class attribute, overridable per-instance), plus
  `attach()` to wire a part's material into an assembly's cadquery tree
  (native color/material for STEP, plus our own metadata for filtering).
- **`lib/layout.py`** — operations that key off material, e.g.
  `collect_by_process`/`layout_for_printing`: given an assembly, find
  every part tagged for a given process (PRINTED, MACHINED, PURCHASED,
  ...) and pack it into a single exportable layout. Each part is also
  tried in all 6 axis-aligned orientations, keeping whichever has the
  least unsupported (overhanging) area, tie-broken by the shortest
  bounding-box height — this both avoids overhangs (e.g. a counterbore's
  shoulder facing down) and corrects a part that's sitting on its side
  because of how it was placed in the assembly, not just how it was
  authored. Packing shelf-wraps into rows sized to keep the layout
  roughly square by default (pass `bed_size` to match a real printer's
  bed instead of the auto-computed size).
- **`lib/bom.py`** — `generate_bom`/`write_bom_csv`: walks an assembly's
  leaf parts and groups repeated instances of the same part (same class,
  constructor params, and material) into one line item with a quantity,
  reporting material, process, envelope dimensions, volume, mass (when
  the material has a density), captured params, and reference names —
  exposed as the `export bom` CLI subcommand.

## Defining your own parts

Subclass `CADObject`/`CADAssembly` anywhere in your own project and
decorate it to register it:

```python
from machinewright import CADObject, register_object

@register_object
class MotorMount(CADObject):
    def __init__(self, bolt_spacing: float): ...
    def cad(self): ...
```

For the `machinewright` CLI to see it, tell it which module(s) to import.
Either pass `--module`/`-m` (repeatable), or — more usefully for a whole
project — list them once in your own `pyproject.toml`:

```toml
[tool.machinewright]
modules = [
    "jog_actuators.objects.motor_mount",
    "jog_actuators.assemblies.actuator_assembly",
]
```

Registered classes are keyed by their fully-qualified dotted path, so
`objects list`/`assemblies list` show exactly the identifier to pass to
`export`.

## Tracking material and color

Give a part a default material by setting the `material` class attribute
(consumers can override per-instance with plain attribute assignment):

```python
from machinewright import MATERIALS, CADObject, register_object

@register_object
class Bracket(CADObject):
    material = MATERIALS["PETG"]
    def __init__(self, thickness: float): ...
    def cad(self): ...
```

Inside `assemble()`, use `attach()` instead of raw `assy.add(...)` so the
part's material flows into the assembly's cadquery tree (native
color/material for STEP export, plus our own metadata for filtering):

```python
from machinewright import attach

def assemble(self):
    assy = cadquery.Assembly()
    attach(assy, Bracket(thickness=3), loc=..., name="bracket")
    return assy
```

`collect_by_process`/`layout_for_printing` then operate on that assembly:
given a `CADAssembly`, find every part tagged for a process and pack it
into a single exportable layout — exposed both as a Python function and
as the `export print-layout` CLI subcommand.

`attach()` also records each part's class and constructor-set attributes
(a generic stand-in for "params", since every `CADObject` subclass sets
`self.foo = foo` per param) as metadata, which is what `generate_bom`
uses to group repeated parts and report their dimensions — no separate
BOM-specific authoring step needed beyond using `attach()`.

## Usage

```bash
machinewright objects list
machinewright assemblies list
machinewright export step "objects.machinewright.objects.fasteners.shoulder_bolt.ShoulderBolt" --params '{"thread_size":"M3","shoulder_diameter":4,"shoulder_length":12,"thread_length":3}' --location out.step
machinewright export print-layout "assemblies.your_project.assemblies.actuator.ActuatorAssembly" --process printed --location print_layout.stl
machinewright export bom "assemblies.your_project.assemblies.actuator.ActuatorAssembly" --location bom.csv
machinewright export bundle "assemblies.your_project.assemblies.actuator.ActuatorAssembly" --location artifacts/
```

## Development

### Release

New production release

```bash
uv run bump2version minor --new-version <new semver version>
```

New release candidate
```bash
uv run bump2version build --new-version <semver tag + rc revision>
```
