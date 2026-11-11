/**
 * A model of an ACP trace: requests paired with their answers, sessions,
 * turns, tool calls, permissions, cancels and anything malformed.
 *
 * Pure and linear in the number of records. It reads both ACP v1 and v2
 * shapes and copes with traces that start late or end early.
 *
 * Every function in this file is a plain function declaration that refers
 * only to the others and to globals, because the viewer embeds them as
 * source (see ANALYZER_FUNCTIONS). Keep it that way: no module-level values.
 */
import type { TraceHeader } from '@deft-subspace/kernel';

export type Side = 'client' | 'agent';
export type JsonRpcId = string | number | null;

export type EventKind = 'request' | 'response' | 'error' | 'notification' | 'invalid' | 'note';

/** One message (or note) of the trace, in order. */
export interface TraceEvent {
  /** Position in `analysis.events`. */
  seq: number;
  /** Position in the records passed in. */
  index: number;
  t: number;
  /** Who sent it. Notes belong to the side that recorded the trace. */
  from: Side;
  kind: EventKind;
  /** For responses, the method of the request they answer. */
  method?: string;
  id?: JsonRpcId;
  sessionId?: string;
  /** `session/update` kind, e.g. `agent_message_chunk`. */
  update?: string;
  /** Short human text for the row. */
  label: string;
  /** Index into `requests`, for requests and their responses. */
  request?: number;
  turn?: number;
  toolCall?: number;
  permission?: number;
  /** A `session/cancel` or `$/cancel_request`. */
  cancel?: boolean;
  /** Set when something is wrong with this message. */
  level?: 'error' | 'warning';
}

export type RequestOutcome = 'result' | 'error' | 'cancelled' | 'unanswered';

export interface RequestInfo {
  seq: number;
  id: JsonRpcId;
  method: string;
  from: Side;
  sessionId?: string;
  t: number;
  /** Event seq of the request. */
  event: number;
  /** Event seq of the response. */
  response?: number;
  latency?: number;
  outcome: RequestOutcome;
  error?: { code?: number; message?: string; data?: unknown };
  /** Event seq of the `$/cancel_request` the requester sent for it. */
  cancelEvent?: number;
  /** The answer came after the requester had asked to cancel. */
  late?: boolean;
}

export interface SessionInfo {
  id: string;
  t: number;
  event: number;
  /** How we learned of it: created, loaded, or only seen in traffic. */
  via: 'session/new' | 'session/load' | 'session/resume' | 'seen';
  cwd?: string;
  turns: number[];
}

export type TurnStatus = 'ended' | 'cancelled' | 'error' | 'open';

export interface TurnInfo {
  seq: number;
  sessionId: string;
  prompt: string;
  t: number;
  /** Event seq of the `session/prompt` request. */
  event: number;
  request: number;
  endT?: number;
  endEvent?: number;
  duration?: number;
  stopReason?: string;
  status: TurnStatus;
  error?: unknown;
  /** Event seq of the `session/cancel` sent during the turn. */
  cancelEvent?: number;
  /** Agent message text, messages separated by a blank line. */
  text: string;
  thoughts: string;
  toolCalls: number[];
  permissions: number[];
  /** Event seqs of the first and last message that belong to the turn. */
  first: number;
  last: number;
  messages: number;
}

export interface ToolCallInfo {
  seq: number;
  id: string;
  sessionId?: string;
  turn?: number;
  title: string;
  kind?: string;
  status: string;
  history: Array<{ t: number; status: string; event: number }>;
  first: number;
  last: number;
}

export type PermissionResult = 'allowed' | 'rejected' | 'cancelled' | 'error' | 'unanswered';

export interface PermissionInfo {
  seq: number;
  sessionId?: string;
  turn?: number;
  title: string;
  toolCallId?: string;
  toolCall?: number;
  options: Array<{ optionId: string; name?: string; kind?: string }>;
  event: number;
  request: number;
  result: PermissionResult;
  optionId?: string;
  latency?: number;
}

export interface CancelInfo {
  kind: 'session' | 'request';
  event: number;
  t: number;
  from: Side;
  sessionId?: string;
  turn?: number;
  requestId?: JsonRpcId;
  request?: number;
  /** How long after the cancel the turn or request ended. */
  confirmedAfter?: number;
}

