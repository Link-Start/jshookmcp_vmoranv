/**
 * OTLP-backed `InstrumentationContract` implementation.
 *
 * Emits spans and metrics over the standard OTLP/HTTP protocol, so any
 * collector-style endpoint can consume them (self-hosted
 * opentelemetry-collector, SigNoz/ClickHouse, Grafana Cloud, a Cloudflare
 * Worker receiver — the endpoint is just OTEL_EXPORTER_OTLP_ENDPOINT).
 *
 * DESIGN CONSTRAINTS (from the contract, non-negotiable):
 *  - MUST NOT throw and MUST NOT block: every public method swallows its own
 *    failures. A dead collector must never break a tool call.
 *  - Construction is synchronous — `createInstrumentation()` is called from
 *    the MCPServer constructor. The OpenTelemetry SDK is loaded via dynamic
 *    import (the packages are optionalDependencies), so this class is a
 *    lazily-initialising facade: spans and metrics emitted before the SDK is
 *    ready are buffered (bounded) and replayed once it is; if the import or
 *    provider construction fails, the instance degrades to a permanent
 *    no-op for the rest of the process lifetime.
 *
 * stdio DEPLOYMENT NOTE: jshookmcp runs as one short-lived process per client
 * session. The batch schedule (default 2s) plus the shutdown flush in
 * closeServer() bound the span-loss window; the periodic metric reader
 * (default 30s) is force-flushed through the same shutdown path.
 */
import type { InstrumentationContract, MetricType, SpanLike } from './InstrumentationContract';
import {
  DEFAULT_TELEMETRY_AUTHORIZATION,
  DEFAULT_TELEMETRY_ENDPOINT,
} from '@src/constants/telemetry';

export interface OtlpInstrumentationOptions {
  /**
   * Full trace-path URL passed to the OTLP exporter, e.g.
   * `http://localhost:4318/v1/traces`. When omitted the exporter falls back
   * to the standard OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
   * environment variables, which is the supported operator path.
   */
  traceUrl?: string;
  /** Full metrics-path URL; same env fallback as `traceUrl`. */
  metricUrl?: string;
  /** Headers forwarded with every export (e.g. basic-auth for Grafana Cloud). */
  headers?: Record<string, string>;
  /** BatchSpanProcessor delay; small default because stdio processes are short-lived. */
  spanScheduleDelayMs?: number;
  /** Periodic metric reader interval. */
  metricExportIntervalMs?: number;
  /**
   * Called once when the SDK import or provider construction fails. The
   * instance has already degraded to a no-op by the time this fires.
   */
  onInitError?: (error: unknown) => void;
  /** Test seam: replace the trace exporter (e.g. InMemorySpanExporter). */
  makeTraceExporter?: () => unknown;
  /** Test seam: replace the metric exporter. */
  makeMetricExporter?: () => unknown;
}

interface BufferedSpan {
  name: string;
  attrs: Record<string, unknown> | undefined;
  startTime: number;
  /** Lifecycle events recorded while the SDK was still loading. */
  events: { name: string; attrs?: Record<string, unknown> }[];
  endAttrs: Record<string, unknown> | undefined;
  ended: boolean;
  /**
   * The live SpanLike once the replay has connected this buffer entry to a
   * real span — later end()/addEvent() calls forward to it.
   */
  live: SpanLike | null;
}

interface BufferedMetric {
  name: string;
  value: number;
  type: MetricType;
  attrs: Record<string, unknown> | undefined;
}

const MAX_BUFFERED_SPANS = 512;
const MAX_BUFFERED_METRICS = 1024;
const FLUSH_TIMEOUT_MS = 5_000;

/** OTLP attribute values: primitives (and arrays thereof) only. */
function sanitizeAttrs(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!attrs) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    } else if (value !== null && value !== undefined) {
      try {
        clean[key] = JSON.stringify(value);
      } catch {
        /* unserialisable attr value: drop it */
      }
    }
  }
  return clean;
}

export class OtlpInstrumentation implements InstrumentationContract {
  private state: 'init' | 'live' | 'broken' = 'init';
  private readonly pendingSpans: BufferedSpan[] = [];
  private readonly pendingMetrics: BufferedMetric[] = [];
  private readonly options: OtlpInstrumentationOptions;
  /**
   * The in-flight (or settled) init. flush()/shutdown() await it first — a
   * shutdown that races the SDK still loading would otherwise no-op and drop
   * every buffered span, which is exactly the stdio short-process loss this
   * class exists to prevent.
   */
  private readonly initPromise: Promise<void>;

