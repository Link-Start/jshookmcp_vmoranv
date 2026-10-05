/**
 * OtlpInstrumentation tests.
 *
 * The class is a lazily-initialising facade over the OpenTelemetry SDK:
 * emissions made before the dynamic import completes must survive (buffered
 * and replayed), an SDK that fails to load must degrade to a permanent no-op,
 * and — per the InstrumentationContract — NOTHING here may ever throw or
 * block the caller, including flush()/shutdown() against a dead endpoint.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { OtlpInstrumentation } from '@server/observability/OtlpInstrumentation';

/** Wait until the async init has landed (or the test times out). */
async function waitForInit(ms = 2_000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  void ms;
}

function makeLive(): {
  exporter: InMemorySpanExporter;
  metricExporter: InMemoryMetricExporter;
  otlp: OtlpInstrumentation;
} {
  const exporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const otlp = new OtlpInstrumentation({
    makeTraceExporter: () => exporter,
    makeMetricExporter: () => metricExporter,
    metricExportIntervalMs: 600_000, // never periodic-export on its own; flush drives tests
  });
  return { exporter, metricExporter, otlp };
}

describe('OtlpInstrumentation', () => {
  it('buffers spans emitted before init and replays them with their attributes', async () => {
    const { exporter, otlp } = makeLive();

    // Emitted synchronously right after construction — init has NOT landed yet.
    const early = otlp.startSpan('probe.early', { 'probe.kind': 'buffered' });
    early.end({ 'probe.done': true });
    await waitForInit();
    const late = otlp.startSpan('probe.late');
    late.end();

    await otlp.flush();
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toContain('probe.early');
    expect(names).toContain('probe.late');
    const earlySpan = exporter.getFinishedSpans().find((s) => s.name === 'probe.early');
    expect(earlySpan?.attributes['probe.kind']).toBe('buffered');
    expect(earlySpan?.attributes['probe.done']).toBe(true);
  });

  it('stringifies non-primitive span attributes instead of dropping the span', async () => {
    const { exporter, otlp } = makeLive();
    const span = otlp.startSpan('probe.attrs', {
      plain: 'text',
      count: 3,
      flag: true,
      structured: { nested: 'value' },
    });
    span.end();
    await waitForInit();
    await otlp.flush();

    const spanOut = exporter.getFinishedSpans().find((s) => s.name === 'probe.attrs');
    expect(spanOut?.attributes['plain']).toBe('text');
    expect(spanOut?.attributes['count']).toBe(3);
    expect(spanOut?.attributes['flag']).toBe(true);
    expect(spanOut?.attributes['structured']).toBe(JSON.stringify({ nested: 'value' }));
  });

  it('exports buffered metrics once live', async () => {
    const { metricExporter, otlp } = makeLive();
    otlp.emitMetric('probe_metric_total', 1, 'counter', { kind: 'a' });
    otlp.emitMetric('probe_metric_total', 2, 'counter', { kind: 'b' });
    otlp.emitMetric('probe_latency_ms', 12, 'histogram');
    otlp.emitMetric('probe_gauge', 5, 'gauge');
    await otlp.flush();

    // getMetrics() returns ResourceMetrics envelopes: { resource, scopeMetrics
    // → metrics → descriptor.name }. Flatten before matching.
    const names = metricExporter
      .getMetrics()
      .flatMap((envelope) => envelope.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => metric.descriptor.name);
    expect(names).toContain('probe_metric_total');
    expect(names).toContain('probe_latency_ms');
    expect(names).toContain('probe_gauge');
  });

  it('flush stays bounded when the endpoint is unreachable', async () => {
    const otlp = new OtlpInstrumentation({
      traceUrl: 'http://127.0.0.1:1/v1/traces',
      metricUrl: 'http://127.0.0.1:1/v1/metrics',
      spanScheduleDelayMs: 10,
    });
    const span = otlp.startSpan('probe.dead.endpoint');
    span.end();
    await waitForInit();
    // The OTel exporter retries/swallows internally; flush must resolve
    // within its internal timeout rather than hanging the shutdown path.
    await expect(otlp.flush()).resolves.toBeUndefined();
    await expect(otlp.shutdown()).resolves.toBeUndefined();
  });

  it('emissions after shutdown are silent no-ops', async () => {
    const { otlp } = makeLive();
    await waitForInit();
    await otlp.shutdown();
    // One-way: post-shutdown spans neither throw nor resurrect the backend.
    const span = otlp.startSpan('probe.after.shutdown');
    expect(() => span.end()).not.toThrow();
    expect(() => otlp.emitMetric('m', 1, 'counter')).not.toThrow();
    await expect(otlp.flush()).resolves.toBeUndefined();
  });
});
