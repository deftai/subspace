"""Fields computed the first time they are read.

A snapshot stores a `Lazy` in the instance's `__dict__` under the field's own name;
the class's `LazyField` descriptor reads it once, stores the plain value in its place
and returns it. So a snapshot can defer copying until someone looks, and still behave
like a plain dataclass: reading twice gives the same value, the value is the
snapshot's own, assignment works as on any other field (a frozen dataclass stays
frozen), and pickling, copying, `asdict`, `replace` and `==` see the value.
"""

from __future__ import annotations

from typing import Any


def _value(value: Any) -> Any:
    return value


class Lazy:
    """A value read when first looked at. Pickles and copies as the value itself."""

    __slots__ = ()

    #: Store the value in place of this once read (False: read each time, for live state).
    once = True

    def read(self) -> Any:
        raise NotImplementedError

    def __reduce__(self) -> tuple[Any, tuple[Any]]:
        return (_value, (self.read(),))

    def __repr__(self) -> str:
        return repr(self.read())


class LazyField:
    """A dataclass field whose stored value may be a `Lazy`. Set on the class after
    `@dataclass` has made its `__init__`, which still takes the field as an argument."""

    def __init__(self, name: str, default: Any) -> None:
        self.name = name
        self.default = default

    def __get__(self, obj: Any, objtype: Any = None) -> Any:
        if obj is None:
            return self.default
        stored = obj.__dict__
        value = stored.get(self.name, self.default)
        if isinstance(value, Lazy):
            lazy = value
            value = lazy.read()
            if lazy.once:
                stored[self.name] = value
        return value

    def __set__(self, obj: Any, value: Any) -> None:
        obj.__dict__[self.name] = value


def stored(obj: Any, name: str, default: Any = None) -> Any:
    """@internal A field as stored: a plain value or a `Lazy`, without reading it."""
    return obj.__dict__.get(name, default)
