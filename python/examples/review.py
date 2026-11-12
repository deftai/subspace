"""Recipe: a code review as data. Ask an agent to review the staged diff and
get typed findings back.
@typecheck-only (starts Claude's ACP adapter through npx)
"""

import asyncio
import subprocess
import sys

from deft_subspace.acp import read_only, start
from pydantic import BaseModel, TypeAdapter


class Finding(BaseModel):
    file: str
    line: int | None = None
    problem: str
    fix: str


diff = subprocess.run(["git", "diff", "--staged"], capture_output=True, text=True, check=True).stdout


async def main() -> int:
    agent = await start("claude", on_permission=read_only)  # it may read the repo, nothing else
    try:
        findings: list[Finding] = await agent.json(
            f"Review this diff for bugs. Ignore style.\n\n```diff\n{diff}\n```",
            schema=TypeAdapter(list[Finding]),
            shape=[{"file": "src/a.py", "line": 12, "problem": "what is wrong", "fix": "what to do"}],
        )
        for f in findings:
            print(f"{f.file}{f':{f.line}' if f.line else ''}  {f.problem}\n    -> {f.fix}")
        return 1 if findings else 0
    finally:
        await agent.close()


sys.exit(asyncio.run(main()))
