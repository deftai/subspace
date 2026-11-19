/**
 * Protocol-neutral interfaces and plain-data event/ask types for agent drivers.
 *
 * Imports types only from `@deft-subspace/acp` and `@deft-subspace/kernel`.
 * Uses no Node APIs.
 */
import type {
  ConfigOption,
  ContentBlock,
  PermissionOption,
  PermissionOutcome,
  PromptInput,
  SessionMode,
  StopReason,
  ToolCall,
  TurnEvent,
} from '@deft-subspace/acp';
import type { Channel } from '@deft-subspace/kernel';

export type {
  Channel,
  ConfigOption,
  ContentBlock,
  PermissionOption,
  PermissionOutcome,
  PromptInput,
  SessionMode,
  StopReason,
  ToolCall,
  TurnEvent,
};

// ---------------------------------------------------------------------------
// 3. Plain data
// ---------------------------------------------------------------------------

/** A permission request with nothing protocol-specific in it. */
export interface PermissionAskRequest {
  /** The session that asks: the main session's id, or a child's on a child workbench. */
  sessionId: string;
  title: string;
  /** The tool call this is about, with the request's fields merged into what was known of it. */
  toolCall?: ToolCall;
  /** The command a command permission asks to run, when the request says. */
  command?: { command: string; cwd: string };
  options: PermissionOption[];
  /** The request as it arrived, for diagnostics only. A workbench MUST NOT depend on it. */
  raw?: unknown;
}

/** TurnEvent, except that `permission` carries a PermissionAskRequest. */
export type CoreEvent =
  | Exclude<TurnEvent, { type: 'permission' }>
  | { type: 'permission'; request: PermissionAskRequest; outcome: PermissionOutcome };

export type AgentEvent = CoreEvent | AgentEventAddition;

export interface Cost {
  amount: number;
  currency: string;
}

/** ACP's available command, as plain data. */
export interface AgentCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export interface WorkState {
  state: 'working' | 'blocked' | 'idle' | 'done' | 'error';
  /** For `blocked`: what it waits for. */
  blockedKind?: 'permission' | 'question' | 'auth';
  /** Shown with the state ("Finished", "Cancelled", an error). */
  message?: string;
}

export interface SubagentStats {
  turns?: number;
  toolCalls?: number;
  tokens?: number;
  contextPercent?: number;
  durationMs?: number;
  errors?: number;
}

/** The fields a `session_message` upsert carried; null clears. */
export interface SessionMessagePatch {
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  senderMessageId?: string | null;
  recipientMessageId?: string | null;
  content?: ContentBlock[] | null;
}

export type AgentEventAddition =
  /** M04: non-text content in the agent's reply (image, resource, resource_link). */
  | { type: 'agent_content'; block: ContentBlock }
  /** M14, M15: what one turn used. `usage` as the agent reported it; `cost` when known. */
  | { type: 'prompt_usage'; usage: Readonly<Record<string, unknown>>; cost?: Cost }
  /** M10: the agent's commands, the full list. */
  | { type: 'commands'; commands: AgentCommand[] }
  /** M17: the session's modes, the full state. */
  | { type: 'modes'; current: string | null; available: SessionMode[] }
  /** M18: the session's config options, the complete list. */
  | { type: 'config_options'; options: ConfigOption[] }
  /** M12: the agent's guess at the next prompt; "" clears it. */
  | { type: 'prompt_suggestion'; text: string }
  /** M19: a saved session was reopened without its history. */
  | { type: 'resumed_without_history' }
  /** M21, M22: a sub-agent announced or changed. Absent fields are unchanged. */
  | {
      type: 'subagent';
      sessionId: string;
      title?: string;
      description?: string;
      status?: WorkState;
      stats?: SubagentStats;
      cancellable?: boolean;
      cwd?: string;
    }
  /** M23: background work the agent runs. Absent fields are unchanged. */
  | {
      type: 'background_work';
      taskId: string;
      title?: string;
      subtitle?: string;
      status?: WorkState;
      cwd?: string;
    }
  /** M24: a message between sessions. Exactly one of `patch` and `append`. */
  | {
      type: 'session_message';
      messageId: string;
      patch?: SessionMessagePatch;
      append?: ContentBlock;
    }
  /** M28: a link question finished on the agent's side. */
  | { type: 'question_completed'; elicitationId: string }
  /** M46: the turn failed with an error from the agent; the agent is still running. */
  | { type: 'turn_failed'; reason: string }
  /** M45: the connection ended while the driver was not stopping. Emitted once. */
  | { type: 'connection_closed'; message: string };

