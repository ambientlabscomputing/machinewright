import pytest
import typer

from machinewright.commands.export import _instantiate
from machinewright.objects.base import PartDefinition
from machinewright.registry import register_object


def test_instantiate_resolves_exact_key_and_applies_params(clean_registry):
    class Plate(PartDefinition):
        def __init__(self, thickness: float):
            self.thickness = thickness

        def geometry(self):
            raise NotImplementedError

    register_object(Plate)
    key = f"{Plate.__module__}.{Plate.__qualname__}"

    inst = _instantiate(f"objects.{key}", '{"thickness": 5.0}')

    assert isinstance(inst, Plate)
    assert inst.thickness == 5.0


def test_instantiate_raises_typer_exit_when_not_found(clean_registry):
    with pytest.raises(typer.Exit) as exc_info:
        _instantiate("objects.does.not.Exist", None)

    assert exc_info.value.exit_code == 1


def test_instantiate_raises_typer_exit_for_unknown_type(clean_registry):
    with pytest.raises(typer.Exit) as exc_info:
        _instantiate("bogus_type.does.not.Exist", None)

    assert exc_info.value.exit_code == 1
