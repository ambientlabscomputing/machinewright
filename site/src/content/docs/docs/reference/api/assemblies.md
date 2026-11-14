---
title: "Assemblies"
description: "Assembly definitions that declare topology through a builder."
sidebar:
  order: 2
---

Assembly definitions that declare topology through a builder.

### `AssemblyDefinition`

<p><em>class in <code>machinewright.assemblies.base</code></em></p>

```python
class AssemblyDefinition
```

A reusable graph-first hardware assembly definition.

##### `define`

```python
def define(
    builder: AssemblyBuilder
) -> None
```

Declare children and connections through ``builder``.

##### `resolve`

```python
def resolve(
    root_id: str = 'assembly'
) -> ResolvedDesign
```

##### `cad`

```python
def cad(
    exploded: bool = False,
    spacing: float = 30.0,
    nested: bool = False
)
```
