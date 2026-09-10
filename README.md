# Machinewright

Machinewright is a graph-native hardware-as-code framework. A design declares
part and assembly instances, typed ports, containment, transforms, and
connections. Machinewright resolves that declaration once and projects CAD,
BOMs, print layouts, documentation graphs, and artifact manifests from the same
canonical `ResolvedHardwareGraph`.

CadQuery remains the leaf-geometry engine. It is not the assembly model.

## Authoring parts

Parts subclass `PartDefinition`. Constructor attributes are canonical design
parameters, `geometry()` returns the leaf shape, and `ports` declares external
interfaces.

```python
import cadquery
from machinewright import PartDefinition, register_object


@register_object
class Bracket(PartDefinition):
    def __init__(self, width: float):
        self.width = width

    def geometry(self) -> cadquery.Workplane:
        return cadquery.Workplane("XY").box(self.width, 20, 4)
```

Parts may also declare material, process, manufacturer identity, finish,
inspection, and typed `PortDefinition` records. `describe()` exposes those
facts to the resolver.

## Authoring assemblies

Assemblies subclass `AssemblyDefinition` and declare their topology through an
`AssemblyBuilder`. Explicit instance and connection keys make identity stable
and reviewable.

```python
from machinewright import (
    AssemblyBuilder,
    AssemblyDefinition,
    ConnectionKind,
    Transform,
    register_assembly,
)


@register_assembly
class Product(AssemblyDefinition):
    def define(self, builder: AssemblyBuilder) -> None:
        base = builder.part("base", Bracket(width=40))
        cover = builder.part(
            "cover", Bracket(width=40), transform=Transform.translated(z=10)
        )
        builder.connect(
            "cover-mount",
            base.port("mount"),
            cover.port("mount"),
            kind=ConnectionKind.MECHANICAL,
        )
```

Supported H0 connection kinds are `mechanical`, `electrical_power`, `signal`,
and `thermal`. Mechanical ports require local frames. Required ports,
cardinality, direction, containment integrity, and interface compatibility are
validated during resolution.

See [Graph architecture](docs/graph-architecture.md) for the contract and
invariants.

## Discovery and export

Consumer projects list registered modules in `pyproject.toml`:

```toml
[tool.machinewright]
modules = ["your_package.parts", "your_package.assemblies"]
```

The CLI discovers those definitions and exports projections:

```bash
machinewright objects list
machinewright assemblies list
machinewright export step "assemblies.your_package.assemblies.Product" --location product.step
machinewright export bom "assemblies.your_package.assemblies.Product" --location bom.csv
machinewright export bundle "assemblies.your_package.assemblies.Product" --location artifacts/
```

## Portable machine templates

Projects that expose typed hardware functions add a `machinewright.toml` beside
their `pyproject.toml` and lock file. Templates are ordinary Python callables:

```python
from machinewright import HardwareResult, machine_template

@machine_template(id="example.axis", version="1.0.0", cacheable=True)
def axis(requirements: AxisRequirements) -> HardwareResult:
    ...
```

The same headless evaluator is used by the CLI, isolated worker, CI, and native
application:

```bash
machinewright project validate
machinewright project schema example.axis 1.0.0 schema.json
machinewright project evaluate example.axis 1.0.0 inputs.json artifacts/
machinewright project sweep example.axis 1.0.0 inputs.json requirements.payload_kg 8 30 100 sweep/
```

`machinewright-worker` exposes the evaluator through the versioned Protobuf
contract in `proto/machinewright_worker.proto`. Worker stdout is reserved for
length-delimited protocol messages; logs and tracebacks use stderr or structured
failure events.

## Native editor

The native application uses Floem as an adapter around the framework-neutral
`machinewright-app` ports. It opens and edits a Python source file, tracks and
saves rope-backed changes, evaluates unsaved overlays after a 300 ms debounce,
and retains the last valid snapshot when a newer generation fails. The graph
panel and GPU-backed projected geometry view share component selection and show
the selected source mapping. A pinned `ty` language server runs behind the
framework-neutral language port and reports diagnostics for unsaved buffers.

```bash
cd native
MACHINEWRIGHT_WORKER=../.venv/bin/machinewright-worker \
  cargo run -p machinewright-floem --bin machinewright-floem -- \
  ../examples/reference_project.py
```

A bundle can contain STEP, STL, preview SVG, print-layout STL, structured BOM
JSON, BOM CSV, canonical hardware-graph JSON, Graphviz DOT, and a provenance
manifest. Logical digests are derived from canonical graph content rather than
CAD file bytes.

## Development

```bash
uv sync --group dev
uv run pytest
uv run ruff check .
uv run mypy -p machinewright
```

### Release

New production release:

```bash
uv run bump2version minor --new-version <new semver version>
```

New release candidate:

```bash
uv run bump2version build --new-version <semver tag + rc revision>
```

The configured release command updates the package version, commits it, and
creates the Git tag. Do not edit the authoritative version or create release
tags manually.
