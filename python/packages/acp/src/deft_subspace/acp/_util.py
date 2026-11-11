"""Small helpers for reading untyped JSON."""

from __future__ import annotations

from typing import Any


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)
