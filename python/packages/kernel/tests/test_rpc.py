import asyncio
import datetime
import sys
import time
from typing import Any

import pytest

from deft_subspace.kernel import (
    AbortController,
    CancelInbound,
    ErrorCode,
    LocalError,
    PeerDiagnostic,
    RpcError,
    RpcPeer,
    ChannelClosed,
    cancel_request,
    channel_pair,
    ndjson,
)
from deft_subspace.kernel.testing import manual_clock, tick


def pair(a: dict[str, Any] | None = None, b: dict[str, Any] | None = None):
    left, right = channel_pair()
    client = RpcPeer(left, **{"name": "client", **(a or {})})
    server = RpcPeer(right, **{"name": "server", **(b or {})})

    def start() -> None:
        client.start()
        server.start()

    return client, server, start


class Raw:
    """A raw end: read what the peer sends, write anything back."""

    def __init__(self) -> None:
        self.channel, self._other = channel_pair()
        self.sent: list[Any] = []
        self._task = asyncio.get_running_loop().create_task(self._read())

    async def _read(self) -> None:
        from deft_subspace.kernel import EndOfChannel

        while True:
            try:
                self.sent.append(await self._other.receive())
            except EndOfChannel:
                return

    async def send(self, message: Any) -> None:
        await self._other.send(message)

    async def end(self) -> None:
        await self._other.close()


async def test_first_request_has_id_0_and_can_be_cancelled():
    client, server, start = pair(cancel_request, cancel_request)
    seen: dict[str, Any] = {}

    def slow(_p, ctx):
        seen["id"] = ctx.id
        seen["signal"] = ctx.signal
        return asyncio.get_running_loop().create_future()  # never answers

    server.on_request("slow", slow)
    start()
    controller = AbortController()
    result = asyncio.ensure_future(client.request("slow", {}, signal=controller.signal))
    await tick()
    assert seen["id"] == 0
    controller.abort()
    with pytest.raises(LocalError) as info:
        await result
    assert info.value.kind == "aborted"
    await tick()
    assert seen["signal"].aborted, "the server handler saw the cancel for id 0"
    assert client.pending_count == 0


async def test_cancelling_the_awaiting_task_gives_up_and_tells_the_other_side():
    client, server, start = pair(cancel_request, cancel_request)
    seen: dict[str, Any] = {}

    def slow(_p, ctx):
        seen["signal"] = ctx.signal
        return asyncio.get_running_loop().create_future()

    server.on_request("slow", slow)
    start()
    task = asyncio.ensure_future(client.request("slow"))
    await tick()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await tick()
    assert seen["signal"].aborted
    assert client.pending_count == 0


async def test_timeout_is_a_timeout_not_an_abort_and_tells_the_other_side():
    clock = manual_clock()
    client, server, start = pair({**cancel_request, "clock": clock}, cancel_request)
    cancelled = []

    async def slow(_p, ctx):
        await ctx.signal.wait()
        cancelled.append(True)
        raise ctx.signal.reason

    server.on_request("slow", slow)
    start()
    result = asyncio.ensure_future(client.request("slow", {}, timeout_ms=5000))
    await tick()
    clock.advance(4999)
    assert client.pending_count == 1
    clock.advance(1)
    with pytest.raises(LocalError) as info:
        await result
    assert info.value.kind == "timeout"
    await tick()
    assert cancelled == [True]
    assert clock.pending_timers == 0, "no timer left behind"


async def test_closing_fails_pending_requests_with_closed_and_aborts_running_handlers():
    client, server, start = pair()
    aborted = []

    async def slow(_p, ctx):
        await ctx.signal.wait()
        aborted.append(True)
        await asyncio.get_running_loop().create_future()

    server.on_request("slow", slow)
    start()
    result = asyncio.ensure_future(client.request("slow"))
    await tick()
    await server.close()
    with pytest.raises(LocalError) as info:
        await result
    assert info.value.kind == "closed"
    await tick()
    assert aborted == [True]
    assert (await client.closed).reason == "remote-ended"


async def test_a_late_answer_is_reported_never_delivered():
    diagnostics: list[PeerDiagnostic] = []
    end = Raw()
    peer = RpcPeer(end.channel, on_diagnostic=diagnostics.append).start()
    controller = AbortController()
    result = asyncio.ensure_future(peer.request("x", {}, signal=controller.signal))
    await tick()
    controller.abort()
    with pytest.raises(LocalError):
        await result
    await end.send({"jsonrpc": "2.0", "id": 0, "result": "too late"})
    await tick()
    assert [d.kind for d in diagnostics] == ["late-response"]


