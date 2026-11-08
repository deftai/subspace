/**
 * deft-subspace-trace <trace.jsonl> [-o out.html] [--summary]
 *
 * Writes a standalone HTML viewer for a trace and prints its path, or prints
 * a text summary with --summary.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTrace, formatSummary, readTrace } from './analyze.ts';
import { exportTrace } from './otlp.ts';
import { renderTraceHtml } from './render.ts';

const USAGE = `Usage: deft-subspace-trace <trace.jsonl> [-o out.html] [--summary] [--title text] [--otlp [url]]

  -o, --out <file>   where to write the viewer (default: next to the trace, .html)
  --summary          print a text summary instead of writing HTML
  --title <text>     page title (default: the trace's label)
  --otlp [url]       send the trace's OpenTelemetry spans to a collector instead
                     (OTLP/HTTP; default $OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
                     $OTEL_EXPORTER_OTLP_ENDPOINT, else http://localhost:4318/v1/traces;
                     headers from $OTEL_EXPORTER_OTLP_HEADERS)
  --service <name>   service.name for --otlp (default: the trace's label)
  --titles           with --otlp, include tool call titles (they can hold commands and paths)
`;

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
}): Promise<number> {
  let input: string | undefined;
  let out: string | undefined;
  let title: string | undefined;
  let summary = false;
  let otlp: string | true | undefined;
  let service: string | undefined;
  let titles = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      io.out(USAGE);
      return 0;
    } else if (arg === '-o' || arg === '--out') out = argv[++i];
    else if (arg === '--title') title = argv[++i];
    else if (arg === '--summary') summary = true;
    else if (arg === '--otlp') otlp = argv[i + 1] && /^https?:\/\//.test(argv[i + 1]!) ? argv[++i]! : true;
    else if (arg.startsWith('--otlp=')) otlp = arg.slice('--otlp='.length);
    else if (arg === '--service') service = argv[++i];
    else if (arg === '--titles') titles = true;
    else if (arg.startsWith('-')) {
      io.err(`Unknown option ${arg}\n${USAGE}`);
      return 2;
    } else if (input === undefined) input = arg;
    else {
      io.err(`One trace at a time\n${USAGE}`);
      return 2;
    }
  }
  if (!input || (out === undefined && argv.some((a) => a === '-o' || a === '--out'))) {
    io.err(USAGE);
    return 2;
  }

  let text: string;
  try {
    text = await readFile(input, 'utf8');
  } catch (error) {
    io.err(`Cannot read ${input}: ${(error as Error).message}\n`);
    return 1;
  }
  const { records, diagnostics } = readTrace(text);
  if (otlp !== undefined) {
    try {
      const { spans } = await exportTrace(records, { ...(otlp !== true ? { url: otlp } : {}), ...(service ? { serviceName: service } : {}), titles });
      io.out(`sent ${spans} span${spans === 1 ? '' : 's'}\n`);
      return 0;
    } catch (error) {
      io.err(`Could not send the spans: ${(error as Error).message}\n`);
      return 1;
    }
  }
  if (summary) {
    io.out(formatSummary(analyzeTrace(records, { diagnostics })));
    return 0;
  }
  const target = resolve(out ?? input.replace(/\.(jsonl|ndjson|json|txt)$/i, '') + '.html');
  await writeFile(target, renderTraceHtml(records, { diagnostics, title: title ?? (hasLabel(records) ? undefined : basename(input)) }));
  io.out(`${target}\n`);
  return 0;
}

function hasLabel(records: unknown[]): boolean {
  const first = records[0] as { kind?: unknown; label?: unknown } | undefined;
  return first?.kind === 'header' && typeof first.label === 'string';
}

// Run when executed directly (not when imported by the bin or tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
