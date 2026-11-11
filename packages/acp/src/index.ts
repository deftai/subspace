export {
  AcpClient,
  promptBlocks,
  Session,
  type AgentInfo,
  type ClientOptions,
  type ElicitationHandler,
  type ElicitationRequest,
  type ElicitationResponse,
  type FileHandlers,
  type PromptInput,
  type PromptOptions,
  type SessionLocator,
  type SessionMcpServers,
  type TerminalHandlers,
} from './client.ts';
export {
  PermissionDenied,
  serveAgent,
  type AgentOptions,
  type AgentTurn,
  type ReplayWriter,
  type TerminalDisplay,
  type TerminalHandle,
  type ToolCallFields,
  type ToolCallHandle,
  type ToolCallInit,
} from './agent.ts';
export { Turn } from './turn.ts';
export {
  agentEndpoint,
  stateKey,
  type AgentEndpoint,
  type AgentEndpointOptions,
  type AgentLayer,
  type CallContext,
  type EndpointCall,
  type EndpointClient,
  type EndpointContext,
  type EndpointReply,
  type Next,
  type StateKey,
} from './endpoint.ts';
export {
  allow,
  allowInside,
  firstOf,
  inside,
  READ_KINDS,
  readOnly,
  reject,
  requestCommand,
  requestPaths,
  type PermissionMatch,
  type PermissionRule,
} from './policies.ts';
export { findJson, JsonAnswerError, type JsonOptions, type SessionConveniences, type StandardSchema } from './conveniences.ts';
export {
  modelAgent,
  type ModelAdapter,
  type ModelAgentOptions,
  type ModelConversation,
  type ModelInput,
  type ModelReply,
  type ModelTool,
  type ModelToolCall,
  type ModelToolResult,
} from './model-agent.ts';
export { checkToolInput, tool, toolInputSchema, toolOutputText, type ToolContext, type ToolDefinition, type ToolSet } from './tools.ts';
export { connectSession, openSession, type ConnectedSession, type ConnectSessionOptions, type SessionSetup } from './open.ts';
export { type TextEndInfo, type TextInfo, type TurnHandlers } from './handlers.ts';
export { agentSupport, CapabilityError, clientSupport, type AgentSupport, type ClientSupport } from './capabilities.ts';
export {
  extensionNotification,
  extensionRequest,
  handle,
  type ExtensionHandler,
  type ExtensionNotification,
  type ExtensionRequest,
  type Validator,
} from './extensions.ts';
export { modesFrom, type SessionMode, type SessionModes } from './modes.ts';
export { decide, resolveDecision, type PermissionDecision, type PermissionHandler, type PermissionPolicy } from './permissions.ts';
export { TurnProjection } from './projection.ts';
export { turnEnd, type TurnEnd } from './model.ts';
export { validateElicitation } from './elicitation.ts';
export { type AuthMethod } from './auth.ts';
export {
  MCP_PROTOCOL_VERSION,
  McpBindingError,
  mcpServersParam,
  parseMcpServers,
  type McpOperationContext,
  type McpOutcome,
  type McpRegistration,
  type McpRequestHandler,
  type McpServer,
  type ServeMcpOptions,
} from './mcp.ts';
// McpCaller: MCP-over-ACP from the agent side outside serveAgent (for example, a proxy with its own endpoint).
export { McpCaller, McpError, serverClient, type McpCallOptions, type McpSend, type McpServerClient, type McpTool } from './mcp-caller.ts';
export { type ExternalMcpServer, type McpConnection, type McpConnector } from './mcp-connections.ts';
export { terminalText, type TerminalExit, type TerminalState, type Terminals } from './terminals.ts';
export {
  configOptionsFrom,
  type BooleanConfigOption,
  type ConfigChoice,
  type ConfigOption,
  type OtherConfigOption,
  type SelectConfigOption,
} from './config.ts';
export type {
  BackgroundItem,
  ContentBlock,
  Exhaustion,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  PlanEntry,
  ProtocolVersion,
  StopReason,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  TurnEvent,
  TurnLimits,
  TurnResult,
  v1,
  v2,
} from './model.ts';
export {
  BUILTIN_AGENTS,
  builtinCatalog,
  listAgents,
  resolveAgent,
  type AgentCatalog,
  type AgentDefinition,
  type BuiltinAgentName,
  type CatalogLayer,
  type Quirk,
  type ResolvedAgent,
} from './agents.ts';
export { REGISTRY_URL, registryTarget, trimRegistry, type Registry, type RegistryAgent } from './registry.ts';
export { otelTap, spansFromTrace, type OtelApi, type OtelSpan, type OtelTap, type OtelTapOptions } from './telemetry.ts';
