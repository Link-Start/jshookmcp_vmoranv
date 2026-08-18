/**
 * Event-loop lag sampling (r1-1).
 *
 * Production observability that does NOT depend on E2E env gating: the existing
 * execution metrics are only collected behind E2E_COLLECT_PERFORMANCE=1, leaving
 * production with zero visibility into event-loop blocking. node:perf_hooks
 * `monitorEventLoopDelay` samples the libuv event-loop delay in nanoseconds and
 * is exposed here as a p50/p90/p99 summary (milliseconds) plus a sample count —
 * surfaced through the /health verbose branch.
 *
 * Zero external dependencies.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/** Nanoseconds per millisecond. */
const NS_PER_MS = 1_000_000;

/** Millisecond latency summary + sample count. */
export interface LoopLagSummary {
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  samples: number;
}

/**
 * Minimal histogram surface the summarizer depends on. Extracted so the
 * ns→ms + percentile reduction can be unit-tested with a plain object
 * instead of a live `IntervalHistogram`.
 */
export interface LoopLagHistogram {
  /** Returns the recorded value at `percentile` (0-100], in nanoseconds. */
  percentile(percentile: number): number;
  /** Number of samples recorded since the last reset. */
  readonly count: number;
}

/** A started / startable event-loop lag sampler. */
export interface LoopLagSampler {
  /** Starts recording. Returns an idempotent stop function. */
  enable(): () => void;
  /** Stops recording (idempotent). */
  stop(): void;
  /** Current p50/p90/p99 (milliseconds) + sample count. */
  getSummary(): LoopLagSummary;
}

/** Pure: convert a histogram-like (nanoseconds) into a millisecond summary. */
export function summarizeLoopLag(histogram: LoopLagHistogram): LoopLagSummary {
  return {
    p50Ms: nsToMs(histogram.percentile(50)),
    p90Ms: nsToMs(histogram.percentile(90)),
    p99Ms: nsToMs(histogram.percentile(99)),
    samples: histogram.count,
  };
}

function nsToMs(nanoseconds: number): number {
  return Number((nanoseconds / NS_PER_MS).toFixed(2));
}

/**
 * Creates a sampler backed by `monitorEventLoopDelay`. Call `enable()` to start
 * recording; `stop()` (or the returned stop function) disables it. Both are
 * idempotent, so a restarted server re-arms cleanly.
 */
export function createLoopLagSampler(resolution = 100): LoopLagSampler {
  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution });
  const disable = () => histogram.disable();
  return {
    enable() {
      histogram.enable();
      return disable;
    },
    stop() {
      disable();
    },
    getSummary() {
      return summarizeLoopLag(histogram);
    },
  };
}