  // OTel runtime handles — typed loosely on purpose: the SDK types come from
  // optionalDependencies and this module must import nothing from them
  // statically, or the no-OTel install path would fail at module load.
  private tracer: { startSpan: (name: string, opts: unknown) => SpanHandle } | null = null;
  private spanProvider: {
    forceFlush: (t: number) => Promise<void>;
    shutdown: (t: number) => Promise<void>;
  } | null = null;
  private metricProvider: {
    forceFlush: (t: number) => Promise<void>;
    shutdown: (t: number) => Promise<void>;
  } | null = null;
  private meter: MeterFacade | null = null;

  constructor(options: OtlpInstrumentationOptions = {}) {
    this.options = options;
    this.initPromise = this.init();
    void this.initPromise.catch(() => {
      /* init() handles its own failures via degrade() */
    });
  }

  private degrade(error: unknown): void {
    this.state = 'broken';
    this.pendingSpans.length = 0;
    this.pendingMetrics.length = 0;
    try {
      this.options.onInitError?.(error);
    } catch {
      /* even the error hook must not throw */
    }
  }

  private async init(): Promise<void> {
    try {
      const [
        { BasicTracerProvider, BatchSpanProcessor },
        { resourceFromAttributes },
        traceExpModule,
        { MeterProvider, PeriodicExportingMetricReader },
        metricExpModule,
      ] = await Promise.all([
        import('@opentelemetry/sdk-trace-base'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/sdk-metrics'),
        import('@opentelemetry/exporter-metrics-otlp-http'),
      ]);

      // Effective exporter targets: explicit options > operator OTel env >
      // built-in project ingress (opt-out telemetry ships ON). The resolver
      // is pure and exported for tests.
      const targets = resolveExporterTargets(this.options);
      const agentOptions = await buildProxyAgentOptions(targets.traceUrl ?? targets.baseUrl ?? '');

      // install.id: persistent anonymous UUID per installation, so
      // distributed telemetry can tell "one install, many sessions" from
      // "many installs" without collecting anything identifying. A filesystem
      // failure degrades to an ephemeral id — never breaks the process.
      const { getOrCreateInstallId } = await import('@utils/installId');
      const installId = await getOrCreateInstallId();

      const resource = resourceFromAttributes({
        'service.name': 'jshookmcp',
        'service.instance.id': `${process.pid}-${Date.now()}`,
        'install.id': installId,
      });

      const traceExporter = this.options.makeTraceExporter
        ? (this.options.makeTraceExporter() as never)
        : new traceExpModule.OTLPTraceExporter({
            ...(targets.traceUrl ? { url: targets.traceUrl } : {}),
            ...(targets.headers ? { headers: targets.headers } : {}),
            ...agentOptions,
          });
      const spanProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [
          new BatchSpanProcessor(traceExporter, {
            scheduledDelayMillis: this.options.spanScheduleDelayMs ?? 2_000,
          }),
        ],
      });

      const metricExporter = this.options.makeMetricExporter
        ? (this.options.makeMetricExporter() as never)
        : new metricExpModule.OTLPMetricExporter({
            ...(targets.metricUrl ? { url: targets.metricUrl } : {}),
            ...(targets.headers ? { headers: targets.headers } : {}),
            ...agentOptions,
          });
      const metricProvider = new MeterProvider({
        resource,
        readers: [
          new PeriodicExportingMetricReader({
            exporter: metricExporter,
            exportIntervalMillis: this.options.metricExportIntervalMs ?? 30_000,
            exportTimeoutMillis: 10_000,
          }),
        ],
      });

      this.tracer = spanProvider.getTracer('jshookmcp') as never;
      this.spanProvider = spanProvider as never;
      this.metricProvider = metricProvider as never;
      this.meter = new MeterFacade(metricProvider.getMeter('jshookmcp'));
      this.state = 'live';

      // Replay the full lifecycle of every span buffered before the SDK
      // finished loading — start attrs, events in order, and the end() (with
      // its trailing attrs) if the caller already finished the span. A
      // replay that only re-starts the span would leave it forever open and
      // the OTel SDK would drop it at export.
      for (const buffered of this.pendingSpans.splice(0)) {
        const live = this.startSpan(buffered.name, buffered.attrs, buffered.startTime);
        for (const event of buffered.events) {
          live.addEvent(event.name, event.attrs);
        }
        if (buffered.ended) {
          live.end(buffered.endAttrs);
        } else {
          // Still open: future lifecycle calls on the caller's handle
          // forward to the live span from now on.
          buffered.live = live;
        }
      }
      for (const buffered of this.pendingMetrics.splice(0)) {
        this.emitMetric(buffered.name, buffered.value, buffered.type, buffered.attrs);
      }
    } catch (error) {
      this.degrade(error);
    }
  }

  startSpan(name: string, attrs?: Record<string, unknown>, startTime?: number): SpanLike {
    if (this.state === 'broken') return noopSpan(name);
    if (this.state === 'init') {
      const entry: BufferedSpan = {
        name,
        attrs,
        startTime: startTime ?? Date.now(),
        events: [],
        endAttrs: undefined,
        ended: false,
        live: null,
      };
      if (this.pendingSpans.length < MAX_BUFFERED_SPANS) {
        this.pendingSpans.push(entry);
      }
      // Buffer-backed handle: lifecycle calls are recorded on the entry; once
      // the replay connects a live span they forward to it instead.
      return {
        name,
        startTime: entry.startTime,
        end(endAttrs?: Record<string, unknown>) {
          if (entry.live) {
            entry.live.end(endAttrs);
            return;
          }
          entry.ended = true;
          if (endAttrs) entry.endAttrs = endAttrs;
        },
        addEvent(eventName: string, eventAttrs?: Record<string, unknown>) {
          if (entry.live) {
            entry.live.addEvent(eventName, eventAttrs);
            return;
          }
          entry.events.push({ name: eventName, attrs: eventAttrs });
        },
      };
    }
    try {
      const otelSpan = this.tracer!.startSpan(
        name,
        startTime ? { startTime } : undefined,
      ) as SpanHandle;
      otelSpan.setAttributes(sanitizeAttrs(attrs));
      return {
        name,
        startTime: startTime ?? Date.now(),
        end(endAttrs?: Record<string, unknown>) {
          try {
            if (endAttrs) otelSpan.setAttributes(sanitizeAttrs(endAttrs));
            otelSpan.end();
          } catch {
            /* never throw from a span callback */
          }
        },
        addEvent(eventName: string, eventAttrs?: Record<string, unknown>) {
          try {
            otelSpan.addEvent(eventName, sanitizeAttrs(eventAttrs));
          } catch {
            /* never throw */
          }
        },
      };
    } catch {
      return noopSpan(name);
    }
  }

  emitMetric(name: string, value: number, type: MetricType, attrs?: Record<string, unknown>): void {
    if (this.state === 'broken') return;
    if (this.state === 'init') {
      if (this.pendingMetrics.length < MAX_BUFFERED_METRICS) {
        this.pendingMetrics.push({ name, value, type, attrs });
      }
      return;
    }
    try {
      this.meter!.record(name, value, type, sanitizeAttrs(attrs));
    } catch {
      /* swallow: metrics must never break the caller */
    }
  }

  /** Force-push buffered spans/metrics to the endpoint. Bounded. */
  async flush(): Promise<void> {
    if (this.state === 'broken') return;
    // Wait for init (bounded) before deciding: a flush that races the SDK
    // load would otherwise no-op and silently drop the pending buffer.
    await Promise.race([
      this.initPromise,
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref?.()),
    ]);
    if (this.state !== 'live') return;
    try {
      await Promise.race([
        Promise.all([
          this.spanProvider!.forceFlush(FLUSH_TIMEOUT_MS),
          this.metricProvider!.forceFlush(FLUSH_TIMEOUT_MS),
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref?.()),
      ]);
    } catch {
      /* flush is best-effort by contract */
    }
  }

  /** Shutdown providers (flushes + stops timers). Called from closeServer. */
  async shutdown(): Promise<void> {
    if (this.state === 'broken') return;
    // Same init-wait as flush(): shutdown is the last chance to export the
    // buffer, and it frequently races a cold start on short-lived stdio
    // processes.
    await Promise.race([
      this.initPromise,
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref?.()),
    ]);
    if (this.state !== 'live') return;
    this.state = 'broken'; // further emissions are no-ops; shutdown is one-way
    try {
      await Promise.race([
        Promise.all([
          this.spanProvider!.shutdown(FLUSH_TIMEOUT_MS),
          this.metricProvider!.shutdown(FLUSH_TIMEOUT_MS),
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref?.()),
      ]);
    } catch {
      /* best-effort */
    }
  }
}

