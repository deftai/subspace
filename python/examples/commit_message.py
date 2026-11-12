"""Recipe: write a commit message for the staged change.
No event loop: the blocking `run()` from `deft_subspace.acp.sync`.
@typecheck-only (starts Codex's ACP adapter through npx)
"""

import subprocess

from deft_subspace.acp.sync import run

diff = subprocess.run(["git", "diff", "--staged"], capture_output=True, text=True, check=True).stdout
if not diff.strip():
    raise SystemExit("Nothing is staged.")
result = run(
    "codex",
    f"Write a commit message for this diff: a subject under 60 characters, a blank line, then why. Only the message.\n\n{diff}",
    permissions="reject",  # it needs nothing but the diff
)
print(result.text.strip())
