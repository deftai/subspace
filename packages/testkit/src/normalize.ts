import type { TurnResult } from '@deft-subspace/acp';

/** A TurnResult without what changes from run to run (ids, raw payloads), for comparing runs and replays. */
export interface NormalizedTurn {
  stopReason: string;
  cancelled: boolean;
  forced: boolean;
  text: string;
  toolCalls: Array<{ title: string; kind?: string; status: string; content: number }>;
}

export function normalizeTurn(result: TurnResult): NormalizedTurn {
  return {
    stopReason: result.stopReason,
    cancelled: result.cancelled,
    forced: result.forced ?? false,
    text: result.text,
    toolCalls: result.toolCalls.map((c) => ({
      title: c.title,
      ...(c.kind !== undefined ? { kind: c.kind } : {}),
      status: c.status,
      content: c.content.length,
    })),
  };
}
