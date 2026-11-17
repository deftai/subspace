"""Replay: play the agent side of a recorded trace to a live client.

    replay = replay_agent(channel, parse_trace(text))
    client = await AcpClient.connect(other_end)
    ...
    await replay.done  # raises ReplayDivergence if the client did something else

- The agent's recorded messages are sent in recorded order, as soon as the
  client messages recorded before them have arrived.
- Client requests and notifications are matched by method. Messages the
  client sends together may arrive in another order than recorded: one is
  matched with any of the next few recorded ones (`window`). Their params
  may differ (pass `check` to be stricter). Responses to the agent's
  requests are matched by id (and passed to `check` too).
- JSON-RPC ids are remapped both ways: recorded answers go out with the
  client's live ids, and the agent's requests get fresh ids.
- When the client sends something else, or nothing within `wait_ms`, the
  replay stops with a ReplayDivergence naming what was expected and what
  arrived, answers the offending request with that error, and closes the
  connection, so the client fails instead of hanging.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Sequence
from typing import Any, Literal

from deft_subspace.kernel import Channel, EndOfChannel, ErrorCode, SubspaceError, TraceRecord, parse_trace

from ._record import messages_of

Message = dict[str, Any]
Check = Callable[[Message, Message], "str | None"]


class ReplayDivergence(SubspaceError):
    """The client did something the recording did not."""

    def __init__(self, step: int, total: int, description: str, expected: Any, got: Any) -> None:
        super().__init__(f"Replay diverged at message {step} of {total}: {description}")
        self.message = str(self)
        #: 1-based position in the trace's messages.
        self.step = step
        self.expected = expected
        self.got = got


def _key(value: Any) -> str:
    return json.dumps(value)


def _is_call(m: Message) -> bool:
    return isinstance(m.get("method"), str)


def _is_response(m: Message) -> bool:
    return not _is_call(m) and "id" in m and ("result" in m or "error" in m)


def _describe(m: Message | None) -> str:
    if m is None:
        return "nothing"
    if _is_call(m):
        return f'{"request" if "id" in m else "notification"} "{m["method"]}"'
    if _is_response(m):
        return f"a response to request {_key(m.get('id'))}"
    return "a malformed message"


_KEEP_WAITING: Any = object()
_STOP: Any = object()


class Replay:
    """A replay running on a channel. Started by `replay_agent()`."""

    def __init__(
        self,
        channel: Channel[Any],
        records: Sequence[TraceRecord],
        *,
        wait_ms: float,
        pace: float,
        recorded_by: Literal["client", "agent"],
        window: int,
        check: Check | None,
    ) -> None:
        self._channel = channel
        # As the agent sees it: `in` is what the client sent.
        self._steps: list[tuple[Literal["send", "expect"], float, Message]] = []
        for m in messages_of(records):
            if not isinstance(m["msg"], dict):
                continue
            from_client = m["dir"] == "out" if recorded_by == "client" else m["dir"] == "in"
            self._steps.append(("expect" if from_client else "send", m["t"], m["msg"]))
        self._wait_ms = wait_ms
        self._pace = pace
        self._window = window
        self._check = check
        self._calls: list[Message] = []  # client requests and notifications not matched yet
        self._responses: dict[str, Message] = {}  # by live id
        self._client_ids: dict[str, Any] = {}  # recorded client request id -> live id
        self._agent_ids: dict[str, Any] = {}  # recorded agent request id -> live id
        self._methods: dict[str, str] = {}  # recorded agent request id -> method
        self._next_agent_id = 0
        self._wake = asyncio.Event()
        self._finished = False
        self._client_gone = False
        self._script_over = False
        self._sent = 0
        self._tasks: set[asyncio.Task[Any]] = set()
        self._reader = asyncio.ensure_future(self._read())
        self._run = asyncio.ensure_future(self._main())
        self._run.add_done_callback(lambda t: t.cancelled() or t.exception())

    @property
    def done(self) -> asyncio.Future[None]:
        """Resolves when every recorded message has been sent and matched; raises a ReplayDivergence.
        Cancelling a task that awaits it does not stop the replay (use `close()`)."""
        return asyncio.shield(self._run)

    @property
    def sent(self) -> int:
        """Messages sent so far."""
        return self._sent

    async def close(self) -> None:
        """Stop and close the connection."""
        await self._shutdown()

    def __repr__(self) -> str:
        state = "done" if self._run.done() else "running"
        return f"<Replay {state}, {self._sent} sent of {len(self._steps)} messages>"

    # ---- io ----------------------------------------------------------------------

    async def _write(self, message: Message) -> None:
        await self._channel.send({"jsonrpc": "2.0", **message})
        self._sent += 1

    def _write_soon(self, message: Message) -> None:
        async def write() -> None:
            try:
                await self._write(message)
            except Exception:  # noqa: BLE001 - the client may be gone
                pass

        task = asyncio.ensure_future(write())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _shutdown(self) -> None:
        if self._finished:
            return
        self._finished = True
        self._wake.set()
        try:
            await self._channel.close()
        except Exception:  # noqa: BLE001
            pass
        if not self._reader.done():
            self._reader.cancel()

    async def _read(self) -> None:
        """Read the client's messages into the buffers."""
        try:
            while True:
                value = await self._channel.receive()
                if not isinstance(value, dict):
                    continue
                if _is_response(value):
                    self._responses[_key(value.get("id"))] = value
                elif _is_call(value):
                    if self._script_over and "id" in value:
                        # Nothing recorded answers this: say so instead of leaving it open.
                        self._write_soon(self._ended_error(value))
                        continue
                    self._calls.append(value)
                self._wake.set()
        except EndOfChannel:
            pass
        except Exception:  # noqa: BLE001 - the connection failed; treated like an end
            pass
        self._client_gone = True
        self._wake.set()

    @staticmethod
    def _ended_error(call: Message) -> Message:
        return {
            "id": call.get("id"),
            "error": {
                "code": ErrorCode.INTERNAL_ERROR,
                "message": f"Replay has ended; nothing was recorded for {call.get('method')}",
            },
        }

    async def _wait_for(self, take: Callable[[], Any]) -> Any:
        """Wait until `take` finds something (or says stop), the client leaves, or time runs out.
        `take` returns a value, `_STOP`, or `_KEEP_WAITING`."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._wait_ms / 1000
        while True:
            self._wake.clear()
            found = take()
            if found is not _KEEP_WAITING or self._client_gone or self._finished:
                return found
            left = deadline - loop.time()
            if left <= 0:
                return _KEEP_WAITING
            try:
                await asyncio.wait_for(self._wake.wait(), left)
            except TimeoutError:
                pass

    # ---- ids ---------------------------------------------------------------------

    def _outgoing(self, message: Message) -> Message:
        """A recorded agent message with live ids."""
        rest = {k: v for k, v in message.items() if k != "jsonrpc"}
        if _is_response(rest):
            live = self._client_ids.get(_key(rest.get("id")), _KEEP_WAITING)
            return rest if live is _KEEP_WAITING else {**rest, "id": live}
        if _is_call(rest) and "id" in rest:
            live = self._next_agent_id
            self._next_agent_id += 1
            self._agent_ids[_key(rest["id"])] = live
            self._methods[_key(rest["id"])] = str(rest["method"])
            return {**rest, "id": live}
        params = rest.get("params")
        if rest.get("method") == "$/cancel_request" and isinstance(params, dict):
            # The agent cancels one of its own requests, which went out with a fresh id.
            live = self._agent_ids.get(_key(params.get("requestId")), _KEEP_WAITING)
            if live is not _KEEP_WAITING:
                return {**rest, "params": {**params, "requestId": live}}
        return rest

    def _live_ids(self, message: Message) -> Message:
        """A recorded client message with the live client's ids."""
        out = dict(message)
        if "id" in out and _key(out["id"]) in self._client_ids:
            out["id"] = self._client_ids[_key(out["id"])]
        params = out.get("params")
        if (
            out.get("method") == "$/cancel_request"
            and isinstance(params, dict)
            and _key(params.get("requestId")) in self._client_ids
        ):
            out["params"] = {**params, "requestId": self._client_ids[_key(params.get("requestId"))]}
        return out

    # ---- the script --------------------------------------------------------------

    async def _main(self) -> None:
        try:
            await self._play()
        except BaseException:
            await self._shutdown()
            raise

    async def _play(self) -> None:
        steps = self._steps
        last_t: float = 0
        # The closures below (B023) are called, and awaited, only within the step that defines them.
        for index, (direction, t, expected) in enumerate(steps):
            if self._finished:
                return

            async def diverge(description: str, got: Message | None = None) -> None:
                error = ReplayDivergence(index + 1, len(steps), description, expected, got)  # noqa: B023
                if got is not None and _is_call(got) and "id" in got:
                    try:
                        await self._write(
                            {
                                "id": got["id"],
                                "error": {
                                    "code": ErrorCode.INTERNAL_ERROR,
                                    "message": error.message,
                                    "data": {"expected": expected, "got": got},  # noqa: B023
                                },
                            }
                        )
                    except Exception:  # noqa: BLE001
                        pass
                raise error

            def silence() -> str:
                return "the client closed the connection" if self._client_gone else f"nothing within {_ms(self._wait_ms)} ms"

            if direction == "send":
                if self._pace > 0 and t > last_t:
                    await asyncio.sleep((t - last_t) * self._pace / 1000)
                last_t = t
                try:
                    await self._write(self._outgoing(expected))
                except Exception:  # noqa: BLE001 - a client that left is found when its next message is due
                    pass
                continue
            last_t = t

            if _is_response(expected):
                live = self._agent_ids.get(_key(expected.get("id")), _KEEP_WAITING)
                live_key = _key(expected.get("id") if live is _KEEP_WAITING else live)

                def take_response() -> Any:
                    return self._responses.pop(live_key, _KEEP_WAITING)  # noqa: B023

                answer = await self._wait_for(take_response)
                if answer is _KEEP_WAITING:
                    method = self._methods.get(_key(expected.get("id")), "?")
                    await diverge(f'expected the client to answer request "{method}", got {silence()}')
                if self._check is not None:
                    complaint = self._check(expected if live is _KEEP_WAITING else {**expected, "id": live}, answer)
                    if complaint:
                        await diverge(complaint, answer)
                continue

            if not _is_call(expected):
                continue
            # The recorded client calls a buffered one may stand for: this one and the next few.
            upcoming = [m for d, _t, m in steps[index:] if d == "expect" and _is_call(m)][: self._window]

            def same(a: Message, b: Message) -> bool:
                return a.get("method") == b.get("method") and ("id" in a) == ("id" in b)

            stray: list[Message] = []

            def take_call() -> Any:
                for at, c in enumerate(self._calls):
                    if same(c, expected):  # noqa: B023
                        return self._calls.pop(at)
                # Something none of them explains: stop now rather than wait.
                for c in self._calls:
                    if not any(same(c, u) for u in upcoming):  # noqa: B023
                        stray[:] = [c]  # noqa: B023
                        return _STOP
                return _KEEP_WAITING

            got = await self._wait_for(take_call)
            if got is _STOP or got is _KEEP_WAITING:
                if stray:
                    self._calls.remove(stray[0])
                    await diverge(f"expected the client to send {_describe(expected)}, got {_describe(stray[0])}", stray[0])
                first = self._calls[0] if self._calls else None
                await diverge(
                    f"expected the client to send {_describe(expected)}, got {_describe(first) if first else silence()}", first
                )
                return
            if "id" in expected:
                self._client_ids[_key(expected["id"])] = got.get("id")
            complaint = self._check(self._live_ids(expected), got) if self._check is not None else None
            if complaint:
                await diverge(complaint, got)
        self._script_over = True
        # Requests already buffered past the end get the same answer as later ones.
        extras, self._calls = self._calls, []
        for extra in extras:
            if "id" in extra:
                try:
                    await self._write(self._ended_error(extra))
                except Exception:  # noqa: BLE001
                    pass


