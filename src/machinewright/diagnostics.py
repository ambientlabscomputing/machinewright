"""Stable validation diagnostics shared by all public contracts."""

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class Diagnostic(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    code: str = Field(pattern=r"^[a-z][a-z0-9_.-]+$")
    severity: Severity
    message: str
    source_path: str = "$"
    context: dict[str, Any] = Field(default_factory=dict)


class ValidationReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    diagnostics: tuple[Diagnostic, ...] = ()

    @property
    def valid(self) -> bool:
        return not any(item.severity == Severity.ERROR for item in self.diagnostics)


class MachinewrightError(RuntimeError):
    """Fatal generation/validation error with machine-readable diagnostics."""

    def __init__(self, message: str, report: ValidationReport):
        super().__init__(message)
        self.report = report
