"""
Importing this module registers machinewright's built-in objects/assemblies
(via their own @register_object/@register_assembly decorators) as a side
effect. Imported unconditionally by main.py so the CLI always has the
built-in library available, independent of any consumer's own discovery
config.
"""

from machinewright.objects import box  # noqa: F401
from machinewright.objects.bearings import bearing  # noqa: F401
from machinewright.objects.fasteners import dowel_pin, shoulder_bolt  # noqa: F401
