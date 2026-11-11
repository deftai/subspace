"""Prompt content from files.

    await agent.run(["Review this change", file("src/parse.py"), image("screenshot.png")])

`file()` embeds a text file; an agent that cannot take embedded files gets
it as text instead (its path, then its contents). `image()` needs an agent
that takes images (`client.supports.prompt.image`).
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

from .model import ContentBlock

TEXT_TYPES: dict[str, str] = {
    ".md": "text/markdown",
    ".json": "application/json",
    ".ts": "text/x-typescript",
    ".tsx": "text/x-typescript",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".py": "text/x-python",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".html": "text/html",
    ".css": "text/css",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/x-toml",
}
IMAGE_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def file(path: str | os.PathLike[str], *, mime_type: str | None = None) -> ContentBlock:
    """A text file as prompt content."""
    full = os.path.abspath(path)
    # As read, without newline translation; bytes that are not UTF-8 become U+FFFD.
    with open(full, encoding="utf-8", errors="replace", newline="") as f:
        text = f.read()
    return {
        "type": "resource",
        "resource": {
            "uri": Path(full).as_uri(),
            "mimeType": mime_type or TEXT_TYPES.get(os.path.splitext(full)[1].lower(), "text/plain"),
            "text": text,
        },
    }


def image(path: str | os.PathLike[str], *, mime_type: str | None = None) -> ContentBlock:
    """An image file as prompt content."""
    full = os.path.abspath(path)
    kind = mime_type or IMAGE_TYPES.get(os.path.splitext(full)[1].lower())
    if not kind:
        raise ValueError(f"{os.fspath(path)}: not a known image type (pass mime_type=)")
    return {"type": "image", "mimeType": kind, "data": base64.b64encode(Path(full).read_bytes()).decode("ascii")}
