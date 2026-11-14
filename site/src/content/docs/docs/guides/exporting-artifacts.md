---
title: Exporting artifacts
description: Export STEP, STL, BOM and bundles from the CLI and the app.
---

Every evaluation already writes its artifacts. Export commands and the app's **Export** button copy or re-project them.

## From the CLI

```bash
machinewright export step "assemblies.your_package.assemblies.Product" --location product.step
machinewright export bom  "assemblies.your_package.assemblies.Product" --location bom.csv
machinewright export bundle "assemblies.your_package.assemblies.Product" --location artifacts/
```

For portable projects, `project evaluate` writes the same bundle:

```bash
machinewright project evaluate my-machine.main 0.1.0 inputs.json artifacts/
```

## What is in a bundle

| Artifact | Purpose |
| --- | --- |
| `*.step` | Full assembly for CAD tools |
| `*.stl` | Mesh of the assembly |
| `*.svg` | Preview image |
| `*.bom.json`, `*.bom.csv` | Structured bill of materials |
| `*.hardware-graph.json` | Canonical graph |
| `*.hardware-graph.dot` | Graphviz view of the graph |
| `*.manifest.json` | Provenance: graph digest and artifact hashes |
| `*.print-layout.stl` | Plate layout, when the design has printed parts |

## From the app

The **Export** button (also `Cmd+Shift+E`) has two tabs:

- **Assembly** exports the whole design as STEP or STL. It is a save-as copy of exactly what the viewport shows.
- **Parts** exports per-part or one combined STL/STEP for all parts, printed parts only, or the current selection. Selecting an assembly in the graph covers all parts beneath it. Parts can keep their assembly position or be exported at their own origin.
