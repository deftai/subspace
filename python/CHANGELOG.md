# Changelog

## Unreleased

- kernel: `notify()` without params leaves `params` out of the message instead of sending `"params": null`.
- kernel: a handler that raises a `BaseException` that is not an `Exception` (`SystemExit`, `KeyboardInterrupt`) is no longer answered with an internal error; it propagates.
- kernel: the NDJSON decoder skips a UTF-8 byte order mark at the start of the stream.
- kernel: `MemoryChannel.receive()` may be awaited by several tasks at once; each gets its own item.