async def test_ids_are_matched_by_value_and_type():
    end = Raw()
    peer = RpcPeer(end.channel).start()
    result = asyncio.ensure_future(peer.request("x"))
    await tick()
    await end.send({"jsonrpc": "2.0", "id": "0", "result": "wrong"})
    await end.send({"jsonrpc": "2.0", "id": 0, "result": "right"})
    assert await result == "right"


async def test_remote_errors_keep_their_code_and_data():
    client, server, start = pair()

    def find(_p, _ctx):
        raise RpcError.not_found("no such session", {"sessionId": "s1"})

    server.on_request("find", find)
    start()
    with pytest.raises(RpcError) as info:
        await client.request("find")
    assert info.value.code == ErrorCode.RESOURCE_NOT_FOUND
    assert info.value.data == {"sessionId": "s1"}


async def test_unknown_methods_and_raised_errors():
    client, server, start = pair()

    def boom(_p, _ctx):
        raise ValueError("kaput")

    server.on_request("boom", boom)
    start()
    with pytest.raises(RpcError) as info:
        await client.request("nope")
    assert info.value.code == ErrorCode.METHOD_NOT_FOUND
    with pytest.raises(RpcError) as info:
        await client.request("boom")
    assert info.value.code == ErrorCode.INTERNAL_ERROR and info.value.message == "kaput"


async def test_a_handler_waiting_on_a_call_back_does_not_block_other_messages():
    client, server, start = pair()
    released = asyncio.Event()

    async def ask(_p, _ctx):
        await released.wait()
        return "answer"

    client.on_request("ask", ask)

    async def work(_p, ctx):
        return await ctx.peer.request("ask")

    server.on_request("work", work)
    server.on_request("ping", lambda _p, _c: "pong")
    start()
    pending = asyncio.ensure_future(client.request("work"))
    assert await client.request("ping") == "pong"
    released.set()
    assert await pending == "answer"


async def test_notifications_are_handled_in_arrival_order():
    client, server, start = pair()
    seen: list[int] = []
    server.on_notification("n", lambda p, _c: seen.append(p["i"]))
    start()
    for i in range(50):
        asyncio.ensure_future(client.notify("n", {"i": i}))
    try:
        await client.request("*missing*")
    except RpcError:
        pass
    assert seen == list(range(50))


async def test_async_notification_handlers_start_in_arrival_order():
    client, server, start = pair()
    seen: list[int] = []

    async def handler(p, _c):
        seen.append(p["i"])
        await asyncio.sleep(0)

    server.on_notification("n", handler)
    start()
    for i in range(20):
        await client.notify("n", {"i": i})
    await tick(10)
    assert seen == list(range(20))


async def test_malformed_messages():
    diagnostics: list[PeerDiagnostic] = []
    end = Raw()
    RpcPeer(end.channel, on_diagnostic=diagnostics.append).start()
    await end.send({"jsonrpc": "2.0", "id": 7})  # neither method nor result
    await end.send("banner text")
    await end.send({"jsonrpc": "2.0", "id": {"no": "objects"}, "method": "x"})
    await end.send({"jsonrpc": "2.0", "id": None, "method": "x"})  # valid JSON-RPC: answered, not rejected
    await tick(10)
    assert [(m["id"], m["error"]["code"]) for m in end.sent] == [
        (7, ErrorCode.INVALID_REQUEST),
        (None, ErrorCode.INVALID_REQUEST),
        (None, ErrorCode.METHOD_NOT_FOUND),
    ]
    assert [d.kind for d in diagnostics] == ["invalid-message", "invalid-message"]


async def test_middleware_wraps_both_directions():
    log: list[str] = []

    async def out(call, nxt):
        log.append(f"out {call.method}")
        return await nxt({**call.params, "stamped": True})

    async def inbound(call, nxt, _ctx):
        log.append(f"in {call.method}")
        return await nxt()

    client, server, start = pair({"outbound": [out]}, {"inbound": [inbound]})
    server.on_request("echo", lambda p, _c: p)
    start()
    assert await client.request("echo", {"a": 1}) == {"a": 1, "stamped": True}
    assert log == ["out echo", "in echo"]


async def test_a_request_on_a_closed_peer_fails_at_once():
    client, _server, start = pair()
    start()
    await client.close()
    with pytest.raises(LocalError) as info:
        await client.request("x")
    assert info.value.kind == "closed"


