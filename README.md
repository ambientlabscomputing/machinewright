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
  these as real designs need new hardware types. New built-ins are
  imported directly from their module path (e.g. `from
  machinewright.objects.fasteners.shoulder_bolt import ShoulderBolt`) —
  there's no separate re-export index to keep in sync.
- **`registry.py`** + **`commands/`** — a CLI (`python -m
  machinewright.main`) that discovers every registered object/assembly
  and exports it to SVG, STEP, STL, or any other format cadquery
  supports.

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

## Usage

```bash
python -m machinewright.main objects list
python -m machinewright.main assemblies list
python -m machinewright.main export step "objects.machinewright.objects.fasteners.shoulder_bolt.ShoulderBolt" --params '{"thread_size":"M3","shoulder_diameter":4,"shoulder_length":12,"thread_length":3}' --location out.step
```
