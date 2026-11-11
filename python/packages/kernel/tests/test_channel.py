import asyncio

import pytest

from deft_subspace.kernel import EndOfChannel, channel_pair


async def test_concurrent_receives_each_get_an_item():
    a, b = channel_pair()
    first = asyncio.ensure_future(b.receive())
    second = asyncio.ensure_future(b.receive())
    await asyncio.sleep(0)
    await a.send(1)
    await a.send(2)
    assert sorted(await asyncio.wait_for(asyncio.gather(first, second), 1)) == [1, 2]


async def test_concurrent_receives_all_see_the_end():
    a, b = channel_pair()
    waiting = [asyncio.ensure_future(b.receive()) for _ in range(3)]
    await asyncio.sleep(0)
    await a.close()
    results = await asyncio.wait_for(asyncio.gather(*waiting, return_exceptions=True), 1)
    assert all(isinstance(r, EndOfChannel) for r in results)


async def test_a_cancelled_receive_does_not_lose_an_item():
    a, b = channel_pair()
    cancelled = asyncio.ensure_future(b.receive())
    await asyncio.sleep(0)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    await a.send("x")
    assert await asyncio.wait_for(b.receive(), 1) == "x"
