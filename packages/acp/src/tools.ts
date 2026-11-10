/**
 * Tools as data: one definition, used three ways.
 *
 *   const listFiles = tool({
 *     description: 'List the files in a folder',
 *     input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
 *     kind: 'read',
 *     run: ({ path }) => readdir(path),
 *   });
 *
 * - An agent built on a model offers it to the model (`modelAgent({ tools })`).
 * - Any agent runs it as a step: `await turn.useTool(listFiles, { path: '.' })`.
 * - A client serves it to the agent over the ACP connection: `client.serveTools({ name, tools })`.
 *
 * `input` is the JSON Schema the model (or the MCP client) sees. `schema` is
 * an optional Standard Schema validator (zod, valibot, ...) that checks the
 * input before `run` and types it; if it can produce a JSON Schema itself
 * (Standard JSON Schema), `input` may be left out.
 */
import type { StandardSchema } from './conveniences.ts';

export interface ToolContext {
  /** Fires when the turn is cancelled. */
  signal: AbortSignal;
}

export interface ToolDefinition<Input = any, Output = unknown> {
  description: string;
  /** JSON Schema for the input (an object schema). */
  input?: Record<string, unknown>;
  /** Checks and types the input before `run`. */
  schema?: StandardSchema<Input>;
  /** ACP tool kind: read, edit, delete, move, search, execute, think, fetch, other. Default other. */
  kind?: string;
  /** Ask the user first (`true`, or the question to ask). */
  ask?: boolean | string;
  /** What the client shows for a call. Default: the tool's name. */
  title?: string | ((input: Input) => string);
  run(input: Input, context: ToolContext): Output | Promise<Output>;
}

export type ToolSet = Record<string, ToolDefinition>;

/** Define a tool (an identity function that keeps the types). */
export function tool<Input = any, Output = unknown>(definition: ToolDefinition<Input, Output>): ToolDefinition<Input, Output> {
  return definition;
}

/** The JSON Schema for a tool's input: `input`, or one its validator can produce, or any object. */
export function toolInputSchema(definition: ToolDefinition): Record<string, unknown> {
  if (definition.input) return definition.input;
  const standard = definition.schema?.['~standard'] as { jsonSchema?: { input?: (options: { target: string }) => Record<string, unknown> } } | undefined;
  try {
    const schema = standard?.jsonSchema?.input?.({ target: 'draft-2020-12' });
    if (schema) return schema;
  } catch {
    // fall through
  }
  return { type: 'object' };
}

/** Check a call's input with the tool's validator (if it has one). */
export async function checkToolInput<Input>(definition: ToolDefinition<Input>, input: unknown): Promise<{ value: Input } | { problems: string[] }> {
  if (!definition.schema) return { value: input as Input };
  const result = await definition.schema['~standard'].validate(input);
  if (!result.issues) return { value: result.value };
  return { problems: result.issues.map((i) => (i.path?.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)) };
}

/** A tool's output as text (for a model, or for MCP content): strings as they are, the rest as JSON. */
export function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export function toolTitle<Input>(name: string, definition: ToolDefinition<Input>, input: Input): string {
  if (typeof definition.title === 'function') {
    try {
      return definition.title(input);
    } catch {
      return name;
    }
  }
  return definition.title ?? name;
}
