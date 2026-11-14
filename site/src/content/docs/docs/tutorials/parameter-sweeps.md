---
title: Explore parameters with sweeps
description: Evaluate a design across a range of inputs from the command line.
sidebar:
  order: 2
---

Because a design is a function of typed inputs, you can evaluate it across a range of values headlessly. This is the same evaluator the app, the worker and CI use.

## Prerequisites

A project with a declared template and an `inputs.json`. The [starter project](/docs/starter-project/) works.

## Validate and inspect the schema

```bash
uv run machinewright project validate
uv run machinewright project schema indexing-table.main 0.1.0 schema.json
```

`schema.json` is the JSON Schema for the template's requirements, handy for editors and for generating input forms.

## Run a linear sweep

Sweep a single input across a range, evaluating at each point:

```bash
uv run machinewright project sweep indexing-table.main 0.1.0 inputs.json \
  requirements.plate_width_mm 20 80 7 sweep/
```

The arguments after the input file are the dotted input path, the start and end values, the number of points, and the output directory. Each point is evaluated into its own subdirectory, with the usual artifact bundle.

## Compare results

Every evaluation writes a manifest with the canonical graph digest. Two points with different digests produced different designs; identical digests mean identical topology and parameters. The BOM files in each folder show how part quantities and parameters change across the sweep.

## Use it in CI

The evaluator is deterministic: repeated resolution of the same declaration produces byte-identical canonical graph JSON. Golden evaluations in `machinewright.toml` let CI assert that a design still produces the expected graph:

```toml
[[golden_evaluations]]
name = "reference"
template_id = "indexing-table.main"
template_version = "0.1.0"
inputs = "inputs.json"
```
