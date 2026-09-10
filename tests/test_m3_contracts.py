from decimal import Decimal

import pytest

from machinewright import (
    DutyCycleRating,
    ManufacturerPartIdentity,
    MotorOperatingPoint,
    MotorRequirement,
    MotorSpec,
    Quantity,
    QuantityConstraint,
    ShaftInterface,
    Tolerance,
    Unit,
    evaluate_motor_compatibility,
)
from machinewright.canonical import (
    CanonicalizationError,
    canonical_json,
    content_digest,
)


def q(value: str, unit: Unit) -> Quantity:
    return Quantity(value=Decimal(value), unit=unit)


def test_quantities_convert_and_serialize_decimals_as_strings():
    assert q("1000", Unit.MM).to(Unit.M).value == Decimal("1.000")
    assert '"value":"1000"' in canonical_json(q("1000", Unit.MM))
    with pytest.raises(ValueError):
        q("1", Unit.MM).to(Unit.KG)


def test_worst_case_tolerance_addition_and_subtraction():
    first = Tolerance(
        nominal=q("10", Unit.MM), minus=q(".1", Unit.MM), plus=q(".2", Unit.MM)
    )
    second = Tolerance(
        nominal=q("2", Unit.MM), minus=q(".3", Unit.MM), plus=q(".4", Unit.MM)
    )
    assert first.add(second).lower == Decimal("11.6")
    result = first.subtract(second)
    assert result.lower == Decimal("7.5")
    assert result.upper == Decimal("8.5")


def test_canonical_digest_ignores_mapping_order_and_rejects_sets():
    assert content_digest({"b": 2, "a": 1}) == content_digest({"a": 1, "b": 2})
    with pytest.raises(CanonicalizationError):
        canonical_json({"bad": {1, 2}})


def test_motor_constraints_return_stable_diagnostics():
    spec = MotorSpec(
        identity=ManufacturerPartIdentity(manufacturer="Example", part_number="M1"),
        datasheet_revision="A",
        motor_type="bldc",
        mass=q("2", Unit.KG),
        rotor_inertia=q("1", Unit.KG_M2),
        continuous_torque=q("2", Unit.NM),
        peak_torque=q("4", Unit.NM),
        max_speed=q("1000", Unit.RPM),
        interfaces=(),
    )
    requirement = MotorRequirement(
        requirement_id="slot",
        motor_types=("bldc",),
        continuous_torque=QuantityConstraint(minimum=q("3", Unit.NM)),
    )
    report = evaluate_motor_compatibility(spec, requirement)
    assert not report.valid
    assert report.diagnostics[0].code == "motor.below_minimum"


def test_interface_matching_normalizes_units_and_contains_tolerance():
    accepted = ShaftInterface(
        interface_id="output",
        diameter=Tolerance(
            nominal=q("10", Unit.MM), minus=q(".2", Unit.MM), plus=q(".2", Unit.MM)
        ),
        length=Tolerance(
            nominal=q("20", Unit.MM), minus=q("1", Unit.MM), plus=q("1", Unit.MM)
        ),
    )
    candidate = ShaftInterface(
        interface_id="output",
        diameter=Tolerance(
            nominal=q(".01", Unit.M), minus=q(".0001", Unit.M), plus=q(".0001", Unit.M)
        ),
        length=Tolerance(
            nominal=q(".02", Unit.M), minus=q(".0005", Unit.M), plus=q(".0005", Unit.M)
        ),
    )
    spec = MotorSpec(
        identity=ManufacturerPartIdentity(manufacturer="Example", part_number="M2"),
        datasheet_revision="A",
        motor_type="bldc",
        mass=q("1", Unit.KG),
        rotor_inertia=q("1", Unit.KG_M2),
        continuous_torque=q("2", Unit.NM),
        peak_torque=q("4", Unit.NM),
        max_speed=q("1000", Unit.RPM),
        interfaces=(candidate,),
    )
    assert evaluate_motor_compatibility(
        spec, MotorRequirement(requirement_id="slot", required_interfaces=(accepted,))
    ).valid


def test_torque_speed_and_duty_cycle_are_checked_with_stable_diagnostics():
    offered_point = MotorOperatingPoint(
        speed=q("600", Unit.RPM),
        continuous_torque=q("1.2", Unit.NM),
        peak_torque=q("2.4", Unit.NM),
    )
    spec = MotorSpec(
        identity=ManufacturerPartIdentity(manufacturer="Example", part_number="M3"),
        datasheet_revision="A",
        motor_type="stepper",
        mass=q("1", Unit.KG),
        rotor_inertia=q("1", Unit.KG_M2),
        continuous_torque=q("1.2", Unit.NM),
        peak_torque=q("2.4", Unit.NM),
        max_speed=q("600", Unit.RPM),
        interfaces=(),
        torque_speed_curve=(offered_point,),
        duty_cycle=DutyCycleRating(
            cycle_id="s1",
            duration=q("600", Unit.S),
            on_fraction=Decimal("0.8"),
            ambient_max=q("40", Unit.C),
        ),
    )
    valid = MotorRequirement(
        requirement_id="axis",
        required_operating_points=(
            MotorOperatingPoint(
                speed=q("500", Unit.RPM),
                continuous_torque=q("1", Unit.NM),
                peak_torque=q("2", Unit.NM),
            ),
        ),
        duty_cycle=DutyCycleRating(
            cycle_id="gantry",
            duration=q("300", Unit.S),
            on_fraction=Decimal("0.5"),
            ambient_max=q("35", Unit.C),
        ),
    )
    assert evaluate_motor_compatibility(spec, valid).valid

    invalid = valid.model_copy(
        update={
            "required_operating_points": (
                MotorOperatingPoint(
                    speed=q("700", Unit.RPM),
                    continuous_torque=q("1", Unit.NM),
                    peak_torque=q("2", Unit.NM),
                ),
            )
        }
    )
    report = evaluate_motor_compatibility(spec, invalid)
    assert [diagnostic.code for diagnostic in report.diagnostics] == [
        "motor.operating_point_unmet"
    ]
