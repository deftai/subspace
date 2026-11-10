import { ndjson, type Channel } from '@deft-subspace/kernel';
import { rechunk } from '@deft-subspace/kernel/testing';
import { DEFAULT_PROMPTS } from '@deft-subspace/acp-testkit';
import type { AgentTurn } from '@deft-subspace/acp';

/** Two byte ends joined as NDJSON, like stdio, re-chunked byte by byte unless `fault` says otherwise. */
export function byteLink(fault: () => TransformStream<Uint8Array, Uint8Array> = () => rechunk(1)) {
  const aToB = new TransformStream<Uint8Array, Uint8Array>();
  const bToA = new TransformStream<Uint8Array, Uint8Array>();
  const a: Channel<Uint8Array> = { readable: bToA.readable.pipeThrough(fault()), writable: aToB.writable };
  const b: Channel<Uint8Array> = { readable: aToB.readable.pipeThrough(fault()), writable: bToA.writable };
  let client: Channel<unknown> | undefined;
  let agent: Channel<unknown> | undefined;
  return {
    a,
    b,
    get client() {
      return (client ??= ndjson(a));
    },
    get agent() {
      return (agent ??= ndjson(b));
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** A serveAgent prompt handler that behaves well for each of checkAgent's default prompts. */
export async function wellBehaved(turn: AgentTurn) {
  if (turn.text === DEFAULT_PROMPTS.longPrompt) {
    for (let i = 1; i <= 300 && !turn.signal.aborted; i++) {
      await turn.say(`${i}\n`);
      await sleep(5);
    }
    return 'end_turn';
  }
  if (turn.text === DEFAULT_PROMPTS.permissionPrompt) {
    const call = await turn.toolCall({ title: 'Write deft-testkit.txt', kind: 'edit' });
    const answer = await turn.requestPermission({ title: 'Write deft-testkit.txt', toolCallId: call.id });
    if (answer.allowed) await call.complete();
    else await call.fail();
    // Answered cancelled: the cancel itself is on its way.
    if (answer.outcome === 'cancelled') await untilAborted(turn.signal);
    return 'end_turn';
  }
  await turn.say('OK');
  return 'end_turn';
}