async def test_send_raw_writes_a_message_as_given():
    end = Raw()
    peer = RpcPeer(end.channel).start()
    await peer.send_raw({"id": "never-received", "result": 42})
    await tick()
    assert end.sent == [{"jsonrpc": "2.0", "id": "never-received", "result": 42}]
    assert peer.pending_count == 0


async def test_writes_keep_their_order():
    end = Raw()
    peer = RpcPeer(end.channel).start()
    for i in range(20):
        asyncio.ensure_future(peer.notify("n", {"i": i}))
    await tick(10)
    assert [m["params"]["i"] for m in end.sent] == list(range(20))


async def test_notify_without_params_omits_params():
    end = Raw()
    peer = RpcPeer(end.channel).start()
    await peer.notify("ping")
    await tick()
    assert end.sent == [{"jsonrpc": "2.0", "method": "ping"}]


async def test_a_cancel_id_extractor_that_raises_is_reported_and_the_connection_stays_open():
    diagnostics: list[PeerDiagnostic] = []
    end = Raw()
    peer = RpcPeer(
        end.channel,
        cancel_inbound=CancelInbound("cancel", lambda params: params["requestId"]),
        on_diagnostic=diagnostics.append,
    )
    peer.on_request("ping", lambda _p, _c: "pong").start()
    await end.send({"jsonrpc": "2.0", "method": "cancel"})
    await end.send({"jsonrpc": "2.0", "id": 1, "method": "ping"})
    await tick(10)
    assert not peer.is_closed
    assert [d.kind for d in diagnostics] == ["invalid-message"]
    assert end.sent == [{"jsonrpc": "2.0", "id": 1, "result": "pong"}]


async def test_start_after_close_does_nothing():
    end = Raw()
    peer = RpcPeer(end.channel)
    handled: list[bool] = []
    peer.on_notification("hello", lambda _p, _c: handled.append(True))
    await peer.close()
    await end.send({"jsonrpc": "2.0", "method": "hello"})
    peer.start()
    await tick(10)
    assert handled == []


async def test_a_base_exception_in_a_handler_is_not_turned_into_a_reply():
    # Like SystemExit or KeyboardInterrupt: not an error to answer, so it propagates.
    class Stop(BaseException):
        pass

    end = Raw()
    peer = RpcPeer(end.channel)

    def stop(_p, _c):
        raise Stop

    peer.on_request("stop", stop)
    peer.start()
    await end.send({"jsonrpc": "2.0", "id": 1, "method": "stop"})
    await tick(10)
    assert end.sent == []
    for task in list(peer._tasks):
        task.cancel()


def byte_pair(b: dict[str, Any] | None = None):
    """Two peers talking NDJSON over bytes, as over stdio."""
    left, right = channel_pair()
    client = RpcPeer(ndjson(left), name="client")
    server = RpcPeer(ndjson(right), **{"name": "server", **(b or {})})

    def start() -> None:
        client.start()
        server.start()

    return client, server, start


async def test_a_request_that_cannot_be_encoded_fails_with_send_failed():
    client, server, start = byte_pair()
    server.on_request("echo", lambda p, _c: p)
    start()
    cycle: dict[str, Any] = {}
    cycle["self"] = cycle
    for params in ({"t": datetime.datetime.now()}, cycle):
        with pytest.raises(LocalError) as info:
            await asyncio.wait_for(client.request("echo", params), 1)
        assert info.value.kind == "send-failed"
    with pytest.raises(ValueError):
        await asyncio.wait_for(client.notify("echo", {"t": datetime.datetime.now()}), 1)
    assert client.pending_count == 0
    assert await client.request("echo", {"ok": True}) == {"ok": True}


async def test_a_result_that_cannot_be_encoded_is_answered_with_internal_error():
    diagnostics: list[PeerDiagnostic] = []
    client, server, start = byte_pair({"on_diagnostic": diagnostics.append})
    server.on_request("dt", lambda _p, _c: {"t": datetime.datetime.now()})

    def bad_error(_p, _c):
        raise RpcError(ErrorCode.INVALID_PARAMS, "bad", {"t": datetime.datetime.now()})

    server.on_request("bad-error", bad_error)
    start()
    for method in ("dt", "bad-error"):
        with pytest.raises(RpcError) as info:
            await asyncio.wait_for(client.request(method), 1)
        assert info.value.code == ErrorCode.INTERNAL_ERROR
    assert [d.kind for d in diagnostics] == ["send-failed", "send-failed"]


