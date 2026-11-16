"""What a conformance check found, and the helpers the suites share."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, TypeVar

T = TypeVar("T")
F = TypeVar("F")


@dataclass(frozen=True)
class CheckResult:
    """What a conformance check found."""

    id: str
    title: str
    #: True when the check passed (also when it was skipped or waived).
    passed: bool
    detail: str
    #: The check could not run (e.g. the agent never asked for permission). `passed` is True.
    skipped: bool = False
    #: A known quirk: the check failed, and was waived for this reason. `passed` is True.
    waived: str | None = None


def apply_waivers(report: Sequence[CheckResult], waive: Mapping[str, str] | None) -> list[CheckResult]:
    """Mark failed checks listed in `waive` (id: reason) as waived. A waiver for a check that passed is dropped."""
    if not waive:
        return list(report)
    return [replace(r, passed=True, waived=waive[r.id]) if not r.passed and waive.get(r.id) else r for r in report]


def failures(report: Sequence[CheckResult]) -> list[CheckResult]:
    """The checks that failed."""
    return [r for r in report if not r.passed]


def format_report(report: Sequence[CheckResult]) -> str:
    """One line per check, for logs."""

    def line(r: CheckResult) -> str:
        verdict = "WAIVE" if r.waived else "SKIP" if r.skipped else "PASS" if r.passed else "FAIL"
        gap = " " if r.waived else "  "
        detail = f" ({r.detail})" if r.detail else ""
        waived = f" [waived: {r.waived}]" if r.waived else ""
        return f"{verdict}{gap}{r.id.ljust(28)} {r.title}{detail}{waived}"

    return "\n".join(line(r) for r in report)


@dataclass(frozen=True)
class Outcome:
    passed: bool
    detail: str
    skipped: bool = False


async def run_check(id: str, title: str, body: Callable[[], Awaitable[Outcome]]) -> CheckResult:
    """Run one check, turning an exception into a failure."""
    try:
        outcome = await body()
    except Exception as error:  # noqa: BLE001 - any failure of the check is its result
        return CheckResult(id, title, False, f"threw: {message(error)}")
    return CheckResult(id, title, outcome.passed, outcome.detail, skipped=outcome.skipped)


class _TimedOut:
    def __repr__(self) -> str:
        return "TIMED_OUT"


TIMED_OUT: Any = _TimedOut()


def _quiet(task: asyncio.Future[Any]) -> None:
    # A task left running after a timeout may fail later; nobody is waiting for it then.
    if not task.cancelled():
        task.exception()


async def within(awaitable: Awaitable[T], ms: float, fallback: F, *, cancel: bool = False) -> T | F:
    """`fallback` if `awaitable` takes longer than `ms`. The work is left running (as a promise
    is in TypeScript) unless `cancel`: cancelling a request would tell the other side."""
    task = asyncio.ensure_future(awaitable)
    try:
        done, _ = await asyncio.wait({task}, timeout=max(0.0, ms) / 1000)
    except asyncio.CancelledError:
        task.cancel()
        raise
    if task in done:
        return task.result()
    if cancel:
        task.cancel()
    task.add_done_callback(_quiet)
    return fallback


def message(error: BaseException) -> str:
    text = str(error)
    return text or type(error).__name__
