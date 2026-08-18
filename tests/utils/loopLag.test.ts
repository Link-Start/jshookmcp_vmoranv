import { describe, expect, it, vi } from 'vitest';
import { createLoopLagSampler, summarizeLoopLag, type LoopLagHistogram } from '@utils/loopLag';

describe('summarizeLoopLag', () => {
  it('converts nanosecond percentiles to milliseconds', () => {
    const histogram: LoopLagHistogram = {
      // 1 ns = 0.001 ms, so percentile N → N ms at the 1e6 scale.
      percentile: (p: number) => p * 1_000_000,
      count: 42,
    };

    expect(summarizeLoopLag(histogram)).toEqual({
      p50Ms: 50,
      p90Ms: 90,
      p99Ms: 99,
      samples: 42,
    });
  });

  it('returns zeros for an empty (unrecorded) histogram', () => {
    const histogram: LoopLagHistogram = { percentile: () => 0, count: 0 };

    expect(summarizeLoopLag(histogram)).toEqual({ p50Ms: 0, p90Ms: 0, p99Ms: 0, samples: 0 });
  });

  it('rounds to two decimal places', () => {
    const histogram: LoopLagHistogram = { percentile: () => 1_234_567, count: 1 };

    expect(summarizeLoopLag(histogram)).toEqual({
      p50Ms: 1.23,
      p90Ms: 1.23,
      p99Ms: 1.23,
      samples: 1,
    });
  });
});

describe('createLoopLagSampler', () => {
  it('returns an idempotent stop function and a numeric summary', () => {
    const sampler = createLoopLagSampler();
    const stop = sampler.enable();

    expect(typeof stop).toBe('function');
    stop();
    stop(); // idempotent
    sampler.stop(); // idempotent

    const summary = sampler.getSummary();
    expect(typeof summary.p50Ms).toBe('number');
    expect(typeof summary.p90Ms).toBe('number');
    expect(typeof summary.p99Ms).toBe('number');
    expect(typeof summary.samples).toBe('number');
  });

  it('enable() returns the same stop function across calls', () => {
    const sampler = createLoopLagSampler();
    const first = sampler.enable();
    const second = sampler.enable();
    expect(second).toBe(first);
    first();
  });
});

describe('createLoopLagSampler windowing', () => {
  /** Fake histogram whose `count`/`percentile` are driven by setters. */
  function createFakeHistogram() {
    let samples = 0;
    let latencyNs = 1_000_000;
    const reset = vi.fn(() => {
      samples = 0;
    });
    const histogram = {
      percentile: vi.fn(() => latencyNs),
      get count() {
        return samples;
      },
      reset,
      enable: vi.fn(),
      disable: vi.fn(),
    };
    return {
      histogram,
      setSamples: (n: number) => {
        samples = n;
      },
      setLatencyNs: (ns: number) => {
        latencyNs = ns;
      },
    };
  }

  it('resets after each window so startup noise stops polluting p50', () => {
    const fake = createFakeHistogram();
    let nowMs = 0;
    const sampler = createLoopLagSampler({
      histogram: fake.histogram as never,
      now: () => nowMs,
      windowMs: 30_000,
    });
    sampler.enable();

    // Window 1 (0-30s): startup blocking dominates — 500 samples at 500ms.
    fake.setLatencyNs(500_000_000);
    fake.setSamples(500);

    // Poll inside window 1: noise still present, no reset yet.
    expect(sampler.getSummary().p50Ms).toBe(500);

    // Window 1 closes at t=30s: summary still reflects that window, then reset.
    nowMs = 30_000;
    sampler.getSummary();
    expect(fake.histogram.reset).toHaveBeenCalledTimes(1);

    // Window 2 (30-60s): clean 1ms samples only.
    fake.setLatencyNs(1_000_000);
    fake.setSamples(100);

    nowMs = 60_000;
    const summary = sampler.getSummary();
    expect(summary.p50Ms).toBe(1);
    expect(summary.p90Ms).toBe(1);
    expect(summary.p99Ms).toBe(1);
    expect(summary.samples).toBe(100);
    expect(summary.cumulativeSamples).toBe(600);
    expect(fake.histogram.reset).toHaveBeenCalledTimes(2);
  });

  it('does not reset before the window elapses', () => {
    const fake = createFakeHistogram();
    let nowMs = 0;
    const sampler = createLoopLagSampler({
      histogram: fake.histogram as never,
      now: () => nowMs,
      windowMs: 30_000,
    });
    sampler.enable();

    fake.setLatencyNs(2_000_000);
    fake.setSamples(10);
    sampler.getSummary();

    nowMs = 10_000; // still within the first window
    fake.setSamples(20);
    sampler.getSummary();

    expect(fake.histogram.reset).not.toHaveBeenCalled();
  });

  it('exposes a cumulative sample count across windows', () => {
    const fake = createFakeHistogram();
    let nowMs = 0;
    const sampler = createLoopLagSampler({
      histogram: fake.histogram as never,
      now: () => nowMs,
      windowMs: 30_000,
    });
    sampler.enable();

    fake.setSamples(50);
    nowMs = 30_000;
    sampler.getSummary(); // closes window 1 (50 samples)

    fake.setSamples(75);
    nowMs = 60_000;
    const summary = sampler.getSummary(); // closes window 2 (75 samples)

    expect(summary.cumulativeSamples).toBe(125);
  });
});