export interface AgentInfo {
  /** The agent's name as the application knows it (from AgentDriverOptions.agent). */
  name: string;
  /** What the agent said about itself, when it did. */
  title?: string;
  version?: string;
  /** The driver's kind, for example "acp-subspace". */
  driver: string;
  /** The protocol in use, when there is one, for example "acp/1". Absent for in-process drivers. */
  protocol?: string;
}

export interface AgentSessionList {
  /** Each as the agent described it; every one has a non-empty sessionId. */
  sessions: Array<Readonly<Record<string, unknown>> & { sessionId: string }>;
  /** Why (the rest of) the list could not be had, or null. */
  error: string | null;
  /** There were more than the driver asks for. */
  truncated: boolean;
}

/** Why the agent could not be started or its session opened (M44). Plain data. */
export interface StartFailure {
  kind: 'failed' | 'not_signed_in' | 'cannot_reopen' | 'restarting' | 'stopped';
  /** One line, shown as the failure's title. */
  message: string;
  /** More, shown under it. May be "". */
  details: string;
}

/** Error rejected by `AgentDriver.start()`, carrying a plain-data `failure`. */
export class StartFailureError extends Error {
  readonly failure: StartFailure;

  constructor(failure: StartFailure, options?: { cause?: unknown }) {
    super(failure.message, options);
    this.name = 'StartFailureError';
    this.failure = failure;
  }
}

export function isStartFailureError(err: unknown): err is Error & { failure: StartFailure } {
  if (!(err instanceof Error)) return false;
  const candidate = (err as { failure?: unknown }).failure;
  if (typeof candidate !== 'object' || candidate === null) return false;
  const f = candidate as Record<string, unknown>;
  return (
    (f.kind === 'failed' ||
      f.kind === 'not_signed_in' ||
      f.kind === 'cannot_reopen' ||
      f.kind === 'restarting' ||
      f.kind === 'stopped') &&
    typeof f.message === 'string' &&
    typeof f.details === 'string'
  );
}

// ---------------------------------------------------------------------------
// 4. Asks
// ---------------------------------------------------------------------------

export interface Ask<Request, Answer> {
  readonly kind: string;
  readonly request: Request;
  /** Phantom type carrier for Answer; not present at runtime. */
  readonly _answer?: Answer;
}

export type Cancelled = { outcome: 'cancelled' };

export function isCancelled(value: unknown): value is Cancelled {
  return typeof value === 'object' && value !== null && (value as { outcome?: unknown }).outcome === 'cancelled';
}

export interface AskOptions {
  signal?: AbortSignal;
  /** The ask belongs to no turn even while one is open (e.g. background work permission). */
  detached?: boolean;
}

// 4.1 permission
export interface PermissionAskAnswer {
  optionId: string;
}
export interface PermissionAsk extends Ask<PermissionAskRequest, PermissionAskAnswer> {
  readonly kind: 'permission';
}

// 4.2 question
export interface QuestionAskRequest {
  mode: 'form' | 'url';
  message: string;
  requestedSchema?: object;
  url?: string;
  elicitationId?: string;
  toolCallId?: string;
  source?: string;
}
export type QuestionAskAnswer =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };
export interface QuestionAsk extends Ask<QuestionAskRequest, QuestionAskAnswer> {
  readonly kind: 'question';
}

// 4.3 choices
export interface ChoiceOption {
  label: string;
  id?: string;
  description?: string;
  preview?: string;
}
export interface ChoiceQuestion {
  question: string;
  id?: string;
  header?: string;
  multiSelect: boolean;
  options: ChoiceOption[];
}
export interface ChoicesAskRequest {
  toolCallId: string;
  planning: boolean;
  questions: ChoiceQuestion[];
}
export type ChoicesAskAnswer =
  | {
      outcome: 'accepted';
      answers: Record<string, string[]>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
    }
  | {
      outcome: 'chat_about_this' | 'skip_interview';
      partialAnswers: Record<string, string>;
    };
export interface ChoicesAsk extends Ask<ChoicesAskRequest, ChoicesAskAnswer> {
  readonly kind: 'choices';
}

// 4.4 plan_approval
export interface PlanApprovalAskRequest {
  toolCallId: string;
  plan: string | null;
}
export interface PlanApprovalAskAnswer {
  decision: 'approve' | 'keep_planning' | 'abandon';
}
export interface PlanApprovalAsk extends Ask<PlanApprovalAskRequest, PlanApprovalAskAnswer> {
  readonly kind: 'plan_approval';
}

