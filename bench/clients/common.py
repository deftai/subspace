"""What every Python benchmark client shares: arguments, timing and the result line."""

import asyncio
import json
import resource
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol


@dataclass
class Args:
    scenario: str
    n: int
    size: int
    agent: list[str]


def parse_args(argv: list[str] | None = None) -> Args:
    argv = sys.argv[1:] if argv is None else argv
    split = argv.index("--")
    head = argv[:split] + ["turns", "1000", "100"][len(argv[:split]) :]
    return Args(head[0], int(head[1]), int(head[2]), argv[split + 1 :])


def now() -> float:
    return time.perf_counter() * 1000


def percentile(ordered: list[float], p: float) -> float:
    return ordered[min(len(ordered) - 1, int(p / 100 * len(ordered)))] if ordered else 0.0


class Driver(Protocol):
    """One per library: open a session, run one prompt to its end and return the text it streamed."""

    async def new_session(self) -> str: ...
    async def prompt(self, session: str, text: str) -> str: ...
    async def close(self) -> None: ...


async def run(args: Args, connect: Callable[[], Awaitable[Driver]]) -> None:
    t0 = now()
    driver = await connect()
    session = await driver.new_session()
    await driver.prompt(session, "noop")
    out: dict[str, object] = {"scenario": args.scenario, "startupMs": now() - t0}

    async def warm(text: str, times: int) -> None:
        for _ in range(times):
            await driver.prompt(session, text)

    if args.scenario == "turns":
        await warm("noop", 100)
        lat: list[float] = []
        start = now()
        for _ in range(args.n):
            t = now()
            await driver.prompt(session, "noop")
            lat.append(now() - t)
        out["ms"] = now() - start
        lat.sort()
        out.update(ops=args.n, p50=percentile(lat, 50), p99=percentile(lat, 99))
    elif args.scenario == "stream":
        await warm(f"stream 200 {min(args.size, 1000)}", 3)
        start = now()
        text = await driver.prompt(session, f"stream {args.n} {args.size}")
        out["ms"] = now() - start
        if len(text) != args.n * args.size:
            raise RuntimeError(f"got {len(text)} characters, expected {args.n * args.size}")
        out.update(ops=args.n, bytes=args.n * args.size)
    elif args.scenario == "ask":
        await warm("ask 50", 2)
        start = now()
        await driver.prompt(session, f"ask {args.n}")
        out["ms"] = now() - start
        out["ops"] = args.n
    elif args.scenario == "concurrent":
        # n sessions, each running `size` turns, all at once.
        await warm("noop", 100)
        sessions = await asyncio.gather(*(driver.new_session() for _ in range(args.n)))

        async def turns(s: str) -> None:
            for _ in range(args.size):
                await driver.prompt(s, "noop")

        start = now()
        await asyncio.gather(*(turns(s) for s in sessions))
        out["ms"] = now() - start
        out["ops"] = args.n * args.size
    elif args.scenario != "startup":
        raise RuntimeError(f"unknown scenario {args.scenario}")
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    out["clientRss"] = peak if sys.platform == "darwin" else peak * 1024
    await driver.close()
    print(json.dumps(out), flush=True)
