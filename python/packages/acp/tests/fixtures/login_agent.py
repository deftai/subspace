"""A stdio agent (plain JSON-RPC, v1) for start(): needs a login before
session/new, offers modes "auto" and "ask", asks permission, then replies.

NO_LOGIN_METHODS=1: needs a login but offers no method (start() cannot log in for you).
"""

import json
import os
import sys

logged_in = False
modes: dict[str, str] = {}
next_id = 0


def send(message: dict) -> None:
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
    sys.stdout.flush()


def read() -> dict | None:
    while True:
        line = sys.stdin.readline()
        if not line:
            return None
        if line.strip():
            return json.loads(line)


def request(method: str, params: dict) -> dict:
    """Send a request and wait for its answer (this agent does one thing at a time)."""
    global next_id
    next_id += 1
    my_id = f"agent-{next_id}"
    send({"id": my_id, "method": method, "params": params})
    while True:
        message = read()
        if message is None:
            sys.exit(0)
        if message.get("id") == my_id and "method" not in message:
            return message.get("result") or {}


def handle(method: str, params: dict) -> dict:
    global logged_in
    if method == "initialize":
        return {
            "protocolVersion": 1,
            "agentCapabilities": {},
            "agentInfo": {"name": "login-agent", "version": "1.0.0"},
            "authMethods": [] if os.environ.get("NO_LOGIN_METHODS") else [{"id": "browser", "name": "Log in with a browser"}],
        }
    if method == "authenticate":
        logged_in = True
        return {}
    if method == "session/new":
        if not logged_in:
            raise PermissionError
        session_id = f"s{len(modes) + 1}"
        modes[session_id] = "auto"
        return {
            "sessionId": session_id,
            "modes": {"currentModeId": "auto", "availableModes": [{"id": "auto", "name": "Auto"}, {"id": "ask", "name": "Ask first"}]},
        }
    if method == "session/set_mode":
        modes[params["sessionId"]] = params["modeId"]
        return {}
    if method == "session/prompt":
        answer = request(
            "session/request_permission",
            {
                "sessionId": params["sessionId"],
                "toolCall": {"toolCallId": "t1", "title": "Write notes.md", "kind": "edit"},
                "options": [
                    {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "no", "name": "Reject", "kind": "reject_once"},
                ],
            },
        )
        outcome = answer.get("outcome") or {}
        allowed = "true" if outcome.get("outcome") == "selected" and outcome.get("optionId") == "yes" else "false"
        text = f"mode={modes[params['sessionId']]} allowed={allowed}"
        send(
            {
                "method": "session/update",
                "params": {"sessionId": params["sessionId"], "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}},
            }
        )
        return {"stopReason": "end_turn"}
    raise LookupError(method)


while True:
    message = read()
    if message is None:
        break
    if "method" not in message or "id" not in message:
        continue  # notifications (cancel) and stray answers
    try:
        send({"id": message["id"], "result": handle(message["method"], message.get("params") or {})})
    except PermissionError:
        send({"id": message["id"], "error": {"code": -32000, "message": "Authentication required"}})
    except LookupError:
        send({"id": message["id"], "error": {"code": -32601, "message": f"Method not found: {message['method']}"}})
