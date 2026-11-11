"""Release checks: both distributions share one version, acp pins that kernel, and (with --tag) the tag and changelog match.

    python scripts/check_versions.py                  # in CI
    python scripts/check_versions.py --tag python-v0.1.0   # before a release
"""

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def project(name: str) -> dict:
    return tomllib.loads((ROOT / "packages" / name / "pyproject.toml").read_text())["project"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", help="the release tag, python-v<version>")
    args = parser.parse_args()
    kernel, acp = project("kernel"), project("acp")
    problems: list[str] = []
    if kernel["version"] != acp["version"]:
        problems.append(f"versions differ: kernel {kernel['version']}, acp {acp['version']}")
    version = acp["version"]
    pin = f"deft-subspace-kernel=={version}"
    if pin not in acp["dependencies"]:
        problems.append(f"acp must depend on {pin} (has {[d for d in acp['dependencies'] if d.startswith('deft-subspace-kernel')]})")
    if args.tag is not None:
        if args.tag != f"python-v{version}":
            problems.append(f"tag {args.tag} does not match version {version} (expected python-v{version})")
        changelog = (ROOT / "CHANGELOG.md").read_text()
        if not re.search(rf"^## {re.escape(version)}\b", changelog, re.M):
            problems.append(f"CHANGELOG.md has no '## {version}' section")
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if not problems:
        print(f"ok: {version}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
