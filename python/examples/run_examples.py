"""Runs every example that needs no outside agent (each must exit 0 within
30 s). The others are typechecked by pyright, and here only compiled, with
the names they import from deft_subspace checked. Mirrors examples/run-examples.ts.
"""

import ast
import importlib
import subprocess
import sys
from pathlib import Path


def missing_imports(tree: ast.Module) -> list[str]:
    """Names imported from deft_subspace that it does not have. (pyright cannot tell:
    `deft_subspace.acp` has a module `__getattr__`, for `v1` and `v2`.)"""
    missing = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("deft_subspace"):
            module = importlib.import_module(node.module)
            missing += [f"{node.module}.{a.name}" for a in node.names if not hasattr(module, a.name)]
    return missing


here = Path(__file__).resolve().parent
failed = 0
for file in sorted(p for p in here.glob("*.py") if p.name != "run_examples.py"):
    # An example that needs a real agent, or serves stdio, says @typecheck-only in its first lines.
    source = file.read_text(encoding="utf-8")
    if "@typecheck-only" in source[:600]:
        missing = missing_imports(ast.parse(source, file.name))
        if missing:
            failed += 1
            print(f"FAIL  {file.name} (no {', '.join(missing)})")
        else:
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
