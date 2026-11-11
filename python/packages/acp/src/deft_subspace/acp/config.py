"""Session config options (model, reasoning effort, mode, on/off switches), one shape for v1 and v2.

v1 names an option `id`, v2 `configId`; both offer `select` options (with
choices, possibly grouped) and `boolean` ones. Choices are flattened here,
keeping the group's name. Options of a type this client does not know are
listed as `type == "other"` (with the agent's type in `raw_type`) and cannot be set.

    model = session.config_option("model")      # or by category:
    effort = next(o for o in session.config_options if o.category == "thought_level")
    await session.set_config_option("model", "opus")
    await session.set_config_option("fast", True)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from typing import Any, Literal, Union

from ._util import as_list
from .model import ProtocolVersion


@dataclass(frozen=True)
class ConfigChoice:
    value: str
    name: str
    description: str | None = None
    #: The name of the group the agent put this choice in, if any.
    group: str | None = None


@dataclass(frozen=True)
class SelectConfigOption:
    """A choice among values (model, effort, mode)."""

    id: str
    name: str
    choices: list[ConfigChoice]
    current_value: str | None = None
    description: str | None = None
    #: `mode`, `model`, `model_config`, `thought_level`, or the agent's own.
    category: str | None = None
    type: Literal["select"] = field(default="select", init=False)


@dataclass(frozen=True)
class BooleanConfigOption:
    """An on/off switch."""

    id: str
    name: str
    current_value: bool | None = None
    description: str | None = None
    category: str | None = None
    type: Literal["boolean"] = field(default="boolean", init=False)


@dataclass(frozen=True)
class OtherConfigOption:
    """An option of a type this client does not know; it cannot be set."""

    id: str
    name: str
    #: The type the agent sent.
    raw_type: str
    current_value: Any = None
    description: str | None = None
    category: str | None = None
    type: Literal["other"] = field(default="other", init=False)


ConfigOption = Union[SelectConfigOption, BooleanConfigOption, OtherConfigOption]


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _choice(entry: dict[str, Any], group: str | None = None) -> ConfigChoice:
    return ConfigChoice(
        value=str(entry.get("value")),
        name=str(entry.get("name", entry.get("value"))),
        description=_text(entry.get("description")) or None,
        group=group or None,
    )


def _option(raw: dict[str, Any]) -> ConfigOption | None:
    option_id = _text(raw.get("configId")) or _text(raw.get("id"))
    if not option_id:
        return None
    name = _text(raw.get("name")) or option_id
    description = _text(raw.get("description")) or None
    category = _text(raw.get("category")) or None
    if raw.get("type") == "select":
        choices: list[ConfigChoice] = []
        for entry in as_list(raw.get("options")):
            if not isinstance(entry, dict):
                continue
            if isinstance(entry.get("options"), list):
                group = _text(entry.get("name")) or _text(entry.get("groupId")) or _text(entry.get("group"))
                choices.extend(_choice(c, group) for c in entry["options"] if isinstance(c, dict))
            else:
                choices.append(_choice(entry))
        current = raw.get("currentValue")
        return SelectConfigOption(
            id=option_id,
            name=name,
            choices=choices,
            current_value=current if isinstance(current, str) else None,
            description=description,
            category=category,
        )
    if raw.get("type") == "boolean":
        current = raw.get("currentValue")
        return BooleanConfigOption(
            id=option_id, name=name, current_value=current if isinstance(current, bool) else None, description=description, category=category
        )
    return OtherConfigOption(
        id=option_id, name=name, raw_type=str(raw.get("type")), current_value=raw.get("currentValue"), description=description, category=category
    )


def config_options_from(options: Any) -> list[ConfigOption] | None:
    """The config options in a session/new, load, resume or set_config_option answer, or a `config_option_update`."""
    if not isinstance(options, list):
        return None
    return [o for o in (_option(raw) for raw in options if isinstance(raw, dict)) if o is not None]


def with_value(option: ConfigOption, value: Any) -> ConfigOption:
    return replace(option, current_value=value)


def config_params(protocol: ProtocolVersion, session_id: str, option: ConfigOption, value: str | bool) -> dict[str, Any] | str:
    """The `session/set_config_option` params to set `value`, or (a str) the reason it cannot be set."""
    base = {"sessionId": session_id, "configId": option.id}
    if isinstance(option, BooleanConfigOption):
        if not isinstance(value, bool):
            return f"{option.id} is on or off: set it to True or False"
        return {**base, "type": "boolean", "value": value}
    if isinstance(option, SelectConfigOption):
        if not isinstance(value, str) or not any(c.value == value for c in option.choices):
            offered = ", ".join(c.value for c in option.choices) or "none"
            return f"{option.id} has no choice {json.dumps(value)} (choices: {offered})"
        return {**base, "type": "id", "value": value} if protocol == 2 else {**base, "value": value}
    return f'{option.id} is a "{option.raw_type}" option, which this client cannot set'