export interface Diagnostic {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  event?: number;
  /** Line number, for problems found while reading the file. */
  line?: number;
}

export interface TraceAnalysis {
  header?: TraceHeader;
  recorder: Side;
  protocol?: number;
  agent?: { name?: string; version?: string; title?: string };
  client?: { name?: string; version?: string };
  /** Time of the last record, in ms since the start. */
  duration: number;
  events: TraceEvent[];
  requests: RequestInfo[];
  sessions: SessionInfo[];
  turns: TurnInfo[];
  toolCalls: ToolCallInfo[];
  permissions: PermissionInfo[];
  cancels: CancelInfo[];
  diagnostics: Diagnostic[];
  /** Messages per method (responses count under their request's method). */
  methods: Record<string, number>;
  /** `session/update` notifications per kind. */
  updates: Record<string, number>;
}

export interface AnalyzeOptions {
  /** Which side recorded the trace. Default: from the header's `peer` (`agent` if it mentions agent, else `client`). */
  recorder?: Side;
  /** Problems found while reading the file (from `readTrace`), listed first. */
  diagnostics?: Diagnostic[];
}

/** Read JSON Lines leniently: bad lines are skipped and reported, a cut-off last line is noted. */
export function readTrace(text: string): { records: unknown[]; diagnostics: Diagnostic[] } {
  const records: unknown[] = [];
  const diagnostics: Diagnostic[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      const last = i === lines.length - 1 || (i === lines.length - 2 && !lines[lines.length - 1]!.trim());
      diagnostics.push(
        last && !text.endsWith('\n')
          ? { level: 'warning', code: 'truncated', message: `Line ${i + 1} is cut off; the trace ends early`, line: i + 1 }
          : { level: 'error', code: 'bad-line', message: `Line ${i + 1} is not JSON`, line: i + 1 }
      );
    }
  }
  return { records, diagnostics };
}

