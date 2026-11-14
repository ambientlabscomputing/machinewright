---
title: "Machine templates"
description: "Portable, typed hardware functions that tools can evaluate headlessly."
sidebar:
  order: 5
---

Portable, typed hardware functions that tools can evaluate headlessly.

### `ComponentCatalog`

<p><em>class in <code>machinewright.templates</code></em></p>

```python
class ComponentCatalog(Contract)
```

Generic catalog input; qualification status remains consumer policy.


### `EvidenceRequirement`

<p><em>class in <code>machinewright.templates</code></em></p>

```python
class EvidenceRequirement(Contract)
```

_No description yet._


### `get_machine_template`

<p><em>function in <code>machinewright.templates</code></em></p>

```python
def get_machine_template(
    template_id: str,
    version: str
) -> MachineTemplate
```

_No description yet._

### `HardwareResult`

<p><em>class in <code>machinewright.templates</code></em></p>

```python
class HardwareResult:
    __init__(
    design: ResolvedDesign,
    observables: tuple[Observable, ...] = (),
    diagnostics: tuple[Diagnostic, ...] = (),
    control_configuration: Mapping[str, Any] | None = None,
    evidence_requirements: tuple[EvidenceRequirement, ...] = ()
    )
```

Runtime result returned by a portable hardware function.


### `machine_template`

<p><em>function in <code>machinewright.templates</code></em></p>

```python
def machine_template(
    id: str,
    version: str,
    cacheable: bool = False
) -> Callable[[_T], _T]
```

Declare an ordinary callable as a versioned portable machine template.

### `machine_templates`

<p><em>function in <code>machinewright.templates</code></em></p>

```python
def machine_templates() -> tuple[MachineTemplate, ...]
```

_No description yet._

### `ManufacturingCapabilities`

<p><em>class in <code>machinewright.templates</code></em></p>

```python
class ManufacturingCapabilities(Contract)
```

_No description yet._


### `Observable`

<p><em>class in <code>machinewright.templates</code></em></p>

```python
class Observable(Contract)
```

_No description yet._


### `ObservableKind`

<p><em>class in <code>machinewright.templates</code></em></p>

```python
class ObservableKind(StrEnum)
```

_No description yet._


### `ProcedureRequirement`

<p><em>class in <code>machinewright.templates</code></em></p>

```python
class ProcedureRequirement(Contract)
```

_No description yet._

