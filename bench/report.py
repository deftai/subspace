"""Turn results.json from run.py into Markdown tables.

    python report.py results.json [more.json ...] > RESULTS.md
"""

import json
import sys

LIBS = ["subspace-ts", "official-ts", "subspace-py", "official-py"]
NAMES = {"subspace-ts": "Subspace TS", "official-ts": "Official TS", "subspace-py": "Subspace Py", "official-py": "Official Py"}

# scenario: (title, what a cell shows, function of a result)
METRICS = {
    "startup": ("Startup: spawn the agent, initialize, session/new, one turn", "ms from the client's first line, lower is better", lambda r: r["startupMs"]),
    "startup-wall": ("Startup including the client's own start and close", "ms for the whole client process, lower is better", lambda r: r["wallMs"]),
    "turns": ("Sequential turns (prompt → end_turn, no updates)", "turns/s, higher is better", lambda r: r["ops"] / r["ms"] * 1000),
    "stream": ("Streaming: 20,000 message chunks of 100 characters in one turn", "chunks/s, higher is better", lambda r: r["ops"] / r["ms"] * 1000),
    "large": ("Large chunks: 50 chunks of 1,000,000 characters in one turn", "MB/s, higher is better", lambda r: r["bytes"] / r["ms"] / 1000),
    "ask": ("Permission requests: 1,000 asked one after another in one turn", "requests/s, higher is better", lambda r: r["ops"] / r["ms"] * 1000),
    "concurrent": ("Concurrent sessions: 20 sessions × 100 turns at once", "turns/s, higher is better", lambda r: r["ops"] / r["ms"] * 1000),
}


def fmt(value: float) -> str:
    if value >= 100:
        return f"{value:,.0f}"
    if value >= 10:
        return f"{value:.1f}"
    return f"{value:.2f}"


def mb(value: float | None) -> str:
    return "–" if value is None else f"{value / 1e6:.0f}"


def cell(results: list[dict], scenario: str, client: str, agent: str) -> dict | None:
    scenario = "startup" if scenario == "startup-wall" else scenario
    return next((r for r in results if r["scenario"] == scenario and r["client"] == client and r["agent"] == agent), None)


def table(results: list[dict], scenario: str) -> list[str]:
    title, unit, metric = METRICS[scenario]
    base = "startup" if scenario == "startup-wall" else scenario
    present = {r["client"] for r in results if r["scenario"] == base} | {r["agent"] for r in results if r["scenario"] == base}
    libs = [lib for lib in LIBS if lib in present]
    lines = [f"### {title}", "", f"Rows: client. Columns: agent. Cells: {unit}.", ""]
    lines.append("| client ↓ / agent → | " + " | ".join(NAMES[a] for a in libs) + " |")
    lines.append("| --- |" + " ---: |" * len(libs))
    for client in libs:
        row = []
        for agent in libs:
            r = cell(results, scenario, client, agent)
            if r is None:
                row.append("")
            elif "error" in r:
                row.append("error")
            else:
                text = fmt(metric(r))
                row.append(f"**{text}**" if client == agent else text)
        lines.append(f"| {NAMES[client]} | " + " | ".join(row) + " |")
    if scenario == "turns":
        lines += ["", "Latency per turn, same-library pairs (ms): " + "; ".join(
            f"{NAMES[l]} p50 {cell(results, 'turns', l, l)['p50']:.3f}, p99 {cell(results, 'turns', l, l)['p99']:.3f}"
            for l in libs if cell(results, "turns", l, l) and "error" not in cell(results, "turns", l, l)
        )]
    return lines + [""]


def memory(results: list[dict], scenario: str) -> list[str]:
    lines = [f"### Peak memory in the {scenario} scenario (MB RSS)", "", "Same-library pairs; the client and the agent are separate processes.", ""]
    lines += ["| library | client | agent |", "| --- | ---: | ---: |"]
    for lib in LIBS:
        r = cell(results, scenario, lib, lib)
        if r and "error" not in r:
            lines.append(f"| {NAMES[lib]} | {mb(r.get('clientRss'))} | {mb(r.get('agentRss'))} |")
    return lines + [""]


def main() -> None:
    for path in sys.argv[1:]:
        data = json.load(open(path))
        meta, results = data["meta"], data["results"]
        print(f"## Protocol v{meta.get('protocol', 1)}: {meta['date']}, {meta['machine']}, Node {meta['node']}, Python {meta['python']}")
        print()
        print(f"Median of {meta['repeat']} runs per cell (5 for startup). The same-library pairs are in bold.")
        print()
        for scenario in METRICS:
            if any(r["scenario"] == ("startup" if scenario == "startup-wall" else scenario) for r in results):
                print("\n".join(table(results, scenario)))
        for scenario in ("stream", "large"):
            if any(r["scenario"] == scenario for r in results):
                print("\n".join(memory(results, scenario)))


if __name__ == "__main__":
    main()
