"""Checking a form answer against the form's `requestedSchema`.

Form elicitation schemas are flat (the subset MCP elicitation uses too): an
object whose properties are strings (minLength, maxLength, format, enum,
oneOf of consts), numbers or integers (minimum, maximum), booleans, or arrays
of enum values (minItems, maxItems), plus `required`. Keywords outside that
subset are ignored rather than refused.

    problems = validate_elicitation(request.requested_schema, content)
    if problems: ask_again(problems)
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from datetime import date, datetime
from typing import Any
from urllib.parse import urlparse

_MISSING: Any = object()


def _allowed_values(schema: dict[str, Any]) -> list[Any] | None:
    """The values an enum-like schema allows: `enum`, or `oneOf`/`anyOf` of `{const}`."""
    if isinstance(schema.get("enum"), list):
        return schema["enum"]
    options = schema.get("oneOf") if isinstance(schema.get("oneOf"), list) else schema.get("anyOf") if isinstance(schema.get("anyOf"), list) else None
    if options is None:
        return None
    consts = [o["const"] for o in options if isinstance(o, dict) and "const" in o]
    return consts or None


def _is_date(v: str) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        return False
    try:
        date.fromisoformat(v)
        return True
    except ValueError:
        return False


def _is_datetime(v: str) -> bool:
    if not re.match(r"\d{4}-\d{2}-\d{2}T", v):
        return False
    try:
        datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _is_uri(v: str) -> bool:
    parsed = urlparse(v)
    return bool(parsed.scheme) and re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*", parsed.scheme) is not None


FORMATS: dict[str, Callable[[str], bool]] = {
    "email": lambda v: re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", v) is not None,
    "uri": _is_uri,
    "date": _is_date,
    "date-time": _is_datetime,
}


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _same(a: Any, b: Any) -> bool:
    # JSON equality: True is not 1.
    return type(a) is type(b) and a == b or (_is_number(a) and _is_number(b) and a == b)


def _check_value(name: str, schema: dict[str, Any], value: Any) -> list[str]:
    problems: list[str] = []
    allowed = _allowed_values(schema)
    kind = schema.get("type")
    if kind == "string":
        if not isinstance(value, str):
            return [f"{name} must be a string"]
        if _is_number(schema.get("minLength")) and len(value) < schema["minLength"]:
            problems.append(f"{name} must be at least {schema['minLength']} characters")
        if _is_number(schema.get("maxLength")) and len(value) > schema["maxLength"]:
            problems.append(f"{name} must be at most {schema['maxLength']} characters")
        check = FORMATS.get(schema["format"]) if isinstance(schema.get("format"), str) else None
        if check is not None and not check(value):
            problems.append(f"{name} must be a valid {schema['format']}")
    elif kind in ("number", "integer"):
        if not _is_number(value):
            return [f"{name} must be a number"]
        if kind == "integer" and not float(value).is_integer():
            problems.append(f"{name} must be an integer")
        if _is_number(schema.get("minimum")) and value < schema["minimum"]:
            problems.append(f"{name} must be at least {schema['minimum']}")
        if _is_number(schema.get("maximum")) and value > schema["maximum"]:
            problems.append(f"{name} must be at most {schema['maximum']}")
    elif kind == "boolean":
        if not isinstance(value, bool):
            return [f"{name} must be true or false"]
    elif kind == "array":
        if not isinstance(value, list):
            return [f"{name} must be a list"]
        if _is_number(schema.get("minItems")) and len(value) < schema["minItems"]:
            problems.append(f"{name} needs at least {schema['minItems']} choices")
        if _is_number(schema.get("maxItems")) and len(value) > schema["maxItems"]:
            problems.append(f"{name} allows at most {schema['maxItems']} choices")
        items = _allowed_values(schema["items"]) if isinstance(schema.get("items"), dict) else None
        if items is not None:
            for v in value:
                if not any(_same(v, i) for i in items):
                    problems.append(f"{name}: {json.dumps(v)} is not one of the choices")
        return problems
    # A type outside the subset (or none): only an enum is checked.
    if allowed is not None and not any(_same(value, a) for a in allowed):
        problems.append(f"{name} must be one of {', '.join(json.dumps(v) for v in allowed)}")
    return problems


def validate_elicitation(schema: Any, content: Any = None) -> list[str]:
    """What is wrong with `content` as an answer to a form with this schema; empty when it fits.

    Missing required fields, unknown fields, wrong types and out-of-range values are
    reported. No schema (or one that is not an object schema) accepts any object.
    """
    if content is not None and not isinstance(content, dict):
        return ["the answer must be an object"]
    answer: dict[str, Any] = content or {}
    if not isinstance(schema, dict) or not isinstance(schema.get("properties"), dict):
        return []
    properties = schema["properties"]
    problems: list[str] = []
    required = [r for r in schema.get("required", []) if isinstance(r, str)] if isinstance(schema.get("required"), list) else []
    for name in required:
        if answer.get(name, _MISSING) is _MISSING:
            problems.append(f"{name} is required")
    for name, value in answer.items():
        prop = properties.get(name)
        if not isinstance(prop, dict):
            problems.append(f"{name} is not a field of this form")
            continue
        problems.extend(_check_value(name, prop, value))
    return problems
