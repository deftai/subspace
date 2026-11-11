/**
 * An ACP agent backed by a model: the turn loop, written once.
 *
 *   import { claude } from '@deft-subspace/claude';
 *   serveStdio(modelAgent({ name: 'helper', model: claude(), system: 'You are terse.', tools: { listFiles } }));
 *
 * Each ACP session gets its own conversation with the model. Per turn: the
 * prompt goes to the model; its text streams as agent messages and its
 * thinking as thoughts; each tool call is checked, shown, asked about if the
 * tool says so, run, and its result sent back; until the model stops calling
 * tools (or `maxSteps`). A refused tool is reported to the model, which
 * decides what to do next. Cancelling the turn stops the model and the tools.
 *
 * The model side is an adapter (`ModelAdapter`), so any model fits;
 * `@deft-subspace/claude` provides one for the Claude API.
 */
import { PermissionDenied, type AgentOptions, type AgentTurn } from './agent.ts';
import type { ContentBlock, StopReason } from './model.ts';
import { checkToolInput, toolInputSchema, toolOutputText, toolTitle, type ToolSet } from './tools.ts';

/** A tool as the model sees it. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tool checks its input itself (so the adapter may stream inputs unchecked). */
  validated: boolean;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelReply {
  /** Why the model stopped: end_turn, tool_use, max_tokens, refusal, ... */
  stopReason: string;
  toolCalls: ModelToolCall[];
}

export interface ModelToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/**
 * What goes to the model next: the user's prompt, or the results of its tool
 * calls. A prompt has `interruptedToolResults` when tools of the previous
 * turn ran but the model never heard back (the turn hit `maxSteps` or was
 * cancelled): give them to the model before the prompt. A call with no result
 * never ran. A conversation that does not know the field still gets the prompt.
 */
export type ModelInput =
  | { prompt: ContentBlock[]; interruptedToolResults?: ModelToolResult[] }
  | { toolResults: ModelToolResult[] };

/** One conversation with a model (one ACP session). It keeps its own history. */
export interface ModelConversation {
  send(
    input: ModelInput,
    stream: { onText(delta: string): unknown; onThinking(delta: string): unknown; signal: AbortSignal }
  ): Promise<ModelReply>;
}

export interface ModelAdapter {
  conversation(setup: { system?: string; tools: ModelTool[]; cwd: string }): ModelConversation;
}

export interface ModelAgentOptions extends Omit<AgentOptions, 'prompt' | 'newSession'> {
  model: ModelAdapter;
  /** The system prompt; it may use the session's folder. */
  system?: string | ((session: { cwd: string }) => string);
  tools?: ToolSet;
  /** Model calls per turn before it is stopped (`max_turn_requests`). Default 50. */
  maxSteps?: number;
}

/** serveAgent options for an agent backed by a model. */
export function modelAgent(options: ModelAgentOptions): AgentOptions {
  const { model, system, tools = {}, maxSteps = 50, ...agentOptions } = options;
  const conversations = new Map<string, ModelConversation>();
  const cwds = new Map<string, string>();
  /** Results of tool calls that ran after the model last heard back, for the next prompt. */
  const unsent = new Map<string, ModelToolResult[]>();
  const modelTools: ModelTool[] = Object.entries(tools).map(([name, definition]) => ({
    name,
    description: definition.description,
    inputSchema: toolInputSchema(definition),
    validated: !!definition.schema,
  }));
  const forget = (sessionId: string) => {
    conversations.delete(sessionId);
    cwds.delete(sessionId);
    unsent.delete(sessionId);
  };
  const conversationFor = (turn: AgentTurn): ModelConversation => {
    let conversation = conversations.get(turn.sessionId);
    if (!conversation) {
      const cwd = cwds.get(turn.sessionId) ?? '.';
      const prompt = typeof system === 'function' ? system({ cwd }) : system;
      conversation = model.conversation({ ...(prompt ? { system: prompt } : {}), tools: modelTools, cwd });
      conversations.set(turn.sessionId, conversation);
    }
    return conversation;
  };

  return {
    ...agentOptions,
    newSession: ({ cwd }) => {
      const sessionId = globalThis.crypto.randomUUID();
      cwds.set(sessionId, cwd);
      return { sessionId };
    },
    closeSession: async (sessionId) => {
      forget(sessionId);
      await agentOptions.closeSession?.(sessionId);
    },
    // A closed connection does not close its sessions: drop their conversations here.
    connectionClosed: async (sessionIds) => {
      for (const sessionId of sessionIds) forget(sessionId);
      await agentOptions.connectionClosed?.(sessionIds);
    },
    async prompt(turn): Promise<StopReason> {
      const conversation = conversationFor(turn);
      const carried = unsent.get(turn.sessionId);
      unsent.delete(turn.sessionId);
      let input: ModelInput = carried?.length ? { prompt: turn.prompt, interruptedToolResults: carried } : { prompt: turn.prompt };
      // Tools that ran but whose results the model has not had yet: kept for the next prompt if the turn stops here,
      // unless the session was forgotten (closed, or its connection closed) while the turn unwound.
      const stopWith = (stop: StopReason, results: ModelToolResult[]): StopReason => {
        if (results.length && conversations.get(turn.sessionId) === conversation) unsent.set(turn.sessionId, results);
        return stop;
      };
      for (let step = 0; step < maxSteps; step++) {
        const reply = await conversation.send(input, {
          onText: (delta) => turn.say(delta),
          onThinking: (delta) => turn.think(delta),
          signal: turn.signal,
        });
        if (turn.signal.aborted) return 'cancelled';
        if (!reply.toolCalls.length) return stopReasonOf(reply.stopReason);
        const results: ModelToolResult[] = [];
        for (const call of reply.toolCalls) {
          if (turn.signal.aborted) return stopWith('cancelled', results);
          results.push(await runToolCall(turn, tools, call));
        }
        if (turn.signal.aborted) return stopWith('cancelled', results);
        input = { toolResults: results };
      }
      // The last input was never sent.
      return stopWith('max_turn_requests', 'toolResults' in input ? input.toolResults : (input.interruptedToolResults ?? []));
    },
  };
}

async function runToolCall(turn: AgentTurn, tools: ToolSet, call: ModelToolCall): Promise<ModelToolResult> {
  const definition = tools[call.name];
  if (!definition) return { id: call.id, content: `There is no tool named ${call.name}.`, isError: true };
  const checked = await checkToolInput(definition, call.input);
  if ('problems' in checked) return { id: call.id, content: `Invalid input: ${checked.problems.join('; ')}`, isError: true };
  try {
    const output = await turn.tool(
      {
        id: call.id,
        title: toolTitle(call.name, definition, checked.value),
        kind: definition.kind ?? 'other',
        rawInput: checked.value,
        ...(definition.ask ? { ask: definition.ask } : {}),
      },
      async (handle) => toolOutputText(await definition.run(checked.value, { signal: handle.signal }))
    );
    return { id: call.id, content: output };
  } catch (error) {
    if (error instanceof PermissionDenied) return { id: call.id, content: 'The user did not allow this tool call.', isError: true };
    return { id: call.id, content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function stopReasonOf(reason: string): StopReason {
  if (reason === 'end_turn' || reason === 'tool_use' || reason === 'pause_turn' || reason === 'stop_sequence') return 'end_turn';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  return 'end_turn';
}
