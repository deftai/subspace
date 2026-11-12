"""ACP for apps: one model over protocol v1 and v2, turns you can await, cancellation that works,
permissions that fail closed. Both sides: `AcpClient` (and `start()`) for clients, `serve_agent`
(and `serve_stdio()`) for agents.

    from deft_subspace.acp import start

    agent = await start("claude", on_permission=lambda r, _s: "allow" if r.tool_call and r.tool_call.kind == "read" else "reject")
    try:
        await agent.run("What does this repo do?", on_message=lambda delta, info, _e: print(info.separator + delta, end=""))
    finally:
        await agent.close()

Where to start (everything is imported from `deft_subspace.acp`):

- Run an agent: `start()`, `run()`, `StartedAgent`; blocking: `deft_subspace.acp.sync.run()`.
- Client: `AcpClient`, `Session`, `Turn`, `TurnResult`, `TurnHandlers`; events: `TurnEvent`,
  `MessageEvent`, `ToolCallEvent`, `PermissionEvent`.
- Permissions: `allow`, `reject`, `read_only`, `allow_inside`, `first_of`, `PermissionRequest`.
- Agents: `serve_stdio()`, `serve_agent()`, `AgentTurn`, `tool()`, `model_agent()`.
- Agent names: `list_agents()`, `load_catalog()`.
- MCP: `mcp_connector()`, `StdioMcpServer`, `HttpMcpServer`.
- Errors: every exception class is a `deft_subspace.kernel.SubspaceError`.

The official SDK's pydantic schemas are `v1` and `v2` (loaded on first use).
"""

from typing import TYPE_CHECKING, Any

