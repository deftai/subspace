"""Run the benchmark matrix: every client against every agent, every scenario.

    python run.py [--python PY] [--repeat N] [--quick] [--only CLIENT/AGENT ...] [--out results.json]

Each run spawns the agent fresh, over stdio, with ACP v1. The result of a cell is
the median of its repeats. Agents write their peak RSS to BENCH_RSS_FILE on exit.
"""

import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

LIBS = {
    "subspace-ts": "Subspace (TS)",
    "official-ts": "Official SDK (TS)",
    "subspace-py": "Subspace (Python)",
    "official-py": "Official SDK (Python)",
}

# scenario: (n, size). Quick sizes are for checking that everything runs.
SCENARIOS = {
    "startup": ((1, 0), (1, 0)),
    "turns": ((2000, 0), (50, 0)),
    "stream": ((20000, 100), (500, 100)),
    "large": ((50, 1_000_000), (5, 100_000)),
    "ask": ((1000, 0), (20, 0)),
    "concurrent": ((20, 100), (4, 10)),
}


def command(lib: str, role: str, python: str) -> list[str]:
    kind, lang = lib.split("-")
    path = str(HERE / role / f"{kind}.{lang}")
    return ["node", path] if lang == "ts" else [python, path]


def one(client: str, agent: str, scenario: str, n: int, size: int, python: str, timeout: float) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        rss_file = os.path.join(tmp, "rss")
        env = {**os.environ, "BENCH_RSS_FILE": rss_file}
        name = "stream" if scenario == "large" else scenario
        argv = [*command(client, "clients", python), name, str(n), str(size), "--", *command(agent, "agents", python)]
        cwd = HERE / "clients"
        started = time.perf_counter()
        done = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        wall = (time.perf_counter() - started) * 1000
        if done.returncode != 0:
            raise RuntimeError(f"exit {done.returncode}: {done.stderr.strip()[-800:]}")
        result = json.loads(done.stdout.strip().splitlines()[-1])
        result["wallMs"] = wall
        try:
            result["agentRss"] = int(Path(rss_file).read_text())
        except (OSError, ValueError):
            result["agentRss"] = None
        return result


def median_of(runs: list[dict]) -> dict:
    out = dict(runs[0])
    for key, value in runs[0].items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values = [r[key] for r in runs if isinstance(r.get(key), (int, float))]
            out[key] = statistics.median(values)
    out["repeats"] = len(runs)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--quick", action="store_true", help="tiny sizes, one repeat: check that every pair runs")
    parser.add_argument("--only", nargs="*", help="client/agent pairs, e.g. subspace-ts/official-py")
    parser.add_argument("--scenarios", nargs="*", default=list(SCENARIOS))
    parser.add_argument("--out", default=str(HERE / "results.json"))
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--protocol", type=int, choices=(1, 2), default=1, help="2: only the Subspace pairs can run it")
    args = parser.parse_args()
    repeat = 1 if args.quick else args.repeat
    pairs = [tuple(p.split("/")) for p in args.only] if args.only else [(c, a) for c in LIBS for a in LIBS]
    if args.protocol == 2:
        pairs = [(c, a) for c, a in pairs if c.startswith("subspace") and a.startswith("subspace")]
    os.environ["BENCH_PROTOCOL"] = str(args.protocol)

    node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    py = subprocess.run([args.python, "-c", "import sys; print(sys.version.split()[0])"], capture_output=True, text=True).stdout.strip()
    meta = {
        "date": time.strftime("%Y-%m-%d"),
        "machine": f"{platform.system()} {platform.release()} {platform.machine()}",
        "cpu": platform.processor() or platform.machine(),
        "node": node,
        "python": py,
        "repeat": repeat,
        "protocol": args.protocol,
        "quick": args.quick,
        "sizes": {s: SCENARIOS[s][1 if args.quick else 0] for s in args.scenarios},
    }
    results = []
    for scenario in args.scenarios:
        n, size = SCENARIOS[scenario][1 if args.quick else 0]
        for client, agent in pairs:
            runs, error = [], None
            for _ in range(repeat if scenario != "startup" else max(repeat, 5)):
                try:
                    runs.append(one(client, agent, scenario, n, size, args.python, args.timeout))
                except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError, IndexError) as e:
                    error = str(e)
                    break
            cell = {"scenario": scenario, "client": client, "agent": agent, "n": n, "size": size}
            cell.update(median_of(runs) if runs and not error else {"error": error})
            cell["scenario"] = scenario  # the client reports "stream" for "large"
            results.append(cell)
            shown = f"{cell.get('ms', cell.get('startupMs', 0)):.1f} ms" if "error" not in cell else "ERROR " + cell["error"][:200]
            print(f"{scenario:10} {client:12} -> {agent:12} {shown}", flush=True)
    Path(args.out).write_text(json.dumps({"meta": meta, "results": results}, indent=2) + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