// 4.5 key
export interface KeyOption {
  key: string;
  label: string;
}
export interface KeyAskRequest {
  message: string;
  keys: KeyOption[];
}
export interface KeyAskAnswer {
  key: string;
}
export interface KeyAsk extends Ask<KeyAskRequest, KeyAskAnswer> {
  readonly kind: 'key';
}

// 4.6 sign_in
export interface AuthEnvVar {
  name: string;
  label?: string;
  secret?: boolean;
  optional?: boolean;
}
export interface DriverAuthMethod {
  id: string;
  name: string;
  description?: string;
  type?: string;
  vars?: AuthEnvVar[];
  args?: string[];
  env?: Readonly<Record<string, string>>;
  meta?: Readonly<Record<string, unknown>>;
}
export interface SignInAskRequest {
  methods: DriverAuthMethod[];
  message: string;
}
export type SignInAskAnswer = { methodId: string } | { methodId: null };
export interface SignInAsk extends Ask<SignInAskRequest, SignInAskAnswer> {
  readonly kind: 'sign_in';
}

// 4.7 sign_in_outside
export interface SignInOutsideAskRequest {
  method: DriverAuthMethod;
}
export interface SignInOutsideAskAnswer {
  signedIn: boolean;
}
export interface SignInOutsideAsk extends Ask<SignInOutsideAskRequest, SignInOutsideAskAnswer> {
  readonly kind: 'sign_in_outside';
}

export type KnownAsk =
  | PermissionAsk
  | QuestionAsk
  | ChoicesAsk
  | PlanApprovalAsk
  | KeyAsk
  | SignInAsk
  | SignInOutsideAsk;

export type AskKind = KnownAsk['kind'];

export const KNOWN_ASK_KINDS: ReadonlySet<string> = new Set<AskKind>([
  'permission',
  'question',
  'choices',
  'plan_approval',
  'key',
  'sign_in',
  'sign_in_outside',
]);

// ---------------------------------------------------------------------------
// 5. The driver
// ---------------------------------------------------------------------------

export interface AgentDriverCapabilities {
  logout: boolean;
  stopTerminals: boolean;
  emptyPrompts: boolean;
  /** The driver can reopen a saved session and replay its history (ACP `loadSession`). */
  loadSession: boolean;
  /** The driver can reopen a saved session without replay (ACP session `resume`). */
  resumeSession: boolean;
  listSessions: boolean;
  deleteSessions: boolean;
  modes: boolean;
  configOptions: boolean;
  /** Session capabilities in ACP's names ("list", "delete", "resume", "close", ...), including ones a vendor layer supplies. */
  sessionCapabilities: readonly string[];
  /** What a prompt may carry besides text and resource links. */
  promptContent: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
}

export interface AgentDriver {
  /** Resolves when the agent is ready for a prompt. Rejects with an StartFailure (3.5). */
  start(): Promise<void>;
  /** Idempotent. Settles every open ask and every pending call (V3). */
  stop(): Promise<void>;
  readonly info: AgentInfo;
  readonly capabilities: AgentDriverCapabilities;
  /** The main session's id once known; null before, and when there is none. */
  readonly sessionId: string | null;
  /** The process the application started for this agent, if it said; never signalled by the driver. */
  readonly pid: number | null;
  sendPrompt(prompt: PromptInput): Promise<StopReason | null>;
  cancel(): Promise<boolean>;
  setMode(modeId: string): Promise<string | null>;
  setConfigOption(id: string, value: string | boolean): Promise<string | null>;
  listSessions(cwd: string): Promise<AgentSessionList | null>;
  deleteSession(sessionId: string): Promise<string | null>;
  /** The session's title changed (by the user, or the application applying the agent's). */
  setSessionTitle(title: string, byUser?: boolean): Promise<void>;
  logout(): Promise<string | null>;
  stopTerminal(toolCallId: string): Promise<string | null>;
  cancelSubagent(childSessionId: string): Promise<boolean>;
}

export interface AgentDriverOptions {
  /** The application's record of the agent. */
  agent: { name: string; identity: string | null };
  /** How the application names itself to the agent. */
  client: { name: string; title?: string; version: string };
  /** Reopen this saved session instead of opening a new one. */
  session?: {
    sessionId: string;
    /** The session's working directory as saved. */
    cwd: string;
    /** The conversation is already on screen (a new connection for an open conversation). */
    reconnect: boolean;
  };
  /** The process the application started for this agent, if any (reported as `pid`). */
  pid?: number | null;
}