def _ms(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def replay_agent(
    channel: Channel[Any],
    trace: Sequence[TraceRecord] | str,
    *,
    wait_ms: float = 5000,
    pace: float = 0,
    recorded_by: Literal["client", "agent"] | None = None,
    window: int = 4,
    check: Check | None = None,
) -> Replay:
    """Play the agent side of `trace` (records, or the JSON Lines text) to the client on `channel`.
    Needs a running event loop.

    - `wait_ms`: how long to wait for each message the client is expected to send. Default 5000.
    - `pace`: 0 (default) sends as fast as possible; 1 keeps the recorded gaps before the
      agent's messages; 0.5 halves them.
    - `recorded_by`: which side recorded the trace. Default: the header's `peer` if it is
      "agent", else "client".
    - `window`: how many of the client's upcoming recorded requests and notifications a
      message may be matched with, when the client sends them in another order. Default 4;
      1 is strict recorded order.
    - `check(expected, got)`: compare a client message with the recorded one (both whole
      JSON-RPC messages; `expected` has its ids mapped to the live ones). Return a
      description to stop the replay as diverged. It sees the client's requests and
      notifications, and its responses to the agent's requests (a permission answer, a
      file's contents). A response has no `"method"`: check `"method" in expected` to tell
      them apart.
    """
    records = parse_trace(trace) if isinstance(trace, str) else trace
    header = records[0] if records and records[0].get("kind") == "header" else None
    by: Literal["client", "agent"] = recorded_by or (
        "agent" if header is not None and header.get("peer") == "agent" else "client"
    )
    return Replay(channel, records, wait_ms=wait_ms, pace=pace, recorded_by=by, window=max(1, window), check=check)
