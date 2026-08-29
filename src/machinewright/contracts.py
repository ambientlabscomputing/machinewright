"""Versioned generic hardware and manufacturing contracts."""

from __future__ import annotations

from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from machinewright.canonical import content_digest
from machinewright.diagnostics import Diagnostic, Severity, ValidationReport


class Contract(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, strict=True, use_enum_values=False
    )
    schema_version: Literal["1.0"] = "1.0"


class Dimension(StrEnum):
    LENGTH = "length"
    MASS = "mass"
    VOLTAGE = "voltage"
    CURRENT = "current"
    RESISTANCE = "resistance"
    INDUCTANCE = "inductance"
    TORQUE = "torque"
    ANGULAR_SPEED = "angular_speed"
    ROTATIONAL_INERTIA = "rotational_inertia"
    TEMPERATURE = "temperature"
    POWER = "power"
    DENSITY = "density"


class Unit(StrEnum):
    MM = "mm"
    M = "m"
    G = "g"
    KG = "kg"
    V = "V"
    A = "A"
    OHM = "ohm"
    MH = "mH"
    H = "H"
    NM = "N*m"
    RPM = "rpm"
    RAD_S = "rad/s"
    KG_M2 = "kg*m^2"
    G_CM2 = "g*cm^2"
    C = "degC"
    W = "W"
    G_CM3 = "g/cm^3"
    KG_M3 = "kg/m^3"


_UNIT: dict[Unit, tuple[Dimension, Decimal]] = {
    Unit.MM: (Dimension.LENGTH, Decimal("0.001")),
    Unit.M: (Dimension.LENGTH, Decimal(1)),
    Unit.G: (Dimension.MASS, Decimal("0.001")),
    Unit.KG: (Dimension.MASS, Decimal(1)),
    Unit.V: (Dimension.VOLTAGE, Decimal(1)),
    Unit.A: (Dimension.CURRENT, Decimal(1)),
    Unit.OHM: (Dimension.RESISTANCE, Decimal(1)),
    Unit.MH: (Dimension.INDUCTANCE, Decimal("0.001")),
    Unit.H: (Dimension.INDUCTANCE, Decimal(1)),
    Unit.NM: (Dimension.TORQUE, Decimal(1)),
    Unit.RPM: (Dimension.ANGULAR_SPEED, Decimal("0.1047197551196597746")),
    Unit.RAD_S: (Dimension.ANGULAR_SPEED, Decimal(1)),
    Unit.KG_M2: (Dimension.ROTATIONAL_INERTIA, Decimal(1)),
    Unit.G_CM2: (Dimension.ROTATIONAL_INERTIA, Decimal("0.0000001")),
    Unit.C: (Dimension.TEMPERATURE, Decimal(1)),
    Unit.W: (Dimension.POWER, Decimal(1)),
    Unit.G_CM3: (Dimension.DENSITY, Decimal("1000")),
    Unit.KG_M3: (Dimension.DENSITY, Decimal(1)),
}


