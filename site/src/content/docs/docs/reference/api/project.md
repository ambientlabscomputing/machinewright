---
title: "Project config"
description: "Loading `machinewright.toml` project descriptions."
sidebar:
  order: 12
---

Loading `machinewright.toml` project descriptions.

### `load_project`

<p><em>function in <code>machinewright.project</code></em></p>

```python
def load_project(
    root: Path | None = None
) -> tuple[Path, ProjectConfig]
```

_No description yet._

### `ProjectConfig`

<p><em>class in <code>machinewright.project</code></em></p>

```python
class ProjectConfig(Contract)
```

_No description yet._

##### `unique_templates`

```python
def unique_templates() -> 'ProjectConfig'
```

### `TemplateEntry`

<p><em>class in <code>machinewright.project</code></em></p>

```python
class TemplateEntry(Contract)
```

_No description yet._

