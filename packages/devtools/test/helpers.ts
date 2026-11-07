import type { TraceRecord } from '@deft-subspace/kernel';

type Step = [t: number, dir: 'in' | 'out', msg: unknown];

/** A trace recorded by `peer`: a header, then messages. */
export function trace(peer: string, ...steps: Step[]): TraceRecord[] {
  return [
    { v: 1, kind: 'header', started: '2026-01-01T00:00:00.000Z', peer, label: 'test' },
    ...steps.map(([t, dir, msg]): TraceRecord => ({ v: 1, kind: 'message', t, dir, msg })),
  ];
}

export const req = (id: unknown, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
export const res = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
export const err = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
export const note = (method: string, params?: unknown) => ({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
export const update = (sessionId: string, u: Record<string, unknown>) => note('session/update', { sessionId, update: u });
export const text = (t: string) => ({ type: 'text', text: t });
