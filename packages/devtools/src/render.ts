/**
 * One standalone HTML file: the trace, the analyzer and the viewer, all
 * inline. No network, so it opens from file:// and can be attached to a bug.
 */
import { ANALYZER_FUNCTIONS, type Diagnostic } from './analyze.ts';
import { VIEWER_CSS } from './viewer/styles.ts';
import { viewerApp } from './viewer/app.ts';

export interface RenderOptions {
  /** Page title. Default: the trace header's label. */
  title?: string;
  /** Problems found while reading the file (from `readTrace`), shown with the others. */
  diagnostics?: Diagnostic[];
}

/**
 * JSON that is safe inside a `<script>` element: `<` is escaped, so neither
 * `</script>` nor `<!--` in the data can end or confuse the element. U+2028
 * and U+2029 are escaped for older parsers.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The viewer's script: the analyzer's functions, then the app. */
export function viewerScript(): string {
  const source = `${ANALYZER_FUNCTIONS.map(String).join('\n')}\n(${String(viewerApp)})();\n`;
  // Guard against our own code ending the element early.
  if (/<\/script|<!--/i.test(source)) throw new Error('The viewer script contains </script or <!--');
  return source;
}

export function renderTraceHtml(records: readonly unknown[], options: RenderOptions = {}): string {
  const header = records[0] as { kind?: unknown; label?: unknown } | undefined;
  const title = options.title ?? (header?.kind === 'header' && typeof header.label === 'string' ? header.label : 'ACP trace');
  const data = scriptSafeJson({ records, title, ...(options.diagnostics?.length ? { diagnostics: options.diagnostics } : {}) });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="@deft-subspace/devtools">
<title>${escapeHtml(title)} · Subspace trace</title>
<style>${VIEWER_CSS}</style>
</head>
<body>
<noscript>This trace viewer needs JavaScript.</noscript>
<script type="application/json" id="trace-data">${data}</script>
<script>
"use strict";
${viewerScript()}</script>
</body>
</html>
`;
}
