---
title: "Export"
description: "Artifact export: STEP, STL, BOM, graph and manifest."
sidebar:
  order: 7
---

Artifact export: STEP, STL, BOM, graph and manifest.

### `apply_linux_process_limits`

<p><em>function in <code>machinewright.export_service</code></em></p>

```python
def apply_linux_process_limits(
    limits: ExportLimits
) -> None
```

Apply hard limits to the current dedicated worker process on Linux.

### `ArtifactResult`

<p><em>class in <code>machinewright.export_service</code></em></p>

```python
class ArtifactResult(Contract)
```

_No description yet._


### `CancellationToken`

<p><em>class in <code>machinewright.export_service</code></em></p>

```python
class CancellationToken
```

_No description yet._

##### `cancel`

```python
def cancel() -> None
```

### `export_artifacts`

<p><em>function in <code>machinewright.export_service</code></em></p>

```python
def export_artifacts(
    assembly: AssemblyDefinition | ResolvedDesign,
    output_directory: str | Path,
    request: ExportRequest | None = None,
    progress: Callable[[ExportProgress], None] | None = None,
    cancellation: CancellationToken | None = None
) -> ExportResult
```

Export requested artifacts, cleaning partial output on any failure.

Memory and CPU limits are applied to the current process when requested, so
callers should set them only in a dedicated Linux worker process. Elapsed
time, part count, cancellation, and output bytes are enforced directly.
A full bundle omits the print layout when there are no printed parts.

### `ExportFormat`

<p><em>class in <code>machinewright.export_service</code></em></p>

```python
class ExportFormat(StrEnum)
```

_No description yet._


### `ExportLimits`

<p><em>class in <code>machinewright.export_service</code></em></p>

```python
class ExportLimits(Contract)
```

_No description yet._


### `ExportProgress`

<p><em>class in <code>machinewright.export_service</code></em></p>

```python
class ExportProgress(Contract)
```

_No description yet._


### `ExportRequest`

<p><em>class in <code>machinewright.export_service</code></em></p>

```python
class ExportRequest(Contract)
```

_No description yet._


### `ExportResult`

<p><em>class in <code>machinewright.export_service</code></em></p>

```python
class ExportResult(Contract)
```

_No description yet._

