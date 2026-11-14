"""Printer bed and layout settings for 3D-print run planning.

Plain pydantic models (not `Contract`s): they are authored as JSON by people and
the app, so lists/ints must validate leniently. Unknown keys are rejected so a
typo fails loudly instead of silently planning with defaults.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PrinterProfile(_Model):
    """A printer's build volume. Generic and user-configured."""

    name: str = "Generic printer"
    bed_x: float = Field(default=220.0, gt=0)
    bed_y: float = Field(default=220.0, gt=0)
    max_z: float = Field(default=250.0, gt=0)
    # Unusable strip around the bed edge (clips, purge line, travel limits).
    bed_margin: float = Field(default=5.0, ge=0)
    # Where plate STL coordinates are zero: the bed's front-left corner, or its
    # center. Match what your slicer expects when importing a multi-part file.
    origin: Literal["corner", "center"] = "corner"


class PlanSettings(_Model):
    """How parts are arranged on the bed."""

    # Minimum clearance between neighbouring parts on a plate.
    part_spacing: float = Field(default=6.0, ge=0)
    # Lay each part on its least-overhanging face; otherwise keep it as designed.
    optimize_orientation: bool = True
