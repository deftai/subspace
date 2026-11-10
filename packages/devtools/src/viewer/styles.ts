/** The viewer's stylesheet. Light and dark follow the system. */
export const VIEWER_CSS = `
:root {
  color-scheme: light dark;
  --bg: #fafaf9; --panel: #ffffff; --raised: #ffffff; --fg: #18181b; --muted: #6b6b73; --faint: #a1a1aa;
  --line: #ebebed; --line-strong: #d9d9de; --hover: #f4f4f5; --sel: #eaf1ff; --sel-edge: #3b82f6;
  --client: #2563eb; --agent: #7c3aed; --ok: #15803d; --err: #dc2626; --warn: #c2410c; --note: #64748b;
  --err-bg: #fef2f2; --warn-bg: #fff7ed; --ok-bg: #f0fdf4; --chip: #f4f4f5;
  --j-key: #7c3aed; --j-str: #15803d; --j-num: #c2410c; --j-lit: #2563eb;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
  --row: 30px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0d0f; --panel: #131417; --raised: #1a1c20; --fg: #e7e7ea; --muted: #9b9ba4; --faint: #5f6068;
    --line: #22242a; --line-strong: #30333a; --hover: #1a1c21; --sel: #172238; --sel-edge: #60a5fa;
    --client: #60a5fa; --agent: #a78bfa; --ok: #4ade80; --err: #f87171; --warn: #fb923c; --note: #94a3b8;
    --err-bg: #2a1215; --warn-bg: #2a1a0e; --ok-bg: #0f2417; --chip: #1f2126;
    --j-key: #c4b5fd; --j-str: #86efac; --j-num: #fdba74; --j-lit: #93c5fd;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--fg); font: 13px/1.45 var(--sans); -webkit-font-smoothing: antialiased; overflow: hidden; }
button, input, select { font: inherit; color: inherit; }
kbd { font: 11px var(--mono); border: 1px solid var(--line-strong); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--raised); }
.app { display: grid; grid-template-rows: auto auto auto 1fr; height: 100vh; }

/* Header */
.top { display: flex; align-items: center; gap: 14px; padding: 12px 18px 10px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.logo { width: 22px; height: 22px; flex: none; }
.title { min-width: 0; }
.title h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title .sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stats { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
.stat { background: var(--chip); border-radius: 999px; padding: 2px 9px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.stat b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.stat.bad { background: var(--err-bg); color: var(--err); } .stat.bad b { color: var(--err); }
.btn { border: 1px solid var(--line-strong); background: var(--raised); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 12px; white-space: nowrap; }
.btn:hover { border-color: var(--faint); }
.btn:focus-visible, .field:focus-visible, select:focus-visible { outline: 2px solid var(--sel-edge); outline-offset: 1px; }

/* Toolbar */
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 18px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
.search { position: relative; flex: 1 1 240px; max-width: 420px; }
.field { width: 100%; border: 1px solid var(--line-strong); background: var(--bg); border-radius: 7px; padding: 5px 30px 5px 10px; outline: none; }
.search kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--muted); }
select { border: 1px solid var(--line-strong); background: var(--bg); border-radius: 7px; padding: 5px 8px; max-width: 220px; outline: none; }
.toggle { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap; }
.count { margin-left: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }

/* Overview */
.overview { position: relative; height: 34px; border-bottom: 1px solid var(--line); background: var(--panel); cursor: pointer; }
.overview canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.viewport { position: absolute; top: 2px; bottom: 2px; border: 1.5px solid var(--sel-edge); border-radius: 4px; background: color-mix(in srgb, var(--sel-edge) 10%, transparent); pointer-events: none; min-width: 3px; }

/* Main */
.main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 34%); min-height: 0; }
.list { position: relative; overflow: auto; outline: none; min-height: 0; }
.list:focus-visible { box-shadow: inset 0 0 0 2px var(--sel-edge); }
.lanes-head { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 78px 46px 280px minmax(0, 1fr); height: 28px; align-items: center; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.lanes-head .lh { display: flex; justify-content: space-between; padding: 0 2px; }
.lanes-head .c { color: var(--client); } .lanes-head .a { color: var(--agent); }
.spacer { position: relative; }
.rows { position: absolute; left: 0; right: 0; top: 0; }
.row { position: absolute; left: 0; right: 0; height: var(--row); display: grid; grid-template-columns: 78px 46px 280px minmax(0, 1fr); align-items: center; cursor: default; border-left: 2px solid transparent; }
.row:hover { background: var(--hover); }
.row.sel { background: var(--sel); border-left-color: var(--sel-edge); }
.row.pair { background: color-mix(in srgb, var(--sel-edge) 7%, transparent); }
.row.bad-error .label { color: var(--err); }
.time { font: 11px var(--mono); color: var(--faint); text-align: right; padding-right: 10px; font-variant-numeric: tabular-nums; }
.gutter { position: relative; height: 100%; }
.span { position: absolute; width: 2px; border-radius: 1px; }
.span.ok { background: color-mix(in srgb, var(--ok) 55%, transparent); }
.span.error { background: color-mix(in srgb, var(--err) 65%, transparent); }
.span.cancelled { background: color-mix(in srgb, var(--warn) 65%, transparent); }
.span.mid { top: 0; bottom: 0; } .span.start { top: 50%; bottom: 0; } .span.end { top: 0; bottom: 50%; }
.span.start::before, .span.end::before { content: ""; position: absolute; left: -2px; width: 6px; height: 6px; border-radius: 50%; background: inherit; top: -3px; }
.span.end::before { top: auto; bottom: -3px; }
.lane { position: relative; height: 100%; }
.lane::before, .lane::after { content: ""; position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line-strong); }
.lane::before { left: 14px; } .lane::after { right: 14px; }
.arrow { position: absolute; top: calc(50% + 4px); left: 15px; right: 15px; height: 0; border-top: 1.5px solid var(--c); }
.arrow::after { content: ""; position: absolute; top: -5px; border: 4.5px solid transparent; }
.arrow.r::after { right: -1px; border-left: 7px solid var(--c); border-right: 0; }
.arrow.l::after { left: -1px; border-right: 7px solid var(--c); border-left: 0; }
.arrow.notification { border-top-style: dashed; }
.arrow.notification.r::after { border-left-color: transparent; border-left-width: 0; width: 6px; height: 6px; border: 0; border-top: 1.5px solid var(--c); border-right: 1.5px solid var(--c); transform: rotate(45deg); top: -3.4px; right: 0; }
.arrow.notification.l::after { width: 6px; height: 6px; border: 0; border-bottom: 1.5px solid var(--c); border-left: 1.5px solid var(--c); transform: rotate(45deg); top: -3.4px; left: 0; }
.arrow.response { border-top-width: 1px; }
.from-client { --c: var(--client); } .from-agent { --c: var(--agent); }
.k-response { --c: color-mix(in srgb, var(--ok) 80%, var(--fg)); }
.k-error, .k-invalid { --c: var(--err); }
.k-cancel { --c: var(--warn); }
.k-note { --c: var(--note); }
.arrow.dim, .dot.dim { opacity: 0.5; }
.dot { position: absolute; top: calc(50% + 1px); width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
.dot.l { left: 11px; } .dot.r { right: 11px; }
.alabel { position: absolute; left: 22px; right: 22px; top: 2px; text-align: center; font: 10.5px/13px var(--mono); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.alabel.req { color: var(--fg); }
.notepill { position: absolute; left: 30px; right: 30px; top: 50%; transform: translateY(-50%); text-align: center; font-size: 11px; color: var(--note); border: 1px dashed var(--line-strong); border-radius: 999px; background: var(--panel); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 8px; }
.summary { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 12px 0 6px; }
.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
.label .q { color: var(--muted); }
.sess { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.badge { flex: none; font: 10.5px/16px var(--mono); padding: 0 6px; border-radius: 4px; background: var(--chip); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.badge.ok { color: var(--ok); background: var(--ok-bg); }
.badge.error { color: var(--err); background: var(--err-bg); }
.badge.cancelled, .badge.warn { color: var(--warn); background: var(--warn-bg); }
.inturn .time { box-shadow: inset 2px 0 0 var(--turn-c, var(--line-strong)); }
.turnrow { background: color-mix(in srgb, var(--panel) 70%, var(--bg)); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); grid-template-columns: 78px minmax(0, 1fr); cursor: pointer; }
.turnrow .time { box-shadow: inset 2px 0 0 var(--turn-c); }
.turnrow .tsum { display: flex; align-items: center; gap: 8px; min-width: 0; padding-right: 12px; }
.chev { width: 16px; height: 16px; flex: none; color: var(--muted); transition: transform 0.12s ease; }
.collapsed .chev { transform: rotate(-90deg); }
.tname { font-weight: 600; white-space: nowrap; }
.tprompt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; color: var(--fg); }
.tprompt::before { content: "“"; color: var(--faint); } .tprompt::after { content: "”"; color: var(--faint); }
.empty { padding: 48px; text-align: center; color: var(--muted); }

/* Details */
.details { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; min-height: 0; padding: 16px 18px 40px; }
.details h2 { font-size: 15px; margin: 0 0 2px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; word-break: break-word; }
.details h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 20px 0 8px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.details h3 .btn { text-transform: none; letter-spacing: 0; font-weight: 400; }
.details h3 .grow { flex: 1; }
.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 14px; margin-top: 10px; font-size: 12.5px; }
.kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; }
.mono { font-family: var(--mono); font-size: 12px; }
.link { color: var(--sel-edge); cursor: pointer; text-decoration: none; background: none; border: 0; padding: 0; }
.link:hover { text-decoration: underline; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 8px 0; background: var(--raised); }
.card .ct { display: flex; align-items: center; gap: 8px; font-weight: 500; }
.card .ct .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }
.hist .sep { color: var(--faint); font-size: 11px; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; max-height: 260px; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 0; }
.prose.thought { color: var(--muted); font-style: italic; }
.diag { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.diag .badge { min-width: 52px; text-align: center; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl td { padding: 3px 0; border-bottom: 1px solid var(--line); }
.tbl td.n { text-align: right; font-family: var(--mono); font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.keys { display: grid; grid-template-columns: max-content 1fr; gap: 5px 12px; font-size: 12.5px; color: var(--muted); align-items: center; }

/* JSON */
.json { font: 12px/1.55 var(--mono); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow: auto; }
.json details > summary { list-style: none; cursor: pointer; }
.json details > summary::-webkit-details-marker { display: none; }
.json details > summary::before { content: "▸"; display: inline-block; width: 12px; margin-left: -12px; color: var(--faint); transition: transform 0.1s; }
.json details[open] > summary::before { transform: rotate(90deg); }
.json .kids { padding-left: 16px; }
.json .item { padding-left: 12px; }
.json .k { color: var(--j-key); } .json .s { color: var(--j-str); white-space: pre-wrap; overflow-wrap: anywhere; } .json .n { color: var(--j-num); } .json .b { color: var(--j-lit); }
.json .p { color: var(--faint); }
.json .more { color: var(--muted); font-style: italic; }
.json details[open] > summary .j-closed { display: none; }

/* Drop + toast + help */
.drop { position: fixed; inset: 0; display: none; place-items: center; background: color-mix(in srgb, var(--bg) 80%, transparent); z-index: 20; font-size: 16px; color: var(--muted); }
.drop.on { display: grid; }
.drop div { border: 2px dashed var(--line-strong); border-radius: 16px; padding: 48px 64px; background: var(--panel); }
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%) translateY(20px); opacity: 0; background: var(--fg); color: var(--bg); padding: 6px 14px; border-radius: 8px; font-size: 12.5px; transition: all 0.18s ease; pointer-events: none; z-index: 30; }
.toast.on { opacity: 1; transform: translateX(-50%); }
.help { position: fixed; inset: 0; display: none; place-items: center; background: color-mix(in srgb, var(--bg) 60%, transparent); z-index: 25; }
.help.on { display: grid; }
.help > div { background: var(--panel); border: 1px solid var(--line-strong); border-radius: 12px; padding: 18px 22px; box-shadow: 0 12px 40px rgba(0,0,0,0.18); min-width: 300px; }
.help h2 { margin: 0 0 12px; font-size: 14px; }

@media (max-width: 860px) {
  body { overflow: auto; }
  .app { height: auto; min-height: 100vh; }
  .main { grid-template-columns: 1fr; }
  .list { height: 62vh; }
  .details { border-left: 0; border-top: 1px solid var(--line); }
  .lanes-head, .row { grid-template-columns: 64px 30px 200px minmax(0, 1fr); }
  .turnrow { grid-template-columns: 64px minmax(0, 1fr); }
  .stats { display: none; }
}
`;
