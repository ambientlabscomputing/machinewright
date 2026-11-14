---
title: Create a starter project
description: Scaffold, evaluate and edit a new Machinewright design in a few minutes.
---

The bundled `basic` starter creates a design with two positioned plates and a typed width input. It is the quickest way to see the whole loop: declare, evaluate, inspect.

## 1. Create the project

```bash
machinewright project init indexing-table --starter basic
cd indexing-table
uv sync
```

`project init` creates a new directory and refuses to overwrite an existing one. Use `--output-dir` to choose the parent directory. The generated project pins Machinewright to the Git release tag that matches the version you ran, with a `v` prefix.

From a Machinewright checkout, `uv run machinewright project init indexing-table --output-dir ..` creates a sibling project.

## 2. Look around

```text
indexing-table/
├── design.py            # parts, assembly and the machine template
├── inputs.json          # typed inputs for the template
├── machinewright.toml   # declares templates and input configurations
├── pyproject.toml
└── README.md
```

`inputs.json` holds the requirements the design reads:

```json
{ "requirements": { "plate_width_mm": 40 } }
```

`design.py` defines a `Requirements` contract, a `Plate` part, a `Machine` assembly, and a `machine_template` function that ties them together:

```python
class Plate(PartDefinition):
    material = MATERIALS["PLA"]

    def __init__(self, width_mm: float):
        self.width_mm = width_mm

    def geometry(self) -> cadquery.Workplane:
        return cadquery.Workplane("XY").box(self.width_mm, 20, 4)


class Machine(AssemblyDefinition):
    def __init__(self, width_mm: float):
        self.width_mm = width_mm

    def define(self, builder: AssemblyBuilder) -> None:
        builder.part("base", Plate(self.width_mm))
        builder.part("cover", Plate(self.width_mm), transform=Transform.translated(z=12))
```

## 3. Validate and evaluate

```bash
uv run machinewright project validate
uv run machinewright project evaluate indexing-table.main 0.1.0 inputs.json artifacts/
```

Evaluation writes an artifact bundle to `artifacts/`: STEP and STL geometry, a preview SVG, structured BOM (JSON and CSV), the canonical graph (JSON and Graphviz DOT), and a provenance manifest. Printed parts also produce a print-layout STL.

## 4. Change an input

Edit `plate_width_mm` from `40` to `60` and evaluate into a new folder:

```bash
uv run machinewright project evaluate indexing-table.main 0.1.0 inputs.json artifacts-wide/
```

Both plates widen, because both read the same input. Compare the two manifests: the graph digest differs, and the artifact hashes record exactly what changed.

## 5. Open it in the app

Open the macOS app, choose **Open Project**, and select the `indexing-table` folder. Select `design.py` to edit it, and use the **Inputs** panel to change values and see the viewport update. Panel edits last for the session; edit `inputs.json` to make them permanent.

## Next steps

- [Build your first assembly](/docs/tutorials/first-assembly/)
- [Explore parameters with sweeps](/docs/tutorials/parameter-sweeps/)
- [Export artifacts](/docs/guides/exporting-artifacts/)
