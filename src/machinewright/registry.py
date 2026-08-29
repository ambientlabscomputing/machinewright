from functools import lru_cache
import inspect
from typing import Literal, TypeVar

from machinewright.assemblies.base import CADAssembly
from machinewright.objects.base import CADObject

_ObjectT = TypeVar("_ObjectT", bound=CADObject)
_AssemblyT = TypeVar("_AssemblyT", bound=CADAssembly)

_OBJECTS: dict[str, type[CADObject]] = {}
_ASSEMBLIES: dict[str, type[CADAssembly]] = {}


def _key_for(cls: type) -> str:
    return f"{cls.__module__}.{cls.__qualname__}"


def register_object(cls: type[_ObjectT]) -> type[_ObjectT]:
    _OBJECTS[_key_for(cls)] = cls
    get_registry.cache_clear()
    return cls


def register_assembly(cls: type[_AssemblyT]) -> type[_AssemblyT]:
    _ASSEMBLIES[_key_for(cls)] = cls
    get_registry.cache_clear()
    return cls


def register(cls):
    """Registers a CADObject or CADAssembly subclass, dispatching on its base."""
    if issubclass(cls, CADAssembly):
        return register_assembly(cls)
    if issubclass(cls, CADObject):
        return register_object(cls)
    raise TypeError(f"{cls!r} is not a CADObject or CADAssembly subclass")


def raw_registry() -> dict[str, dict]:
    """likely not what you're looking for"""
    return {
        "objects": {key: {"class": cls} for key, cls in _OBJECTS.items()},
        "assemblies": {key: {"class": cls} for key, cls in _ASSEMBLIES.items()},
    }


@lru_cache
def get_registry():
    registry_ = raw_registry()

    def __build_params(type_: Literal["objects", "assemblies"]):
        for _obj, data in registry_[type_].items():
            sig = inspect.signature(data.get("class").__init__)
            data["params"] = {}
            for name, param in sig.parameters.items():
                if name == "self":
                    continue
                data["params"][name] = {
                    "type": param.annotation,
                    "required": param.default is inspect.Parameter.empty,
                }
                if not data["params"][name]["required"]:
                    data["params"][name]["default"] = param.default

    __build_params("assemblies")
    __build_params("objects")

    return registry_
