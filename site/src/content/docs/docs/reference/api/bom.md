---
title: "Bill of materials"
description: "Structured BOM generation and writers."
sidebar:
  order: 8
---

Structured BOM generation and writers.

### `BOM`

<p><em>class in <code>machinewright.lib.bom</code></em></p>

```python
class BOM(Contract)
```

_No description yet._


### `BOMLineV1`

<p><em>class in <code>machinewright.lib.bom</code></em></p>

```python
class BOMLineV1(Contract)
```

_No description yet._


### `generate_structured_bom`

<p><em>function in <code>machinewright.lib.bom</code></em></p>

```python
def generate_structured_bom(
    graph: ResolvedHardwareGraph
) -> BOM
```

_No description yet._

### `write_bom_csv`

<p><em>function in <code>machinewright.lib.bom</code></em></p>

```python
def write_bom_csv(
    graph: ResolvedHardwareGraph,
    location: str | Path
) -> None
```

_No description yet._

### `write_bom_json`

<p><em>function in <code>machinewright.lib.bom</code></em></p>

```python
def write_bom_json(
    graph: ResolvedHardwareGraph,
    location: str | Path
) -> None
```

_No description yet._
