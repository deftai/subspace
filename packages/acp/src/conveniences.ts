/**
 * The conveniences `start()` and `connectSession()` give a session:
 *
 *   await agent.run('Fix the test', { onMessage })             // the TurnResult
 *   const answer = await agent.text('What does this repo do?') // just the text
 *   for await (const chunk of agent.stream('Explain it')) process.stdout.write(chunk)
 *   const files = await agent.json('Which files need changing?', { schema: z.array(z.string()) })
 *
 * `json()` asks for JSON only, finds it in the reply (bare, or in a code
 * fence, or the first object or array), checks it with your schema (any
 * Standard Schema: zod, valibot, arktype, ...), and if it does not fit asks
 * once more, saying what was wrong.
 */
import type { PromptInput, PromptOptions, Session } from './client.ts';
import type { ContentBlock, TurnResult } from './model.ts';
import type { Turn } from './turn.ts';

type Prompt = PromptInput;

/** The Standard Schema interface (https://standardschema.dev), as far as `json()` uses it. */
export interface StandardSchema<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): StandardResult<Output> | Promise<StandardResult<Output>>;
  };
}
type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<unknown> }> };

export interface JsonOptions<T> extends PromptOptions {
  /** Checks the answer (and types the result). Any Standard Schema validator. */
  schema?: StandardSchema<T>;
  /** What the JSON should look like, told to the agent: a description, an example, or a JSON Schema. */
  shape?: string | object;
  /** How many times to ask again when the answer is not valid. Default 1. */
  retries?: number;
}

/** A JSON value can't be found in the reply, or it never fit the schema. */
export class JsonAnswerError extends Error {
  readonly reply: string;
  readonly problems: string[];

  constructor(message: string, reply: string, problems: string[] = []) {
    super(message);
    this.name = 'JsonAnswerError';
    this.reply = reply;
    this.problems = problems;
  }
}

export interface SessionConveniences {
  /** Run one turn and resolve with its result (after its handlers ran). */
  run(prompt: Prompt, options?: PromptOptions): Promise<TurnResult>;
  /** Start a turn; iterate it, or pass handlers. */
  prompt(prompt: Prompt, options?: PromptOptions): Turn;
  /** Run one turn and resolve with its text. */
  text(prompt: Prompt, options?: PromptOptions): Promise<string>;
  /** The turn's text as it streams, messages separated as in `result.text`. */
  stream(prompt: Prompt, options?: PromptOptions): AsyncIterable<string>;
  /** Ask for JSON, check it, and resolve with the value. */
  json<T = unknown>(prompt: string, options?: JsonOptions<T>): Promise<T>;
}

/** The first JSON value in a reply: all of it, a ```json fence, or the first balanced object or array. */
export function findJson(reply: string): unknown {
  const attempts: string[] = [reply.trim()];
  for (const match of reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) attempts.push(match[1]!.trim());
  const start = reply.search(/[[{]/);
  if (start >= 0) {
    // Scan for the matching close, minding strings.
    const open = reply[start]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    for (let i = start; i < reply.length; i++) {
      const c = reply[i]!;
      if (quoted) {
        if (c === '\\') i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        attempts.push(reply.slice(start, i + 1));
        break;
      }
    }
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // next
    }
  }
  throw new JsonAnswerError('The reply has no JSON value in it', reply);
}

function instructions(shape: string | object | undefined): string {
  const described = shape === undefined ? '' : `\n\nThe JSON should look like this:\n${typeof shape === 'string' ? shape : JSON.stringify(shape, null, 2)}`;
  return `${described}\n\nReply with only the JSON value: no explanation and no code fence.`;
}

export function conveniences(session: Session): SessionConveniences {
  const run = (prompt: Prompt, options?: PromptOptions) => session.prompt(prompt, options).done;
  return {
    run,
    prompt: (prompt, options) => session.prompt(prompt, options),
    text: async (prompt, options) => (await run(prompt, options)).text,
    stream: (prompt, options = {}) => ({
      async *[Symbol.asyncIterator]() {
        const queue: string[] = [];
        let wake: (() => void) | undefined;
        const turn = session.prompt(prompt, {
          ...options,
          onMessage: async (delta, info, event) => {
            queue.push(info.separator + delta);
            wake?.();
            await options.onMessage?.(delta, info, event);
          },
        });
        let ended = false;
        const done = turn.done.finally(() => {
          ended = true;
          wake?.();
        });
        try {
          for (;;) {
            while (queue.length) yield queue.shift()!;
            if (ended) break;
            await new Promise<void>((resolve) => (wake = resolve));
            wake = undefined;
          }
          await done;
        } finally {
          // A consumer that stops early stops the turn.
          if (!ended) await turn.cancel();
        }
      },
    }),
    json: async <T>(prompt: string, options: JsonOptions<T> = {}) => {
      const { schema, shape, retries = 1, ...promptOptions } = options;
      let reply = await session.prompt(`${prompt}${instructions(shape)}`, promptOptions).done;
      for (let attempt = 0; ; attempt++) {
        let problems: string[];
        try {
          const value = findJson(reply.text);
          if (!schema) return value as T;
          const checked = await schema['~standard'].validate(value);
          if (!checked.issues) return checked.value;
          problems = checked.issues.map((i) => (i.path?.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message));
        } catch (error) {
          if (!(error instanceof JsonAnswerError)) throw error;
          problems = ['there was no JSON value in the reply'];
        }
        if (attempt >= retries) throw new JsonAnswerError(`The reply never fit: ${problems.join('; ')}`, reply.text, problems);
        reply = await session.prompt(`That answer was not right: ${problems.join('; ')}.${instructions(shape)}`, promptOptions).done;
      }
    },
  };
}
