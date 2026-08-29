"""Canonical, process-independent serialization and content digests."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from decimal import Decimal
from enum import Enum
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from pydantic import BaseModel


class CanonicalizationError(ValueError):
    """Raised when a value cannot be represented deterministically."""


def _decimal(value: Decimal) -> str:
    if not value.is_finite():
        raise CanonicalizationError("non-finite decimals are not canonical")
    normalized = value.normalize()
    if normalized == 0:
        return "0"
    return format(normalized, "f")


def canonical_value(value: Any) -> Any:  # noqa: C901 - explicit type allowlist
    """Return JSON-compatible data with stable ordering and scalar forms."""
    if isinstance(value, BaseModel):
        return canonical_value(value.model_dump(mode="python", exclude_none=True))
    if is_dataclass(value) and not isinstance(value, type):
        return canonical_value(asdict(value))
    if isinstance(value, Enum):
        return canonical_value(value.value)
    if isinstance(value, Decimal):
        return _decimal(value)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalizationError("non-finite floats are not canonical")
        return _decimal(Decimal(str(value)))
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise CanonicalizationError("canonical mappings require string keys")
        return {key: canonical_value(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [canonical_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        raise CanonicalizationError("unordered collections are not canonical")
    if isinstance(value, Path):
        return value.as_posix()
    raise CanonicalizationError(f"unsupported canonical value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(
        canonical_value(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def content_digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode()).hexdigest()
