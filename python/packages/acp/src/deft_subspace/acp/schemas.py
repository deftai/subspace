"""Validators, the Python way: anything that checks a value and says what is wrong.

Where the TypeScript packages take a Standard Schema (zod, valibot, ...),
these take any of:

- a pydantic model class (`Answer`), checked with `model_validate`;
- a pydantic `TypeAdapter` (`TypeAdapter(list[int])`);
- a type pydantic understands (`list[int]`, a TypedDict, a dataclass);
- an object with `parse(value)` or `validate(value)` that returns the value or raises.

A JSON Schema for the model or the client comes from pydantic when it can make one.
"""

from __future__ import annotations

from typing import Any

try:  # pydantic comes with agent-client-protocol
    import pydantic
except ImportError:  # pragma: no cover
    pydantic = None  # type: ignore[assignment]


Schema = Any


def _adapter(schema: Schema) -> Any:
    if pydantic is None:
        return None
    if isinstance(schema, pydantic.TypeAdapter):
        return schema
    if isinstance(schema, type) and issubclass(schema, pydantic.BaseModel):
        return None
    try:
        return pydantic.TypeAdapter(schema)
    except Exception:  # noqa: BLE001 - not a type pydantic understands
        return None


def _problems(error: Exception) -> list[str]:
    if pydantic is not None and isinstance(error, pydantic.ValidationError):
        out = []
        for item in error.errors():
            path = ".".join(str(p) for p in item.get("loc", ()))
            out.append(f"{path}: {item.get('msg')}" if path else str(item.get("msg")))
        return out
    return [str(error) or type(error).__name__]


def check(schema: Schema, value: Any) -> tuple[bool, Any]:
    """`(True, value)` (the value as the schema makes it), or `(False, problems)`."""
    try:
        if pydantic is not None and isinstance(schema, type) and issubclass(schema, pydantic.BaseModel):
            return True, schema.model_validate(value)
        for method in ("parse", "validate"):
            fn = getattr(schema, method, None)
            if callable(fn) and not isinstance(schema, type):
                return True, fn(value)
        adapter = _adapter(schema)
        if adapter is not None:
            return True, adapter.validate_python(value)
        if callable(schema):
            return True, schema(value)
    except Exception as error:  # noqa: BLE001
        return False, _problems(error)
    raise TypeError(f"Not a validator: {schema!r}")


def json_schema(schema: Schema) -> dict[str, Any] | None:
    """A JSON Schema for the validator, if it can produce one."""
    try:
        if pydantic is not None and isinstance(schema, type) and issubclass(schema, pydantic.BaseModel):
            return schema.model_json_schema()
        own = getattr(schema, "json_schema", None)
        if callable(own):
            result = own()
            if isinstance(result, dict):
                return result
        adapter = _adapter(schema)
        if adapter is not None:
            return adapter.json_schema()
    except Exception:  # noqa: BLE001
        return None
    return None


def to_json(value: Any) -> Any:
    """A validated value as JSON-able data (pydantic models become dicts)."""
    if pydantic is not None and isinstance(value, pydantic.BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    return value