async def test_a_failed_write_of_an_answer_is_a_send_failure_with_no_second_answer():
    diagnostics: list[PeerDiagnostic] = []
    left, right = channel_pair()
    writes: list[Any] = []

    class Breaks:
        async def receive(self) -> Any:
            return await left.receive()

        async def send(self, item: Any) -> None:
            writes.append(item)
            if "result" in item:
                raise ChannelClosed("pipe broke")
            await left.send(item)

        async def close(self) -> None:
            await left.close()

    peer = RpcPeer(Breaks(), on_diagnostic=diagnostics.append)
    peer.on_request("x", lambda _p, _c: "answer").start()
    await right.send({"jsonrpc": "2.0", "id": 1, "method": "x"})
    await tick(10)
    assert [d.kind for d in diagnostics] == ["send-failed"]
    assert len(writes) == 1


async def test_when_the_other_side_ends_running_handlers_finish_and_their_answers_are_sent():
    end = Raw()
    peer = RpcPeer(end.channel)

    async def x(_p, ctx):
        await tick()
        await ctx.peer.notify("progress", {"done": True})
        return "aborted" if ctx.signal.aborted else "answer"

    peer.on_request("x", x)
    peer.start()
    asked = asyncio.ensure_future(peer.request("ask"))
    await tick()
    await end.send({"jsonrpc": "2.0", "id": 1, "method": "x"})
    await end.end()
    with pytest.raises(LocalError) as info:
        await asked
    assert info.value.kind == "closed"
    assert peer.state == "draining"
    assert not peer.is_closed
    with pytest.raises(LocalError) as info:
        await peer.request("later")
    assert info.value.kind == "closed"
    assert (await asyncio.wait_for(peer.closed, 1)).reason == "remote-ended"
    assert peer.state == "closed"
    await tick()
    assert end.sent[1:] == [
        {"jsonrpc": "2.0", "method": "progress", "params": {"done": True}},
        {"jsonrpc": "2.0", "id": 1, "result": "answer"},
    ]


async def test_handlers_still_running_when_the_drain_time_is_up_are_aborted():
    clock = manual_clock()
    end = Raw()
    peer = RpcPeer(end.channel, clock=clock, drain_timeout_ms=1000)
    seen: dict[str, Any] = {}

    def slow(_p, ctx):
        seen["signal"] = ctx.signal
        return asyncio.get_running_loop().create_future()

    peer.on_request("slow", slow)
    assert peer.state == "idle"
    peer.start()
    assert peer.state == "open"
    await end.send({"jsonrpc": "2.0", "id": 1, "method": "slow"})
    await end.end()
    await tick()
    assert peer.state == "draining"
    clock.advance(999)
    assert not seen["signal"].aborted
    clock.advance(1)
    assert seen["signal"].aborted
    assert (await asyncio.wait_for(peer.closed, 1)).reason == "remote-ended"
    assert clock.pending_timers == 0
    for task in list(peer._tasks):
        task.cancel()


async def test_close_gives_up_on_a_stuck_writer_and_aborts_the_channel():
    left, _right = channel_pair()
    aborted: list[bool] = []

    class Stuck:
        async def receive(self) -> Any:
            return await left.receive()

        async def send(self, item: Any) -> None:
            await asyncio.get_running_loop().create_future()  # a full pipe nobody reads

        async def close(self) -> None:
            pass

        async def abort(self) -> None:
            aborted.append(True)

    peer = RpcPeer(Stuck())
    peer._close_wait_s = 0.05
    peer.start()
    first = asyncio.ensure_future(peer.notify("a"))
    second = asyncio.ensure_future(peer.notify("b"))
    await tick()
    await asyncio.wait_for(peer.close(), 1)
    assert peer._writer_task is not None and peer._writer_task.done()
    assert aborted == [True]
    for write in (first, second):
        with pytest.raises(LocalError):
            await asyncio.wait_for(write, 1)


async def test_with_nothing_running_the_other_side_ending_closes_at_once():
    end = Raw()
    peer = RpcPeer(end.channel).start()
    await end.end()
    assert (await asyncio.wait_for(peer.closed, 1)).reason == "remote-ended"


async def test_writes_behind_a_slow_write_keep_their_order_and_the_writer_stops_when_idle():
    left, right = channel_pair()
    gate = asyncio.Event()
    sent: list[Any] = []

    class Slow:
        async def receive(self) -> Any:
            return await left.receive()

        async def send(self, item: Any) -> None:
            if item.get("params", {}).get("i") == 2:
                await gate.wait()
            sent.append(item["params"]["i"])

        async def close(self) -> None:
            pass

    peer = RpcPeer(Slow()).start()
    writes = [asyncio.ensure_future(peer.notify("n", {"i": i})) for i in range(6)]
    await tick(5)
    assert sent == [0, 1]
    gate.set()
    await asyncio.gather(*writes)
    assert sent == list(range(6))
    # Nothing queued: no writer task waits around.
    assert peer._writer_task is not None and peer._writer_task.done() and not peer._writing
    await peer.notify("n", {"i": 6})
    assert sent[-1] == 6
    await peer.close()
    del right


