"""Graph-native hardware authoring, resolution, validation, and projection."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Any, Literal

import cadquery
from pydantic import Field, model_validator

from machinewright.canonical import canonical_value, content_digest
from machinewright.contracts import (
    Contract,
    FinishRequirement,
    InspectionRequirement,
    InterfaceSpec,
    ManufacturerPartIdentity,
    ProcessSpec,
    interfaces_compatible,
)
from machinewright.diagnostics import (
    Diagnostic,
    MachinewrightError,
    Severity,
    ValidationReport,
)


def _number(value: float) -> Decimal:
    return Decimal(str(round(value, 9)))


class Transform(Contract):
    translation_mm: tuple[Decimal, Decimal, Decimal] = (
        Decimal(0),
        Decimal(0),
        Decimal(0),
    )
    rotation_degrees_xyz: tuple[Decimal, Decimal, Decimal] = (
        Decimal(0),
        Decimal(0),
        Decimal(0),
    )

    @classmethod
    def identity(cls) -> Transform:
        return cls()

    @classmethod
    def translated(cls, x: float = 0, y: float = 0, z: float = 0) -> Transform:
        return cls(translation_mm=(_number(x), _number(y), _number(z)))

    @classmethod
    def from_location(cls, location: cadquery.Location) -> Transform:
        translation, rotation = location.toTuple()
        return cls(
            translation_mm=(
                _number(translation[0]),
                _number(translation[1]),
                _number(translation[2]),
            ),
            rotation_degrees_xyz=(
                _number(rotation[0]),
                _number(rotation[1]),
                _number(rotation[2]),
            ),
        )

    def location(self) -> cadquery.Location:
        return cadquery.Location(
            cadquery.Vector(*(float(value) for value in self.translation_mm)),
            (
                float(self.rotation_degrees_xyz[0]),
                float(self.rotation_degrees_xyz[1]),
                float(self.rotation_degrees_xyz[2]),
            ),
        )

    def compose(self, child: Transform) -> Transform:
        return Transform.from_location(self.location() * child.location())


class PortRole(StrEnum):
    SOURCE = "source"
    SINK = "sink"
    BIDIRECTIONAL = "bidirectional"


class ConnectionKind(StrEnum):
    MECHANICAL = "mechanical"
    ELECTRICAL_POWER = "electrical_power"
    SIGNAL = "signal"
    THERMAL = "thermal"


class PortDefinition(Contract):
    port_id: str = Field(min_length=1)
    interface: InterfaceSpec
    frame: Transform | None = None
    required: bool = False
    max_connections: int | None = Field(default=1, gt=0)
    role: PortRole = PortRole.BIDIRECTIONAL


class GeometryProperties(Contract):
    envelope_mm: tuple[Decimal, Decimal, Decimal]
    volume_mm3: Decimal
    center_mm: tuple[Decimal, Decimal, Decimal]
    mass_g: Decimal | None = None


class AssemblyNode(Contract):
    kind: Literal["assembly"] = "assembly"
    node_id: str
    instance_key: str
    definition_id: str
    definition_revision: str
    parameter_digest: str
    transform: Transform


class PartNode(Contract):
    kind: Literal["part"] = "part"
    node_id: str
    instance_key: str
    definition_id: str
    definition_revision: str
    parameter_digest: str
    geometry_digest: str
    parameters: dict[str, Any]
    transform: Transform
    geometry: GeometryProperties
    manufacturer_part: ManufacturerPartIdentity | None = None
    material_name: str | None = None
    process: ProcessSpec | None = None
    finishes: tuple[FinishRequirement, ...] = ()
    inspections: tuple[InspectionRequirement, ...] = ()


HardwareNode = Annotated[AssemblyNode | PartNode, Field(discriminator="kind")]


class PortInstance(Contract):
    port_id: str
    node_id: str
    instance_key: str
    interface: InterfaceSpec
    frame: Transform | None = None
    required: bool = False
    max_connections: int | None = Field(default=1, gt=0)
    role: PortRole = PortRole.BIDIRECTIONAL


class ContainmentEdge(Contract):
    kind: Literal["contains"] = "contains"
    edge_id: str
    parent_node_id: str
    child_node_id: str


class ConnectionEdge(Contract):
    kind: ConnectionKind
    edge_id: str
    source_port_id: str
    target_port_id: str


class ResolvedHardwareGraph(Contract):
    root_id: str
    nodes: tuple[HardwareNode, ...]
    ports: tuple[PortInstance, ...] = ()
    containment: tuple[ContainmentEdge, ...] = ()
    connections: tuple[ConnectionEdge, ...] = ()

    @model_validator(mode="after")
    def enforce_integrity(self) -> ResolvedHardwareGraph:
        report = self.validate_graph()
        if not report.valid:
            codes = ", ".join(item.code for item in report.diagnostics)
            raise ValueError(f"invalid hardware graph: {codes}")
        return self

    @property
    def graph_digest(self) -> str:
        return content_digest(self)

    def parent(self, node_id: str) -> str | None:
        return next(
            (
                edge.parent_node_id
                for edge in self.containment
                if edge.child_node_id == node_id
            ),
            None,
        )

    def children(self, node_id: str) -> tuple[str, ...]:
        return tuple(
            edge.child_node_id
            for edge in self.containment
            if edge.parent_node_id == node_id
        )

    def descendants(self, node_id: str) -> tuple[str, ...]:
        result: list[str] = []
        pending = deque(self.children(node_id))
        while pending:
            child = pending.popleft()
            result.append(child)
            pending.extend(self.children(child))
        return tuple(result)

    def ports_for(self, node_id: str) -> tuple[PortInstance, ...]:
        return tuple(port for port in self.ports if port.node_id == node_id)

    def connections_for(self, identity: str) -> tuple[ConnectionEdge, ...]:
        port_ids = {port.port_id for port in self.ports_for(identity)} or {identity}
        return tuple(
            edge
            for edge in self.connections
            if edge.source_port_id in port_ids or edge.target_port_id in port_ids
        )

    def neighbors(
        self, node_id: str, *, kind: ConnectionKind | None = None
    ) -> tuple[str, ...]:
        port_owner = {port.port_id: port.node_id for port in self.ports}
        neighbors: set[str] = set()
        for edge in self.connections_for(node_id):
            if kind is not None and edge.kind != kind:
                continue
            other = (
                edge.target_port_id
                if port_owner.get(edge.source_port_id) == node_id
                else edge.source_port_id
            )
            if other in port_owner:
                neighbors.add(port_owner[other])
        return tuple(sorted(neighbors))

    def connected_subgraph(self, node_id: str) -> tuple[str, ...]:
        found = {node_id}
        pending = deque([node_id])
        while pending:
            for neighbor in self.neighbors(pending.popleft()):
                if neighbor not in found:
                    found.add(neighbor)
                    pending.append(neighbor)
        return tuple(sorted(found))

    def validate_graph(self) -> ValidationReport:  # noqa: C901
        diagnostics: list[Diagnostic] = []
        node_ids = [node.node_id for node in self.nodes]
        node_set = set(node_ids)
        if len(node_ids) != len(node_set):
            diagnostics.append(
                _diagnostic("graph.node_duplicate", "node IDs must be unique")
            )
        roots = [node for node in self.nodes if node.node_id == self.root_id]
        if len(roots) != 1 or not isinstance(roots[0], AssemblyNode):
            diagnostics.append(
                _diagnostic(
                    "graph.root_invalid", "root must identify one assembly node"
                )
            )
        parents: dict[str, list[str]] = defaultdict(list)
        for edge in self.containment:
            if (
                edge.parent_node_id not in node_set
                or edge.child_node_id not in node_set
            ):
                diagnostics.append(
                    _diagnostic(
                        "graph.containment_dangling",
                        "containment endpoint is missing",
                        edge.edge_id,
                    )
                )
            parents[edge.child_node_id].append(edge.parent_node_id)
        for child, values in parents.items():
            if len(values) > 1:
                diagnostics.append(
                    _diagnostic(
                        "graph.multiple_parents", "node has multiple parents", child
                    )
                )

        reachable: set[str] = set()
        visiting: set[str] = set()

        def visit(current: str) -> None:
            if current in visiting:
                diagnostics.append(
                    _diagnostic(
                        "graph.containment_cycle",
                        "containment graph contains a cycle",
                        current,
                    )
                )
                return
            if current in reachable:
                return
            visiting.add(current)
            for child in self.children(current):
                visit(child)
            visiting.remove(current)
            reachable.add(current)

        if self.root_id in node_set:
            visit(self.root_id)
        for missing in sorted(node_set - reachable):
            diagnostics.append(
                _diagnostic(
                    "graph.node_unreachable",
                    "node is unreachable from the root",
                    missing,
                )
            )

        port_ids = [port.port_id for port in self.ports]
        port_map = {port.port_id: port for port in self.ports}
        if len(port_ids) != len(port_map):
            diagnostics.append(
                _diagnostic("graph.port_duplicate", "port IDs must be unique")
            )
        for port in self.ports:
            if port.node_id not in node_set:
                diagnostics.append(
                    _diagnostic(
                        "graph.port_owner_missing",
                        "port owner is missing",
                        port.port_id,
                    )
                )

        edge_ids = [edge.edge_id for edge in self.containment] + [
            connection.edge_id for connection in self.connections
        ]
        if len(edge_ids) != len(set(edge_ids)):
            diagnostics.append(
                _diagnostic("graph.edge_duplicate", "edge IDs must be unique")
            )

        counts: dict[str, int] = defaultdict(int)
        for connection in self.connections:
            source = port_map.get(connection.source_port_id)
            target = port_map.get(connection.target_port_id)
            if source is None or target is None:
                diagnostics.append(
                    _diagnostic(
                        "graph.connection_dangling",
                        "connection endpoint is missing",
                        connection.edge_id,
                    )
                )
                continue
            if source.port_id == target.port_id:
                diagnostics.append(
                    _diagnostic(
                        "graph.connection_self",
                        "port cannot connect to itself",
                        connection.edge_id,
                    )
                )
            counts[source.port_id] += 1
            counts[target.port_id] += 1
            if not _roles_compatible(source.role, target.role):
                diagnostics.append(
                    _diagnostic(
                        "graph.connection_role",
                        "port roles are incompatible",
                        connection.edge_id,
                    )
                )
            if not interfaces_compatible(
                source.interface, target.interface, require_identity=False
            ):
                diagnostics.append(
                    _diagnostic(
                        "graph.connection_incompatible",
                        "port interfaces are incompatible",
                        connection.edge_id,
                    )
                )
            if connection.kind == ConnectionKind.MECHANICAL and (
                source.frame is None or target.frame is None
            ):
                diagnostics.append(
                    _diagnostic(
                        "graph.mechanical_frame_missing",
                        "mechanical ports require local frames",
                        connection.edge_id,
                    )
                )
        for port in self.ports:
            if port.required and counts[port.port_id] == 0:
                diagnostics.append(
                    _diagnostic(
                        "graph.port_required",
                        "required port is unconnected",
                        port.port_id,
                    )
                )
            if (
                port.max_connections is not None
                and counts[port.port_id] > port.max_connections
            ):
                diagnostics.append(
                    _diagnostic(
                        "graph.port_cardinality",
                        "port connection cardinality exceeded",
                        port.port_id,
                    )
                )
        return ValidationReport(diagnostics=tuple(diagnostics))

    def to_dot(self) -> str:
        lines = ["digraph hardware {", "  rankdir=LR;"]
        for node in self.nodes:
            lines.append(
                f'  "{node.node_id}" [label="{node.instance_key}\\n{node.kind}"];'
            )
        for edge in self.containment:
            lines.append(
                f'  "{edge.parent_node_id}" -> "{edge.child_node_id}" '
                '[label="contains"];'
            )
        owners = {port.port_id: port.node_id for port in self.ports}
        for connection in self.connections:
            if (
                connection.source_port_id in owners
                and connection.target_port_id in owners
            ):
                lines.append(
                    f'  "{owners[connection.source_port_id]}" -> '
                    f'"{owners[connection.target_port_id]}" '
                    f'[style=dashed,label="{connection.kind.value}"];'
                )
        lines.append("}")
        return "\n".join(lines) + "\n"


def _diagnostic(code: str, message: str, source_path: str = "$") -> Diagnostic:
    return Diagnostic(
        code=code,
        severity=Severity.ERROR,
        message=message,
        source_path=source_path,
    )


def _roles_compatible(source: PortRole, target: PortRole) -> bool:
    return source != PortRole.SINK and target != PortRole.SOURCE


@dataclass(frozen=True)
class PortRef:
    node_key: str
    port_key: str


@dataclass(frozen=True)
class NodeRef:
    key: str

    def port(self, port_key: str) -> PortRef:
        return PortRef(self.key, port_key)


@dataclass(frozen=True)
class _Placement:
    key: str
    definition: Any
    transform: Transform
    assembly: bool


@dataclass(frozen=True)
class _Connection:
    key: str
    source: PortRef
    target: PortRef
    kind: ConnectionKind


class AssemblyBuilder:
    def __init__(self) -> None:
        self.placements: list[_Placement] = []
        self.connections: list[_Connection] = []
        self._keys: set[str] = set()
        self._connection_keys: set[str] = set()

    def part(
        self,
        instance_key: str,
        definition: Any,
        *,
        transform: Transform | None = None,
    ) -> NodeRef:
        return self._place(instance_key, definition, transform, assembly=False)

    def assembly(
        self,
        instance_key: str,
        definition: Any,
        *,
        transform: Transform | None = None,
    ) -> NodeRef:
        return self._place(instance_key, definition, transform, assembly=True)

    def _place(
        self,
        key: str,
        definition: Any,
        transform: Transform | None,
        *,
        assembly: bool,
    ) -> NodeRef:
        if not key or "/" in key or "#" in key or key in self._keys:
            raise ValueError(f"invalid or duplicate instance key {key!r}")
        self._keys.add(key)
        self.placements.append(
            _Placement(key, definition, transform or Transform.identity(), assembly)
        )
        return NodeRef(key)

    def connect(
        self,
        connection_key: str,
        source: PortRef,
        target: PortRef,
        *,
        kind: ConnectionKind,
    ) -> None:
        if not connection_key or connection_key in self._connection_keys:
            raise ValueError(f"invalid or duplicate connection key {connection_key!r}")
        self._connection_keys.add(connection_key)
        self.connections.append(_Connection(connection_key, source, target, kind))


@dataclass(frozen=True)
class ResolvedDesign:
    graph: ResolvedHardwareGraph
    geometries: dict[str, cadquery.Shape]
    materials: dict[str, Any]

    def assembly(self) -> cadquery.Assembly:
        nodes = {node.node_id: node for node in self.graph.nodes}

        def project(assembly_id: str) -> cadquery.Assembly:
            result = cadquery.Assembly()
            parent = nodes[assembly_id]
            parent_location = parent.transform.location()
            for child_id in self.graph.children(assembly_id):
                child = nodes[child_id]
                local_location = parent_location.inverse * child.transform.location()
                if isinstance(child, AssemblyNode):
                    result.add(
                        project(child_id),
                        name=child.instance_key,
                        loc=local_location,
                    )
                    continue
                kwargs: dict[str, Any] = {
                    "name": child.instance_key,
                    "loc": local_location,
                }
                material = self.materials.get(child.node_id)
                if material is not None:
                    kwargs["color"] = cadquery.Color(*material.color)
                result.add(self.geometries[child.node_id], **kwargs)
            return result

        return project(self.graph.root_id)

    def cad(
        self,
        *,
        exploded: bool = False,
        spacing: float = 30.0,
        nested: bool = False,
    ) -> cadquery.Workplane:
        if not exploded:
            return cadquery.Workplane(obj=self.assembly().toCompound())
        parts = [node for node in self.graph.nodes if isinstance(node, PartNode)]
        shapes: list[cadquery.Shape] = []
        for index, node in enumerate(parts):
            located = self.geometries[node.node_id].located(node.transform.location())
            shapes.append(located.translate((0, 0, index * spacing)))
        return cadquery.Workplane(obj=cadquery.Compound.makeCompound(shapes))


def resolve_hardware(definition: Any, *, root_id: str = "assembly") -> ResolvedDesign:
    nodes: list[HardwareNode] = []
    ports: list[PortInstance] = []
    containment: list[ContainmentEdge] = []
    connections: list[ConnectionEdge] = []
    geometries: dict[str, cadquery.Shape] = {}
    materials: dict[str, Any] = {}

    def resolve_definition(
        current: Any,
        node_id: str,
        instance_key: str,
        transform: Transform,
    ) -> None:
        definition_id = current.definition_id or (
            f"{type(current).__module__}.{type(current).__qualname__}"
        )
        parameters = canonical_value(vars(current))
        nodes.append(
            AssemblyNode(
                node_id=node_id,
                instance_key=instance_key,
                definition_id=definition_id,
                definition_revision=current.definition_revision,
                parameter_digest=content_digest(parameters),
                transform=transform,
            )
        )
        for port in current.ports:
            ports.append(
                PortInstance(
                    port_id=f"{node_id}#{port.port_id}",
                    node_id=node_id,
                    instance_key=port.port_id,
                    interface=port.interface,
                    frame=port.frame,
                    required=port.required,
                    max_connections=port.max_connections,
                    role=port.role,
                )
            )
        builder = AssemblyBuilder()
        current.define(builder)
        local_ids = {
            placement.key: f"{node_id}/{placement.key}"
            for placement in builder.placements
        }
        for placement in builder.placements:
            child_id = local_ids[placement.key]
            child_transform = transform.compose(placement.transform)
            containment.append(
                ContainmentEdge(
                    edge_id=f"contains:{child_id}",
                    parent_node_id=node_id,
                    child_node_id=child_id,
                )
            )
            if placement.assembly:
                resolve_definition(
                    placement.definition,
                    child_id,
                    placement.key,
                    child_transform,
                )
                continue
            description = placement.definition.describe()
            shape = placement.definition.geometry().val()
            bbox = shape.BoundingBox()
            material = description["material"]
            volume = shape.Volume()
            mass = (
                _number(volume / 1000 * material.density)
                if material is not None and material.density is not None
                else None
            )
            parameters = canonical_value(description["parameters"])
            geometry = GeometryProperties(
                envelope_mm=(
                    _number(bbox.xlen),
                    _number(bbox.ylen),
                    _number(bbox.zlen),
                ),
                volume_mm3=_number(volume),
                center_mm=(
                    _number(bbox.center.x),
                    _number(bbox.center.y),
                    _number(bbox.center.z),
                ),
                mass_g=mass,
            )
            nodes.append(
                PartNode(
                    node_id=child_id,
                    instance_key=placement.key,
                    definition_id=description["definition_id"],
                    definition_revision=description["definition_revision"],
                    parameter_digest=content_digest(parameters),
                    geometry_digest=content_digest(geometry),
                    parameters=parameters,
                    transform=child_transform,
                    geometry=geometry,
                    manufacturer_part=description["manufacturer_part"],
                    material_name=material.name if material is not None else None,
                    process=description["process"],
                    finishes=description["finishes"],
                    inspections=description["inspections"],
                )
            )
            geometries[child_id] = shape
            materials[child_id] = material
            for port in description["ports"]:
                ports.append(
                    PortInstance(
                        port_id=f"{child_id}#{port.port_id}",
                        node_id=child_id,
                        instance_key=port.port_id,
                        interface=port.interface,
                        frame=port.frame,
                        required=port.required,
                        max_connections=port.max_connections,
                        role=port.role,
                    )
                )
        for connection in builder.connections:
            source_node = local_ids.get(connection.source.node_key)
            target_node = local_ids.get(connection.target.node_key)
            connections.append(
                ConnectionEdge(
                    kind=connection.kind,
                    edge_id=f"{node_id}/connection:{connection.key}",
                    source_port_id=f"{source_node}#{connection.source.port_key}",
                    target_port_id=f"{target_node}#{connection.target.port_key}",
                )
            )

    resolve_definition(
        definition,
        root_id,
        root_id.rsplit("/", 1)[-1],
        Transform.identity(),
    )
    graph = ResolvedHardwareGraph(
        root_id=root_id,
        nodes=tuple(sorted(nodes, key=lambda item: item.node_id)),
        ports=tuple(sorted(ports, key=lambda item: item.port_id)),
        containment=tuple(sorted(containment, key=lambda item: item.edge_id)),
        connections=tuple(sorted(connections, key=lambda item: item.edge_id)),
    )
    report = graph.validate_graph()
    if not report.valid:
        raise MachinewrightError("hardware graph validation failed", report)
    return ResolvedDesign(graph=graph, geometries=geometries, materials=materials)