export function analyzeTrace(records: readonly unknown[], options: AnalyzeOptions = {}): TraceAnalysis {
  const diagnostics: Diagnostic[] = [...(options.diagnostics ?? [])];
  const first = records[0];
  const header = isObj(first) && first.kind === 'header' ? (first as unknown as TraceHeader) : undefined;
  if (!header) diagnostics.push({ level: 'warning', code: 'no-header', message: 'The trace has no header' });
  const recorder: Side = options.recorder ?? (header && /agent/i.test(String(header.peer)) ? 'agent' : 'client');
  const other: Side = recorder === 'client' ? 'agent' : 'client';

  const a: TraceAnalysis = {
    recorder,
    duration: 0,
    events: [],
    requests: [],
    sessions: [],
    turns: [],
    toolCalls: [],
    permissions: [],
    cancels: [],
    diagnostics,
    methods: {},
    updates: {},
  };
  if (header) a.header = header;

  const pending = new Map<string, number>();
  const answered = new Map<string, number>();
  /** Requests whose id was reused while they were open. */
  const reused = new Set<number>();
  const sessionIndex = new Map<string, number>();
  /** Sessions something succeeded for: created, loaded or resumed, updated, or a request about them answered with a result. */
  const confirmed = new Set<string>();
  const activeTurn = new Map<string, number>();
  const turnOfRequest = new Map<number, number>();
  const permissionOfRequest = new Map<number, number>();
  const toolIndex = new Map<string, number>();
  const cancelOfTurn = new Map<number, number>();
  const cancelOfRequest = new Map<number, number>();
  // Per-turn message text, built as the projection in @deft-subspace/acp does.
  const texts = new Map<number, { order: string[]; parts: Map<string, { thought: boolean; text: string }>; segment: number; lastText: boolean }>();
  let lastT = 0;

  const warn = (level: Diagnostic['level'], code: string, message: string, event?: number) => {
    diagnostics.push(event === undefined ? { level, code, message } : { level, code, message, event });
    if (event !== undefined && level !== 'info') {
      const e = a.events[event]!;
      if (e.level !== 'error') e.level = level;
    }
  };

  const session = (id: string, t: number, event: number, via: SessionInfo['via'], cwd?: string): SessionInfo => {
    let i = sessionIndex.get(id);
    if (i === undefined) {
      i = a.sessions.length;
      sessionIndex.set(id, i);
      a.sessions.push({ id, t, event, via, turns: [] });
    }
    const s = a.sessions[i]!;
    if (via !== 'seen' && s.via === 'seen') s.via = via;
    if (cwd !== undefined) s.cwd = cwd;
    return s;
  };

  const touchTurn = (turn: number | undefined, event: TraceEvent) => {
    if (turn === undefined) return;
    const info = a.turns[turn]!;
    event.turn = turn;
    info.last = event.seq;
    info.messages++;
  };

  const tool = (sessionId: string | undefined, raw: Record<string, unknown>, event: TraceEvent, create: boolean): number | undefined => {
    if (typeof raw.toolCallId !== 'string') return undefined;
    const key = `${sessionId ?? ''}\u0000${raw.toolCallId}`;
    let i = toolIndex.get(key);
    let info: ToolCallInfo;
    if (i === undefined) {
      i = a.toolCalls.length;
      toolIndex.set(key, i);
      info = { seq: i, id: raw.toolCallId, title: '', status: 'pending', history: [], first: event.seq, last: event.seq };
      if (sessionId !== undefined) info.sessionId = sessionId;
      if (event.turn !== undefined) {
        info.turn = event.turn;
        a.turns[event.turn]!.toolCalls.push(i);
      }
      a.toolCalls.push(info);
      create = true;
    } else {
      info = a.toolCalls[i]!;
      info.last = event.seq;
    }
    if (typeof raw.title === 'string' && raw.title) info.title = raw.title;
    if (typeof raw.kind === 'string') info.kind = raw.kind;
    const status = typeof raw.status === 'string' ? raw.status : create ? 'pending' : undefined;
    if (status !== undefined) {
      info.status = status;
      const lastStatus = info.history[info.history.length - 1];
      if (!lastStatus || lastStatus.status !== status) info.history.push({ t: event.t, status, event: event.seq });
    }
    event.toolCall = i;
    return i;
  };

  const addText = (turn: number | undefined, update: Record<string, unknown>, kind: string) => {
    if (turn === undefined) return;
    let state = texts.get(turn);
    if (!state) texts.set(turn, (state = { order: [], parts: new Map(), segment: 0, lastText: false }));
    const thought = kind.indexOf('thought') >= 0;
    const whole = kind === 'agent_message' || kind === 'agent_thought';
    let id = typeof update.messageId === 'string' && update.messageId ? update.messageId : '';
    if (!id) {
      if (!state.lastText) state.segment++;
      id = `${thought ? 't' : 'm'}${state.segment}`;
    }
    state.lastText = true;
    let part = state.parts.get(id);
    if (!part) {
      part = { thought, text: '' };
      state.parts.set(id, part);
      state.order.push(id);
    }
    const text = contentText(update.content);
    part.text = whole ? text : part.text + text;
  };

  const endTurn = (turn: number, event: TraceEvent, stopReason: string, error?: unknown) => {
    const info = a.turns[turn]!;
    if (info.status !== 'open') return;
    info.endT = event.t;
    info.endEvent = event.seq;
    info.duration = event.t - info.t;
    info.stopReason = stopReason;
    info.status = stopReason === 'cancelled' ? 'cancelled' : stopReason === 'error' ? 'error' : 'ended';
    if (error !== undefined) info.error = error;
    if (activeTurn.get(info.sessionId) === turn) activeTurn.delete(info.sessionId);
    const cancel = cancelOfTurn.get(turn);
    if (cancel !== undefined) a.cancels[cancel]!.confirmedAfter = event.t - a.cancels[cancel]!.t;
  };

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isObj(record)) {
      diagnostics.push({ level: 'error', code: 'bad-record', message: `Record ${index + 1} is not an object` });
      continue;
    }
    if (record.kind === 'header') {
      if (index !== 0) diagnostics.push({ level: 'warning', code: 'extra-header', message: `Record ${index + 1} is a second header` });
      continue;
    }
    const t = typeof record.t === 'number' && isFinite(record.t) ? record.t : lastT;
    if (t > lastT) lastT = t;
    const seq = a.events.length;

    if (record.kind === 'note') {
      a.events.push({ seq, index, t, from: recorder, kind: 'note', label: clip(String(record.text ?? ''), 160) });
      continue;
    }
    if (record.kind !== 'message') {
      diagnostics.push({ level: 'warning', code: 'bad-record', message: `Record ${index + 1} has unknown kind ${JSON.stringify(record.kind)}` });
      continue;
    }

    const from: Side = record.dir === 'in' ? other : recorder;
    const msg = record.msg;
    const event: TraceEvent = { seq, index, t, from, kind: 'invalid', label: '' };
    a.events.push(event);
    if (record.dir !== 'in' && record.dir !== 'out') warn('warning', 'bad-direction', `Message ${seq + 1} has no direction`, seq);

    if (!isObj(msg)) {
      event.label = Array.isArray(msg) ? 'batch (not supported by ACP)' : `not a JSON-RPC message: ${clip(JSON.stringify(msg) ?? String(msg), 80)}`;
      warn('error', 'invalid-message', `Message ${seq + 1} is not a JSON-RPC object`, seq);
      continue;
    }
    if (msg.jsonrpc !== '2.0') warn('warning', 'not-jsonrpc-2', `Message ${seq + 1} lacks "jsonrpc": "2.0"`, seq);
    const params = isObj(msg.params) ? msg.params : {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;

    if (typeof msg.method === 'string') {
      const method = msg.method;
      event.method = method;
      a.methods[method] = (a.methods[method] ?? 0) + 1;
      if (sessionId !== undefined) {
        event.sessionId = sessionId;
        session(sessionId, t, seq, method === 'session/load' || method === 'session/resume' ? method : 'seen');
      }

      if ('id' in msg) {
        // A request.
        const id = msg.id as JsonRpcId;
        event.kind = 'request';
        event.id = id;
        if (!isId(id)) warn('error', 'invalid-id', `Request ${method} has an invalid id ${JSON.stringify(id)}`, seq);
        const rq = a.requests.length;
        const info: RequestInfo = { seq: rq, id, method, from, t, event: seq, outcome: 'unanswered' };
        if (sessionId !== undefined) info.sessionId = sessionId;
        a.requests.push(info);
        event.request = rq;
        const key = idKey(from, id);
        if (pending.has(key)) {
          warn('error', 'duplicate-request-id', `${from} reused id ${JSON.stringify(id)} while it was still open`, seq);
          // Its answer cannot be told apart from the new one's: already reported, not also "never answered".
          reused.add(pending.get(key)!);
        }
        pending.set(key, rq);
        answered.delete(key);
        event.label = requestLabel(method, params);

        if (method === 'initialize') {
          if (isObj(params.clientInfo)) a.client = params.clientInfo as TraceAnalysis['client'];
        } else if (method === 'session/prompt' && sessionId !== undefined) {
          const open = activeTurn.get(sessionId);
          if (open !== undefined) warn('warning', 'overlapping-turn', `A prompt was sent while turn ${open + 1} was still running`, seq);
          const turn = a.turns.length;
          a.turns.push({
            seq: turn, sessionId, prompt: promptText(params.prompt), t, event: seq, request: rq, status: 'open',
            text: '', thoughts: '', toolCalls: [], permissions: [], first: seq, last: seq, messages: 0,
          });
          session(sessionId, t, seq, 'seen').turns.push(turn);
          activeTurn.set(sessionId, turn);
          turnOfRequest.set(rq, turn);
          touchTurn(turn, event);
        } else {
          touchTurn(sessionId !== undefined ? activeTurn.get(sessionId) : undefined, event);
        }

        if (method === 'session/request_permission') {
          const subject = isObj(params.subject) ? params.subject : undefined;
          const rawTool = isObj(params.toolCall) ? params.toolCall : subject && isObj(subject.toolCall) ? subject.toolCall : undefined;
          const toolSeq = rawTool ? tool(sessionId, rawTool, event, false) : undefined;
          const p = a.permissions.length;
          const toolTitle = toolSeq !== undefined ? a.toolCalls[toolSeq]!.title : '';
          const title =
            typeof params.title === 'string' ? params.title : toolTitle || (subject && typeof subject.command === 'string' ? subject.command : 'Permission requested');
          const perm: PermissionInfo = {
            seq: p, title, event: seq, request: rq, result: 'unanswered',
            options: Array.isArray(params.options) ? params.options.filter(isObj).map((o) => ({ optionId: String(o.optionId), name: o.name as string | undefined, kind: o.kind as string | undefined })) : [],
          };
          if (sessionId !== undefined) perm.sessionId = sessionId;
          if (event.turn !== undefined) {
            perm.turn = event.turn;
            a.turns[event.turn]!.permissions.push(p);
          }
          if (rawTool && typeof rawTool.toolCallId === 'string') perm.toolCallId = rawTool.toolCallId;
          if (toolSeq !== undefined) perm.toolCall = toolSeq;
          a.permissions.push(perm);
          permissionOfRequest.set(rq, p);
          event.permission = p;
          event.label = `permission: ${clip(title, 100)}`;
        }
        continue;
      }

      // A notification.
      event.kind = 'notification';
      const turn = sessionId !== undefined ? activeTurn.get(sessionId) : undefined;
      touchTurn(turn, event);
      event.label = method;
      if (method === 'session/update') {
        if (sessionId !== undefined) confirmed.add(sessionId);
        const update = isObj(params.update) ? params.update : {};
        const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '?';
        event.update = kind;
        a.updates[kind] = (a.updates[kind] ?? 0) + 1;
        event.label = updateLabel(kind, update);
        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'agent_message' || kind === 'agent_thought') {
          addText(turn, update, kind);
        } else {
          const state = turn !== undefined ? texts.get(turn) : undefined;
          if (state) state.lastText = false;
        }
        if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_call_content_chunk') {
          const toolSeq = tool(sessionId, update, event, kind === 'tool_call');
          if (toolSeq !== undefined && kind !== 'tool_call') {
            const title = a.toolCalls[toolSeq]!.title;
            if (title && typeof update.title !== 'string') event.label = `${kind}: ${clip(title, 60)}${typeof update.status === 'string' ? ` → ${update.status}` : ''}`;
          }
        } else if (kind === 'state_update') {
          if (a.protocol === undefined) a.protocol = 2;
          if (update.state === 'idle' && turn !== undefined) {
            // v2: the turn ends at idle.
            endTurn(turn, event, typeof update.stopReason === 'string' ? update.stopReason : 'end_turn', update.error);
          }
        } else if (kind === 'user_message' && turn !== undefined && !a.turns[turn]!.prompt) {
          a.turns[turn]!.prompt = contentText(update.content);
        }
      } else if (method === 'session/cancel') {
        event.cancel = true;
        event.label = 'cancel turn';
        const c = a.cancels.length;
        const cancel: CancelInfo = { kind: 'session', event: seq, t, from };
        if (sessionId !== undefined) cancel.sessionId = sessionId;
        if (turn !== undefined) {
          cancel.turn = turn;
          if (a.turns[turn]!.cancelEvent === undefined) {
            a.turns[turn]!.cancelEvent = seq;
            cancelOfTurn.set(turn, c);
          }
        } else {
          warn('info', 'cancel-without-turn', 'session/cancel with no turn running', seq);
        }
        a.cancels.push(cancel);
      } else if (method === '$/cancel_request') {
        event.cancel = true;
        const requestId = params.requestId as JsonRpcId;
        const target = pending.get(idKey(from, requestId));
        const c = a.cancels.length;
        const cancel: CancelInfo = { kind: 'request', event: seq, t, from, requestId };
        event.label = `cancel request ${JSON.stringify(requestId)}`;
        if (target !== undefined) {
          const rq = a.requests[target]!;
          rq.cancelEvent = seq;
          cancel.request = target;
          cancelOfRequest.set(target, c);
          event.request = target;
          event.label = `cancel ${rq.method} #${JSON.stringify(requestId)}`;
          if (rq.sessionId !== undefined) cancel.sessionId = rq.sessionId;
        } else {
          warn('info', 'cancel-unknown-request', `$/cancel_request for ${JSON.stringify(requestId)}, which is not open`, seq);
        }
        a.cancels.push(cancel);
      }
      continue;
    }

    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      // A response: it answers a request the other side sent.
      const id = msg.id as JsonRpcId;
      event.id = id;
      const isError = 'error' in msg;
      event.kind = isError ? 'error' : 'response';
      const key = idKey(from === 'client' ? 'agent' : 'client', id);
      const rqSeq = pending.get(key);
      if (rqSeq === undefined) {
        const before = answered.get(key);
        event.label = `${isError ? 'error' : 'result'} for unknown id ${JSON.stringify(id)}`;
        if (before !== undefined) {
          event.method = a.requests[before]!.method;
          event.request = before;
          warn('error', 'duplicate-response', `Request ${JSON.stringify(id)} (${event.method}) was answered twice`, seq);
        } else {
          warn('warning', 'orphan-response', `No request with id ${JSON.stringify(id)} was seen; the trace may start late`, seq);
        }
        continue;
      }
      pending.delete(key);
      answered.set(key, rqSeq);
      const rq = a.requests[rqSeq]!;
      const method = rq.method;
      event.method = method;
      event.request = rqSeq;
      a.methods[method] = (a.methods[method] ?? 0) + 1;
      if (rq.sessionId !== undefined) event.sessionId = rq.sessionId;
      rq.response = seq;
      rq.latency = t - rq.t;
      if (rq.cancelEvent !== undefined) {
        rq.late = true;
        const c = cancelOfRequest.get(rqSeq);
        if (c !== undefined) a.cancels[c]!.confirmedAfter = t - a.cancels[c]!.t;
      }
      const result = isObj(msg.result) ? msg.result : {};
      const turnSeq = turnOfRequest.get(rqSeq);
      touchTurn(turnSeq ?? (rq.sessionId !== undefined ? activeTurn.get(rq.sessionId) : undefined), event);

      if (isError) {
        const err = isObj(msg.error) ? msg.error : {};
        rq.error = { code: typeof err.code === 'number' ? err.code : undefined, message: typeof err.message === 'string' ? err.message : undefined };
        if (err.data !== undefined) rq.error.data = err.data;
        rq.outcome = err.code === -32800 ? 'cancelled' : 'error';
        // Loading names a session the client knew; a cancel says nothing against it.
        if (rq.outcome === 'cancelled' && (method === 'session/load' || method === 'session/resume') && rq.sessionId !== undefined) confirmed.add(rq.sessionId);
        event.label = `${rq.outcome === 'cancelled' ? 'cancelled' : 'error'} ${err.code ?? ''} ${clip(String(err.message ?? ''), 80)}`.replace(/\s+/g, ' ').trim();
        if (rq.outcome === 'error') event.level = 'error';
        if (turnSeq !== undefined) endTurn(turnSeq, event, rq.outcome === 'cancelled' ? 'cancelled' : 'error', msg.error);
        const p = permissionOfRequest.get(rqSeq);
        if (p !== undefined) a.permissions[p]!.result = rq.outcome === 'cancelled' ? 'cancelled' : 'error';
        if (p !== undefined) a.permissions[p]!.latency = rq.latency;
        continue;
      }

      rq.outcome = 'result';
      if (rq.sessionId !== undefined) confirmed.add(rq.sessionId);
      event.label = resultLabel(method, result);
      if (method === 'initialize') {
        if (typeof result.protocolVersion === 'number') a.protocol = result.protocolVersion;
        const info = isObj(result.agentInfo) ? result.agentInfo : isObj(result.info) ? result.info : undefined;
        if (info) a.agent = info as TraceAnalysis['agent'];
      } else if ((method === 'session/new' || method === 'session/load' || method === 'session/resume') && (typeof result.sessionId === 'string' || rq.sessionId)) {
        const sid = typeof result.sessionId === 'string' ? result.sessionId : rq.sessionId!;
        const requestMsg = (records[a.events[rq.event]!.index] as { msg?: { params?: { cwd?: unknown } } }).msg;
        const cwd = requestMsg?.params?.cwd;
        session(sid, rq.t, rq.event, method, typeof cwd === 'string' ? cwd : undefined);
        confirmed.add(sid);
        event.sessionId = sid;
      } else if (method === 'session/prompt' && turnSeq !== undefined) {
        if (typeof result.stopReason === 'string') {
          if (a.protocol === undefined) a.protocol = 1;
          endTurn(turnSeq, event, result.stopReason);
        }
      } else if (method === 'session/request_permission') {
        const p = permissionOfRequest.get(rqSeq);
        if (p !== undefined) {
          const perm = a.permissions[p]!;
          perm.latency = rq.latency;
          const outcome = isObj(result.outcome) ? result.outcome : {};
          if (outcome.outcome === 'selected' && typeof outcome.optionId === 'string') {
            perm.optionId = outcome.optionId;
            const option = perm.options.find((o) => o.optionId === outcome.optionId);
            if (!option) warn('warning', 'unknown-option', `Permission answered with option ${outcome.optionId}, which was not offered`, seq);
            perm.result = option && typeof option.kind === 'string' && option.kind.indexOf('allow') === 0 ? 'allowed' : 'rejected';
          } else {
            perm.result = 'cancelled';
          }
          event.label = `permission ${perm.result}${perm.optionId ? ` (${perm.optionId})` : ''}`;
        }
      }
      continue;
    }

    event.label = `invalid: ${clip(JSON.stringify(msg), 80)}`;
    warn('error', 'invalid-message', `Message ${seq + 1} is neither a request, a notification nor a response`, seq);
  }

  a.duration = lastT;
  for (const rq of a.requests) {
    if (rq.outcome !== 'unanswered' || reused.has(rq.seq)) continue;
    if (rq.cancelEvent !== undefined) rq.outcome = 'cancelled';
    warn(rq.cancelEvent !== undefined ? 'info' : 'warning', 'unanswered', `${rq.method} #${JSON.stringify(rq.id)} from the ${rq.from} was never answered`, rq.event);
  }
  for (const turn of a.turns) {
    const state = texts.get(turn.seq);
    if (state) {
      const parts = state.order.map((id) => state.parts.get(id)!);
      turn.text = joinMessages(parts.filter((p) => !p.thought).map((p) => p.text));
      turn.thoughts = joinMessages(parts.filter((p) => p.thought).map((p) => p.text));
    }
    if (turn.status === 'open') warn('warning', 'turn-open', `Turn ${turn.seq + 1} never ended; the trace may be cut short`, turn.event);
  }
  // An id seen only in requests that failed (a prompt for an unknown session, say) is not a session.
  for (const s of a.sessions) {
    if (!confirmed.has(s.id)) warn('info', 'session-unconfirmed', `${JSON.stringify(s.id)} appears only in requests that failed; not counted as a session`, s.event);
  }
  a.sessions = a.sessions.filter((s) => confirmed.has(s.id));
  return a;
}

