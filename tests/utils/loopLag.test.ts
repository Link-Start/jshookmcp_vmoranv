import { describe, expect, it } from 'vitest';
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
