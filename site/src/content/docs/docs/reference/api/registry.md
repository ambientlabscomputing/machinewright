---
title: "Registry"
description: "Registering parts and assemblies for discovery."
sidebar:
  order: 11
---

Registering parts and assemblies for discovery.

### `clear_registry`

<p><em>function in <code>machinewright.registry</code></em></p>

```python
def clear_registry() -> None
```

Clear process registrations before a worker reloads a project.

### `get_registry`

<p><em>function in <code>machinewright.registry</code></em></p>

```python
def get_registry()
```

_No description yet._

### `register`

<p><em>function in <code>machinewright.registry</code></em></p>

```python
def register()
```

Registers a PartDefinition or AssemblyDefinition subclass, dispatching on its base.

### `register_assembly`

<p><em>function in <code>machinewright.registry</code></em></p>

```python
def register_assembly() -> type[_AssemblyT]
```

_No description yet._

### `register_object`

<p><em>function in <code>machinewright.registry</code></em></p>

```python
def register_object() -> type[_ObjectT]
```

_No description yet._