/** Plain-text summary, for the terminal. */
export function formatSummary(a: TraceAnalysis): string {
  const lines: string[] = [];
  const h = a.header;
  const agent = a.agent ? `${a.agent.name ?? '?'} ${a.agent.version ?? ''}`.trim() : 'unknown agent';
  lines.push(`${h?.label ? `${h.label}: ` : ''}${agent}, protocol ${a.protocol ? `v${a.protocol}` : 'unknown'}, recorded by the ${a.recorder}`);
  if (h?.started) lines.push(`started ${h.started}, ${formatMs(a.duration)} long`);
  const msgs = a.events.filter((e) => e.kind !== 'note').length;
  const errors = a.requests.filter((r) => r.outcome === 'error').length;
  lines.push(
    `${msgs} messages, ${a.requests.length} requests (${errors} errors), ${a.sessions.length} sessions, ${a.turns.length} turns, ${a.toolCalls.length} tool calls, ${a.permissions.length} permissions, ${a.cancels.length} cancels`
  );
  if (a.turns.length) lines.push('', 'Turns:');
  for (const turn of a.turns) {
    const bits = [
      turn.status === 'open' ? 'open' : turn.stopReason,
      turn.duration !== undefined ? formatMs(turn.duration) : '',
      turn.toolCalls.length ? `${turn.toolCalls.length} tools` : '',
      turn.permissions.length ? `${turn.permissions.length} permissions (${turn.permissions.map((p) => a.permissions[p]!.result).join(', ')})` : '',
      turn.cancelEvent !== undefined ? 'cancel sent' : '',
    ].filter(Boolean);
    lines.push(`  ${turn.seq + 1}. ${JSON.stringify(clip(turn.prompt, 60))}  ${bits.join(' · ')}`);
  }
  const slow = a.requests.filter((r) => r.latency !== undefined).sort((x, y) => y.latency! - x.latency!).slice(0, 3);
  if (slow.length) {
    lines.push('', 'Slowest requests:');
    for (const r of slow) lines.push(`  ${r.method} #${JSON.stringify(r.id)}  ${formatMs(r.latency!)}  ${r.outcome}`);
  }
  const shown = a.diagnostics.filter((d) => d.level !== 'info');
  if (shown.length) {
    lines.push('', 'Diagnostics:');
    for (const d of shown.slice(0, 20)) lines.push(`  ${d.level}: ${d.message}`);
    if (shown.length > 20) lines.push(`  ... and ${shown.length - 20} more`);
  }
  return lines.join('\n') + '\n';
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): boolean {
  return value === null || typeof value === 'string' || (typeof value === 'number' && isFinite(value));
}