/** The driver over AcpClient also takes the agent's connection. */
export interface AcpDriverOptions extends AgentDriverOptions {
  /** JSON-RPC messages to and from the agent (use ndjson() over a byte channel). */
  channel: Channel<unknown>;
  /** Passed to AcpClient's `protocol` option unchanged; AcpClient's default when absent. */
  protocol?: 'auto' | 1 | 2;
}

export type AgentDriverFactory = (workbench: AgentWorkbench, options: AgentDriverOptions) => AgentDriver;

// ---------------------------------------------------------------------------
// 8. The workbench and services
// ---------------------------------------------------------------------------

export interface WorkbenchFiles {
  /** `line` is 1-based; `limit` is a number of lines. */
  readText(request: { sessionId: string; path: string; line?: number | null; limit?: number | null }): Promise<string>;
  writeText(request: { sessionId: string; path: string; content: string }): Promise<void>;
}

export interface WorkbenchTerminals {
  create(request: {
    sessionId: string;
    command: string;
    args?: string[];
    cwd?: string | null;
    env?: Readonly<Record<string, string>>;
    outputByteLimit?: number | null;
  }): Promise<{ terminalId: string }>;
  output(request: { sessionId: string; terminalId: string }): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  }>;
  waitForExit(request: { sessionId: string; terminalId: string }): Promise<{
    exitCode: number | null;
    signal: string | null;
  }>;
  kill(request: { sessionId: string; terminalId: string }): Promise<void>;
  release(request: { sessionId: string; terminalId: string }): Promise<void>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: object;
}

/** An ACP `McpServer` (stdio, http or sse), as plain data. */
export type McpServerDeclaration = Readonly<Record<string, unknown>> & { name: string };

export interface WorkbenchTools {
  /** The application's tools (MCP's tool shape: name, description, inputSchema, annotations), or null when turned off. */
  list(): Promise<ToolDescriptor[] | null>;
  /** Run one. Never rejects for a tool's own failure: `ok: false` and what to tell the model. */
  call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: boolean; message: string }>;
  /** MCP servers that offer the same tools, to attach to sessions; [] when none. */
  mcpServers(): Promise<McpServerDeclaration[]>;
}

export interface WorkbenchSessions {
  opened(record: { sessionId: string; cwd: string; how: 'new' | 'load' | 'resume'; reopenable: boolean }): Promise<void>;
  titled(record: { sessionId: string; title: string; byUser: boolean }): Promise<void>;
  used(record: { sessionId: string }): Promise<void>;
  /** The agent deleted it; the application forgets it too. */
  deleted(record: { sessionId: string }): Promise<void>;
}

export interface WorkbenchProject {
  readonly path: string;
  /** The environment the agent runs with (the application's and the agent's own variables). */
  readonly env: Readonly<Record<string, string>>;
  setting(key: string): unknown;
  /** Keep a variable for this agent's later starts (a key the user gave to sign in). */
  rememberEnv(name: string, value: string): Promise<void>;
}

export interface WorkbenchPresentation {
  /** What the application can show (diagrams, images, a browser view, its theme), as plain data. */
  capabilities(): Promise<Readonly<Record<string, unknown>>>;
  /** Text to append to the agent's system prompt for each session, or null. */
  systemPrompt(): Promise<string | null>;
}

export interface AgentWorkbench {
  /** The only way anything reaches the conversation. MUST NOT throw. */
  emit(event: AgentEvent): void;
  /** Resolves with the answer, or `{ outcome: 'cancelled' }`. MUST never stay pending. */
  ask<Request, Answer>(ask: Ask<Request, Answer>, options?: AskOptions): Promise<Answer | Cancelled>;
  turnStarted(turnId: string): void;
  turnEnded(turnId: string, stopReason: string): void;
  readonly files: WorkbenchFiles;
  readonly terminals: WorkbenchTerminals;
  readonly tools: WorkbenchTools;
  readonly sessions: WorkbenchSessions;
  readonly project: WorkbenchProject;
  /** What the application can show, and what it asks the agent to keep in mind. */
  readonly presentation: WorkbenchPresentation;
  /** The application's record of which agent this is. */
  readonly agent: { readonly name: string; readonly identity: string | null };
  /** A workbench for a sub-agent. Its events and asks are scoped to that child. */
  child(childSessionId: string): AgentWorkbench;
}

// ---------------------------------------------------------------------------
// 9. Handlers and wires
// ---------------------------------------------------------------------------

export interface AgentHandler<Wire> {
  readonly name: string;
  attach(workbench: AgentWorkbench, wire: Wire): void | (() => void);
}
