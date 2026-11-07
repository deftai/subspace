#!/usr/bin/env bash
# Record the Claude and Codex corpus traces: a plain turn, a write the
# reject policy refuses, and a cancel mid-stream, for each agent.
#
#   packages/testkit/scripts/record-claude-codex.sh           # both agents
#   packages/testkit/scripts/record-claude-codex.sh claude    # one agent
#
# Uses your Claude and Codex logins (one short turn each). Writes
# corpus/<agent>-{plain,write-rejected,cancel}.trace.jsonl and commits
# nothing: check the traces for private data before committing them.
set -o pipefail

cd "$(dirname "$0")/.." || exit 1

if [ $# -gt 0 ]; then agents=("$@"); else agents=(claude codex); fi

adapter() {
  case "$1" in
    claude) echo "@agentclientprotocol/claude-agent-acp" ;;
    codex) echo "@agentclientprotocol/codex-acp" ;;
    *) return 1 ;;
  esac
}

plain_prompt="Reply with exactly SUBSPACE_OK and nothing else. Do not use any tools."
write_prompt="Create a file named hello.txt containing hi. Use your file write tool."
count_prompt="Count from 1 to 300, one number per line, no other text. Do not use tools."

ok=()
failed=()

# record <name> <prompt> <cancel-after-ms or empty> <command> [args...]
record() {
  local name=$1 prompt=$2 cancel=$3
  shift 3
  echo
  echo "=== $name"
  local vars=("PROMPT=$prompt")
  [ -n "$cancel" ] && vars+=("CANCEL_AFTER_MS=$cancel")
  if env "${vars[@]}" node --conditions=source scripts/record.ts "$name" "$@"; then
    ok+=("$name")
  else
    failed+=("$name")
  fi
}

for agent in "${agents[@]}"; do
  if ! pkg=$(adapter "$agent"); then
    echo "Unknown agent: $agent (use claude or codex)" >&2
    exit 2
  fi
  record "$agent-plain" "$plain_prompt" "" npx -y "$pkg"
  record "$agent-write-rejected" "$write_prompt" "" npx -y "$pkg"
  record "$agent-cancel" "$count_prompt" 300 npx -y "$pkg"
done

echo
echo "Recorded: ${ok[*]:-none}"
if [ ${#failed[@]} -gt 0 ]; then echo "Failed:   ${failed[*]}"; fi
echo "Traces are in $(pwd)/corpus. Nothing was committed."
[ ${#failed[@]} -eq 0 ]