/** Ids are opaque and per sender: `0` and `"0"` differ, and each side numbers its own. */
function idKey(from: string, id: unknown): string {
  return `${from} ${JSON.stringify(id)}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(contentText).join('');
  if (isObj(content) && content.type === 'text' && typeof content.text === 'string') return content.text;
  if (isObj(content) && isObj(content.content)) return contentText(content.content);
  return '';
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  return prompt.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : isObj(b) && typeof b.type === 'string' ? `[${b.type}]` : '')).filter(Boolean).join('\n');
}

function joinMessages(parts: string[]): string {
  let out = '';
  for (const text of parts) {
    if (!text) continue;
    if (out && !out.endsWith('\n')) out += '\n\n';
    out += text;
  }
  return out;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function requestLabel(method: string, params: Record<string, unknown>): string {
  if (method === 'initialize') return `initialize v${String(params.protocolVersion ?? '?')}`;
  if (method === 'session/new') return `new session${typeof params.cwd === 'string' ? ` in ${clip(params.cwd, 60)}` : ''}`;
  if (method === 'session/prompt') return `prompt “${clip(promptText(params.prompt), 100)}”`;
  if (method === 'fs/read_text_file' || method === 'fs/write_text_file') return `${method} ${String(params.path ?? '')}`;
  if (method === 'session/set_mode') return `set mode ${String(params.modeId ?? '')}`;
  return method;
}

function updateLabel(kind: string, update: Record<string, unknown>): string {
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'agent_message' || kind === 'agent_thought' || kind === 'user_message' || kind === 'user_message_chunk') {
    return `${kind}  ${JSON.stringify(clip(contentText(update.content), 90))}`;
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const title = typeof update.title === 'string' ? clip(update.title, 60) : String(update.toolCallId ?? '');
    return `${kind}: ${title}${typeof update.status === 'string' ? ` → ${update.status}` : ''}`;
  }
  if (kind === 'state_update') return `state → ${String(update.state)}${update.stopReason ? ` (${String(update.stopReason)})` : ''}`;
  if (kind === 'plan' || kind === 'plan_update') {
    const entries = Array.isArray(update.entries) ? update.entries : isObj(update.plan) && Array.isArray(update.plan.entries) ? update.plan.entries : [];
    return `${kind}: ${entries.length} entries`;
  }
  if (kind === 'usage_update') return `usage ${String(update.used)} / ${String(update.size)}`;
  return kind;
}

function resultLabel(method: string, result: Record<string, unknown>): string {
  if (method === 'initialize') {
    const info = isObj(result.agentInfo) ? result.agentInfo : isObj(result.info) ? result.info : {};
    return `protocol v${String(result.protocolVersion ?? '?')}${info.name ? ` · ${String(info.name)}` : ''}`;
  }
  if (typeof result.sessionId === 'string') return `session ${clip(result.sessionId, 40)}`;
  if (method === 'session/prompt') return typeof result.stopReason === 'string' ? `stop: ${result.stopReason}` : 'accepted';
  return 'result';
}

/** The analyzer's functions, so the viewer can embed them as source and open dropped files. */
export const ANALYZER_FUNCTIONS: ReadonlyArray<(...args: never[]) => unknown> = [
  readTrace,
  analyzeTrace,
  isObj,
  isId,
  idKey,
  clip,
  contentText,
  promptText,
  joinMessages,
  formatMs,
  requestLabel,
  updateLabel,
  resultLabel,
];
