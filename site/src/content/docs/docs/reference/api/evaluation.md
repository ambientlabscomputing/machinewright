---
title: "Evaluation"
description: "Headless project evaluation, caching and provenance."
sidebar:
  order: 6
---

Headless project evaluation, caching and provenance.

### `DependencyRecord`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class DependencyRecord(Contract)
```

_No description yet._


### `evaluate_project`

<p><em>function in <code>machinewright.evaluation</code></em></p>

```python
def evaluate_project(
    project_root: Path,
    template_id: str,
    template_version: str,
    inputs: Mapping[str, Any],
    output_directory: Path,
    generation: int = 0,
    request: ExportRequest | None = None,
    cancellation: CancellationToken | None = None,
    progress: Callable[[Any], None] | None = None,
    cache: EvaluationCache | None = None,
    on_input_schema: Callable[[dict[str, Any]], None] | None = None
) -> EvaluationOutcome
```

_No description yet._

### `EvaluationCache`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class EvaluationCache:
    __init__(
    root: Path
    )
```

_No description yet._

##### `restore`

```python
def restore(
    key: str,
    destination: Path
) -> EvaluationOutcome | None
```

##### `store`

```python
def store(
    key: str,
    destination: Path,
    outcome: EvaluationOutcome
) -> None
```

### `EvaluationOutcome`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class EvaluationOutcome(Contract)
```

_No description yet._


### `EvaluationProvenance`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class EvaluationProvenance(Contract)
```

_No description yet._


### `EvaluationSnapshot`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class EvaluationSnapshot(Contract)
```

_No description yet._


### `MeshReference`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class MeshReference(Contract)
```

_No description yet._


### `SourceMapping`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class SourceMapping(Contract)
```

_No description yet._


### `SourceSpan`

<p><em>class in <code>machinewright.evaluation</code></em></p>

```python
class SourceSpan(Contract)
```

_No description yet._

