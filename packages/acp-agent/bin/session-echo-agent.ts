#!/usr/bin/env node
/**
 * Stdio session-echo agent for phase-2 product tests.
 * Implements session/new|load|prompt|cancel; reverse-requests permissions.
 */
import { createInterface } from "node:readline";
import {
  type AcpMessage,
  NdjsonCodec,
} from "../../acp-wire/src/index.ts";

const te = new TextEncoder();

type Handler = (params: unknown) => Promise<unknown> | unknown;

const sessions = new Map<string, { turns: number }>();
const cancelFlags = new Map<string, boolean>();

let nextOutId = 9000;
const pending = new Map<
  string | number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

function writeMsg(msg: AcpMessage) {
  process.stdout.write(NdjsonCodec.encode(msg));
}

async function reverseRequest(
  method: string,
  params?: unknown,
): Promise<unknown> {
  const id = nextOutId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeMsg({ kind: "request", id, method, params });
  });
}

function notify(method: string, params?: unknown) {
  writeMsg({ kind: "notification", method, params });
}

const handlers: Record<string, Handler> = {
  async "session/new"(params) {
    const id = crypto.randomUUID();
    sessions.set(id, { turns: 0 });
    cancelFlags.set(id, false);
    const p = (params ?? {}) as { cwd?: string };
    return { sessionId: id, cwd: p.cwd };
  },
  async "session/load"(params) {
    const p = params as { sessionId?: string };
    if (!p?.sessionId) throw new Error("session/load requires sessionId");
    if (!sessions.has(p.sessionId)) sessions.set(p.sessionId, { turns: 0 });
    cancelFlags.set(p.sessionId, false);
    return { sessionId: p.sessionId };
  },
  async "session/prompt"(params) {
    const p = params as { sessionId?: string; prompt?: unknown };
    if (!p?.sessionId) throw new Error("session/prompt requires sessionId");
    if (!sessions.has(p.sessionId)) {
      throw new Error(`unknown session ${p.sessionId}`);
    }
    cancelFlags.set(p.sessionId, false);
    const rec = sessions.get(p.sessionId)!;
    rec.turns += 1;
    const promptText =
      typeof p.prompt === "string"
        ? p.prompt
        : JSON.stringify(p.prompt ?? null);

    notify("session/update", {
      sessionId: p.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `turn:${rec.turns}:${promptText}` },
      },
    });

    if (promptText === "need-perm") {
      const perm = await reverseRequest("session/request_permission", {
        sessionId: p.sessionId,
        toolCall: { kind: "read", title: "read workspace file" },
      });
      notify("session/update", {
        sessionId: p.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `perm:${JSON.stringify(perm)}` },
        },
      });
    }

    if (promptText === "slow") {
      for (let i = 0; i < 30; i++) {
        if (cancelFlags.get(p.sessionId)) {
          return { stopReason: "cancelled" };
        }
        await new Promise((r) => setTimeout(r, 15));
        notify("session/update", {
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `slow:${i}` },
          },
        });
      }
    }

    if (cancelFlags.get(p.sessionId)) {
      return { stopReason: "cancelled" };
    }
    return { stopReason: "end_turn", turns: rec.turns };
  },
  async "session/cancel"(params) {
    const p = params as { sessionId?: string };
    if (!p?.sessionId) throw new Error("session/cancel requires sessionId");
    cancelFlags.set(p.sessionId, true);
    return null;
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let msg: AcpMessage;
  try {
    msg = NdjsonCodec.decodeLine(te.encode(line));
  } catch {
    continue;
  }

  if (msg.kind === "response") {
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(msg.error);
    else p.resolve(msg.result);
    continue;
  }

  if (msg.kind !== "request") continue;
  // Concurrent dispatch so session/cancel can interrupt an in-flight prompt
  const handler = handlers[msg.method];
  const reqId = msg.id;
  void (async () => {
    try {
      const result = handler ? await handler(msg.params) : null;
      writeMsg({ kind: "response", id: reqId, result });
    } catch (error) {
      writeMsg({
        kind: "response",
        id: reqId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })();
}
