---
title: "Hardware graph"
description: "The canonical resolved graph: nodes, ports, containment, transforms and connections."
sidebar:
  order: 3
---

The canonical resolved graph: nodes, ports, containment, transforms and connections.

### `AssemblyBuilder`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class AssemblyBuilder
```

_No description yet._

##### `part`

```python
def part(
    instance_key: str,
    definition: Any,
    transform: Transform | None = None
) -> NodeRef
```

##### `assembly`

```python
def assembly(
    instance_key: str,
    definition: Any,
    transform: Transform | None = None
) -> NodeRef
```

##### `connect`

```python
def connect(
    connection_key: str,
    source: PortRef,
    target: PortRef,
    kind: ConnectionKind
) -> None
```

### `AssemblyNode`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class AssemblyNode(Contract)
```

_No description yet._


### `ConnectionEdge`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class ConnectionEdge(Contract)
```

_No description yet._


### `ConnectionKind`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class ConnectionKind(StrEnum)
```

_No description yet._


### `ContainmentEdge`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class ContainmentEdge(Contract)
```

_No description yet._


### `PartNode`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class PartNode(Contract)
```

_No description yet._


### `PortDefinition`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class PortDefinition(Contract)
```

_No description yet._


### `PortInstance`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class PortInstance(Contract)
```

_No description yet._


### `PortRole`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class PortRole(StrEnum)
```

_No description yet._


### `resolve_hardware`

<p><em>function in <code>machinewright.hardware_graph</code></em></p>

```python
def resolve_hardware(
    definition: Any,
    root_id: str = 'assembly'
) -> ResolvedDesign
```

_No description yet._

### `ResolvedDesign`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class ResolvedDesign:
    __init__(
    graph: ResolvedHardwareGraph,
    geometries: dict[str, cadquery.Shape],
    materials: dict[str, Any],
    source_hints: dict[str, tuple[str, int]]
    )
```

_No description yet._

##### `assembly`

```python
def assembly() -> cadquery.Assembly
```

##### `cad`

```python
def cad(
    exploded: bool = False,
    spacing: float = 30.0,
    nested: bool = False
) -> cadquery.Workplane
```

### `ResolvedHardwareGraph`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class ResolvedHardwareGraph(Contract)
```

_No description yet._

##### `enforce_integrity`

```python
def enforce_integrity() -> ResolvedHardwareGraph
```

##### `parent`

```python
def parent(
    node_id: str
) -> str | None
```

##### `children`

```python
def children(
    node_id: str
) -> tuple[str, ...]
```

##### `descendants`

```python
def descendants(
    node_id: str
) -> tuple[str, ...]
```

##### `ports_for`

```python
def ports_for(
    node_id: str
) -> tuple[PortInstance, ...]
```

##### `connections_for`

```python
def connections_for(
    identity: str
) -> tuple[ConnectionEdge, ...]
```

##### `neighbors`

```python
def neighbors(
    node_id: str,
    kind: ConnectionKind | None = None
) -> tuple[str, ...]
```

##### `connected_subgraph`

```python
def connected_subgraph(
    node_id: str
) -> tuple[str, ...]
```

##### `validate_graph`

```python
def validate_graph() -> ValidationReport
```

##### `to_dot`

```python
def to_dot() -> str
```

### `Transform`

<p><em>class in <code>machinewright.hardware_graph</code></em></p>

```python
class Transform(Contract)
```

_No description yet._

##### `identity`

```python
def identity() -> Transform
```

##### `translated`

```python
def translated(
    x: float = 0,
    y: float = 0,
    z: float = 0
) -> Transform
```

##### `from_location`

```python
def from_location(
    location: cadquery.Location
) -> Transform
```

##### `location`

```python
def location() -> cadquery.Location
```

##### `compose`

```python
def compose(
    child: Transform
) -> Transform
```
