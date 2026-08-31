"""Graph-first reference assemblies used by Machinewright tests."""

from decimal import Decimal

from machinewright import (
    MATERIALS,
    AssemblyBuilder,
    AssemblyDefinition,
    ConnectionKind,
    ElectricalInterface,
    FeedbackInterface,
    PortDefinition,
    PortRole,
    Quantity,
    ShaftInterface,
    ThermalInterface,
    Tolerance,
    Transform,
    Unit,
    register_assembly,
    register_object,
)
from machinewright.objects.box import Box
from machinewright.objects.fasteners.dowel_pin import DowelPin


def _q(value: str, unit: Unit) -> Quantity:
    return Quantity(value=Decimal(value), unit=unit)


def _tol(value: str) -> Tolerance:
    return Tolerance(
        nominal=_q(value, Unit.MM),
        minus=_q("0.1", Unit.MM),
        plus=_q("0.1", Unit.MM),
    )


@register_object
class ConnectedBox(Box):
    ports = (
        PortDefinition(
            port_id="shaft",
            interface=ShaftInterface(
                interface_id="shaft", diameter=_tol("3"), length=_tol("5")
            ),
            frame=Transform.identity(),
            required=True,
            role=PortRole.SOURCE,
        ),
        PortDefinition(
            port_id="power",
            interface=ElectricalInterface(
                interface_id="power",
                phases=1,
                voltage=_q("24", Unit.V),
                continuous_current=_q("1", Unit.A),
                peak_current=_q("2", Unit.A),
            ),
            required=True,
            role=PortRole.SOURCE,
        ),
        PortDefinition(
            port_id="signal",
            interface=FeedbackInterface(
                interface_id="signal", feedback_type="position", protocol="spi"
            ),
            required=True,
            role=PortRole.SOURCE,
        ),
        PortDefinition(
            port_id="thermal",
            interface=ThermalInterface(
                interface_id="thermal",
                ambient_min=_q("0", Unit.C),
                ambient_max=_q("80", Unit.C),
            ),
            required=True,
            role=PortRole.SOURCE,
        ),
    )


@register_object
class ConnectedPin(DowelPin):
    ports = (
        PortDefinition(
            port_id="shaft",
            interface=ShaftInterface(
                interface_id="shaft", diameter=_tol("3"), length=_tol("5")
            ),
            frame=Transform.identity(),
            role=PortRole.SINK,
        ),
        PortDefinition(
            port_id="power",
            interface=ElectricalInterface(
                interface_id="power",
                phases=1,
                voltage=_q("24", Unit.V),
                continuous_current=_q("1", Unit.A),
                peak_current=_q("2", Unit.A),
            ),
            role=PortRole.SINK,
        ),
        PortDefinition(
            port_id="signal",
            interface=FeedbackInterface(
                interface_id="signal", feedback_type="position", protocol="spi"
            ),
            role=PortRole.SINK,
        ),
        PortDefinition(
            port_id="thermal",
            interface=ThermalInterface(
                interface_id="thermal",
                ambient_min=_q("0", Unit.C),
                ambient_max=_q("80", Unit.C),
            ),
            role=PortRole.SINK,
        ),
    )


@register_assembly
class NestedPinPair(AssemblyDefinition):
    def define(self, builder: AssemblyBuilder) -> None:
        builder.part("lower_pin", DowelPin(diameter=3, length=5))
        builder.part(
            "upper_pin",
            DowelPin(diameter=3, length=5),
            transform=Transform.translated(z=10),
        )


@register_assembly
class SimpleAssembly(AssemblyDefinition):
    def define(self, builder: AssemblyBuilder) -> None:
        base = ConnectedBox(height=2, width=20, depth=20)
        base.material = MATERIALS["PLA"]
        source = builder.part("base_plate", base)
        builder.assembly(
            "pin_pair", NestedPinPair(), transform=Transform.translated(z=20)
        )
        target = builder.part(
            "top_pin",
            ConnectedPin(diameter=3, length=5),
            transform=Transform.translated(z=40),
        )
        builder.connect(
            "mechanical",
            source.port("shaft"),
            target.port("shaft"),
            kind=ConnectionKind.MECHANICAL,
        )
        builder.connect(
            "power",
            source.port("power"),
            target.port("power"),
            kind=ConnectionKind.ELECTRICAL_POWER,
        )
        builder.connect(
            "signal",
            source.port("signal"),
            target.port("signal"),
            kind=ConnectionKind.SIGNAL,
        )
        builder.connect(
            "thermal",
            source.port("thermal"),
            target.port("thermal"),
            kind=ConnectionKind.THERMAL,
        )
