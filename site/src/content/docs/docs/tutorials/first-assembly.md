---
title: Build your first assembly
description: Write a part, place it in an assembly, connect it, and export a bundle.
sidebar:
  order: 1
---

In this tutorial you will extend the starter project with a custom part, position it in an assembly, and connect two parts through typed ports. You need a project from [Create a starter project](/docs/starter-project/).

## 1. Write a part

Parts subclass `PartDefinition`. Constructor attributes are the canonical design parameters, and `geometry()` returns the leaf shape. Register the class so the CLI can discover it:

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

Parts may also declare material, process, manufacturer identity, finish, inspection requirements and typed `PortDefinition` records. These facts flow into the BOM and print planner.

## 2. Assemble it

Assemblies subclass `AssemblyDefinition` and declare their topology through an `AssemblyBuilder`. Explicit keys such as `"base"` and `"cover"` make instance identity stable and reviewable:

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

The `connect` call references a `mount` port. Declare it on the part with a `PortDefinition`; mechanical ports require local frames. Required ports, cardinality, direction, containment integrity and interface compatibility are all validated when the design resolves.

## 3. Register the modules

List the modules that contain your definitions in `pyproject.toml`:

```toml
[tool.machinewright]
modules = ["your_package.parts", "your_package.assemblies"]
```

## 4. Check discovery

```bash
uv run machinewright objects list
uv run machinewright assemblies list
```

## 5. Export a bundle

```bash
uv run machinewright export bundle "assemblies.your_package.assemblies.Product" --location artifacts/
```

The bundle contains STEP, STL, a preview SVG, BOM JSON and CSV, the canonical hardware-graph JSON and DOT, and a manifest. Open the `.dot` file with Graphviz to see the topology you declared.

## What you learned

- Parts own geometry and parameters; assemblies own topology.
- Every output comes from the same resolved graph, so they cannot disagree.
- Explicit instance keys keep identity stable as the design evolves.

Continue with [parameter sweeps](/docs/tutorials/parameter-sweeps/).
