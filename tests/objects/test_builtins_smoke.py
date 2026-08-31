from machinewright.lib.fasteners import ScrewSize
from machinewright.lib.materials import Process
from machinewright.objects.bearings.bearing import Bearing
from machinewright.objects.box import Box
from machinewright.objects.fasteners.dowel_pin import DowelPin
from machinewright.objects.fasteners.shoulder_bolt import ShoulderBolt


def _volume(inst) -> float:
    return inst.geometry().val().Volume()


def test_box_cad_produces_nonzero_volume():
    inst = Box(height=10, width=5, depth=3)
    assert _volume(inst) > 0


def test_box_has_no_default_material():
    assert Box.material is None


def test_dowel_pin_cad_produces_nonzero_volume():
    inst = DowelPin(diameter=3, length=12)
    assert _volume(inst) > 0


def test_dowel_pin_defaults_to_purchased():
    assert DowelPin.material.process == Process.PURCHASED


def test_bearing_cad_produces_nonzero_volume():
    inst = Bearing(outer_diameter=10, inner_diameter=5, width=4)
    assert _volume(inst) > 0


def test_bearing_defaults_to_purchased():
    assert Bearing.material.process == Process.PURCHASED


def test_shoulder_bolt_cad_produces_nonzero_volume():
    inst = ShoulderBolt(
        thread_size=ScrewSize.M3,
        shoulder_diameter=4,
        shoulder_length=12,
        thread_length=3,
    )
    assert _volume(inst) > 0


def test_shoulder_bolt_defaults_to_purchased():
    assert ShoulderBolt.material.process == Process.PURCHASED
