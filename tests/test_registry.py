from machinewright.assemblies.base import CADAssembly
from machinewright.objects.base import CADObject
from machinewright.registry import (
    get_registry,
    register,
    register_assembly,
    register_object,
)


def test_register_object_uses_dotted_module_path_as_key(clean_registry):
    class Widget(CADObject):
        def __init__(self, size: float):
            self.size = size

        def cad(self):
            raise NotImplementedError

    register_object(Widget)

    key = f"{Widget.__module__}.{Widget.__qualname__}"
    assert get_registry()["objects"][key]["class"] is Widget


def test_register_assembly_uses_dotted_module_path_as_key(clean_registry):
    class Gizmo(CADAssembly):
        def assemble(self):
            raise NotImplementedError

    register_assembly(Gizmo)

    key = f"{Gizmo.__module__}.{Gizmo.__qualname__}"
    assert get_registry()["assemblies"][key]["class"] is Gizmo


def test_register_dispatches_on_base_class(clean_registry):
    class DispatchedObject(CADObject):
        def cad(self):
            raise NotImplementedError

    class DispatchedAssembly(CADAssembly):
        def assemble(self):
            raise NotImplementedError

    register(DispatchedObject)
    register(DispatchedAssembly)

    reg = get_registry()
    assert f"{DispatchedObject.__module__}.{DispatchedObject.__qualname__}" in reg["objects"]
    assert (
        f"{DispatchedAssembly.__module__}.{DispatchedAssembly.__qualname__}"
        in reg["assemblies"]
    )


def test_same_bare_class_name_from_different_modules_does_not_collide(clean_registry):
    class Part(CADObject):
        __module__ = "fake_pkg_a.parts"
        __qualname__ = "Part"

        def cad(self):
            raise NotImplementedError

    class PartOther(CADObject):
        __module__ = "fake_pkg_b.parts"
        __qualname__ = "Part"

        def cad(self):
            raise NotImplementedError

    register_object(Part)
    register_object(PartOther)

    reg = get_registry()["objects"]
    assert "fake_pkg_a.parts.Part" in reg
    assert "fake_pkg_b.parts.Part" in reg
    assert reg["fake_pkg_a.parts.Part"]["class"] is Part
    assert reg["fake_pkg_b.parts.Part"]["class"] is PartOther


def test_registry_params_reflect_required_and_default_args(clean_registry):
    class Configurable(CADObject):
        def __init__(self, width: float, height: float = 10.0):
            self.width = width
            self.height = height

        def cad(self):
            raise NotImplementedError

    register_object(Configurable)

    key = f"{Configurable.__module__}.{Configurable.__qualname__}"
    params = get_registry()["objects"][key]["params"]

    assert params["width"]["required"] is True
    assert "default" not in params["width"]
    assert params["height"]["required"] is False
    assert params["height"]["default"] == 10.0
