# Changelog

## Unreleased

- `serve_agent`: with `queue_prompts` on v2, a turn's idle state (and its failed tool calls) now goes out before the next queued turn starts.
- `serve_agent`: a prompt handler that raises now fails the tool calls it left open and stops the terminals it did not detach, as a cancelled turn already did.
- `serve_agent`: a prompt handler that ends with `asyncio.CancelledError` after the turn was cancelled (e.g. it cancelled its own task when `turn.signal` fired) now ends the turn `cancelled`: v1 answers `stopReason: "cancelled"` instead of a -32800 error, and v2 sends its idle state.
