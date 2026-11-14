"""Portable hardware-function declarations and generic result contracts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
import inspect
from typing import Any, TypeVar, get_type_hints

from pydantic import Field, TypeAdapter

from machinewright.assemblies.base import AssemblyDefinition
from machinewright.contracts import Contract
from machinewright.diagnostics import Diagnostic
from machinewright.hardware_graph import ResolvedDesign


class ObservableKind(StrEnum):
    SCALAR = "scalar"
    SERIES = "series"
    INTERVAL = "interval"
    CONSTRAINT_MARGIN = "constraint_margin"
    CANDIDATE = "candidate"
    EXTENSION = "extension"


class Observable(Contract):
    observable_id: str = Field(min_length=1)
    kind: ObservableKind
    label: str
    value: Any
    unit: str | None = None
    feasible: bool | None = None
    source_ids: tuple[str, ...] = ()
    extension_schema: str | None = None


class ProcedureRequirement(Contract):
    procedure_id: str = Field(min_length=1)
    revision: str
    reason: str
    observable_ids: tuple[str, ...] = ()


class EvidenceRequirement(Contract):
    requirement_id: str = Field(min_length=1)
    procedure: ProcedureRequirement
    operating_envelope: dict[str, Any] = Field(default_factory=dict)
    applicable_graph_digest: str | None = None


class ComponentCatalog(Contract):
    """Generic catalog input; qualification status remains consumer policy."""

    catalog_id: str
    revision: str
    components: tuple[dict[str, Any], ...] = ()


class ManufacturingCapabilities(Contract):
    capability_set_id: str
    revision: str
    processes: tuple[str, ...] = ()
    constraints: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class HardwareResult:
    """Runtime result returned by a portable hardware function."""

    design: ResolvedDesign
    observables: tuple[Observable, ...] = ()
    diagnostics: tuple[Diagnostic, ...] = ()
    control_configuration: Mapping[str, Any] | None = None
    evidence_requirements: tuple[EvidenceRequirement, ...] = ()


TemplateCallable = Callable[..., HardwareResult | ResolvedDesign | AssemblyDefinition]


@dataclass(frozen=True)
class MachineTemplate:
    template_id: str
    version: str
    function: TemplateCallable
    cacheable: bool

    @property
    def signature(self) -> inspect.Signature:
        return inspect.signature(self.function)

    def input_schema(self) -> dict[str, Any]:
        hints = get_type_hints(self.function)
        properties: dict[str, Any] = {}
        required: list[str] = []
        for name, parameter in self.signature.parameters.items():
            annotation = hints.get(name, parameter.annotation)
            if annotation is inspect.Parameter.empty:
                raise TypeError(
                    f"template parameter {name!r} requires a type annotation"
                )
            properties[name] = TypeAdapter(annotation).json_schema()
            if parameter.default is inspect.Parameter.empty:
                required.append(name)
        return {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": f"{self.template_id}@{self.version} inputs",
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": required,
        }

    def evaluate(self, inputs: Mapping[str, Any]) -> HardwareResult:
        hints = get_type_hints(self.function)
        unexpected = set(inputs) - set(self.signature.parameters)
        if unexpected:
            raise ValueError(f"unexpected template inputs: {sorted(unexpected)}")
        arguments: dict[str, Any] = {}
        for name, parameter in self.signature.parameters.items():
            if name in inputs:
                arguments[name] = TypeAdapter(
                    hints.get(name, parameter.annotation)
                ).validate_python(inputs[name], strict=False)
            elif parameter.default is not inspect.Parameter.empty:
                arguments[name] = parameter.default
            else:
                raise ValueError(f"missing required template input {name!r}")
        value = self.function(**arguments)
        if isinstance(value, HardwareResult):
            return value
        if isinstance(value, ResolvedDesign):
            return HardwareResult(design=value)
        if isinstance(value, AssemblyDefinition):
            return HardwareResult(design=value.resolve(root_id=self.template_id))
        raise TypeError(
            "machine template must return HardwareResult, ResolvedDesign, or AssemblyDefinition"
        )


_T = TypeVar("_T", bound=TemplateCallable)
_TEMPLATES: dict[tuple[str, str], MachineTemplate] = {}


def machine_template(
    *, id: str, version: str, cacheable: bool = False
) -> Callable[[_T], _T]:
    """Declare an ordinary callable as a versioned portable machine template."""

    def decorate(function: _T) -> _T:
        key = (id, version)
        existing = _TEMPLATES.get(key)
        if existing is not None and existing.function is not function:
            raise ValueError(f"duplicate machine template {id}@{version}")
        _TEMPLATES[key] = MachineTemplate(id, version, function, cacheable)
        setattr(function, "__machinewright_template__", _TEMPLATES[key])  # noqa: B010
        return function

    return decorate


def get_machine_template(template_id: str, version: str) -> MachineTemplate:
    try:
        return _TEMPLATES[(template_id, version)]
    except KeyError as exc:
        raise ValueError(f"unknown machine template {template_id}@{version}") from exc


def machine_templates() -> tuple[MachineTemplate, ...]:
    return tuple(_TEMPLATES[key] for key in sorted(_TEMPLATES))


def clear_machine_templates() -> None:
    """Clear process registrations before reloading a project in a worker."""

    _TEMPLATES.clear()
