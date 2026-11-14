---
title: "Diagnostics"
description: "Errors, severities and validation reports."
sidebar:
  order: 13
---

Errors, severities and validation reports.

### `Diagnostic`

<p><em>class in <code>machinewright.diagnostics</code></em></p>

```python
class Diagnostic(BaseModel)
```

_No description yet._


### `MachinewrightError`

<p><em>class in <code>machinewright.diagnostics</code></em></p>

```python
class MachinewrightError(RuntimeError):
    __init__(
    message: str,
    report: ValidationReport
    )
```

Fatal generation/validation error with machine-readable diagnostics.


### `Severity`

<p><em>class in <code>machinewright.diagnostics</code></em></p>

```python
class Severity(StrEnum)
```

_No description yet._


### `ValidationReport`

<p><em>class in <code>machinewright.diagnostics</code></em></p>

```python
class ValidationReport(BaseModel)
```

_No description yet._

