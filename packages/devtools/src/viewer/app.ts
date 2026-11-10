/**
 * The trace viewer, as it runs in the browser.
 *
 * `renderTraceHtml` embeds `viewerApp` as source, after the analyzer's
 * functions, so it must be self-contained: it may use only browser globals and
 * the analyzer (`analyzeTrace`, `readTrace`). It never runs in Node.
 *
 * The list is virtualized: rows have one height and only the visible ones are
 * in the DOM, so 10,000 messages scroll as smoothly as 10. Every rebuild
 * (filter, collapse) is one linear pass.
 */
import { analyzeTrace, readTrace, type Diagnostic, type TraceAnalysis, type TraceEvent } from '../analyze.ts';

export function viewerApp(): void {
  const ROW = 30;
  const HEAD = 28;
  const LANES = 6;
  const OVERSCAN = 12;
  const SESSION_COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#84cc16'];
  const CHUNKS: Record<string, true> = { agent_message_chunk: true, agent_thought_chunk: true, user_message_chunk: true, tool_call_content_chunk: true };
  const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6l4 4 4-4"/></svg>';

  type Row = { turn: number; seq: -1 } | { turn: -1; seq: number };

  const payload = JSON.parse(document.getElementById('trace-data')?.textContent || '{}') as {
    records?: unknown[];
    diagnostics?: Diagnostic[];
    title?: string;
  };

  // ---------------------------------------------------------------- state
  let records: unknown[] = [];
  let A: TraceAnalysis = analyzeTrace([]);
  let haystack: Array<string | undefined> = [];
  let rows: Row[] = [];
  let eventRow = new Int32Array(0);
  let turnRow = new Int32Array(0);
  /** Per row and lane: the request whose span passes through, or -1. */
  let laneReq = new Int32Array(0);
  let selected: string | undefined;
  let lastRange = '';
  const collapsed = new Set<number>();
  const filter = { q: '', method: '', session: '', hideChunks: false, problems: false };

  // ---------------------------------------------------------------- skeleton
  document.body.innerHTML = `
<div class="app">
  <header class="top">
    <svg class="logo" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M5 4v16" stroke="var(--client)"/><path d="M19 4v16" stroke="var(--agent)"/><path d="M5 8h12m-3-3 3 3-3 3" stroke="var(--client)"/><path d="M19 16H7m3-3-3 3 3 3" stroke="var(--agent)"/></svg>
    <div class="title"><h1 id="t-title"></h1><div class="sub" id="t-sub"></div></div>
    <div class="stats" id="t-stats"></div>
    <button class="btn" id="b-open" title="Open a .jsonl trace (or drop one here)">Open…</button>
    <input type="file" id="f-open" accept=".jsonl,.json,.ndjson,.txt" hidden>
  </header>
  <div class="bar">
    <label class="search"><input class="field" id="q" type="search" placeholder="Search messages, methods, JSON…" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
    <select id="m" title="Method"></select>
    <select id="s" title="Session"></select>
    <label class="toggle"><input type="checkbox" id="hc"> Hide chunks</label>
    <label class="toggle"><input type="checkbox" id="pr"> Problems only</label>
    <button class="btn" id="b-fold" title="Collapse or expand all turns (z)">Collapse turns</button>
    <span class="count" id="count"></span>
    <button class="btn" id="b-help" title="Keyboard shortcuts (?)">?</button>
  </div>
  <div class="overview" id="ov" title="Click to jump"><canvas id="ovc"></canvas><div class="viewport" id="vp"></div></div>
  <div class="main">
    <div class="list" id="list" tabindex="0" role="listbox" aria-label="Messages">
      <div class="lanes-head"><span></span><span></span><span class="lh"><span class="c">Client</span><span class="a">Agent</span></span><span style="padding-left:6px">Message</span></div>
      <div class="spacer" id="spacer"><div class="rows" id="rows"></div></div>
    </div>
    <aside class="details" id="details" aria-live="polite"></aside>
  </div>
</div>
<div class="drop" id="drop"><div>Drop a trace (.jsonl) to open it</div></div>
<div class="help" id="help"><div><h2>Keyboard</h2><div class="keys">
  <kbd>j</kbd><span>next message (or <kbd>↓</kbd>)</span><kbd>k</kbd><span>previous message (or <kbd>↑</kbd>)</span>
  <kbd>Enter</kbd><span>collapse or expand a turn; expand the JSON</span><kbd>←</kbd> <span>collapse turn · <kbd>→</kbd> expand</span>
  <kbd>[</kbd><span>previous turn · <kbd>]</kbd> next turn</span><kbd>e</kbd><span>next problem · <kbd>E</kbd> previous</span>
  <kbd>p</kbd><span>jump to the paired request or response</span><kbd>c</kbd><span>copy the message JSON</span>
  <kbd>/</kbd><span>search</span><kbd>z</kbd><span>collapse or expand all turns</span>
  <kbd>g</kbd><span>first · <kbd>G</kbd> last</span><kbd>Esc</kbd><span>clear search, then selection</span>
</div></div></div>
<div class="toast" id="toast"></div>`;

  const $ = (id: string) => document.getElementById(id)!;
  const list = $('list');
  const spacer = $('spacer');
  const rowsEl = $('rows');
  const details = $('details');
  const q = $('q') as HTMLInputElement;
  const mSel = $('m') as HTMLSelectElement;
  const sSel = $('s') as HTMLSelectElement;
  const canvas = $('ovc') as HTMLCanvasElement;

  // ---------------------------------------------------------------- helpers
  const esc = (s: unknown) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const ms = (n: number | undefined) =>
    n === undefined ? '' : n < 1 ? '<1 ms' : n < 1000 ? `${Math.round(n)} ms` : n < 60000 ? `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s` : `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
  const clock = (t: number) => {
    if (t < 60000) return `${(t / 1000).toFixed(3)}s`;
    const m = Math.floor(t / 60000);
    return `${m}:${((t % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
  };
  const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
  const msgOf = (e: TraceEvent): unknown => {
    const r = records[e.index] as { msg?: unknown; text?: unknown; data?: unknown } | undefined;
    return e.kind === 'note' ? { text: r?.text, data: r?.data } : r?.msg;
  };
  const sessionColor = (id: string | undefined) => {
    if (id === undefined) return '';
    const i = A.sessions.findIndex((s) => s.id === id);
    return SESSION_COLORS[(i < 0 ? 0 : i) % SESSION_COLORS.length]!;
  };
  const statusClass = (s: string | undefined) =>
    s === 'completed' || s === 'ended' || s === 'end_turn' || s === 'allowed' || s === 'result' ? 'ok'
      : s === 'failed' || s === 'error' || s === 'refusal' || s === 'rejected' ? 'error'
        : s === 'cancelled' || s === 'unanswered' || s === 'open' ? 'cancelled' : '';
  const turnColor = (turn: number) => {
    const s = A.turns[turn]!.status;
    return s === 'ended' ? 'var(--ok)' : s === 'error' ? 'var(--err)' : s === 'cancelled' ? 'var(--warn)' : 'var(--faint)';
  };
  const isProblem = (e: TraceEvent) => {
    if (e.level || e.cancel || e.kind === 'error' || e.kind === 'invalid') return true;
    const rq = e.request !== undefined ? A.requests[e.request] : undefined;
    // An answer after $/cancel_request is what the protocol expects (a result or -32800), so neither is a problem.
    return !!rq && e.kind === 'request' && (rq.outcome === 'unanswered' || (rq.outcome === 'cancelled' && rq.cancelEvent === undefined));
  };
  let toastTimer = 0;
  const toast = (text: string) => {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('on'), 1400);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast('Copied');
  };

  // ---------------------------------------------------------------- load
  function load(recs: unknown[], diagnostics: Diagnostic[] | undefined, title?: string): void {
    records = recs;
    A = analyzeTrace(recs, diagnostics ? { diagnostics } : {});
    haystack = new Array(A.events.length);
    collapsed.clear();
    selected = undefined;
    filter.q = filter.method = filter.session = '';
    q.value = '';

    const h = A.header;
    const name = title || h?.label || 'ACP trace';
    document.title = `${name} · Subspace trace`;
    $('t-title').textContent = name;
    const agent = A.agent?.name ? `${A.agent.name}${A.agent.version ? ` ${A.agent.version}` : ''}` : 'unknown agent';
    $('t-sub').textContent = [
      agent,
      A.protocol ? `ACP v${A.protocol}` : 'protocol unknown',
      `recorded by the ${A.recorder}`,
      h?.started ? new Date(h.started).toLocaleString() : '',
      ms(A.duration),
    ].filter(Boolean).join(' · ');
    const errors = A.requests.filter((r) => r.outcome === 'error').length + A.events.filter((e) => e.kind === 'invalid').length;
    const stat = (n: number, label: string, bad = false) => `<span class="stat${bad && n ? ' bad' : ''}"><b>${n.toLocaleString()}</b> ${label}</span>`;
    $('t-stats').innerHTML =
      stat(A.events.length, 'messages') + stat(A.turns.length, 'turns') + stat(A.toolCalls.length, 'tools') +
      stat(A.permissions.length, 'permissions') + stat(errors, errors === 1 ? 'error' : 'errors', true);

    const methods = Object.entries(A.methods).sort((x, y) => y[1] - x[1]);
    const updates = Object.entries(A.updates).sort((x, y) => y[1] - x[1]);
    mSel.innerHTML = `<option value="">All methods</option>` +
      methods.map(([m, n]) => `<option value="m:${esc(m)}">${esc(m)} (${n.toLocaleString()})</option>`).join('') +
      (updates.length ? `<optgroup label="session/update">${updates.map(([u, n]) => `<option value="u:${esc(u)}">${esc(u)} (${n.toLocaleString()})</option>`).join('')}</optgroup>` : '');
    sSel.innerHTML = `<option value="">All sessions</option>` +
      A.sessions.map((s) => `<option value="${esc(s.id)}">${esc(short(s.id))} · ${s.turns.length} turns</option>`).join('');
    sSel.style.display = A.sessions.length > 1 ? '' : 'none';
    rebuild();
    showDetails();
  }

  // ---------------------------------------------------------------- filtering and rows
  function matches(e: TraceEvent): boolean {
    if (filter.hideChunks && e.update && CHUNKS[e.update]) return false;
    if (filter.session && e.sessionId !== filter.session) return false;
    if (filter.method) {
      if (filter.method.startsWith('u:') ? e.update !== filter.method.slice(2) : e.method !== filter.method.slice(2)) return false;
    }
    if (filter.problems && !isProblem(e)) return false;
    if (filter.q) {
      let text = haystack[e.seq];
      if (text === undefined) {
        let json = '';
        try {
          json = JSON.stringify(msgOf(e)) ?? '';
        } catch {}
        text = haystack[e.seq] = `${e.label}\n${e.method ?? ''}\n${json}`.toLowerCase();
      }
      if (text.indexOf(filter.q) < 0) return false;
    }
    return true;
  }

  function rebuild(): void {
    const out: Row[] = [];
    const headed = new Uint8Array(A.turns.length);
    for (const e of A.events) {
      if (!matches(e)) continue;
      if (e.turn !== undefined) {
        if (!headed[e.turn]) {
          headed[e.turn] = 1;
          out.push({ turn: e.turn, seq: -1 });
        }
        if (collapsed.has(e.turn)) continue;
      }
      out.push({ turn: -1, seq: e.seq });
    }
    rows = out;
    eventRow = new Int32Array(A.events.length).fill(-1);
    turnRow = new Int32Array(A.turns.length).fill(-1);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.seq >= 0) eventRow[r.seq] = i;
      else turnRow[r.turn] = i;
    }
    // Request-to-response spans, greedily packed into a few lanes.
    laneReq = new Int32Array(rows.length * LANES).fill(-1);
    const laneEnd = new Int32Array(LANES).fill(-1);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      for (let l = 0; l < LANES; l++) {
        if (laneEnd[l]! >= i) laneReq[i * LANES + l] = laneReq[(i - 1) * LANES + l]!;
      }
      if (r.seq < 0) continue;
      const e = A.events[r.seq]!;
      if (e.kind !== 'request' || e.request === undefined) continue;
      const rq = A.requests[e.request]!;
      const end = rq.response !== undefined ? eventRow[rq.response]! : -1;
      if (end <= i) continue;
      for (let l = 0; l < LANES; l++) {
        if (laneEnd[l]! < i) {
          laneEnd[l] = end;
          laneReq[i * LANES + l] = e.request;
          break;
        }
      }
    }
    spacer.style.height = `${rows.length * ROW}px`;
    const shown = rows.length - rows.filter((r) => r.seq < 0).length;
    $('count').textContent = shown === A.events.length ? `${A.events.length.toLocaleString()} messages` : `${shown.toLocaleString()} of ${A.events.length.toLocaleString()}`;
    $('b-fold').textContent = collapsed.size && collapsed.size >= A.turns.length ? 'Expand turns' : 'Collapse turns';
    lastRange = '';
    drawOverview();
    render();
  }

  // ---------------------------------------------------------------- rendering
  function render(): void {
    const top = Math.max(0, Math.min(list.scrollTop - HEAD, rows.length * ROW - list.clientHeight));
    const from = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const to = Math.min(rows.length, Math.ceil((top + list.clientHeight) / ROW) + OVERSCAN);
    const key = `${from}:${to}:${selected}`;
    if (key !== lastRange) {
      lastRange = key;
      let pair = -1;
      if (selected?.startsWith('e:')) {
        const e = A.events[Number(selected.slice(2))];
        const rq = e?.request !== undefined ? A.requests[e.request] : undefined;
        if (rq) pair = e!.kind === 'request' ? (rq.response ?? -1) : rq.event;
      }
      let html = '';
      for (let i = from; i < to; i++) html += rowHtml(i, pair);
      rowsEl.innerHTML = rows.length ? html : `<div class="empty">${A.events.length ? 'Nothing matches the filters.' : 'This trace has no messages. Drop a .jsonl trace here to open one.'}</div>`;
    }
    updateViewport(from + OVERSCAN, to - OVERSCAN);
  }

  function rowHtml(i: number, pair: number): string {
    const r = rows[i]!;
    const y = i * ROW;
    if (r.seq < 0) {
      const t = A.turns[r.turn]!;
      const sel = selected === `t:${r.turn}` ? ' sel' : '';
      const fold = collapsed.has(r.turn) ? ' collapsed' : '';
      const stop = t.status === 'open' ? 'open' : t.stopReason ?? t.status;
      const perms = t.permissions.map((p) => A.permissions[p]!.result);
      const badges = [
        `<span class="badge ${statusClass(stop)}">${esc(stop)}</span>`,
        t.duration !== undefined ? `<span class="badge">${ms(t.duration)}</span>` : '',
        t.toolCalls.length ? `<span class="badge">${t.toolCalls.length} tool${t.toolCalls.length > 1 ? 's' : ''}</span>` : '',
        perms.length ? `<span class="badge ${perms.every((p) => p === 'allowed') ? 'ok' : 'warn'}">${perms.length} permission${perms.length > 1 ? 's' : ''}: ${esc(perms.join(', '))}</span>` : '',
        t.cancelEvent !== undefined ? '<span class="badge cancelled">cancel sent</span>' : '',
        `<span class="badge">${t.messages.toLocaleString()} msgs</span>`,
      ].join('');
      const sess = A.sessions.length > 1 ? `<span class="sess" style="background:${sessionColor(t.sessionId)}"></span>` : '';
      return `<div class="row turnrow${sel}${fold}" data-i="${i}" role="option" aria-selected="${!!sel}" aria-expanded="${!fold}" style="top:${y}px;--turn-c:${turnColor(r.turn)}"><div class="time">${clock(t.t)}</div><div class="tsum">${CHEVRON}${sess}<span class="tname">Turn ${r.turn + 1}</span><span class="tprompt">${esc(t.prompt || '(no text)')}</span>${badges}</div></div>`;
    }
    const e = A.events[r.seq]!;
    const sel = selected === `e:${e.seq}` ? ' sel' : '';
    const cls = `row${sel}${e.seq === pair ? ' pair' : ''}${e.turn !== undefined ? ' inturn' : ''}${e.level === 'error' ? ' bad-error' : ''}`;
    const style = `top:${y}px${e.turn !== undefined ? `;--turn-c:${turnColor(e.turn)}` : ''}`;

    // Spans.
    let gutter = '';
    for (let l = 0; l < LANES; l++) {
      const rqSeq = laneReq[i * LANES + l]!;
      if (rqSeq < 0) continue;
      const rq = A.requests[rqSeq]!;
      const part = rq.event === e.seq ? 'start' : rq.response === e.seq ? 'end' : 'mid';
      const c = rq.outcome === 'result' ? 'ok' : rq.outcome === 'error' ? 'error' : 'cancelled';
      gutter += `<span class="span ${part} ${c}" style="left:${8 + l * 6}px"></span>`;
    }

    // Arrow between the lanes.
    let lane: string;
    if (e.kind === 'note') {
      lane = `<span class="notepill">note</span>`;
    } else {
      const dir = e.from === 'client' ? 'r' : 'l';
      const color = `from-${e.from} k-${e.cancel ? 'cancel' : e.kind}`;
      const dim = e.update && CHUNKS[e.update] ? ' dim' : '';
      const text = e.kind === 'response' || e.kind === 'error' ? `${e.kind === 'error' ? 'error' : 'result'} #${esc(JSON.stringify(e.id))}`
        : e.kind === 'request' ? `${esc(e.method)} #${esc(JSON.stringify(e.id))}` : esc(e.method ?? 'invalid');
      lane = `<span class="alabel${e.kind === 'request' ? ' req' : ''}">${text}</span><span class="dot ${dir === 'r' ? 'l' : 'r'} ${color}${dim}"></span><span class="arrow ${dir} ${e.kind} ${color}${dim}"></span>`;
    }

    // Label and badges.
    let label = esc(e.label);
    if (e.update && e.label.startsWith(e.update)) label = `<span class="q">${esc(e.update)}</span>${esc(e.label.slice(e.update.length))}`;
    let badges = '';
    const rq = e.request !== undefined ? A.requests[e.request] : undefined;
    if (rq && e.kind === 'request' && !e.cancel) {
      if (rq.response !== undefined) badges += `<span class="badge ${statusClass(rq.outcome)}">${ms(rq.latency)}</span>`;
      else badges += `<span class="badge cancelled">${rq.outcome === 'cancelled' ? 'cancelled' : 'no answer'}</span>`;
    } else if (rq && (e.kind === 'response' || e.kind === 'error') && rq.response === e.seq) {
      badges += `<span class="badge ${statusClass(rq.outcome)}">↩ ${ms(rq.latency)}</span>`;
      if (rq.late) badges += `<span class="badge" title="Answered after the requester asked to cancel it (expected: a cancelled request is still answered)">after cancel</span>`;
    }
    if (e.cancel) badges += `<span class="badge cancelled">cancel</span>`;
    if (e.toolCall !== undefined && e.update) {
      const status = (msgOf(e) as { params?: { update?: { status?: unknown } } })?.params?.update?.status;
      if (typeof status === 'string') badges += `<span class="badge ${statusClass(status)}">${esc(status)}</span>`;
    }
    if (e.level === 'warning' && !e.cancel) badges += `<span class="badge warn">!</span>`;
    const sess = A.sessions.length > 1 && e.sessionId ? `<span class="sess" style="background:${sessionColor(e.sessionId)}"></span>` : '';
    return `<div class="${cls}" data-i="${i}" role="option" aria-selected="${!!sel}" style="${style}"><div class="time">${clock(e.t)}</div><div class="gutter">${gutter}</div><div class="lane">${lane}</div><div class="summary">${sess}<span class="label">${label}</span>${badges}</div></div>`;
  }

  // ---------------------------------------------------------------- overview strip
  const xOf = (t: number, seq: number) => (A.duration > 0 ? t / A.duration : A.events.length > 1 ? seq / (A.events.length - 1) : 0);

  function drawOverview(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const pad = 8;
    const span = w - pad * 2;
    for (const t of A.turns) {
      const x0 = pad + xOf(t.t, t.first) * span;
      const x1 = pad + xOf(t.endT ?? A.duration, t.last) * span;
      g.globalAlpha = 0.14;
      g.fillStyle = v(t.status === 'ended' ? '--ok' : t.status === 'error' ? '--err' : t.status === 'cancelled' ? '--warn' : '--faint');
      g.fillRect(x0, 3, Math.max(2, x1 - x0), h - 6);
    }
    g.globalAlpha = 1;
    // Density of the messages that pass the filters, one bin per pixel.
    const bins = new Uint32Array(Math.max(1, Math.ceil(span)) + 1);
    const marks: Array<[number, string]> = [];
    let max = 1;
    for (const r of rows) {
      if (r.seq < 0) continue;
      const e = A.events[r.seq]!;
      const b = Math.round(xOf(e.t, e.seq) * span);
      const n = ++bins[b]!;
      if (n > max) max = n;
      if (e.kind === 'error' || e.kind === 'invalid' || e.level === 'error') marks.push([b, '--err']);
      else if (e.cancel) marks.push([b, '--warn']);
    }
    g.fillStyle = v('--muted');
    g.globalAlpha = 0.55;
    const lm = Math.log(1 + max);
    for (let b = 0; b < bins.length; b++) {
      const n = bins[b]!;
      if (!n) continue;
      const bh = Math.max(1.5, ((h - 12) * Math.log(1 + n)) / lm);
      g.fillRect(pad + b, h - 6 - bh, 1, bh);
    }
    g.globalAlpha = 1;
    for (const [b, color] of marks) {
      g.fillStyle = v(color);
      g.fillRect(pad + b - 0.75, 3, 1.5, h - 6);
    }
  }

  function rowX(i: number): number {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return 0;
    if (r.seq < 0) {
      const t = A.turns[r.turn]!;
      return xOf(t.t, t.first);
    }
    const e = A.events[r.seq]!;
    return xOf(e.t, e.seq);
  }

  function updateViewport(from: number, to: number): void {
    const vp = $('vp');
    if (!rows.length) {
      vp.style.display = 'none';
      return;
    }
    vp.style.display = '';
    const w = canvas.clientWidth - 16;
    const x0 = rowX(from);
    const x1 = rowX(to - 1);
    vp.style.left = `${8 + x0 * w - 2}px`;
    vp.style.width = `${Math.max(4, (x1 - x0) * w + 4)}px`;
  }

  // ---------------------------------------------------------------- selection and navigation
  function rowIndexOf(key: string | undefined): number {
    if (!key) return -1;
    const n = Number(key.slice(2));
    return key[0] === 't' ? (turnRow[n] ?? -1) : (eventRow[n] ?? -1);
  }

  function keyOf(i: number): string | undefined {
    const r = rows[i];
    return r ? (r.seq < 0 ? `t:${r.turn}` : `e:${r.seq}`) : undefined;
  }

  function scrollTo(i: number, center = false): void {
    const y = HEAD + i * ROW;
    const view = list.clientHeight;
    if (center) list.scrollTop = Math.max(0, y - view / 2);
    else if (y - HEAD < list.scrollTop) list.scrollTop = y - HEAD;
    else if (y + ROW > list.scrollTop + view) list.scrollTop = y + ROW - view;
  }

  function select(key: string | undefined, opts: { scroll?: boolean; center?: boolean } = {}): void {
    selected = key;
    const i = rowIndexOf(key);
    if (i >= 0 && opts.scroll !== false) scrollTo(i, opts.center);
    lastRange = '';
    render();
    showDetails();
  }

  function move(delta: number): void {
    if (!rows.length) return;
    const i = rowIndexOf(selected);
    const next = i < 0 ? (delta > 0 ? Math.floor(Math.max(0, list.scrollTop - HEAD) / ROW) : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + delta));
    select(keyOf(next));
  }

  function jump(test: (r: Row) => boolean, dir: 1 | -1): void {
    const start = rowIndexOf(selected);
    for (let i = start + dir; i >= 0 && i < rows.length; i += dir) {
      if (test(rows[i]!)) return select(keyOf(i), { center: true });
    }
    toast(dir > 0 ? 'No more below' : 'No more above');
  }

  /** Show an event or turn even if filters or a collapsed turn hide it. */
  function goTo(key: string): void {
    if (rowIndexOf(key) < 0) {
      const n = Number(key.slice(2));
      const turn = key[0] === 't' ? n : A.events[n]?.turn;
      if (turn !== undefined) collapsed.delete(turn);
      rebuild();
      if (rowIndexOf(key) < 0) {
        filter.q = filter.method = filter.session = '';
        filter.hideChunks = filter.problems = false;
        q.value = mSel.value = sSel.value = '';
        ($('hc') as HTMLInputElement).checked = ($('pr') as HTMLInputElement).checked = false;
        rebuild();
        toast('Filters cleared to show it');
      }
    }
    select(key, { center: true });
  }

  function toggleTurn(turn: number, open?: boolean): void {
    const isOpen = !collapsed.has(turn);
    if (open === isOpen) return;
    if (isOpen) collapsed.add(turn);
    else collapsed.delete(turn);
    rebuild();
    const i = rowIndexOf(`t:${turn}`);
    if (i >= 0) scrollTo(i);
  }

  // ---------------------------------------------------------------- details
  function showDetails(): void {
    details.scrollTop = 0;
    if (selected?.startsWith('t:')) return turnDetails(A.turns[Number(selected.slice(2))]!);
    if (selected?.startsWith('e:')) return eventDetails(A.events[Number(selected.slice(2))]!);
    homeDetails();
  }

  const go = (key: string, text: string) => `<button class="link" data-go="${key}">${text}</button>`;
  const evLink = (seq: number | undefined, text?: string) => (seq === undefined ? '' : go(`e:${seq}`, esc(text ?? `#${seq + 1}`)));
  const kv = (pairs: Array<[string, string | undefined | false]>) =>
    `<dl class="kv">${pairs.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  function toolCard(i: number): string {
    const t = A.toolCalls[i]!;
    const hist = t.history
      .map((h, n) => `${n ? '<span class="sep">→</span>' : ''}${go(`e:${h.event}`, `<span class="badge ${statusClass(h.status)}">${esc(h.status)} <span style="opacity:.7">${clock(h.t)}</span></span>`)}`)
      .join('');
    const took = t.history.length > 1 ? ms(t.history[t.history.length - 1]!.t - t.history[0]!.t) : '';
    return `<div class="card"><div class="ct"><span class="grow">${esc(t.title || t.id)}</span>${t.kind ? `<span class="badge">${esc(t.kind)}</span>` : ''}<span class="badge ${statusClass(t.status)}">${esc(t.status)}</span></div><div class="mono" style="color:var(--muted);margin-top:2px">${esc(t.id)}${took ? ` · ${took}` : ''}</div><div class="hist">${hist}</div></div>`;
  }

  function permissionCard(i: number): string {
    const p = A.permissions[i]!;
    const opts = p.options
      .map((o) => `<span class="badge ${o.optionId === p.optionId ? statusClass(p.result) : ''}">${esc(o.name ?? o.optionId)}${o.kind ? ` · ${esc(o.kind)}` : ''}</span>`)
      .join(' ');
    const rq = A.requests[p.request]!;
    return `<div class="card"><div class="ct"><span class="grow">${esc(p.title)}</span><span class="badge ${statusClass(p.result)}">${esc(p.result)}</span></div><div class="hist">${opts}</div><div style="margin-top:6px;font-size:12px;color:var(--muted)">${evLink(p.event, 'asked')} ${clock(rq.t)}${rq.response !== undefined ? ` · ${evLink(rq.response, 'answered')} after ${ms(p.latency)}` : ''}</div></div>`;
  }

  function eventDetails(e: TraceEvent): void {
    const rq = e.request !== undefined ? A.requests[e.request] : undefined;
    const to = e.from === 'client' ? 'agent' : 'client';
    const kindBadge = `<span class="badge ${e.kind === 'error' || e.kind === 'invalid' ? 'error' : e.cancel ? 'cancelled' : e.kind === 'response' ? 'ok' : ''}">${e.kind}</span>`;
    let rel = '';
    if (rq && e.kind === 'request' && !e.cancel) {
      rel = rq.response !== undefined
        ? `${evLink(rq.response, rq.outcome === 'result' ? 'result' : rq.outcome)} after <b>${ms(rq.latency)}</b>${rq.late ? ' <span class="badge">after cancel</span>' : ''}`
        : `<span class="badge cancelled">${rq.outcome === 'cancelled' ? 'cancelled, never answered' : 'never answered'}</span>`;
      if (rq.cancelEvent !== undefined) rel += ` · ${evLink(rq.cancelEvent, 'cancel requested')} at ${clock(A.events[rq.cancelEvent]!.t)}`;
    } else if (rq && (e.kind === 'response' || e.kind === 'error')) {
      rel = `answers ${evLink(rq.event, `${rq.method} #${JSON.stringify(rq.id)}`)} after <b>${ms(rq.latency)}</b>`;
    } else if (rq && e.cancel) {
      rel = `cancels ${evLink(rq.event, `${rq.method} #${JSON.stringify(rq.id)}`)}`;
    }
    const cancel = e.cancel ? A.cancels.find((c) => c.event === e.seq) : undefined;
    const err = rq?.error && (e.kind === 'error' || (e.kind === 'request' && rq.outcome === 'error'));
    const diags = A.diagnostics.filter((d) => d.event === e.seq);
    let html = `<h2>${kindBadge}<span class="mono" style="font-size:14px">${esc(e.method ?? (e.kind === 'note' ? 'note' : 'message'))}</span></h2>`;
    html += `<div style="color:var(--muted);overflow-wrap:anywhere">${esc(e.label)}</div>`;
    html += kv([
      ['Time', `${clock(e.t)} <span style="color:var(--faint)">· message ${e.seq + 1} of ${A.events.length}</span>`],
      ['Direction', e.kind === 'note' ? 'note' : `${e.from} → ${to}`],
      ['Id', e.id !== undefined ? `<span class="mono">${esc(JSON.stringify(e.id))}</span>` : undefined],
      ['Session', e.sessionId ? `<span class="mono">${esc(e.sessionId)}</span>` : undefined],
      ['Turn', e.turn !== undefined ? go(`t:${e.turn}`, `Turn ${e.turn + 1}`) : undefined],
      ['Pair', rel || undefined],
      ['Error', err ? `<span class="badge error">${esc(rq!.error!.code ?? '')}</span> ${esc(rq!.error!.message ?? '')}` : undefined],
      ['Cancel', cancel ? (cancel.confirmedAfter !== undefined ? `confirmed after <b>${ms(cancel.confirmedAfter)}</b>` : 'not confirmed in the trace') : undefined],
    ]);
    if (diags.length) html += `<h3>Problems</h3>${diags.map((d) => `<div class="diag"><span class="badge ${d.level === 'error' ? 'error' : 'warn'}">${d.level}</span><span>${esc(d.message)}</span></div>`).join('')}`;
    if (e.toolCall !== undefined) html += `<h3>Tool call</h3>${toolCard(e.toolCall)}`;
    if (e.permission !== undefined) html += `<h3>Permission</h3>${permissionCard(e.permission)}`;
    html += `<h3>JSON<span class="grow"></span><button class="btn" data-act="expand">Expand all</button><button class="btn" data-act="copy">Copy</button></h3><div class="json" id="json"></div>`;
    details.innerHTML = html;
    $('json').appendChild(jsonNode(msgOf(e), undefined, 0));
  }

  function turnDetails(t: TurnInfo): void {
    const stop = t.status === 'open' ? 'open' : t.stopReason ?? t.status;
    const cancel = t.cancelEvent !== undefined ? A.cancels.find((c) => c.event === t.cancelEvent) : undefined;
    let html = `<h2>Turn ${t.seq + 1}<span class="badge ${statusClass(stop)}">${esc(stop)}</span></h2>`;
    html += `<pre class="prose" style="margin-top:10px">${esc(t.prompt || '(no text)')}</pre>`;
    html += kv([
      ['Session', `<span class="mono">${esc(t.sessionId)}</span>`],
      ['Started', `${evLink(t.event, clock(t.t))}`],
      ['Ended', t.endEvent !== undefined ? `${evLink(t.endEvent, clock(t.endT!))} · <b>${ms(t.duration)}</b>` : '<span class="badge cancelled">not in the trace</span>'],
      ['Messages', t.messages.toLocaleString()],
      ['Cancel', cancel ? `${evLink(cancel.event, `sent at ${clock(cancel.t)}`)}${cancel.confirmedAfter !== undefined ? ` · confirmed after <b>${ms(cancel.confirmedAfter)}</b>` : ''}` : undefined],
      ['Error', t.error !== undefined ? `<span class="mono">${esc(JSON.stringify(t.error))}</span>` : undefined],
    ]);
    if (t.toolCalls.length) html += `<h3>Tool calls · ${t.toolCalls.length}</h3>${t.toolCalls.map(toolCard).join('')}`;
    if (t.permissions.length) html += `<h3>Permissions · ${t.permissions.length}</h3>${t.permissions.map(permissionCard).join('')}`;
    if (t.text) html += `<h3>Agent said</h3><pre class="prose">${esc(t.text)}</pre>`;
    if (t.thoughts) html += `<h3>Agent thought</h3><pre class="prose thought">${esc(t.thoughts)}</pre>`;
    details.innerHTML = html;
  }
  type TurnInfo = TraceAnalysis['turns'][number];

  function homeDetails(): void {
    const h = A.header;
    let html = `<h2>${esc(h?.label || 'Trace')}</h2><div style="color:var(--muted)">Select a message or a turn to see it here.</div>`;
    html += kv([
      ['Agent', A.agent?.name ? esc(`${A.agent.name} ${A.agent.version ?? ''}`) : undefined],
      ['Client', A.client?.name ? esc(`${A.client.name} ${A.client.version ?? ''}`) : undefined],
      ['Protocol', A.protocol ? `ACP v${A.protocol}` : 'unknown'],
      ['Recorded by', esc(A.recorder)],
      ['Started', h?.started ? esc(new Date(h.started).toLocaleString()) : undefined],
      ['Duration', ms(A.duration)],
    ]);
    if (A.sessions.length) {
      html += `<h3>Sessions · ${A.sessions.length}</h3>`;
      html += A.sessions.map((s) => `<div class="card"><div class="ct"><span class="sess" style="background:${sessionColor(s.id)}"></span><span class="grow mono">${esc(s.id)}</span><span class="badge">${s.turns.length} turns</span></div>${s.cwd ? `<div class="mono" style="color:var(--muted);margin-top:2px">${esc(s.cwd)}</div>` : ''}<div class="hist">${s.turns.map((n) => go(`t:${n}`, `<span class="badge ${statusClass(A.turns[n]!.status)}">Turn ${n + 1}</span>`)).join('')}</div></div>`).join('');
    }
    const diags = A.diagnostics.filter((d) => d.level !== 'info');
    html += `<h3>Problems · ${diags.length}</h3>`;
    html += diags.length
      ? diags.slice(0, 200).map((d) => `<div class="diag"><span class="badge ${d.level === 'error' ? 'error' : 'warn'}">${d.level}</span><span>${d.event !== undefined ? go(`e:${d.event}`, esc(d.message)) : esc(d.message)}</span></div>`).join('')
      : '<div style="color:var(--muted)">None. Every request was answered and every turn ended.</div>';
    const slow = A.requests.filter((r) => r.latency !== undefined).sort((x, y) => y.latency! - x.latency!).slice(0, 6);
    if (slow.length) {
      html += `<h3>Slowest requests</h3><table class="tbl">${slow.map((r) => `<tr><td>${go(`e:${r.event}`, `<span class="mono">${esc(r.method)} #${esc(JSON.stringify(r.id))}</span>`)}</td><td class="n">${ms(r.latency)}</td></tr>`).join('')}</table>`;
    }
    const methods = Object.entries(A.methods).sort((x, y) => y[1] - x[1]);
    html += `<h3>Methods</h3><table class="tbl">${methods.map(([m, n]) => `<tr><td class="mono">${esc(m)}</td><td class="n">${n.toLocaleString()}</td></tr>`).join('')}</table>`;
    html += `<h3>Keys</h3><div style="color:var(--muted)"><kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> expand · <kbd>/</kbd> search · <kbd>?</kbd> all keys</div>`;
    details.innerHTML = html;
  }

  // ---------------------------------------------------------------- JSON tree, built lazily
  function jsonNode(value: unknown, key: string | undefined, depth: number): HTMLElement {
    const k = key === undefined ? '' : `<span class="k">${esc(key)}</span><span class="p">: </span>`;
    if (value === null || typeof value !== 'object') {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = k + primitive(value);
      return div;
    }
    const isArray = Array.isArray(value);
    const entries: Array<[string, unknown]> = isArray ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as object);
    const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
    if (!entries.length) {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `${k}<span class="p">${open}${close}</span>`;
      return div;
    }
    const node = document.createElement('details');
    const summary = document.createElement('summary');
    const count = `${entries.length} ${isArray ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}`;
    summary.innerHTML = `${k}<span class="p">${open}</span><span class="more j-closed"> ${count} </span><span class="p j-closed">${close}</span>`;
    node.className = 'item';
    node.appendChild(summary);
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      const kids = document.createElement('div');
      kids.className = 'kids';
      for (const [ck, cv] of entries) kids.appendChild(jsonNode(cv, isArray ? undefined : ck, depth + 1));
      const end = document.createElement('div');
      end.className = 'p';
      end.textContent = close;
      node.appendChild(kids);
      node.appendChild(end);
    };
    node.addEventListener('toggle', () => node.open && build());
    if (depth < 3 && entries.length <= 40) {
      build();
      node.open = true;
    }
    return node;
  }

  function primitive(value: unknown): string {
    if (typeof value === 'string') {
      const max = 4000;
      const text = value.length > max ? `${value.slice(0, max)}… (${(value.length - max).toLocaleString()} more characters; copy to see all)` : value;
      return `<span class="s">${esc(JSON.stringify(text))}</span>`;
    }
    if (typeof value === 'number') return `<span class="n">${value}</span>`;
    return `<span class="b">${esc(String(value))}</span>`;
  }

  function expandAll(): void {
    const root = document.getElementById('json');
    if (!root) return;
    for (let pass = 0; pass < 64; pass++) {
      const closed = root.querySelectorAll('details:not([open])');
      if (!closed.length) break;
      closed.forEach((d) => ((d as HTMLDetailsElement).open = true));
      // Opening builds children synchronously through the toggle handler only later, so build now.
      closed.forEach((d) => d.dispatchEvent(new Event('toggle')));
    }
  }

  function copySelected(): void {
    if (!selected?.startsWith('e:')) return;
    const e = A.events[Number(selected.slice(2))]!;
    void copy(JSON.stringify(msgOf(e), null, 2));
  }

  // ---------------------------------------------------------------- events
  let frame = 0;
  list.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  });

  rowsEl.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest('.row') as HTMLElement | null;
    if (!el) return;
    const i = Number(el.dataset.i);
    const r = rows[i];
    if (!r) return;
    if (r.seq < 0 && (ev.target as HTMLElement).closest('.chev, .tname')) return toggleTurn(r.turn);
    if (r.seq < 0 && selected === `t:${r.turn}`) return toggleTurn(r.turn);
    list.focus({ preventScroll: true });
    select(keyOf(i), { scroll: false });
  });

  details.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const link = target.closest('[data-go]') as HTMLElement | null;
    if (link) return goTo(link.dataset.go!);
    const act = (target.closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act === 'copy') copySelected();
    if (act === 'expand') expandAll();
  });

  let searchTimer = 0;
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      filter.q = q.value.trim().toLowerCase();
      rebuild();
    }, 90);
  });
  mSel.addEventListener('change', () => {
    filter.method = mSel.value;
    rebuild();
  });
  sSel.addEventListener('change', () => {
    filter.session = sSel.value;
    rebuild();
  });
  $('hc').addEventListener('change', (ev) => {
    filter.hideChunks = (ev.target as HTMLInputElement).checked;
    rebuild();
  });
  $('pr').addEventListener('change', (ev) => {
    filter.problems = (ev.target as HTMLInputElement).checked;
    rebuild();
  });
  const foldAll = () => {
    if (collapsed.size >= A.turns.length) collapsed.clear();
    else for (const t of A.turns) collapsed.add(t.seq);
    rebuild();
    const i = rowIndexOf(selected);
    if (i >= 0) scrollTo(i, true);
  };
  $('b-fold').addEventListener('click', foldAll);
  $('b-help').addEventListener('click', () => $('help').classList.toggle('on'));
  $('help').addEventListener('click', () => $('help').classList.remove('on'));

  $('ov').addEventListener('click', (ev) => {
    if (!rows.length) return;
    const rect = canvas.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (ev.clientX - rect.left - 8) / (rect.width - 16)));
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowX(mid) < f) lo = mid + 1;
      else hi = mid;
    }
    select(keyOf(lo), { center: true });
    list.focus({ preventScroll: true });
  });

  // Open a file: button, or drop anywhere.
  const openText = (text: string, name: string) => {
    const { records: recs, diagnostics } = readTrace(text);
    load(recs, diagnostics, name);
    list.scrollTop = 0;
    toast(`Opened ${name}`);
  };
  const openFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => openText(text, file.name));
  };
  $('b-open').addEventListener('click', () => $('f-open').click());
  $('f-open').addEventListener('change', (ev) => openFile((ev.target as HTMLInputElement).files?.[0]));
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    dragDepth++;
    $('drop').classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) $('drop').classList.remove('on');
  });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    $('drop').classList.remove('on');
    openFile(ev.dataTransfer?.files?.[0]);
  });

  document.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA';
    if ($('help').classList.contains('on')) {
      $('help').classList.remove('on');
      if (ev.key === 'Escape' || ev.key === '?') return ev.preventDefault();
    }
    if (typing) {
      if (target === q && (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === 'ArrowDown')) {
        if (ev.key === 'Escape' && q.value) {
          q.value = '';
          filter.q = '';
          rebuild();
        }
        ev.preventDefault();
        list.focus();
        if (ev.key !== 'Escape' && rowIndexOf(selected) < 0) move(1);
      }
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const sel = rowIndexOf(selected);
    const row = sel >= 0 ? rows[sel] : undefined;
    const handled = () => ev.preventDefault();
    switch (ev.key) {
      case 'j':
      case 'ArrowDown':
        handled();
        return move(1);
      case 'k':
      case 'ArrowUp':
        handled();
        return move(-1);
      case 'PageDown':
        handled();
        return move(Math.floor(list.clientHeight / ROW) - 1);
      case 'PageUp':
        handled();
        return move(-(Math.floor(list.clientHeight / ROW) - 1));
      case 'g':
      case 'Home':
        handled();
        return select(keyOf(0));
      case 'G':
      case 'End':
        handled();
        return select(keyOf(rows.length - 1));
      case 'Enter':
      case ' ':
        handled();
        if (row && row.seq < 0) return toggleTurn(row.turn);
        if (row) return expandAll();
        return move(1);
      case 'ArrowLeft':
      case 'h':
        handled();
        if (row && row.seq < 0) return toggleTurn(row.turn, false);
        if (row && row.seq >= 0) {
          const turn = A.events[row.seq]!.turn;
          if (turn !== undefined) {
            toggleTurn(turn, false);
            return select(`t:${turn}`);
          }
        }
        return;
      case 'ArrowRight':
      case 'l':
        handled();
        if (row && row.seq < 0) toggleTurn(row.turn, true);
        return;
      case ']':
        handled();
        return jump((r) => r.seq < 0, 1);
      case '[':
        handled();
        return jump((r) => r.seq < 0, -1);
      case 'e':
        handled();
        return jump((r) => r.seq >= 0 && isProblem(A.events[r.seq]!), 1);
      case 'E':
        handled();
        return jump((r) => r.seq >= 0 && isProblem(A.events[r.seq]!), -1);
      case 'p': {
        handled();
        if (!row || row.seq < 0) return;
        const e = A.events[row.seq]!;
        const rq = e.request !== undefined ? A.requests[e.request] : undefined;
        const other = rq ? (e.kind === 'request' ? rq.response : rq.event) : undefined;
        if (other !== undefined && other !== e.seq) goTo(`e:${other}`);
        else toast('No pair');
        return;
      }
      case 'c':
        handled();
        return copySelected();
      case 'z':
        handled();
        return foldAll();
      case '/':
        handled();
        q.focus();
        q.select();
        return;
      case '?':
        handled();
        $('help').classList.add('on');
        return;
      case 'Escape':
        handled();
        if (filter.q) {
          q.value = '';
          filter.q = '';
          rebuild();
          return;
        }
        return select(undefined);
    }
  });

  window.addEventListener('resize', () => {
    drawOverview();
    lastRange = '';
    render();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', drawOverview);

  load(payload.records ?? [], payload.diagnostics, payload.title);
  list.focus({ preventScroll: true });
}