class Quantity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    value: Decimal
    unit: Unit

    @field_validator("value")
    @classmethod
    def finite(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("quantity must be finite")
        return value

    @property
    def dimension(self) -> Dimension:
        return _UNIT[self.unit][0]

    def canonical_value(self) -> Decimal:
        return self.value * _UNIT[self.unit][1]

    def to(self, unit: Unit) -> Quantity:
        if _UNIT[unit][0] != self.dimension:
            raise ValueError(f"cannot convert {self.dimension} to {_UNIT[unit][0]}")
        return Quantity(value=self.canonical_value() / _UNIT[unit][1], unit=unit)


class Tolerance(Contract):
    nominal: Quantity
    minus: Quantity
    plus: Quantity

    @model_validator(mode="after")
    def compatible(self) -> Tolerance:
        if not (self.nominal.dimension == self.minus.dimension == self.plus.dimension):
            raise ValueError("tolerance quantities must have the same dimension")
        if self.minus.value < 0 or self.plus.value < 0:
            raise ValueError("tolerance deviations must be non-negative")
        return self

    @property
    def lower(self) -> Decimal:
        return self.nominal.value - self.minus.to(self.nominal.unit).value

    @property
    def upper(self) -> Decimal:
        return self.nominal.value + self.plus.to(self.nominal.unit).value

    def add(self, other: Tolerance) -> Tolerance:
        if self.nominal.dimension != other.nominal.dimension:
            raise ValueError("cannot add tolerances of different dimensions")
        unit = self.nominal.unit
        return Tolerance(
            nominal=Quantity(
                value=self.nominal.value + other.nominal.to(unit).value, unit=unit
            ),
            minus=Quantity(
                value=self.minus.value + other.minus.to(unit).value, unit=unit
            ),
            plus=Quantity(value=self.plus.value + other.plus.to(unit).value, unit=unit),
        )

    def subtract(self, other: Tolerance) -> Tolerance:
        unit = self.nominal.unit
        if self.nominal.dimension != other.nominal.dimension:
            raise ValueError("cannot subtract tolerances of different dimensions")
        return Tolerance(
            nominal=Quantity(
                value=self.nominal.value - other.nominal.to(unit).value, unit=unit
            ),
            minus=Quantity(
                value=self.minus.value + other.plus.to(unit).value, unit=unit
            ),
            plus=Quantity(
                value=self.plus.value + other.minus.to(unit).value, unit=unit
            ),
        )


class ManufacturerPartIdentity(Contract):
    manufacturer: str = Field(min_length=1)
    part_number: str = Field(min_length=1)
    revision: str | None = None


class DistributorSkuIdentity(Contract):
    distributor: str = Field(min_length=1)
    sku: str = Field(min_length=1)
    manufacturer_part: ManufacturerPartIdentity


class ProcessSpec(Contract):
    process_id: str
    name: str
    parameters: dict[str, str] = Field(default_factory=dict)


class MaterialSpec(Contract):
    material_id: str
    name: str
    standard: str | None = None
    density: Quantity | None = None

    @model_validator(mode="after")
    def density_dimension(self) -> MaterialSpec:
        if self.density and self.density.dimension != Dimension.DENSITY:
            raise ValueError("material density must use density units")
        return self


class FinishRequirement(Contract):
    finish_id: str
    description: str


class InspectionRequirement(Contract):
    inspection_id: str
    characteristic: str
    method: str
    acceptance: str


class InterfaceBase(Contract):
    interface_id: str


class MechanicalMountInterface(InterfaceBase):
    kind: Literal["mechanical_mount"] = "mechanical_mount"
    pattern: str
    pilot_diameter: Tolerance | None = None
    bolt_circle_diameter: Tolerance | None = None
    fastener_count: int = Field(gt=0)


class ShaftInterface(InterfaceBase):
    kind: Literal["shaft"] = "shaft"
    diameter: Tolerance
    length: Tolerance
    feature: Literal["plain", "key", "flat", "spline"] = "plain"

    @model_validator(mode="after")
    def length_dimensions(self) -> ShaftInterface:
        if (
            self.diameter.nominal.dimension != Dimension.LENGTH
            or self.length.nominal.dimension != Dimension.LENGTH
        ):
            raise ValueError("shaft diameter and length must use length units")
        return self


class ElectricalInterface(InterfaceBase):
    kind: Literal["electrical"] = "electrical"
    phases: int = Field(gt=0)
    voltage: Quantity
    continuous_current: Quantity
    peak_current: Quantity

    @model_validator(mode="after")
    def electrical_dimensions(self) -> ElectricalInterface:
        expected = (
            (self.voltage, Dimension.VOLTAGE),
            (self.continuous_current, Dimension.CURRENT),
            (self.peak_current, Dimension.CURRENT),
        )
        if any(value.dimension != dimension for value, dimension in expected):
            raise ValueError("electrical interface quantities have invalid dimensions")
        return self


class FeedbackInterface(InterfaceBase):
    kind: Literal["feedback"] = "feedback"
    feedback_type: str
    protocol: str | None = None
    resolution: int | None = Field(default=None, gt=0)


class ThermalInterface(InterfaceBase):
    kind: Literal["thermal"] = "thermal"
    ambient_min: Quantity
    ambient_max: Quantity
    insulation_class: str | None = None
    sensor: str | None = None

    @model_validator(mode="after")
    def temperature_dimensions(self) -> ThermalInterface:
        if (
            self.ambient_min.dimension != Dimension.TEMPERATURE
            or self.ambient_max.dimension != Dimension.TEMPERATURE
        ):
            raise ValueError("thermal bounds must use temperature units")
        if self.ambient_min.canonical_value() > self.ambient_max.canonical_value():
            raise ValueError("thermal minimum exceeds maximum")
        return self


class ConnectorInterface(InterfaceBase):
    kind: Literal["connector"] = "connector"
    family: str
    positions: int = Field(gt=0)
    pinout: dict[str, str] = Field(default_factory=dict)


InterfaceSpec = Annotated[
    MechanicalMountInterface
    | ShaftInterface
    | ElectricalInterface
    | FeedbackInterface
    | ThermalInterface
    | ConnectorInterface,
    Field(discriminator="kind"),
]


class MotorSpec(Contract):
    identity: ManufacturerPartIdentity
    datasheet_revision: str
    motor_type: str
    mass: Quantity
    rotor_inertia: Quantity
    continuous_torque: Quantity
    peak_torque: Quantity
    max_speed: Quantity
    resistance: Quantity | None = None
    inductance: Quantity | None = None
    torque_constant: Decimal | None = None
    back_emf_constant: Decimal | None = None
    brake: str | None = None
    interfaces: tuple[InterfaceSpec, ...]

    @property
    def content_digest(self) -> str:
        return content_digest(self)

    @model_validator(mode="after")
    def physical_dimensions(self) -> MotorSpec:
        expected = {
            "mass": Dimension.MASS,
            "rotor_inertia": Dimension.ROTATIONAL_INERTIA,
            "continuous_torque": Dimension.TORQUE,
            "peak_torque": Dimension.TORQUE,
            "max_speed": Dimension.ANGULAR_SPEED,
            "resistance": Dimension.RESISTANCE,
            "inductance": Dimension.INDUCTANCE,
        }
        for field, dimension in expected.items():
            value = getattr(self, field)
            if value is not None and value.dimension != dimension:
                raise ValueError(f"{field} must use {dimension.value} units")
        return self


class QuantityConstraint(Contract):
    minimum: Quantity | None = None
    maximum: Quantity | None = None

    @model_validator(mode="after")
    def bounds(self) -> QuantityConstraint:
        if self.minimum and self.maximum:
            if self.minimum.dimension != self.maximum.dimension:
                raise ValueError("constraint bounds must share a dimension")
            if self.minimum.canonical_value() > self.maximum.canonical_value():
                raise ValueError("minimum exceeds maximum")
        return self


class MotorRequirement(Contract):
    requirement_id: str
    motor_types: tuple[str, ...] = ()
    mass: QuantityConstraint | None = None
    rotor_inertia: QuantityConstraint | None = None
    continuous_torque: QuantityConstraint | None = None
    peak_torque: QuantityConstraint | None = None
    max_speed: QuantityConstraint | None = None
    required_interfaces: tuple[InterfaceSpec, ...] = ()


def _quantity_check(
    name: str, actual: Quantity, constraint: QuantityConstraint | None
) -> list[Diagnostic]:
    if constraint is None:
        return []
    result: list[Diagnostic] = []
    path = f"$.{name}"
    if constraint.minimum and actual.dimension != constraint.minimum.dimension:
        return [
            Diagnostic(
                code="motor.dimension_mismatch",
                severity=Severity.ERROR,
                message=f"{name} has the wrong dimension",
                source_path=path,
            )
        ]
    if constraint.maximum and actual.dimension != constraint.maximum.dimension:
        return [
            Diagnostic(
                code="motor.dimension_mismatch",
                severity=Severity.ERROR,
                message=f"{name} has the wrong dimension",
                source_path=path,
            )
        ]
    if (
        constraint.minimum
        and actual.canonical_value() < constraint.minimum.canonical_value()
    ):
        result.append(
            Diagnostic(
                code="motor.below_minimum",
                severity=Severity.ERROR,
                message=f"{name} is below the required minimum",
                source_path=path,
            )
        )
    if (
        constraint.maximum
        and actual.canonical_value() > constraint.maximum.canonical_value()
    ):
        result.append(
            Diagnostic(
                code="motor.above_maximum",
                severity=Severity.ERROR,
                message=f"{name} exceeds the allowed maximum",
                source_path=path,
            )
        )
    return result


def _same_quantity(left: Quantity, right: Quantity) -> bool:
    return (
        left.dimension == right.dimension
        and left.canonical_value() == right.canonical_value()
    )


def _tolerance_contained(candidate: Tolerance, accepted: Tolerance) -> bool:
    if candidate.nominal.dimension != accepted.nominal.dimension:
        return False
    candidate_lower = (
        candidate.nominal.canonical_value() - candidate.minus.canonical_value()
    )
    candidate_upper = (
        candidate.nominal.canonical_value() + candidate.plus.canonical_value()
    )
    accepted_lower = (
        accepted.nominal.canonical_value() - accepted.minus.canonical_value()
    )
    accepted_upper = (
        accepted.nominal.canonical_value() + accepted.plus.canonical_value()
    )
    return candidate_lower >= accepted_lower and candidate_upper <= accepted_upper


def _interface_compatible(candidate: InterfaceSpec, required: InterfaceSpec) -> bool:  # noqa: C901
    if (
        candidate.kind != required.kind
        or candidate.interface_id != required.interface_id
    ):
        return False
    if isinstance(candidate, ShaftInterface) and isinstance(required, ShaftInterface):
        return (
            candidate.feature == required.feature
            and _tolerance_contained(candidate.diameter, required.diameter)
            and _tolerance_contained(candidate.length, required.length)
        )
    if isinstance(candidate, MechanicalMountInterface) and isinstance(
        required, MechanicalMountInterface
    ):
        if (
            candidate.pattern != required.pattern
            or candidate.fastener_count != required.fastener_count
        ):
            return False
        return all(
            required_value is None
            or (
                candidate_value is not None
                and _tolerance_contained(candidate_value, required_value)
            )
            for candidate_value, required_value in (
                (candidate.pilot_diameter, required.pilot_diameter),
                (candidate.bolt_circle_diameter, required.bolt_circle_diameter),
            )
        )
    if isinstance(candidate, ElectricalInterface) and isinstance(
        required, ElectricalInterface
    ):
        return (
            candidate.phases == required.phases
            and _same_quantity(candidate.voltage, required.voltage)
            and candidate.continuous_current.canonical_value()
            >= required.continuous_current.canonical_value()
            and candidate.peak_current.canonical_value()
            >= required.peak_current.canonical_value()
        )
    if isinstance(candidate, FeedbackInterface) and isinstance(
        required, FeedbackInterface
    ):
        return (
            candidate.feedback_type == required.feedback_type
            and (required.protocol is None or candidate.protocol == required.protocol)
            and (
                required.resolution is None
                or (
                    candidate.resolution is not None
                    and candidate.resolution >= required.resolution
                )
            )
        )
    if isinstance(candidate, ThermalInterface) and isinstance(
        required, ThermalInterface
    ):
        return (
            candidate.ambient_min.canonical_value()
            <= required.ambient_min.canonical_value()
            and candidate.ambient_max.canonical_value()
            >= required.ambient_max.canonical_value()
            and (
                required.insulation_class is None
                or candidate.insulation_class == required.insulation_class
            )
            and (required.sensor is None or candidate.sensor == required.sensor)
        )
    if isinstance(candidate, ConnectorInterface) and isinstance(
        required, ConnectorInterface
    ):
        return (
            candidate.family == required.family
            and candidate.positions == required.positions
            and all(
                candidate.pinout.get(pin) == signal
                for pin, signal in required.pinout.items()
            )
        )
    return False


def evaluate_motor_compatibility(
    spec: MotorSpec, requirement: MotorRequirement
) -> ValidationReport:
    diagnostics: list[Diagnostic] = []
    if requirement.motor_types and spec.motor_type not in requirement.motor_types:
        diagnostics.append(
            Diagnostic(
                code="motor.type_mismatch",
                severity=Severity.ERROR,
                message="motor type is not accepted",
                source_path="$.motor_type",
            )
        )
    for name in (
        "mass",
        "rotor_inertia",
        "continuous_torque",
        "peak_torque",
        "max_speed",
    ):
        diagnostics.extend(
            _quantity_check(name, getattr(spec, name), getattr(requirement, name))
        )
    offered = {(item.kind, item.interface_id): item for item in spec.interfaces}
    for required in requirement.required_interfaces:
        candidate = offered.get((required.kind, required.interface_id))
        if candidate is None:
            diagnostics.append(
                Diagnostic(
                    code="motor.interface_missing",
                    severity=Severity.ERROR,
                    message=f"required {required.kind} interface is missing",
                    source_path=f"$.interfaces.{required.interface_id}",
                )
            )
        elif not _interface_compatible(candidate, required):
            diagnostics.append(
                Diagnostic(
                    code="motor.interface_mismatch",
                    severity=Severity.ERROR,
                    message=f"{required.kind} interface does not match",
                    source_path=f"$.interfaces.{required.interface_id}",
                )
            )
    return ValidationReport(diagnostics=tuple(diagnostics))
