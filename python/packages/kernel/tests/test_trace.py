import pytest

from deft_subspace.kernel import RpcPeer, channel_pair, format_trace, parse_trace, trace_tap
from deft_subspace.kernel.testing import manual_clock


async def test_trace_tap_records_every_message_and_round_trips():
    clock = manual_clock(1_700_000_000_000)
    records = []
    tap = trace_tap(records.append, peer="client", label="demo", clock=clock, redact=lambda m, _d: None if "secret" in str(m) else m)
    a, b = channel_pair()
    client = RpcPeer(a, tap=tap).start()
    RpcPeer(b).on_request("echo", lambda p, _c: p).start()
    clock.advance(5)
    assert await client.request("echo", {"n": 1}) == {"n": 1}
    await client.notify("secret", {})
    tap.note("done", {"ok": True})
    await client.close()
    assert [[r["kind"], r["dir"], r["t"]] if r["kind"] == "message" else [r["kind"]] for r in records] == [
        ["header"],
        ["message", "out", 5],
        ["message", "in", 5],
        ["note"],
    ]
    assert records[0]["started"] == "2023-11-14T22:13:20.000Z"
    assert parse_trace(format_trace(records)) == records


def test_a_note_keeps_explicit_none_data_and_leaves_out_missing_data():
    records = []
    tap = trace_tap(records.append, peer="client", clock=manual_clock())
    tap.note("none", None)
    tap.note("missing")
    assert records[1] == {"v": 1, "kind": "note", "t": 0, "text": "none", "data": None}
    assert records[2] == {"v": 1, "kind": "note", "t": 0, "text": "missing"}


def test_parse_trace_names_a_bad_line_and_requires_a_header():
    with pytest.raises(ValueError, match="line 2 is not JSON"):
        parse_trace('{"v":1,"kind":"header","started":"x","peer":"c"}\nnope\n')
    with pytest.raises(ValueError, match="starts with a header"):
        parse_trace('{"v":1,"kind":"note","t":0,"text":"x"}\n')
    with pytest.raises(ValueError, match="line 1 is not a version 1"):
        parse_trace('{"v":9,"kind":"header"}\n')
