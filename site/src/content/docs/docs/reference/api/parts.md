---
title: "Parts"
description: "Leaf parts: geometry, materials, ports and manufacturing facts."
sidebar:
  order: 1
---

Leaf parts: geometry, materials, ports and manufacturing facts.

### `PartDefinition`

<p><em>class in <code>machinewright.objects.base</code></em></p>

```python
class PartDefinition
```

A reusable leaf-part definition in a hardware graph.

##### `geometry`

```python
def geometry() -> cadquery.Workplane
```

Return this leaf part's resolved CadQuery geometry.

##### `describe`

```python
def describe() -> dict[str, Any]
```

Return the canonical semantic description used by graph resolution.
