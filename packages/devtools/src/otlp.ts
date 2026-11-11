/**
 * Send a saved trace's spans to an OpenTelemetry collector (OTLP over HTTP,
 * protobuf): `subspace trace run.jsonl --otlp`.
 *
 * The spans are the ones `otelTap()` makes live (`spansFromTrace()`), at the
 * times the trace recorded. The endpoint and headers come from the options,
 * else the standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`, else
 * `http://localhost:4318/v1/traces`.
 */
import * as otel from '@opentelemetry/api';
import { spansFromTrace, type OtelApi } from '@deft-subspace/acp';
import type { TraceRecord } from '@deft-subspace/kernel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace';

export interface ExportTraceOptions {
  /** The OTLP traces endpoint, e.g. `http://localhost:4318/v1/traces`. */
  url?: string;
  headers?: Record<string, string>;
  /** `service.name` on the spans. Default: the trace's label, else `subspace`. */
  serviceName?: string;
  /** Record tool call titles (they can hold commands and paths). Default false. */
  titles?: boolean;
  /** @internal Where the spans go instead of OTLP (tests). */
  exporter?: SpanExporter;
  /** @internal How many spans may wait to be sent (tests). Default 100 000. */
  maxQueueSize?: number;
}

/**
 * Export the trace's spans; resolves with how many were sent once the
 * collector took them (and how many did not fit the queue and were dropped),
 * rejects if the collector did not take them.
 */
export async function exportTrace(input: readonly unknown[], options: ExportTraceOptions = {}): Promise<{ spans: number; dropped: number }> {
  // As read from a file: only well-formed records.
  const records = input.filter(isRecord);
  const header = records.find((r) => r.kind === 'header');
  const label = header?.kind === 'header' ? header.label : undefined;
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({ ...(options.url ? { url: options.url } : {}), ...(options.headers ? { headers: options.headers } : {}) });
  // Count what is exported, and keep the first failure (the SDK only logs it).
  let count = 0;
  let failure: Error | undefined;
  const counting: SpanExporter = {
    export: (spans: ReadableSpan[], done) => {
      exporter.export(spans, (result) => {
        if (result.code === 0) count += spans.length;
        else failure ??= reason(result.error ?? 'the collector did not take the spans');
        done(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    ...(exporter.forceFlush ? { forceFlush: () => exporter.forceFlush!() } : {}),
  };
  // Every span made, so the ones the batch queue drops when full are not lost silently.
  let made = 0;
  const counter: SpanProcessor = {
    onStart: () => {},
    onEnd: () => void made++,
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName ?? label ?? 'subspace' }),
    // Batched: one request per 512 spans, sent on the flush below.
    spanProcessors: [counter, new BatchSpanProcessor({ exporter: counting, maxExportBatchSize: 512, maxQueueSize: options.maxQueueSize ?? 100_000 })],
  });
  // This provider, not a global one: the export is self-contained.
  const api: OtelApi = {
    trace: {
      getTracer: (name, version) => provider.getTracer(name, version),
      setSpan: (context, span) => otel.trace.setSpan(context, span),
    },
    context: { active: () => otel.ROOT_CONTEXT },
  };
  spansFromTrace(records, api, options.titles ? { titles: true } : {});
  try {
    await provider.forceFlush();
  } catch (error) {
    failure ??= reason(error);
  } finally {
    await provider.shutdown().catch(() => {});
  }
  if (failure) throw failure;
  return { spans: count, dropped: Math.max(0, made - count) };
}

function isRecord(value: unknown): value is TraceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r.kind === 'header') return typeof r.started === 'string';
  if (r.kind === 'message') return typeof r.t === 'number' && (r.dir === 'in' || r.dir === 'out');
  return false;
}

/** The SDK rejects with arrays of errors, and errors whose detail is in `cause` or `code`. */
function reason(error: unknown): Error {
  if (Array.isArray(error)) return reason(error[0]);
  if (error instanceof Error) {
    const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
    const detail = error.message || (cause && String(cause.message || cause.code || '')) || String((error as { code?: unknown }).code ?? '');
    return detail === error.message ? error : new Error(detail || error.name, { cause: error });
  }
  return new Error(String(error));
}
