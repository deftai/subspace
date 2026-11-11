"""Vendor extension methods, declared once and used on both sides.

    steer = extension_request("_acme/steer")

    # agent:  serve_agent(channel, extensions=[handle(steer, lambda p, ctx: {"ok": True})], ...)
    # client: await client.call(steer, {"sessionId": sid, "text": "focus on tests"})

ACP reserves names that start with `_` for extensions, so declarations must use
one. Pass a validator (see `schemas`: a pydantic model, a TypeAdapter, ...) to
check params on the receiving side and results on the calling side; a failed
check is InvalidParams there and an `invalid-response` error here.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Generic, Literal, TypeVar

from deft_subspace.kernel import AbortSignal, InboundContext, LocalError, RpcError, RpcPeer

from . import schemas

P = TypeVar("P")
R = TypeVar("R")


@dataclass(frozen=True)
class ExtensionRequest(Generic[P, R]):
    method: str
    params: schemas.Schema | None = None
    result: schemas.Schema | None = None
    kind: Literal["request"] = "request"


@dataclass(frozen=True)
class ExtensionNotification(Generic[P]):
    method: str
    params: schemas.Schema | None = None
    kind: Literal["notification"] = "notification"


def _check_name(method: str) -> None:
    if not method.startswith("_") or len(method) < 2:
        raise ValueError(f'Extension method names start with "_" (ACP reserves them for extensions): {method}')


def extension_request(method: str, *, params: schemas.Schema | None = None, result: schemas.Schema | None = None) -> ExtensionRequest[Any, Any]:
    _check_name(method)
    return ExtensionRequest(method, params, result)


def extension_notification(method: str, *, params: schemas.Schema | None = None) -> ExtensionNotification[Any]:
    _check_name(method)
    return ExtensionNotification(method, params)


@dataclass(frozen=True)
class ExtensionHandler:
    """A handler bound to its declaration, for `serve_agent(extensions=...)` or `AcpClient.connect(extensions=...)`."""

    kind: Literal["request", "notification"]
    method: str
    handler: Callable[[Any, InboundContext], Any]


def _parse(schema: schemas.Schema | None, value: Any, what: str) -> Any:
    if schema is None:
        return value
    ok, out = schemas.check(schema, value)
    if not ok:
        raise RpcError.invalid_params(f"Invalid {what}: {'; '.join(out)}")
    return out


def handle(extension: ExtensionRequest[Any, Any] | ExtensionNotification[Any], handler: Callable[[Any, InboundContext], Any]) -> ExtensionHandler:
    if isinstance(extension, ExtensionRequest):

        async def on_request(params: Any, context: InboundContext) -> Any:
            result = handler(_parse(extension.params, params, f"params for {extension.method}"), context)
            if inspect.isawaitable(result):
                result = await result
            return schemas.to_json(result)

        return ExtensionHandler("request", extension.method, on_request)

    def on_notification(params: Any, context: InboundContext) -> Any:
        # A notification cannot be answered; bad params are dropped.
        try:
            parsed = _parse(extension.params, params, f"params for {extension.method}")
        except RpcError:
            return None
        return handler(parsed, context)

    return ExtensionHandler("notification", extension.method, on_notification)


def register_extensions(peer: RpcPeer, handlers: list[ExtensionHandler] | None) -> None:
    for h in handlers or []:
        if h.kind == "request":
            peer.on_request(h.method, h.handler)
        else:
            peer.on_notification(h.method, h.handler)


async def call_extension(
    request: Callable[..., Any],
    extension: ExtensionRequest[Any, Any],
    params: Any,
    *,
    signal: AbortSignal | None = None,
    timeout_ms: float | None = None,
) -> Any:
    """Call an extension request, checking the result if a validator was given."""
    result = await request(extension.method, schemas.to_json(params), signal=signal, timeout_ms=timeout_ms)
    if extension.result is None:
        return result
    ok, out = schemas.check(extension.result, result)
    if not ok:
        raise LocalError("invalid-response", f"Invalid result for {extension.method}: {'; '.join(out)}", method=extension.method)
    return out
