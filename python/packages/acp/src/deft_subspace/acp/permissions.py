"""How to answer an agent's permission question.

A decision is one of:

- `"allow"` / `"reject"`: pick the agent's once-only option of that kind (or its
  always option if that is all it offers).
- `"allow_always"` / `"reject_always"`: prefer the always option.
- `{"optionId": ...}` (or `OptionId(...)`): exactly that option. It must be one the agent offered.
- `"cancelled"`: answer cancelled.

Anything else is a rejection. A policy is a fixed `"allow"` / `"reject"`, or a
handler `(request, signal) -> decision | None` (plain or async). Anything that
goes wrong while deciding (an exception, an unknown option id) becomes a
rejection: permissions fail closed.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Union

from deft_subspace.kernel import AbortSignal

from .model import PermissionOption, PermissionOutcome, PermissionRequest


@dataclass(frozen=True)
class OptionId:
    option_id: str


PermissionDecision = Union[str, OptionId, dict[str, Any]]
PermissionHandler = Callable[[PermissionRequest, AbortSignal], Union[PermissionDecision, None, Awaitable[Union[PermissionDecision, None]]]]
PermissionPolicy = Union[str, PermissionHandler]

_ALLOW = ("allow_once", "allow_always")


def _is_allow(option: PermissionOption) -> bool:
    return option.get("kind") in _ALLOW


def _pick(options: list[PermissionOption], kinds: list[str]) -> PermissionOption | None:
    for kind in kinds:
        for option in options:
            if option.get("kind") == kind:
                return option
    return None


def _option_id(decision: Any) -> str | None:
    if isinstance(decision, OptionId):
        return decision.option_id
    if isinstance(decision, dict) and isinstance(decision.get("optionId"), str):
        return decision["optionId"]
    return None


def resolve_decision(decision: Any, options: list[PermissionOption]) -> PermissionOutcome:
    """Turn a decision into an outcome the agent accepts. Never selects an option the agent did not offer."""

    def reject() -> PermissionOutcome:
        option = _pick(options, ["reject_once", "reject_always"])
        return PermissionOutcome.selected(str(option.get("optionId")), False) if option else PermissionOutcome.cancelled()

    def selected(option: PermissionOption | None) -> PermissionOutcome:
        return PermissionOutcome.selected(str(option.get("optionId")), _is_allow(option)) if option else reject()

    if decision == "cancelled":
        return PermissionOutcome.cancelled()
    if decision == "allow":
        return selected(_pick(options, ["allow_once", "allow_always"]))
    if decision == "allow_always":
        return selected(_pick(options, ["allow_always", "allow_once"]))
    if decision == "reject_always":
        option = _pick(options, ["reject_always", "reject_once"])
        return PermissionOutcome.selected(str(option.get("optionId")), False) if option else PermissionOutcome.cancelled()
    wanted = _option_id(decision)
    if wanted is not None:
        return selected(next((o for o in options if o.get("optionId") == wanted), None))
    return reject()


async def decide(policy: PermissionPolicy, request: PermissionRequest, signal: AbortSignal) -> PermissionOutcome:
    if signal.aborted:
        return PermissionOutcome.cancelled()
    if policy in ("allow", "reject"):
        return resolve_decision(policy, request.options)
    if not callable(policy):
        return resolve_decision("reject", request.options)
    try:
        result = policy(request, signal)
        if inspect.isawaitable(result):
            decision_task = asyncio.ensure_future(result)
            abort_task = asyncio.ensure_future(signal.wait())
            try:
                await asyncio.wait({decision_task, abort_task}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                abort_task.cancel()
            if not decision_task.done():
                # Cancelled while deciding: stop waiting for the answer.
                decision_task.cancel()
                return PermissionOutcome.cancelled()
            result = decision_task.result()
        return PermissionOutcome.cancelled() if signal.aborted else resolve_decision(result, request.options)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - fail closed
        return resolve_decision("reject", request.options)
