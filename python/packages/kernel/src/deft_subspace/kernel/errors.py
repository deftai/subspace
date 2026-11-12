"""Two kinds of failure, kept apart on purpose.

- `RpcError` crosses the wire. The other side sent it (or we send it).
- `LocalError` never crosses the wire. It says why *this* side stopped
  waiting: the caller aborted, a deadline passed, the connection closed, ...

Code that cares should look at `error.kind`, never at message text.

Every exception Subspace raises (both packages) is a `SubspaceError`, so `except SubspaceError`
catches them all.
"""

from __future__ import annotations

from typing import Any, Literal


class SubspaceError(Exception):
    """The base of every exception the Subspace packages raise."""


class ErrorCode:
    """Standard JSON-RPC 2.0 codes, plus the ones ACP and LSP use."""

    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    #: ACP: the session (or other resource) does not exist.
    RESOURCE_NOT_FOUND = -32002
    #: ACP: authentication required.
    AUTH_REQUIRED = -32000
    #: LSP / ACP `$/cancel_request`: the request was cancelled.
    REQUEST_CANCELLED = -32800


_MISSING: Any = object()


class RpcError(SubspaceError):
    """An error the remote side returned, or one a handler raises to return."""

    kind: Literal["remote"] = "remote"

    def __init__(self, code: int, message: str, data: Any = _MISSING) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self._data = data

    @property
    def data(self) -> Any:
        return None if self._data is _MISSING else self._data

    @property
    def has_data(self) -> bool:
        return self._data is not _MISSING

    @classmethod
    def method_not_found(cls, method: str) -> RpcError:
        return cls(ErrorCode.METHOD_NOT_FOUND, f"Method not found: {method}")

    @classmethod
    def invalid_params(cls, message: str, data: Any = _MISSING) -> RpcError:
        return cls(ErrorCode.INVALID_PARAMS, message, data)

    @classmethod
    def not_found(cls, message: str, data: Any = _MISSING) -> RpcError:
        return cls(ErrorCode.RESOURCE_NOT_FOUND, message, data)

    @classmethod
    def internal(cls, message: str, data: Any = _MISSING) -> RpcError:
        return cls(ErrorCode.INTERNAL_ERROR, message, data)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self._data is not _MISSING:
            out["data"] = self._data
        return out

    def __repr__(self) -> str:
        return f"RpcError({self.code}, {self.message!r})"


LocalErrorKind = Literal["aborted", "timeout", "closed", "invalid-response", "send-failed"]
"""Why this side gave up on a request.

- `aborted`: the caller's AbortSignal fired (or its task was cancelled).
- `timeout`: the request's deadline passed.
- `closed`: the connection closed before an answer arrived.
- `invalid-response`: the answer was not a valid JSON-RPC response.
- `send-failed`: the request could not be written.
"""


class LocalError(SubspaceError):
    def __init__(self, kind: LocalErrorKind, message: str, *, cause: Any = None, method: str | None = None) -> None:
        super().__init__(message)
        self.kind: LocalErrorKind = kind
        self.message = message
        self.method = method
        self.cause = cause
        if isinstance(cause, BaseException):
            self.__cause__ = cause

    @staticmethod
    def is_(value: object, kind: LocalErrorKind | None = None) -> bool:
        """Whether `value` is a LocalError (of `kind`, if given)."""
        return isinstance(value, LocalError) and (kind is None or value.kind == kind)

    def __repr__(self) -> str:
        return f"LocalError({self.kind!r}, {self.message!r})"
