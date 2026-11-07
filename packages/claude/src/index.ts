/**
 * A Claude model for Subspace agents.
 *
 *   import { modelAgent, tool } from '@deft-subspace/acp';
 *   import { serveStdio } from '@deft-subspace/acp/node';
 *   import { claude } from '@deft-subspace/claude';
 *
 *   serveStdio(modelAgent({ name: 'helper', model: claude(), tools: { listFiles } }));
 *
 * Credentials come from the environment as the Anthropic SDK resolves them
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
 *
 * Defaults: Claude Opus 5.5, adaptive thinking with summarized display (so
 * thoughts stream to the client), effort "high", streaming with a 64K
 * output budget, and server-side refusal fallbacks ("default") on - pass
 * `fallbacks: false` to turn them off. Tools that validate their own input
 * get eager input streaming.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, ModelAdapter, ModelConversation, ModelInput, ModelReply, ModelTool } from '@deft-subspace/acp';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentParam = Anthropic.Beta.BetaContentBlockParam;

export interface ClaudeOptions {
  /** Default `claude-opus-5-5`. */
  model?: string;
  /** Your own client (base URL, timeouts, a cloud platform). Default `new Anthropic()`. */
  client?: Anthropic;
  /** Output budget per model call. Default 64000. */
  maxTokens?: number;
  /** Thinking depth and token spend. Default `high`. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Show the model's reasoning as thoughts (`summarized`) or not (`omitted`). Default `summarized`. */
  thinking?: 'summarized' | 'omitted';
  /** Server-side refusal fallbacks (Claude API). Default true. */
  fallbacks?: boolean;
}

/** ACP prompt content as Claude content. */
export function claudeContent(blocks: ContentBlock[]): ContentParam[] {
  return blocks.flatMap((block): ContentParam[] => {
    const b = block as Record<string, any>;
    if (b.type === 'text') return [{ type: 'text', text: String(b.text) }];
    if (b.type === 'image' && typeof b.data === 'string') {
      return [{ type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } }];
    }
    if (b.type === 'resource' && typeof b.resource?.text === 'string') {
      const name = String(b.resource.uri ?? 'file').replace(/^file:\/\//, '');
      return [{ type: 'text', text: `${name}:\n\n\`\`\`\n${b.resource.text}\n\`\`\`` }];
    }
    if (b.type === 'resource_link' && typeof b.uri === 'string') return [{ type: 'text', text: `(link: ${b.uri})` }];
    return [];
  });
}

class ClaudeConversation implements ModelConversation {
  private readonly messages: MessageParam[] = [];
  /** tool_use ids the model is waiting for results to (unanswered after a cancel or a cut). */
  private pending: string[] = [];

  private readonly client: Anthropic;
  private readonly options: Required<Omit<ClaudeOptions, 'client'>>;
  private readonly system: string | undefined;
  private readonly tools: Anthropic.Beta.BetaToolUnion[];

  constructor(client: Anthropic, options: Required<Omit<ClaudeOptions, 'client'>>, system: string | undefined, tools: Anthropic.Beta.BetaToolUnion[]) {
    this.client = client;
    this.options = options;
    this.system = system;
    this.tools = tools;
  }

  async send(input: ModelInput, stream: { onText(delta: string): unknown; onThinking(delta: string): unknown; signal: AbortSignal }): Promise<ModelReply> {
    const answered = 'toolResults' in input ? new Set(input.toolResults.map((r) => r.id)) : new Set<string>();
    // Every tool_use needs a result in the next user message; ones nobody answered get an error.
    const unanswered: ContentParam[] = this.pending
      .filter((id) => !answered.has(id))
      .map((id) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Not run: the turn ended first.' }));
    const content: ContentParam[] =
      'toolResults' in input
        ? input.toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) }))
        : claudeContent(input.prompt);
    this.messages.push({ role: 'user', content: [...unanswered, ...content] });
    this.pending = [];

    let jsonRetries = 0;
    for (;;) {
      const request = this.client.beta.messages.stream(
        {
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          ...(this.system ? { system: this.system } : {}),
          ...(this.tools.length ? { tools: this.tools } : {}),
          messages: this.messages,
          thinking: { type: 'adaptive', display: this.options.thinking },
          output_config: { effort: this.options.effort },
          ...(this.options.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: stream.signal }
      );
      request.on('text', (delta) => void stream.onText(delta));
      request.on('thinking', (delta) => void stream.onThinking(delta));
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await request.finalMessage();
        jsonRetries = 0;
      } catch (error) {
        if (stream.signal.aborted) return { stopReason: 'cancelled', toolCalls: [] };
        // A tool input that could not be parsed at all (eager streaming): re-issue, a few times.
        if (error instanceof Anthropic.APIError || jsonRetries++ >= 2) throw error;
        continue;
      }
      // Append-only history: the whole assistant turn, thinking blocks included.
      this.messages.push({ role: 'assistant', content: message.content as ContentParam[] });
      if (message.stop_reason === 'pause_turn') continue;
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      // Never run tools from a refused or truncated turn; their ids still need results next time.
      if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
        this.pending = toolUses.map((t) => t.id);
        return { stopReason: message.stop_reason, toolCalls: [] };
      }
      this.pending = toolUses.map((t) => t.id);
      return { stopReason: message.stop_reason ?? 'end_turn', toolCalls: toolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })) };
    }
  }
}

/** A Claude model for `modelAgent()`. */
export function claude(options: ClaudeOptions = {}): ModelAdapter {
  const client = options.client ?? new Anthropic();
  const settings = {
    model: options.model ?? 'claude-opus-5-5',
    maxTokens: options.maxTokens ?? 64000,
    effort: options.effort ?? 'high',
    thinking: options.thinking ?? 'summarized',
    fallbacks: options.fallbacks ?? true,
  } as const;
  return {
    conversation: ({ system, tools }) =>
      new ClaudeConversation(
        client,
        settings,
        system,
        tools.map((t: ModelTool) => ({
          name: t.name,
          description: t.description,
          input_schema: { type: 'object', ...t.inputSchema } as Anthropic.Beta.BetaTool.InputSchema,
          // Large inputs stream as generated; the tool's own validator checks them before it runs.
          ...(t.validated ? { eager_input_streaming: true } : {}),
        }))
      ),
  };
}
