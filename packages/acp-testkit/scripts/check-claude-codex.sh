#!/usr/bin/env bash
# Run the agent conformance checks against Claude and Codex, each in its
# ask-first mode (so the permission check runs). Each prompt check costs a
# real model turn, about five per agent.
#
#   packages/acp-testkit/scripts/check-claude-codex.sh            # both agents
#   packages/acp-testkit/scripts/check-claude-codex.sh codex      # one agent
#   packages/acp-testkit/scripts/check-claude-codex.sh --quick    # only the checks with no model turn
#
# Prints each report and saves it to /tmp/deft-check-<agent>.txt.
set -o pipefail

cd "$(dirname "$0")/.." || exit 1

only=""
if [ "$1" = "--quick" ]; then
  only="initialize.version,auth.methods,session.new,config.set-current,session.delete,session.unknown"
  shift
fi
if [ $# -gt 0 ]; then agents=("$@"); else agents=(claude codex); fi

ok=()
failed=()
for agent in "${agents[@]}"; do
  case "$agent" in
    claude) pkg="@agentclientprotocol/claude-agent-acp" mode="default" ;;
    codex) pkg="@agentclientprotocol/codex-acp" mode="read-only" ;;
    *) echo "Unknown agent: $agent (use claude or codex)" >&2; exit 2 ;;
  esac
  echo
  echo "=== $agent (mode $mode)"
  vars=("MODE=$mode")
  [ -n "$only" ] && vars+=("ONLY=$only")
  if env "${vars[@]}" node --conditions=subspace-source scripts/check-agent.ts npx -y "$pkg" 2>&1 | tee "/tmp/deft-check-$agent.txt"; then
    ok+=("$agent")
  else
    failed+=("$agent")
  fi
done

echo
echo "All checks passed: ${ok[*]:-none}"
if [ ${#failed[@]} -gt 0 ]; then echo "Some checks failed: ${failed[*]}"; fi
[ ${#failed[@]} -eq 0 ]