from ._conveniences import (
    JsonAnswerError,
    SessionConveniences,
    conveniences,
    find_json,
)
from ._mcp_connector import (
    mcp_connector,
)
from ._model_agent import (
    ConversationSetup,
    ModelAdapter,
    ModelConversation,
    ModelInput,
    ModelPromptInput,
    ModelReply,
    ModelStream,
    ModelTool,
    ModelToolCall,
    ToolResult,
    ToolResultsInput,
    model_agent,
)
from ._start import (
    AgentCommand,
    StartedAgent,
    agent_by_name,
    run,
    serve_stdio,
    start,
)
from .agent import (
    AgentTurn,
    ElicitAnswer,
    LoadSessionRequest,
    NewSessionRequest,
    PermissionAnswer,
    PermissionDenied,
    ReplayWriter,
    TerminalDisplay,
    TerminalHandle,
    ToolCallHandle,
    serve_agent,
)
from .agents import (
    BUILTIN_AGENTS,
    AgentCatalog,
    AgentDefinition,
    CatalogLayer,
    Quirk,
    ResolvedAgent,
    builtin_catalog,
    list_agents,
    resolve_agent,
)
from .auth import (
    AuthMethod,
)
from .capabilities import (
    AgentSupport,
    CapabilityError,
    ClientSupport,
    agent_support,
    client_support,
)
from .catalog import (
    AgentFileError,
    agent_files,
    load_catalog,
    load_catalog_async,
    load_registry,
    parse_agent_file,
    parse_agent_table,
    refresh_registry,
    registry_cache_path,
)
from .client import (
    AcpClient,
    AgentInfo,
    ElicitationRequest,
    FileHandlers,
    Session,
    SessionInfo,
    SessionSummary,
    TerminalHandlers,
    Timeouts,
    prompt_blocks,
)
from .config import (
    BooleanConfigOption,
    ConfigChoice,
    OtherConfigOption,
    SelectConfigOption,
    config_options_from,
)
from .content import (
    file,
    image,
)
from .elicitation import (
    validate_elicitation,
)
from .endpoint import (
    AgentEndpoint,
    AgentLayer,
    CallContext,
    EndpointCall,
    EndpointClient,
    EndpointContext,
    StateKey,
    agent_endpoint,
    state_key,
)
from .extensions import (
    ExtensionHandler,
    ExtensionNotification,
    ExtensionRequest,
    extension_notification,
    extension_request,
    handle,
)
from .handlers import (
    TextEndInfo,
    TextInfo,
    ToolCallInfo,
    TurnHandlers,
)
from .install import (
    Installed,
    InstallError,
    binaries_path,
    install_agent,
    installed_binaries,
)
from .mcp import (
    MCP_PROTOCOL_VERSION,
    AcpMcpServer,
    HttpMcpServer,
    McpBindingError,
    McpOperationContext,
    McpRegistration,
    SseMcpServer,
    StdioMcpServer,
    mcp_servers_param,
    parse_mcp_servers,
)
from .mcp_caller import (
    McpCaller,
    McpCallOptions,
    McpError,
    McpServerClient,
    server_client,
)
from .mcp_connections import (
    McpConnectContext,
    McpConnection,
    McpConnector,
)
from .model import (
    BackgroundItem,
    ContentBlock,
    ExhaustedEvent,
    Exhaustion,
    MessageEndEvent,
    MessageEvent,
    OtherWork,
    PermissionCommand,
    PermissionEvent,
    PermissionOption,
    PermissionOutcome,
    PermissionRequest,
    PlanEntry,
    PlanEvent,
    ProtocolVersion,
    SessionInfoEvent,
    StateEvent,
    StopReason,
    SubagentWork,
    TerminalEvent,
    TerminalWork,
    ThoughtEndEvent,
    ThoughtEvent,
    ToolCall,
    ToolCallContent,
    ToolCallEvent,
    ToolCallStatus,
    ToolCallWork,
    TurnEnd,
    TurnEvent,
    TurnLimits,
    TurnResult,
    UpdateEvent,
    UsageEvent,
    UserMessageEndEvent,
    UserMessageEvent,
    turn_end,
)
from .modes import (
    SessionMode,
    SessionModes,
    modes_from,
)
from .node import (
    ConnectedAgent,
    WorkspaceFiles,
    WorkspaceTerminals,
    connect_agent,
    inside_workspace,
    workspace_files,
    workspace_terminals,
)
from .open import (
    ConnectedSession,
    OpenedSession,
    connect_session,
    open_session,
)
from .permissions import (
    OptionId,
    PermissionDecision,
    PermissionHandler,
    PermissionPolicy,
    decide,
    resolve_decision,
)
from .policies import (
    READ_KINDS,
    PermissionRule,
    allow,
    allow_inside,
    first_of,
    inside,
    read_only,
    reject,
    request_command,
    request_paths,
)
from .projection import (
    TurnProjection,
)
from .registry import (
    REGISTRY_URL,
    Registry,
    RegistryAgent,
    registry_target,
    trim_registry,
)
from .telemetry import (
    OtelTap,
    otel_tap,
    spans_from_trace,
)
from .terminal_ui import (
    ask_in_terminal,
    terminal,
)
from .terminals import (
    TerminalExit,
    Terminals,
    TerminalSize,
    TerminalState,
    terminal_text,
)
from .tools import (
    ToolContext,
    ToolDefinition,
    ToolSet,
    check_tool_input,
    tool,
    tool_input_schema,
    tool_output_text,
)
from .turn import (
    Turn,
    TurnHistory,
)

if TYPE_CHECKING:
    from acp import schema as v1
    from acp.experimental.v2 import schema as v2


def __getattr__(name: str) -> Any:
    if name in ("v1", "v2"):
        from . import model

        return getattr(model, name)
    raise AttributeError(name)


