# Graph architecture

`ResolvedHardwareGraph` is Machinewright's canonical hardware representation.
CAD assemblies, BOMs, layouts, documentation, and manifests are projections of
that graph and may not rediscover topology independently.

## Identities and content

- A definition ID and revision identify reusable engineering intent.
- An instance ID is the explicit rooted path created from assembly-builder keys.
- A parameter digest identifies the resolved constructor inputs.
- A geometry digest identifies computed leaf geometry properties.
- The graph digest covers the canonical nodes, ports, containment, and
  connections.

Identity and content digests are deliberately separate. Repeated resolution of
the same declaration produces byte-identical canonical graph JSON.

## Nodes and containment

Assembly and part instances are nodes. `ContainmentEdge` records form one
rooted, acyclic hierarchy: every non-root node has exactly one parent and every
node is reachable from the root. Reusable definitions may appear multiple
times, but each physical occurrence has its own instance node.

Transforms are explicit. A resolved node carries its composed world transform;
Machinewright does not solve mates during H0.

## Ports and connections

A `PortDefinition` describes a connection point on a definition. Resolution
creates a `PortInstance` owned by a node. Ports carry a typed interface,
optional local coordinate frame, required status, connection cardinality, and
source/sink/bidirectional role.

Binary `ConnectionEdge` records connect ports. H0 defines four kinds:

| Kind | Intended relation | Additional rule |
| --- | --- | --- |
| `mechanical` | Mounting or mechanical transmission | Both ports require frames |
| `electrical_power` | Electrical energy delivery | Electrical interface bounds must match |
| `signal` | Feedback or communications | Feedback/connector contracts must match |
| `thermal` | Thermal observation or coupling | Thermal envelopes must match |

Direction is source to target. A sink cannot be a source endpoint and a source
cannot be a target endpoint. Bidirectional ports may occupy either endpoint.
Interfaces are compared structurally and with normalized units and tolerances.

Nets and buses are deferred. They can later be represented by explicit junction
nodes without changing the node-port-edge model.

## Resolution and projections

`AssemblyDefinition.define()` declares a graph fragment. Resolution recursively
expands nested definitions, computes leaf geometry once, composes transforms,
sorts graph records canonically, validates the result, and returns a
`ResolvedDesign` containing the immutable graph and runtime geometry index.

Every exporter consumes that `ResolvedDesign`:

- STEP, STL, and SVG project geometry and graph transforms;
- print layouts select graph nodes by process;
- BOMs group graph part nodes by definition, revision, and parameter digest;
- JSON and DOT expose the canonical semantic graph;
- manifests record the graph digest and artifact hashes.

CadQuery is permitted in leaf `geometry()` methods and final projection only.
Assembly definitions must not use `cadquery.Assembly.add()`.
