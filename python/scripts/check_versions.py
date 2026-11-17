"""Release checks: every distribution shares one version, each pins the ones it depends on to it,
and (with --tag) the tag and changelog match.

    python scripts/check_versions.py                  # in CI
    python scripts/check_versions.py --tag python-v0.1.0   # before a release
"""

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
#: Each distribution's folder, and the distributions it must pin to the same version.
PINS = {"kernel": [], "acp": ["deft-subspace-kernel"], "acp-testkit": ["deft-subspace-kernel", "deft-subspace-acp"]}


def project(name: str) -> dict:
    return tomllib.loads((ROOT / "packages" / name / "pyproject.toml").read_text())["project"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", help="the release tag, python-v<version>")
    args = parser.parse_args()
    projects = {name: project(name) for name in PINS}
    problems: list[str] = []
    version = projects["acp"]["version"]
    for name, data in projects.items():
        if data["version"] != version:
            problems.append(f"versions differ: acp {version}, {name} {data['version']}")
    for name, pinned in PINS.items():
        dependencies = projects[name]["dependencies"]
        for dependency in pinned:
            pin = f"{dependency}=={version}"
            if pin not in dependencies:
                found = [d for d in dependencies if re.match(rf"{re.escape(dependency)}\b(?!-)", d)]
                problems.append(f"{name} must depend on {pin} (has {found})")
    if args.tag is not None:
        if args.tag != f"python-v{version}":
            problems.append(f"tag {args.tag} does not match version {version} (expected python-v{version})")
        changelog = (ROOT / "CHANGELOG.md").read_text()
        if not re.search(rf"^## {re.escape(version)}\b", changelog, re.MULTILINE):
            problems.append(f"CHANGELOG.md has no '## {version}' section")
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if not problems:
        print(f"ok: {version}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