__all__ = [
    "ConversationSetup",
    "ModelInput",
    "ModelPromptInput",
    "ToolResultsInput",
    "AcpClient",
    "AcpMcpServer",
    "AgentCatalog",
    "AgentCommand",
    "AgentDefinition",
    "AgentEndpoint",
    "AgentFileError",
    "AgentInfo",
    "AgentLayer",
    "AgentSupport",
    "AgentTurn",
    "AuthMethod",
    "BUILTIN_AGENTS",
    "BackgroundItem",
    "BooleanConfigOption",
    "CallContext",
    "CapabilityError",
    "CatalogLayer",
    "ClientSupport",
    "ConfigChoice",
    "ConnectedAgent",
    "ConnectedSession",
    "ContentBlock",
    "ElicitAnswer",
    "ElicitationRequest",
    "EndpointCall",
    "EndpointClient",
    "EndpointContext",
    "ExhaustedEvent",
    "Exhaustion",
    "ExtensionHandler",
    "ExtensionNotification",
    "ExtensionRequest",
    "FileHandlers",
    "HttpMcpServer",
    "InstallError",
    "Installed",
    "JsonAnswerError",
    "LoadSessionRequest",
    "MCP_PROTOCOL_VERSION",
    "McpBindingError",
    "McpCallOptions",
    "McpCaller",
    "McpConnectContext",
    "McpConnection",
    "McpConnector",
    "McpError",
    "McpOperationContext",
    "McpRegistration",
    "McpServerClient",
    "MessageEndEvent",
    "MessageEvent",
    "ModelAdapter",
    "ModelConversation",
    "ModelReply",
    "ModelStream",
    "ModelTool",
    "ModelToolCall",
    "NewSessionRequest",
    "OpenedSession",
    "OptionId",
    "OtelTap",
    "OtherConfigOption",
    "OtherWork",
    "PermissionAnswer",
    "PermissionCommand",
    "PermissionDecision",
    "PermissionDenied",
    "PermissionEvent",
    "PermissionHandler",
    "PermissionOption",
    "PermissionOutcome",
    "PermissionPolicy",
    "PermissionRequest",
    "PermissionRule",
    "PlanEntry",
    "PlanEvent",
    "ProtocolVersion",
    "Quirk",
    "READ_KINDS",
    "REGISTRY_URL",
    "Registry",
    "RegistryAgent",
    "ReplayWriter",
    "ResolvedAgent",
    "SelectConfigOption",
    "Session",
    "SessionConveniences",
    "SessionInfo",
    "SessionInfoEvent",
    "SessionMode",
    "SessionModes",
    "SessionSummary",
    "SseMcpServer",
    "StartedAgent",
    "StateEvent",
    "StateKey",
    "StdioMcpServer",
    "StopReason",
    "SubagentWork",
    "TerminalDisplay",
    "TerminalEvent",
    "TerminalExit",
    "TerminalHandle",
    "TerminalHandlers",
    "TerminalSize",
    "TerminalState",
    "TerminalWork",
    "Terminals",
    "TextEndInfo",
    "TextInfo",
    "ThoughtEndEvent",
    "ThoughtEvent",
    "Timeouts",
    "ToolCall",
    "ToolCallContent",
    "ToolCallEvent",
    "ToolCallHandle",
    "ToolCallInfo",
    "ToolCallStatus",
    "ToolCallWork",
    "ToolContext",
    "ToolDefinition",
    "ToolResult",
    "ToolSet",
    "Turn",
    "TurnHistory",
    "TurnEnd",
    "TurnEvent",
    "TurnHandlers",
    "TurnLimits",
    "TurnProjection",
    "TurnResult",
    "UpdateEvent",
    "UsageEvent",
    "UserMessageEndEvent",
    "UserMessageEvent",
    "WorkspaceFiles",
    "WorkspaceTerminals",
    "agent_by_name",
    "agent_endpoint",
    "agent_files",
    "agent_support",
    "allow",
    "allow_inside",
    "ask_in_terminal",
    "binaries_path",
    "builtin_catalog",
    "check_tool_input",
    "client_support",
    "config_options_from",
    "connect_agent",
    "connect_session",
    "conveniences",
    "decide",
    "extension_notification",
    "extension_request",
    "file",
    "find_json",
    "first_of",
    "handle",
    "image",
    "inside",
    "inside_workspace",
    "install_agent",
    "installed_binaries",
    "list_agents",
    "load_catalog",
    "load_catalog_async",
    "load_registry",
    "mcp_connector",
    "mcp_servers_param",
    "model_agent",
    "modes_from",
    "open_session",
    "otel_tap",
    "parse_agent_file",
    "parse_agent_table",
    "parse_mcp_servers",
    "prompt_blocks",
    "read_only",
    "refresh_registry",
    "registry_cache_path",
    "registry_target",
    "reject",
    "request_command",
    "request_paths",
    "resolve_agent",
    "resolve_decision",
    "run",
    "serve_agent",
    "serve_stdio",
    "server_client",
    "spans_from_trace",
    "start",
    "state_key",
    "terminal",
    "terminal_text",
    "tool",
    "tool_input_schema",
    "tool_output_text",
    "trim_registry",
    "turn_end",
    "v1",
    "v2",
    "validate_elicitation",
    "workspace_files",
    "workspace_terminals",
]
