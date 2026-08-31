"""
Material/color contracts consumed by graph-native part definitions. Not a
real materials database -- MATERIALS is a
small starter catalog; consumers are expected to add their own entries or
construct Material directly.
"""

from dataclasses import dataclass
from enum import Enum


class Process(str, Enum):
    PRINTED = "PRINTED"
    MACHINED = "MACHINED"
    PURCHASED = "PURCHASED"
    SHEET = "SHEET"
    OTHER = "OTHER"


@dataclass(frozen=True)
class Material:
    name: str
    process: Process
    color: tuple[float, float, float] = (0.7, 0.7, 0.7)  # RGB, 0-1
    density: float | None = (
        None  # g/cm^3; None skips cadquery's native Material wrapper
    )


MATERIALS: dict[str, Material] = {
    "PLA": Material(
        name="PLA", process=Process.PRINTED, color=(0.9, 0.9, 0.85), density=1.24
    ),
    "PETG": Material(
        name="PETG", process=Process.PRINTED, color=(0.85, 0.9, 0.95), density=1.27
    ),
    "PETG_CF": Material(
        name="PETG-CF", process=Process.PRINTED, color=(0.15, 0.15, 0.15), density=1.30
    ),
    "ALUMINUM_6061": Material(
        name="6061-T6 Aluminum",
        process=Process.MACHINED,
        color=(0.75, 0.75, 0.78),
        density=2.70,
    ),
    "OFF_THE_SHELF": Material(
        name="Off-the-shelf hardware", process=Process.PURCHASED, color=(0.6, 0.6, 0.65)
    ),
}
