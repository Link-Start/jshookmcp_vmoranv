/**
 * Fix 1 [P0] — webgpu_frame_timing tool.
 *
 * Pure statistics (`computeFrameStats`) are tested directly; the handler is
 * exercised with a mocked page whose evaluate resolves the in-page rAF +
 * timestamp-query script result.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MCPServerContext } from '@server/domains/shared/registry';
import { WebGPUHandlers } from '@server/domains/webgpu/index';
import { ResponseBuilder } from '@server/domains/shared/ResponseBuilder';
import { computeFrameStats } from '@server/domains/webgpu/handlers/frame-timing';

// ─── Pure statistics ─────────────────────────────────────────────────────────

describe('computeFrameStats', () => {
  it('computes avg and p95 from frame timings', () => {
    const stats = computeFrameStats([10, 11, 12, 13, 14, 15, 16, 17, 18, 100], [], 'gpu-timestamp');
    expect(stats.frameCount).toBe(10);
    expect(stats.avgFrameMs).toBeCloseTo(22.6, 5);
    // p95 = index floor(10*0.95)=9 → 100
    expect(stats.p95FrameMs).toBe(100);
  });

  it('computes avg and p95 GPU timings from resolved timestamp queries', () => {
    const stats = computeFrameStats(
      [16, 17, 16, 16, 16, 16, 16, 16, 16, 16],
      [8, 9, 8, 8, 8, 8, 8, 8, 8, 8],
      'gpu-timestamp',
    );
    expect(stats.avgGpuMs).toBeCloseTo(8.1, 5);
    expect(stats.p95GpuMs).toBe(9);
  });

  it('flags dropped frames beyond 1.5x median or 34ms', () => {
    const timings = [16, 16, 16, 16, 16, 16, 16, 16, 16, 80, 16, 16];
    const stats = computeFrameStats(timings, [], 'gpu-timestamp');
    // median 16 → threshold max(34, 24) = 34 → 80 counts as dropped
    expect(stats.droppedFrames).toBe(1);
  });

  it('classifies GPU-bound when gpu/frame ratio ≥ 0.8', () => {
    const stats = computeFrameStats([16, 16, 16, 16], [14, 14, 14, 14], 'gpu-timestamp');
    expect(stats.cpuOrGpuBound).toBe('gpu-bound');
  });

  it('classifies CPU-bound when gpu/frame ratio ≤ 0.5', () => {
    const stats = computeFrameStats([16, 16, 16, 16], [5, 5, 5, 5], 'gpu-timestamp');
    expect(stats.cpuOrGpuBound).toBe('cpu-bound');
  });

  it('reports unknown bound when falling back to CPU round-trip timing', () => {
    const stats = computeFrameStats([16, 17, 18, 16], [], 'cpu-roundtrip');
    expect(stats.precision).toBe('cpu-roundtrip');
    expect(stats.cpuOrGpuBound).toBe('unknown');
    expect(stats.avgGpuMs).toBeNull();
    expect(stats.p95GpuMs).toBeNull();
  });

  it('handles empty input without throwing', () => {
    const stats = computeFrameStats([], [], 'gpu-timestamp');
    expect(stats.frameCount).toBe(0);
    expect(stats.avgFrameMs).toBe(0);
    expect(stats.p95FrameMs).toBe(0);
    expect(stats.droppedFrames).toBe(0);
    expect(stats.avgGpuMs).toBeNull();
  });
});

// ─── Handler ─────────────────────────────────────────────────────────────────

describe('webgpu_frame_timing', () => {
  let ctx: MCPServerContext;
  let handlers: WebGPUHandlers;

  beforeEach(() => {
    ctx = {
      eventBus: { emit: () => {} },
      pageController: {
        getActivePage: async () => {
          throw new Error('No active page');
        },
      },
    } as unknown as MCPServerContext;
    handlers = new WebGPUHandlers(ctx);
  });

  it('should require an active page', async () => {
    const response = await handlers.webgpu_frame_timing({ frameCount: 60 });
    const result = ResponseBuilder.parse(response);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/page/i),
    });
  });

  it('should validate frameCount bounds', async () => {
    const mockPage = {
      url: () => 'https://example.com/',
      evaluate: vi.fn().mockResolvedValue(undefined),
      evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      createCDPSession: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ metrics: [] }),
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    };
    ctx.pageController = { getActivePage: async () => mockPage } as any;
    handlers = new WebGPUHandlers(ctx);

    const response = await handlers.webgpu_frame_timing({ frameCount: 0 });
    const result = ResponseBuilder.parse(response);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/frameCount/i);
  });

  it('should return frame timing stats from GPU timestamp queries', async () => {
    const mockPage = {
      url: () => 'https://example.com/',
      evaluate: vi.fn().mockResolvedValue({
        frameTimesMs: [16, 17, 16, 16, 16, 16, 16, 16, 16, 16],
        gpuTimesMs: [8, 9, 8, 8, 8, 8, 8, 8, 8, 8],
        timestampSupported: true,
        timestampPeriod: 1,
      }),
      evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      createCDPSession: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ metrics: [] }),
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    };
    ctx.pageController = { getActivePage: async () => mockPage } as any;
    handlers = new WebGPUHandlers(ctx);

    const response = await handlers.webgpu_frame_timing({ frameCount: 10 });
    const result = ResponseBuilder.parse(response);

    expect(result.success).toBe(true);
    expect(result.precision).toBe('gpu-timestamp');
    expect(result.frameCount).toBe(10);
    expect(result.avgFrameMs).toBeGreaterThan(0);
    expect(result.avgGpuMs).toBeGreaterThan(0);
    expect(typeof result.p95FrameMs).toBe('number');
    expect(typeof result.droppedFrames).toBe('number');
    expect(['gpu-bound', 'cpu-bound', 'balanced', 'unknown']).toContain(result.cpuOrGpuBound);
  });

  it('should degrade to cpu-roundtrip precision when timestamp-query is unavailable', async () => {
    const mockPage = {
      url: () => 'https://example.com/',
      evaluate: vi.fn().mockResolvedValue({
        frameTimesMs: [16, 17, 16, 16],
        gpuTimesMs: [],
        timestampSupported: false,
        timestampPeriod: 0,
      }),
      evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      createCDPSession: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ metrics: [] }),
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    };
    ctx.pageController = { getActivePage: async () => mockPage } as any;
    handlers = new WebGPUHandlers(ctx);

    const response = await handlers.webgpu_frame_timing({ frameCount: 4 });
    const result = ResponseBuilder.parse(response);

    expect(result.success).toBe(true);
    expect(result.precision).toBe('cpu-roundtrip');
    expect(result.cpuOrGpuBound).toBe('unknown');
    expect(result.avgGpuMs).toBeNull();
    expect(result.avgFrameMs).toBeGreaterThan(0);
  });

  it('should include per-frame timestamps when includeTimestamps is true', async () => {
    const mockPage = {
      url: () => 'https://example.com/',
      evaluate: vi.fn().mockResolvedValue({
        frameTimesMs: [16, 17, 16, 16],
        gpuTimesMs: [8, 9, 8, 8],
        timestampSupported: true,
        timestampPeriod: 1,
      }),
      evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      createCDPSession: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ metrics: [] }),
        detach: vi.fn().mockResolvedValue(undefined),
      }),
    };
    ctx.pageController = { getActivePage: async () => mockPage } as any;
    handlers = new WebGPUHandlers(ctx);

    const response = await handlers.webgpu_frame_timing({
      frameCount: 4,
      includeTimestamps: true,
    });
    const result = ResponseBuilder.parse(response);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.frames)).toBe(true);
    expect(result.frames.length).toBe(4);
    expect(result.frames[0]).toMatchObject({ frameIndex: 0, frameMs: 16, gpuMs: 8 });
  });
});
