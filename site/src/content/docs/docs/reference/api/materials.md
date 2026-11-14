---
title: "Materials"
description: "Materials and manufacturing processes."
sidebar:
  order: 9
---

Materials and manufacturing processes.

### `Material`

<p><em>class in <code>machinewright.lib.materials</code></em></p>

```python
class Material:
    __init__(
    name: str,
    process: Process,
    color: tuple[float, float, float] = (0.7, 0.7, 0.7),
    density: float | None = None
    )
```

_No description yet._


### `MATERIALS`

<p><em>data in <code>machinewright.lib.materials</code></em></p>

```python
MATERIALS
```

_No description yet._

### `Process`

<p><em>class in <code>machinewright.lib.materials</code></em></p>

```python
class Process(str, Enum)
```

_No description yet._

