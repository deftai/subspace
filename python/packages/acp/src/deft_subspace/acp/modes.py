"""Session modes, one API over both ways agents offer them:

- v1 `modes` (`session/set_mode`, `current_mode_update`), and
- config options with category `mode` (`session/set_config_option`,
  `config_option_update`), which v1 also has and v2 uses exclusively.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from ._util import as_list


@dataclass(frozen=True)
class SessionMode:
    id: str
    name: str
    description: str | None = None


@dataclass
class SessionModes:
    available: list[SessionMode]
    #: How the agent offers them, and so how `set_mode` switches.
    via: Literal["modes", "config"]
    current: str | None = None
    #: For `via == "config"`, the config option's id.
    config_id: str | None = None


def modes_from(source: dict[str, Any]) -> SessionModes | None:
    """Modes from a session/new (or set_config_option) answer. Config options win when both exist."""
    return modes_from_config(source.get("configOptions")) or _modes_from_mode_state(source.get("modes"))


def _modes_from_mode_state(state: Any) -> SessionModes | None:
    if not isinstance(state, dict) or not isinstance(state.get("availableModes"), list):
        return None
    return SessionModes(
        via="modes",
        current=state["currentModeId"] if isinstance(state.get("currentModeId"), str) else None,
        available=[
            SessionMode(
                id=str(m.get("id")),
                name=str(m.get("name", m.get("id"))),
                description=m["description"] if isinstance(m.get("description"), str) else None,
            )
            for m in state["availableModes"]
            if isinstance(m, dict)
        ],
    )


def modes_from_config(options: Any) -> SessionModes | None:
    if not isinstance(options, list):
        return None
    option = next((o for o in options if isinstance(o, dict) and o.get("category") == "mode" and o.get("type") == "select"), None)
    if option is None:
        return None
    choices: list[SessionMode] = []
    for entry in as_list(option.get("options")):
        # Options may be grouped.
        group = as_list(entry.get("options")) if isinstance(entry, dict) and isinstance(entry.get("options"), list) else [entry]
        for choice in group:
            if not isinstance(choice, dict):
                continue
            choices.append(
                SessionMode(
                    id=str(choice.get("value")),
                    name=str(choice.get("name", choice.get("value"))),
                    description=choice["description"] if isinstance(choice.get("description"), str) else None,
                )
            )
    return SessionModes(
        via="config",
        config_id=str(option.get("configId", option.get("id"))),
        current=option["currentValue"] if isinstance(option.get("currentValue"), str) else None,
        available=choices,
    )
