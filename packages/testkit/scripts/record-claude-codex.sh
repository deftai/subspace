#!/usr/bin/env bash
# Record the Claude and Codex corpus traces: a plain turn, a cancel
# mid-stream, and a write the reject policy refuses, for each agent.
#
#   packages/testkit/scripts/record-claude-codex.sh                # both agents
#   packages/testkit/scripts/record-claude-codex.sh claude         # one agent
#   packages/testkit/scripts/record-claude-codex.sh --write-only   # only the write traces
#
# Uses your Claude and Codex logins (one short turn each). Writes
# corpus/<agent>-{plain,cancel,write-rejected}.trace.jsonl and commits
# nothing: check the traces for private data before committing them.
set -o pipefail

cd "$(dirname "$0")/.." || exit 1

only=""
if [ "$1" = "--write-only" ]; then
  only=write
  shift
fi
if [ $# -gt 0 ]; then agents=("$@"); else agents=(claude codex); fi

adapter() {
  case "$1" in
    claude) echo "@agentclientprotocol/claude-agent-acp" ;;
    codex) echo "@agentclientprotocol/codex-acp" ;;
    *) return 1 ;;
  esac
}

# The mode in which each agent asks before writing. In its starting mode
# each one writes without asking, so the reject policy never comes into play.
ask_mode() {
  case "$1" in
    claude) echo "default" ;;
    codex) echo "read-only" ;;
  esac
}

plain_prompt="Reply with exactly SUBSPACE_OK and nothing else. Do not use any tools."
write_prompt="Create a file named hello.txt containing hi. Use your file write tool."
count_prompt="Count from 1 to 300, one number per line, no other text. Do not use tools."

ok=()
failed=()

# record <name> <prompt> <cancel-after-ms or empty> <mode or empty> <command> [args...]
record() {
  local name=$1 prompt=$2 cancel=$3 mode=$4
  shift 4
  echo
  echo "=== $name"
  local vars=("PROMPT=$prompt")
  [ -n "$cancel" ] && vars+=("CANCEL_AFTER_MS=$cancel")
  [ -n "$mode" ] && vars+=("MODE=$mode")
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
  if [ "$only" != "write" ]; then
    record "$agent-plain" "$plain_prompt" "" "" npx -y "$pkg"
    record "$agent-cancel" "$count_prompt" 300 "" npx -y "$pkg"
  fi
  record "$agent-write-rejected" "$write_prompt" "" "$(ask_mode "$agent")" npx -y "$pkg"
done

echo
echo "Recorded: ${ok[*]:-none}"
if [ ${#failed[@]} -gt 0 ]; then echo "Failed:   ${failed[*]}"; fi
echo "Traces are in $(pwd)/corpus. Nothing was committed."
[ ${#failed[@]} -eq 0 ]
