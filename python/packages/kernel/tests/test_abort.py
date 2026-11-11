"""AbortSignal.any: following several signals, and letting go of them."""

from __future__ import annotations

from deft_subspace.kernel import AbortController, AbortSignal


def test_any_fires_with_the_first_reason_and_lets_go_of_the_sources() -> None:
    a, b = AbortController(), AbortController()
    combined = AbortSignal.any([a.signal, None, b.signal])
    b.abort("b first")
    assert combined.aborted and combined.reason == "b first"
    assert a.signal._listeners == [] and b.signal._listeners == []


def test_any_dispose_removes_its_listeners_from_the_sources() -> None:
    long_lived = AbortController()
    combined = AbortSignal()
    for _ in range(100):
        combined = AbortSignal.any([AbortController().signal, long_lived.signal])
        combined.dispose()
    assert long_lived.signal._listeners == []
    # Disposed: it no longer follows its sources.
    long_lived.abort("late")
    assert not combined.aborted
    combined.dispose()  # twice is fine


def test_any_as_a_context_manager_disposes_on_exit() -> None:
    long_lived = AbortController()
    with AbortSignal.any([long_lived.signal]) as combined:
        assert len(long_lived.signal._listeners) == 1
        assert not combined.aborted
    assert long_lived.signal._listeners == []


def test_dispose_on_a_plain_or_fired_signal_is_a_no_op() -> None:
    controller = AbortController()
    controller.signal.dispose()
    controller.abort("x")
    assert controller.signal.aborted
    fired = AbortSignal.any([AbortSignal.abort("already")])
    fired.dispose()
    assert fired.reason == "already"
