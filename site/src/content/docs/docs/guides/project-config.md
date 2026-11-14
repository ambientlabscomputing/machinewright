---
title: Projects and machine templates
description: Describe portable projects with machinewright.toml and typed machine templates.
---

Projects that expose typed hardware functions add a `machinewright.toml` beside their `pyproject.toml` and lock file.

```toml
project_id = "ironless-actuator"
environment_lock = "uv.lock"
input_configurations = ["inputs.json"]

[[templates]]
id = "ironless-actuator.main"
version = "0.1.0"
callable = "design:machine"
```

## Templates

Templates are ordinary Python callables decorated with `machine_template`. They take a typed requirements object and return a `HardwareResult`:

```python
from machinewright import HardwareResult, machine_template

@machine_template(id="example.axis", version="1.0.0", cacheable=True)
def axis(requirements: AxisRequirements) -> HardwareResult:
    ...
```

## Commands

The same headless evaluator serves the CLI, isolated worker, CI and the app:

```bash
machinewright project validate
machinewright project schema example.axis 1.0.0 schema.json
machinewright project evaluate example.axis 1.0.0 inputs.json artifacts/
machinewright project sweep example.axis 1.0.0 inputs.json requirements.payload_kg 8 30 100 sweep/
```

`machinewright-worker` exposes the evaluator through a versioned Protobuf contract. Worker stdout is reserved for length-delimited protocol messages; logs and tracebacks use stderr or structured failure events.

## Example: ironless-actuator

The sample project's inputs drive its geometry directly: stator and magnet dimensions, gear tooth counts and module, bearing fits and output bolt circle. Requirements reject tooth counts that cannot be phased at equal planet spacing, and layouts that exceed the clearance available around the purchased hardware.
