from abc import abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from machinewright.hardware_graph import AssemblyBuilder, ResolvedDesign


class AssemblyDefinition:
    """A reusable graph-first hardware assembly definition."""

    definition_id: str | None = None
    definition_revision: str = "1"
    ports: tuple = ()

    @abstractmethod
    def define(self, builder: "AssemblyBuilder") -> None:
        """Declare children and connections through ``builder``."""

    def resolve(self, *, root_id: str = "assembly") -> "ResolvedDesign":
        from machinewright.hardware_graph import resolve_hardware

        return resolve_hardware(self, root_id=root_id)

    def cad(self, exploded: bool = False, spacing: float = 30.0, nested: bool = False):
        return self.resolve().cad(exploded=exploded, spacing=spacing, nested=nested)