@pytest.mark.skipif(sys.version_info < (3, 12), reason="eager tasks are 3.12+")
async def test_a_write_to_an_idle_channel_and_a_handler_that_does_not_wait_need_no_trip_through_the_loop():
    end = Raw()
    peer = RpcPeer(end.channel)
    peer.on_request("echo", lambda params, _context: params)
    peer.start()
    # Handed to the channel before _write returns.
    written = peer._write({"jsonrpc": "2.0", "method": "n"})
    assert written.done() and written.exception() is None
    # A request whose handler does not wait is answered within the read that received it.
    await end.send({"jsonrpc": "2.0", "id": 1, "method": "echo", "params": {"x": 1}})
    await tick(3)
    assert {"jsonrpc": "2.0", "id": 1, "result": {"x": 1}} in end.sent
    assert not peer._tasks
    await peer.close()


async def test_nothing_more_is_dispatched_once_a_handler_closes_the_peer():
    # On 3.12+ a handler starts eagerly, inside the read loop: once one closes the peer, the
    # messages already buffered behind it must not be dispatched on the closed connection.
    end = Raw()
    peer = RpcPeer(end.channel)
    seen: list[Any] = []

    async def shutdown(_params, context):
        await context.peer.close()

    peer.on_request("shutdown", shutdown)
    peer.on_request("after", lambda _params, context: seen.append((peer.state, context.signal.aborted)))
    peer.on_notification("note", lambda _params, _context: seen.append("note"))
    await end.send({"jsonrpc": "2.0", "id": 1, "method": "shutdown"})
    await end.send({"jsonrpc": "2.0", "id": 2, "method": "after"})
    await end.send({"jsonrpc": "2.0", "method": "note"})
    peer.start()
    await asyncio.wait_for(peer.closed, 2)
    await tick(5)
    assert seen == []


async def test_a_request_handled_after_the_connection_closed_starts_aborted():
    end = Raw()
    peer = RpcPeer(end.channel)
    seen: list[bool] = []
    peer.on_request("x", lambda _params, context: seen.append(context.signal.aborted))
    peer.start()
    await peer.close()
    peer._handle_request(1, "x", None)  # as the read loop would, had it got that far
    await tick(3)
    assert seen == [True]


class _SlowToCancel:
    """A channel whose receive() (if `reads`) and send() wait until cancelled, and then
    take a while to stop: until `stopping` is cancelled too, or released."""

    def __init__(self, *, reads: bool) -> None:
        self.reads = reads
        self.waiting = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.release = asyncio.Event()

    async def _block(self) -> None:
        self.waiting.set()
        try:
            await asyncio.get_running_loop().create_future()
        except asyncio.CancelledError:
            self.cancelled.set()
            await self.release.wait()  # a second cancel ends this at once
            raise

    async def receive(self) -> Any:
        if self.reads:
            await self._block()
        else:
            await self.release.wait()
        from deft_subspace.kernel import EndOfChannel

        raise EndOfChannel()

    async def send(self, item: Any) -> None:
        await self._block()

    async def close(self) -> None:
        pass


async def test_cancelling_close_while_it_waits_for_the_reader_is_not_swallowed():
    channel = _SlowToCancel(reads=True)
    peer = RpcPeer(channel).start()
    try:
        await channel.waiting.wait()
        closer = asyncio.ensure_future(peer.close())
        await channel.cancelled.wait()  # close() cancelled the reader and waits for it
        closer.cancel()
        await asyncio.wait([closer], timeout=2)
        assert closer.cancelled()
    finally:
        channel.release.set()
        await tick(3)


async def test_cancelling_close_while_it_waits_for_the_writer_is_not_swallowed():
    channel = _SlowToCancel(reads=False)
    peer = RpcPeer(channel)
    peer._close_wait_s = 0.05
    peer.start()
    try:
        peer._write_quiet({"jsonrpc": "2.0", "method": "n"})
        await channel.waiting.wait()
        closer = asyncio.ensure_future(peer.close())
        await asyncio.wait_for(channel.cancelled.wait(), 2)  # past the close wait, close() cancelled the writer
        closer.cancel()
        await asyncio.wait([closer], timeout=2)
        assert closer.cancelled()
    finally:
        channel.release.set()
        await tick(3)
