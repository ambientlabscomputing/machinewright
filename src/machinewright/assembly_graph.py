"""Serializable semantic assembly graphs derived from CadQuery assemblies."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Literal, cast

import cadquery
from pydantic import model_validator

from machinewright.canonical import canonical_value, content_digest
from machinewright.contracts import (
    Contract,
    FinishRequirement,
    InspectionRequirement,
    InterfaceSpec,
    ManufacturerPartIdentity,
    ProcessSpec,
)
from machinewright.diagnostics import Diagnostic, Severity, ValidationReport


def _number(value: float) -> Decimal:
    return Decimal(str(round(value, 9)))


class Transform(Contract):
    translation_mm: tuple[Decimal, Decimal, Decimal]
    rotation_degrees_xyz: tuple[Decimal, Decimal, Decimal]


class GeometryProperties(Contract):
    envelope_mm: tuple[Decimal, Decimal, Decimal]
    volume_mm3: Decimal
    center_mm: tuple[Decimal, Decimal, Decimal]
    mass_g: Decimal | None = None


class AssemblyNode(Contract):
    kind: Literal["assembly"] = "assembly"
    node_id: str
    instance_key: str
    parent_id: str | None
    source_path: str
    transform: Transform


class PartNode(Contract):
    kind: Literal["part"] = "part"
    node_id: str
    instance_key: str
    parent_id: str
    source_path: str
    definition_id: str
    definition_revision: str
    parameter_digest: str
    parameters: dict[str, Any]
    transform: Transform
    geometry: GeometryProperties
    manufacturer_part: ManufacturerPartIdentity | None = None
    material_name: str | None = None
    process: ProcessSpec | None = None
    finishes: tuple[FinishRequirement, ...] = ()
    inspections: tuple[InspectionRequirement, ...] = ()
    interfaces: tuple[InterfaceSpec, ...] = ()


class ResolvedAssembly(Contract):
    root_id: str
    nodes: tuple[AssemblyNode | PartNode, ...]

    @model_validator(mode="after")
    def graph_integrity(self) -> ResolvedAssembly:
        ids = [node.node_id for node in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("assembly node IDs must be unique")
        known = set(ids)
        if self.root_id not in known:
            raise ValueError("root node is missing")
        for node in self.nodes:
            if node.parent_id is not None and node.parent_id not in known:
                raise ValueError(f"dangling parent {node.parent_id}")
        return self

    @property
    def content_digest(self) -> str:
        return content_digest(self)

    def validate_interfaces(self) -> ValidationReport:
        diagnostics: list[Diagnostic] = []
        for node in self.nodes:
            if isinstance(node, PartNode):
                keys = [(item.kind, item.interface_id) for item in node.interfaces]
                if len(keys) != len(set(keys)):
                    diagnostics.append(
                        Diagnostic(
                            code="assembly.interface_duplicate",
                            severity=Severity.ERROR,
                            message="part contains duplicate interface identities",
                            source_path=node.source_path,
                        )
                    )
        return ValidationReport(diagnostics=tuple(diagnostics))


def _transform(loc: cadquery.Location) -> Transform:
    translation, rotation = loc.toTuple()
    return Transform(
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


def resolve_assembly(
    assy: cadquery.Assembly, *, root_id: str = "assembly"
) -> ResolvedAssembly:
    nodes: list[AssemblyNode | PartNode] = [
        AssemblyNode(
            node_id=root_id,
            instance_key=root_id,
            parent_id=None,
            source_path="$",
            transform=_transform(cadquery.Location()),
        )
    ]

    def walk(
        current: cadquery.Assembly,
        parent_id: str,
        path: str,
        parent_loc: cadquery.Location,
    ) -> None:
        sibling_keys: set[str] = set()
        for index, child in enumerate(current.children):
            metadata = dict(child.metadata)
            key = metadata.get("instance_key") or child.name or f"item-{index}"
            if key in sibling_keys:
                raise ValueError(f"duplicate sibling instance key {key!r} at {path}")
            sibling_keys.add(key)
            source_path = f"{path}.{key}"
            node_id = content_digest({"parent": parent_id, "key": key})
            world_loc = parent_loc * child.loc
            if child.obj is None:
                nodes.append(
                    AssemblyNode(
                        node_id=node_id,
                        instance_key=key,
                        parent_id=parent_id,
                        source_path=source_path,
                        transform=_transform(world_loc),
                    )
                )
                walk(child, node_id, source_path, world_loc)
                continue
            shape = cast(Any, child.obj).val()
            bbox = shape.BoundingBox()
            material = metadata.get("material")
            volume = shape.Volume()
            mass = None
            if material is not None and material.density is not None:
                mass = _number(volume / 1000 * material.density)
            params = canonical_value(metadata.get("part_params", {}))
            nodes.append(
                PartNode(
                    node_id=node_id,
                    instance_key=key,
                    parent_id=parent_id,
                    source_path=source_path,
                    definition_id=metadata.get("definition_id")
                    or metadata.get("part_class")
                    or key,
                    definition_revision=str(metadata.get("definition_revision", "1")),
                    parameter_digest=content_digest(params),
                    parameters=params,
                    transform=_transform(world_loc),
                    geometry=GeometryProperties(
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
                    ),
                    manufacturer_part=metadata.get("manufacturer_part"),
                    process=metadata.get("process_spec"),
                    material_name=material.name if material is not None else None,
                    finishes=metadata.get("finish_requirements", ()),
                    inspections=metadata.get("inspection_requirements", ()),
                    interfaces=metadata.get("interfaces", ()),
                )
            )

    walk(assy, root_id, "$", cadquery.Location())
    return ResolvedAssembly(root_id=root_id, nodes=tuple(nodes))
