"""Set the version of every distribution (and their pins on each other) at once.

    python scripts/set_version.py 0.1.0
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ("kernel", "acp", "acp-testkit")


def main(version: str) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?", version):
        sys.exit(f"not a PEP 440 release version: {version}")
    for name in PACKAGES:
        path = ROOT / "packages" / name / "pyproject.toml"
        text = re.sub(r'^version = "[^"]*"', f'version = "{version}"', path.read_text(), count=1, flags=re.MULTILINE)
        for pinned in ("deft-subspace-kernel", "deft-subspace-acp"):
            text = re.sub(rf'"{pinned}==[^"]*"', f'"{pinned}=={version}"', text)
        path.write_text(text)
    print(f"version {version}; now run `uv lock`, and add a '## {version}' section to CHANGELOG.md")


if __name__ == "__main__":
    main(sys.argv[1])
