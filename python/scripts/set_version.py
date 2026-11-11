"""Set the version of both distributions (and acp's kernel pin) at once.

    python scripts/set_version.py 0.1.0
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(version: str) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?", version):
        sys.exit(f"not a PEP 440 release version: {version}")
    for name in ("kernel", "acp"):
        path = ROOT / "packages" / name / "pyproject.toml"
        text = re.sub(r'^version = "[^"]*"', f'version = "{version}"', path.read_text(), count=1, flags=re.M)
        text = re.sub(r'"deft-subspace-kernel==[^"]*"', f'"deft-subspace-kernel=={version}"', text)
        path.write_text(text)
    print(f"version {version}; now run `uv lock`, and add a '## {version}' section to CHANGELOG.md")


if __name__ == "__main__":
    main(sys.argv[1])
