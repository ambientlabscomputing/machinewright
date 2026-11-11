# Machinewright

Machinewright is a graph-native hardware-as-code framework. A design declares
part and assembly instances, typed ports, containment, transforms, and
connections. Machinewright resolves that declaration once and projects CAD,
BOMs, print layouts, documentation graphs, and artifact manifests from the same
canonical `ResolvedHardwareGraph`.

CadQuery remains the leaf-geometry engine. It is not the assembly model.

## Start a new design

With Machinewright and uv installed, run:

```bash
machinewright project init indexing-table --starter basic
cd indexing-table
uv sync
uv run machinewright project evaluate indexing-table.main 0.1.0 inputs.json artifacts/
```

The bundled starter creates two positioned plates in `design.py` and a typed
width input in `inputs.json`. Change the width and evaluate again to see both
plates grow. Open the generated folder in the macOS app to edit the source
and inspect the design.

The generated project uses the installed Machinewright version. When the CLI
is installed directly from a checkout, wheel, or Git commit, the project
uses that same source. A local checkout or wheel must remain available while
the project uses it. The command creates a new directory and refuses an
existing destination. Use `--output-dir` to choose the parent directory.
From a Machinewright checkout, run
`uv run machinewright project init indexing-table --output-dir ..` to create
a sibling project.

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

The React Native macOS app opens a Machinewright project and edits its Python
source. It evaluates unsaved changes through the project's Python worker,
keeps the last valid snapshot if a newer evaluation fails, and links graph
and viewport selection to source locations. For inline diagnostics, install
`pylsp` in the project environment alongside `machinewright-worker`.

With Xcode, CocoaPods, Node.js 24+, and uv installed, run from the
Machinewright checkout:

```bash
make sync
make app-install
make run
```

Use **Open Project** to select the Machinewright checkout for the reference
design. Its template lives in `examples/reference_project.py`.

The default export bundle includes STEP, STL, preview SVG, structured BOM JSON,
BOM CSV, canonical hardware-graph JSON, Graphviz DOT, and a provenance
manifest. It includes a print-layout STL when the design contains printed
parts. Logical digests are derived from canonical graph content.

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