// ── minimal structural types for the dynamically-imported OTel SDK ──
// The real Span interface is far richer; we only use the three members the
// contract needs. Structural typing keeps this module free of static imports.

interface SpanHandle {
  setAttributes(attrs: Record<string, unknown>): void;
  end(): void;
  addEvent(name: string, attrs?: Record<string, unknown>): void;
}

/** Lazily creates instruments per (name, type) — attr sets vary per call. */
class MeterFacade {
  private readonly meter: {
    createCounter: (n: string) => CounterLike;
    createHistogram: (n: string) => HistogramLike;
    createGauge: (n: string) => GaugeLike;
  };
  private readonly counters = new Map<string, CounterLike>();
  private readonly histograms = new Map<string, HistogramLike>();
  private readonly gauges = new Map<string, GaugeLike>();

  constructor(meter: unknown) {
    this.meter = meter as never;
  }

  record(name: string, value: number, type: MetricType, attrs: Record<string, unknown>): void {
    if (type === 'counter') {
      const counter = this.counters.get(name) ?? this.meter.createCounter(name);
      this.counters.set(name, counter);
      counter.add(value, attrs);
    } else if (type === 'histogram') {
      const histogram = this.histograms.get(name) ?? this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
      histogram.record(value, attrs);
    } else {
      const gauge = this.gauges.get(name) ?? this.meter.createGauge(name);
      this.gauges.set(name, gauge);
      gauge.record(value, attrs);
    }
  }
}

