"""A tiny MCP server over stdio (NDJSON JSON-RPC), for the connector tests."""

import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    method, request_id = message.get("method"), message.get("id")
    if request_id is None:
        continue
    if method == "initialize":
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "tiny", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "add", "description": "Add two numbers", "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]}}]}
    elif method == "tools/call":
        token = (message.get("params", {}).get("_meta") or {}).get("progressToken")
        if token is not None:
            print(json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": token, "progress": 1}}), flush=True)
        args = message["params"]["arguments"]
        result = {"content": [{"type": "text", "text": str(args["a"] + args["b"])}], "isError": False}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"No method {method}"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}), flush=True)
