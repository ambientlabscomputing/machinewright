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

The generated project pins Machinewright to the Git release tag for the
version in Machinewright's `pyproject.toml`, with a `v` prefix. The command
creates a new directory and refuses an existing destination. Use
`--output-dir` to choose the parent directory.
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

### Exporting from the app

The macOS app has an **Export** button (also `Cmd+Shift+E` and the command
palette) with two tabs, and a separate **3D Print** app tab:

- **Assembly** — whole-design STEP or STL. Every evaluation already writes both
  files, so this is a save-as copy of exactly what the viewport shows.
- **Parts** — per-part (or one combined) STL/STEP for all parts, printed parts
  only, or the current selection (selecting an assembly in the graph covers all
  parts beneath it). Parts can keep their assembly position or be exported at
  their own origin.
- **3D Print** (its own app-level tab, next to the workspace) — a full-window 3D
  view of your printer's bed with floating tool boxes: printer settings and
  **Generate Plates** on the left, the plate list on the right. A progress bar
  follows orienting, packing, and writing, and each plate appears in the view the
  moment its STL is written. **Export STLs…** copies the set to a folder you
  choose, for a real slicer. Machinewright does not slice or generate G-code.

### Purchased-parts BOM

The **BOM** app tab shows the design's purchased parts (material process
`PURCHASED`). The lines are Machinewright's own BOM — the `bom.json` every
evaluation writes (`lib/bom.py`) — so grouping, quantities and manufacturer
identity are exactly what `machinewright export bom` produces; the tab adds no
second BOM logic. For each line you can
record supplier, SKU, product link, unit cost, spares, order status (to order /
ordered / received / on hand), and notes; the tab totals units to buy and cost
and exports a CSV. **Show in Viewport** selects a line's instances in the 3D view.

Procurement data is saved in `bom-procurement.json` in the project root (schema:
`schemas/ProcurementFile-1.0.schema.json`), so it can be committed with the design.
It is keyed by the BOM line's `line_id` (a digest of part definition, revision, and
parameters), so it survives unrelated edits; entries for parts that leave the
design are kept in case they return. The **Export CSV** button runs the same code as
the CLI below, in the worker.

The file and the merge with the BOM live in `lib/procurement.py`, shared by the app,
the CLI, and agents. For scripting and sourcing work:

```bash
machinewright bom list --unsourced --json     # purchased lines still missing a supplier or price
machinewright bom set 4702b31a22e0 --supplier McMaster --sku 91290A115 \
    --unit-cost 0.12 --spares 2 --status ordered
machinewright bom export parts.csv            # BOM + sourcing as CSV
```

Commands read the newest `.machinewright/output/assembly-*.bom.json` (or `--bom`),
accept a unique prefix of a line id, and write the procurement file atomically. The
app reads the file when the BOM tab opens, so reopen the tab after editing it
externally.

Print planning rules:

- Only parts whose material process is `PRINTED` are planned.
- Plates never mix materials (different filaments cannot share a run), so a
  design using two nylons produces separate plates for each.
- Each part is laid on its least-overhanging axis-aligned face (overhang means
  surfaces steeper than 45 degrees, including curved ones). Taller orientations
  pay a penalty, so a marginal overhang saving never produces a very tall print.
  Choose **As designed** to keep authored orientations.
- Parts are shelf-packed with the configured spacing and bed margin, rotating
  90 degrees about Z when that helps, and spill onto extra plates when a bed
  fills. Parts too tall or too large for the printer are listed as skipped, never
  silently dropped.
- Output is `<name>-plate-NN-<material>.stl` per plate plus `<name>-plan.json`
  (positions, orientations, skipped parts). Coordinates put the bed's front-left
  corner (or its center, if configured) at the origin.

Printer and export settings are saved per project in
`.machinewright/export-settings.json`; generated plates live in
`.machinewright/print/` until you export them. The same jobs run in the worker through
the `RunExportJob` protocol message, so they never interrupt live evaluation.

The planner does not generate supports. Parts with unavoidable overhangs (for
example a closed cup with features facing both ways) still need supports enabled
in your slicer.

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
source with syntax highlighting, auto-indentation, folding, search, and
Command-S to save. Project-local `pylsp` provides completions (Control-Space),
hover documentation, Go to Definition (F12), and inline diagnostics.
The Inputs panel exposes the active template's fields and re-evaluates the
preview as you change values. Panel edits apply for the current session.
Edit the project's input JSON to persist values.

The editor evaluates unsaved changes through the project's Python worker,
keeps the last valid snapshot if a newer evaluation fails, and links graph
and viewport selection to source locations. `pylsp` is a core
Machinewright dependency, so any project that depends on Machinewright has it in
its `.venv` with no extra install step.

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