interface CounterLike {
  add(value: number, attrs?: Record<string, unknown>): void;
}
interface HistogramLike {
  record(value: number, attrs?: Record<string, unknown>): void;
}
interface GaugeLike {
  record(value: number, attrs?: Record<string, unknown>): void;
}

function noopSpan(name: string): SpanLike {
  const startTime = Date.now();
  return {
    name,
    startTime,
    end() {
      /* no-op */
    },
    addEvent() {
      /* no-op */
    },
  };
}

// ── proxy support ──

export interface ExporterTargets {
  /** Full trace-path URL, or undefined when the exporter should read env. */
  traceUrl?: string;
  /** Full metrics-path URL, or undefined when the exporter should read env. */
  metricUrl?: string;
  /** Headers to pass; undefined → exporter reads OTEL_EXPORTER_OTLP_HEADERS. */
  headers?: Record<string, string>;
  /** Base endpoint actually in effect (for NO_PROXY evaluation). */
  baseUrl?: string;
}

/**
 * Resolve exporter targets with the built-in project ingress as the LAST
 * resort: explicit options win, operator OTel env vars are honored natively
 * (nothing passed → exporters read OTEL_EXPORTER_OTLP_* themselves), and a
 * fresh install with no configuration lands on DEFAULT_TELEMETRY_ENDPOINT
 * with the public write token. Telemetry therefore ships ON unless the
 * operator opts out — see docs/guide/telemetry.
 */
export function resolveExporterTargets(options: OtlpInstrumentationOptions): ExporterTargets {
  if (options.traceUrl ?? options.metricUrl ?? options.headers) {
    return {
      ...(options.traceUrl ? { traceUrl: options.traceUrl } : {}),
      ...(options.metricUrl ? { metricUrl: options.metricUrl } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      baseUrl: options.traceUrl,
    };
  }
  const envEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (envEndpoint) {
    // Operator-configured collector: pass nothing so the exporters honor the
    // full standard env surface (incl. per-signal endpoints and headers).
    return { baseUrl: envEndpoint };
  }
  return {
    traceUrl: `${DEFAULT_TELEMETRY_ENDPOINT}/v1/traces`,
    metricUrl: `${DEFAULT_TELEMETRY_ENDPOINT}/v1/metrics`,
    headers: { authorization: DEFAULT_TELEMETRY_AUTHORIZATION },
    baseUrl: DEFAULT_TELEMETRY_ENDPOINT,
  };
}

/**
 * Build the `httpAgentOptions` constructor injection for the OTLP exporters
 * when (a) a proxy env var is present and (b) the effective OTLP endpoint
 * host is not covered by NO_PROXY. Returns `{}` (no injection → default
 * direct agents) otherwise. https-proxy-agent is an optional dependency:
 * a missing package degrades to direct connection.
 */
async function buildProxyAgentOptions(baseUrl: string): Promise<Record<string, unknown>> {
  const proxyUrl =
    process.env.https_proxy ??
    process.env.HTTPS_PROXY ??
    process.env.all_proxy ??
    process.env.ALL_PROXY;
  if (!proxyUrl) return {};

  let targetHost = '';
  try {
    targetHost = baseUrl ? new URL(baseUrl).hostname : '';
  } catch {
    targetHost = '';
  }
  // No endpoint resolvable (localhost default) — a proxy would only get in
  // the way.
  if (!targetHost || isNoProxyMatch(targetHost, process.env.NO_PROXY ?? process.env.no_proxy)) {
    return {};
  }

  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyUrl);
    return {
      // Function-valued httpAgentOptions is the legacy constructor path's
      // agentFactory hook — a top-level `agentFactory` option is silently
      // dropped by convertLegacyHttpOptions.
      httpAgentOptions: async () => agent as never,
    };
  } catch {
    return {};
  }
}

/** NO_PROXY matching: comma-separated hostnames/suffixes; localhost + loopback always bypass. */
function isNoProxyMatch(host: string, noProxy: string | undefined): boolean {
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  if (!noProxy) return false;
  return noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .some((entry) => host.toLowerCase() === entry || host.toLowerCase().endsWith(`.${entry}`));
}
