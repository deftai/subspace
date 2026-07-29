/**
 * @deft/acp-probe — thin host CLI library over phase-2 acp-client product.
 *
 * Owns: one-shot stdio spawn probe (create → prompt → collect), argv parsing,
 * and human-readable event lines / help text for the bin entry.
 * Does not own: session store, NDJSON codec, or a second client — wire + product only.
 */
import {
  defineAcpClientProduct,
  formatWireError,
  type AgentEvent,
  type PermissionPolicy,
} from "@deft/acp-client";
import { defineStdioTransport } from "@deft/acp-wire";

/** Inputs for a single probe run (spawn + one prompt). */
export type ProbeOptions = {
  command: string;
  args?: readonly string[];
  prompt: string;
  permissionPolicy?: PermissionPolicy;
  /** Wall-clock timeout for the whole probe run (ms). */
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Called for each demuxed agent event (default: no-op). */
  onEvent?: (event: AgentEvent) => void;
};

/** Successful probe: session ids plus full demuxed event list. */
export type ProbeResult = {
  ok: true;
  acpSessionId: string;
  localId: string;
  events: AgentEvent[];
};

/** Soft failure: transport/agent/timeout — not programmer misuse. */
export type ProbeFailure = {
  ok: false;
  error: string;
  events: AgentEvent[];
};

/**
 * Spawn an agent over stdio, create a session, prompt once, collect events.
 * Throws only for programmer misuse; transport/agent failures return ok:false.
 * Timeout races the whole run and sets a flag so the prompt loop can exit early.
 */
export async function runProbe(
  options: ProbeOptions,
): Promise<ProbeResult | ProbeFailure> {
  const events: AgentEvent[] = [];
  const onEvent = options.onEvent ?? (() => undefined);
  const permissionPolicy = options.permissionPolicy ?? "deny";

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs;

  /** Core path without outer race: connect, prompt, close product. */
  const run = async (): Promise<ProbeResult | ProbeFailure> => {
    try {
      const transport = await defineStdioTransport({
        mode: "spawn",
        command: options.command,
        args: options.args ?? [],
        cwd: options.cwd,
        env: options.env,
      }).connect();

      const product = await defineAcpClientProduct({
        permissionPolicy,
      }).connect(transport);

      try {
        // Align spawn cwd with session/new cwd (real agents require both fields).
        const sessionCwd = options.cwd ?? process.cwd();
        const session = await product.sessions.create({ cwd: sessionCwd });
        // ACP session/prompt expects ContentBlock[]; plain string is fixture-only.
        const promptBlocks = [{ type: "text" as const, text: options.prompt }];
        for await (const event of session.prompt(promptBlocks)) {
          // Cooperative exit when wall-clock race already lost
          if (timedOut) break;
          events.push(event);
          onEvent(event);
          if (event.type === "prompt_error") {
            return {
              ok: false,
              error: formatWireError(event.error),
              events,
            };
          }
        }

        if (timedOut) {
          return { ok: false, error: `timeout after ${timeoutMs}ms`, events };
        }

        // Host contract: a finished prompt stream should end with prompt_done
        const done = events.find((e) => e.type === "prompt_done");
        if (!done) {
          return {
            ok: false,
            error: "prompt finished without prompt_done",
            events,
          };
        }

        return {
          ok: true,
          acpSessionId: session.acpSessionId,
          localId: session.localId,
          events,
        };
      } finally {
        // Always tear down product even when returning early on error/timeout
        await product.close().catch(() => undefined);
      }
    } catch (error) {
      return {
        ok: false,
        error: formatWireError(error),
        events,
      };
    }
  };

  // Optional wall-clock race: timeout side sets timedOut so run() can stop the loop
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const raced = await Promise.race([
      run(),
      new Promise<ProbeFailure>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve({
            ok: false,
            error: `timeout after ${timeoutMs}ms`,
            events,
          });
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return raced;
  }

  return run();
}

/** Single-line JSON for CLI stdout streaming of demuxed events. */
export function formatEventLine(event: AgentEvent): string {
  return JSON.stringify(event);
}

/** Parsed CLI flags for the acp-probe bin (or help-only mode). */
export type ParsedCli = {
  command: string;
  args: string[];
  prompt: string;
  permissionPolicy: PermissionPolicy;
  timeoutMs?: number;
  cwd?: string;
  help?: boolean;
};

/**
 * Minimal argv parser. Supports:
 *   --command / -c
 *   --arg / -a  (repeatable)
 *   --prompt / -p
 *   --permission deny|approve-reads
 *   --timeout <ms>
 *   --cwd <path>
 *   --help / -h
 * Returns `{ error }` for bad flags/values; help short-circuits required fields.
 */
export function parseArgv(argv: string[]): ParsedCli | { error: string } {
  let command: string | undefined;
  const args: string[] = [];
  let prompt: string | undefined;
  let permissionPolicy: PermissionPolicy = "deny";
  let timeoutMs: number | undefined;
  let cwd: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    /** Consume the next argv token or throw for missing value. */
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value after ${a}`);
      return v;
    };
    try {
      if (a === "--help" || a === "-h") {
        help = true;
        continue;
      }
      if (a === "--command" || a === "-c") {
        command = next();
        continue;
      }
      if (a === "--arg" || a === "-a") {
        args.push(next());
        continue;
      }
      if (a === "--prompt" || a === "-p") {
        prompt = next();
        continue;
      }
      if (a === "--permission") {
        const v = next();
        if (v !== "deny" && v !== "approve-reads") {
          return {
            error: `--permission must be deny or approve-reads (got ${v})`,
          };
        }
        permissionPolicy = v;
        continue;
      }
      if (a === "--timeout") {
        const v = Number(next());
        if (!Number.isFinite(v) || v <= 0) {
          return { error: `--timeout must be a positive number (ms)` };
        }
        timeoutMs = v;
        continue;
      }
      if (a === "--cwd") {
        cwd = next();
        continue;
      }
      return { error: `unknown flag: ${a}` };
    } catch (e) {
      // next() throws when a flag lacks its value
      return {
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Help may omit required flags; bin prints HELP_TEXT and exits 0
  if (help) {
    return {
      command: command ?? "",
      args,
      prompt: prompt ?? "",
      permissionPolicy,
      timeoutMs,
      cwd,
      help: true,
    };
  }

  if (!command) return { error: "--command is required" };
  if (!prompt) return { error: "--prompt is required" };

  return {
    command,
    args,
    prompt,
    permissionPolicy,
    timeoutMs,
    cwd,
  };
}

/** Usage blurb for --help and parse errors (kept next to parseArgv). */
export const HELP_TEXT = `acp-probe — thin ACP host smoke CLI (phase 3)

Usage:
  acp-probe --command <cmd> [--arg <a>]... --prompt <text> [options]

Options:
  -c, --command <cmd>       Agent executable (required)
  -a, --arg <arg>           Agent arg (repeatable)
  -p, --prompt <text>       Prompt to send (required)
      --permission <mode>   deny | approve-reads (default: deny)
      --timeout <ms>        Wall-clock timeout for the run
      --cwd <path>          Working directory (spawn + session/new; default process.cwd())
  -h, --help                Show help

Exit codes:
  0  success
  1  bad flags / usage
  2  agent, transport, or prompt failure
  3  timeout
`;
