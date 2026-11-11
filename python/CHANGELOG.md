# Changelog

## Unreleased

- kernel: `notify()` without params leaves `params` out of the message instead of sending `"params": null`.
- kernel: a handler that raises a `BaseException` that is not an `Exception` (`SystemExit`, `KeyboardInterrupt`) is no longer answered with an internal error; it propagates.
- kernel: the NDJSON decoder skips a UTF-8 byte order mark at the start of the stream.
- kernel: a message that cannot be encoded as JSON (a datetime, a cycle, NaN) no longer vanishes. `NdjsonEncoder.feed()` raises the new `EncodeError` (a `ValueError`) after calling `on_error`; a request fails with `LocalError("send-failed")`, `notify()` raises, and a handler whose answer cannot be encoded replies with an internal error. Later messages still go out.
- kernel: a failed write of an answer is reported as a new `send-failed` diagnostic, not `handler-failed`, and no second answer is attempted.
- kernel: a `cancel_inbound.id` extractor that raises is reported as `invalid-message` instead of closing the connection.
- kernel: `start()` after `close()` does nothing.
- kernel: `MemoryChannel.receive()` may be awaited by several tasks at once; each gets its own item.
