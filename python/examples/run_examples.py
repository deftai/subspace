"""Runs every example that needs no outside agent (each must exit 0 within
30 s). The others are only compiled here; pyright typechecks them all.
Mirrors examples/run-examples.ts.
"""

import subprocess
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
failed = 0
for file in sorted(p for p in here.glob("*.py") if p.name != "run_examples.py"):
    # An example that needs a real agent, or serves stdio, says @typecheck-only in its first lines.
    source = file.read_text(encoding="utf-8")
    if "@typecheck-only" in source[:600]:
        compile(source, file.name, "exec")
        print(f"skip  {file.name} (typecheck only)")
        continue
    try:
        # -P: the examples folder is not put on sys.path, so a file here never shadows a module.
        run = subprocess.run([sys.executable, "-P", file.name], check=False, cwd=here, capture_output=True, text=True, timeout=30)
        code, output = run.returncode, run.stdout + run.stderr
    except subprocess.TimeoutExpired as error:
        code, output = "timeout", f"{error.stdout or ''}{error.stderr or ''}"
    if code == 0:
        print(f"ok    {file.name}")
    else:
        failed += 1
        print(f"FAIL  {file.name} (exit {code})\n{output}")
sys.exit(1 if failed else 0)
