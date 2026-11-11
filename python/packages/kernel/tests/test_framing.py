import datetime
import time
from typing import Any

import pytest

from deft_subspace.kernel import EncodeError, FramingDiagnostic, ndjson_decoder, ndjson_encoder
from deft_subspace.kernel.testing import merge, rechunk


def decode(chunks: list[bytes], fault=None, **options: Any) -> list[Any]:
    if fault is not None:
        chunks = [piece for chunk in chunks for piece in fault.feed(chunk)] + list(fault.flush())
    decoder = ndjson_decoder(**options)
    out: list[Any] = []
    for chunk in chunks:
        out.extend(decoder.feed(chunk))
    out.extend(decoder.flush())
    return out


def test_keeps_a_multibyte_character_split_across_chunks():
    line = '{"text":"héllo 🌍"}\n'.encode()
    split = line.index(0xC3) + 1  # inside é
    assert decode([line[:split], line[split:]]) == [{"text": "héllo 🌍"}]


def test_same_values_byte_by_byte_and_merged():
    data = '{"a":1}\n{"b":"ü"}\r\n\n{"c":[1,2,3]}\n'.encode()
    expected = [{"a": 1}, {"b": "ü"}, {"c": [1, 2, 3]}]
    assert decode([data], rechunk(1)) == expected
    assert decode([data], merge(100)) == expected


def test_skips_and_reports_non_json_lines():
    diagnostics: list[FramingDiagnostic] = []
    out = decode([b"Welcome to Agent v1.2!\n{\"ok\":true}\n[INFO] ready\n"], on_diagnostic=diagnostics.append)
    assert out == [{"ok": True}]
    assert [(d.kind, d.preview) for d in diagnostics] == [
        ("invalid-json", "Welcome to Agent v1.2!"),
        ("invalid-json", "[INFO] ready"),
    ]


def test_skips_an_overlong_line_then_recovers():
    diagnostics: list[FramingDiagnostic] = []
    long = '{"x":"' + "a" * 5000 + '"}'
    out = decode([f'{long}\n{{"after":1}}\n'.encode()], rechunk(64), max_line_length=1000, on_diagnostic=diagnostics.append)
    assert out == [{"after": 1}]
    assert [d.kind for d in diagnostics] == ["too-large"]


def test_accepts_a_last_line_without_newline():
    assert decode([b'{"a":1}\n{"b":2}']) == [{"a": 1}, {"b": 2}]


def test_nan_is_not_json():
    diagnostics: list[FramingDiagnostic] = []
    assert decode([b"NaN\n1\n"], on_diagnostic=diagnostics.append) == [1]
    assert len(diagnostics) == 1


def test_large_lines_cost_linear_time():
    big = ('{"x":"' + "z" * 4_000_000 + '"}\n').encode()
    started = time.perf_counter()
    out = decode([big], rechunk(4096))
    elapsed = time.perf_counter() - started
    assert len(out[0]["x"]) == 4_000_000
    assert elapsed < 3, f"took {elapsed:.2f} s"


def test_a_leading_byte_order_mark_is_skipped():
    diagnostics: list[FramingDiagnostic] = []
    data = '﻿{"a":1}\n{"b":"﻿"}\n'.encode()
    assert decode([data[:2], data[2:]], on_diagnostic=diagnostics.append) == [{"a": 1}, {"b": "﻿"}]
    assert diagnostics == []


def test_encoder_writes_one_line_per_value():
    encoder = ndjson_encoder()
    text = b"".join(b for value in ({"text": "a\nb"}, 0) for b in encoder.feed(value)).decode()
    assert text == '{"text":"a\\nb"}\n0\n'


def test_encoder_raises_for_an_unserializable_value_and_keeps_working():
    errors: list[Any] = []
    cycle: dict[str, Any] = {}
    cycle["self"] = cycle
    encoder = ndjson_encoder(on_error=lambda e, _v: errors.append(e))
    for value in (cycle, {"t": datetime.datetime.now()}, float("nan")):
        with pytest.raises(EncodeError):
            encoder.feed(value)
    assert b"".join(encoder.feed({"b": 2})) == b'{"b":2}\n'
    assert len(errors) == 3
