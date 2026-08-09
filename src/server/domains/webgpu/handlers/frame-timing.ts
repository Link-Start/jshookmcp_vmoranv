import { handleSafe, type ToolResponse } from '@server/domains/shared/ResponseBuilder';
import { argNumber, argBool } from '@server/domains/shared/parse-args';
import { getPageLockManager } from '@modules/webgpu/PageLockManager';
import { ensureDevice } from '@modules/webgpu/CDPIntegration';
import type { MCPServerContext } from '@server/domains/shared/registry';
import type { WebGPUDomainDependencies } from '../types';

/**
 * Handler for webgpu_frame_timing tool.
 *
 * Measures per-frame CPU and GPU cost over a rAF loop:
 *  - CPU side: `performance.now` frame intervals.
 *  - GPU side: `timestamp-query` (createQuerySet + timestampWrites in the
 *    pass descriptor + resolveQuerySet after submit), converted with
 *    `device.limits.timestampPeriod` (ns per tick).
 *
 * When the device does not support the `timestamp-query` feature, GPU timings
 * are unavailable and the result degrades to CPU round-trip timing with
 * `precision: 'cpu-roundtrip'` (avgGpuMs/p95GpuMs null, bound unknown).
 *
 * Pattern reference: WebGPU Inspector frame timing and stats-gl's
 * rAF + timestamp-query loops.
 */
export class FrameTimingHandler {
  private pageLockManager = getPageLockManager();

  constructor(
    _ctx: MCPServerContext,
    private deps: WebGPUDomainDependencies,
  ) {}

  async handle(args: Record<string, unknown>): Promise<ToolResponse> {
    return handleSafe(async () => {
      const frameCount = argNumber(args, 'frameCount', 60);
      if (!Number.isInteger(frameCount) || frameCount <= 0) {
        throw new Error('Invalid frameCount: must be a positive integer');
      }
      const includeTimestamps = argBool(args, 'includeTimestamps', true);

      const page = await this.getActivePage();
      if (!page) {
        throw new Error('No active page. Call browser_launch or browser_attach first.');
      }

      const pageId = page.url();

      return await this.pageLockManager.withLock(pageId, async () => {
        // Reuse the cached adapter/device established by ensureDevice so the
        // timing loop shares the same adapter selection as other WebGPU tools.
        await ensureDevice(page);

        const raw = await page.evaluate(
          async ({ _frameCount }: { _frameCount: number }) => {
            const cache = (window as any).__webgpuDeviceCache;
            if (!cache || !cache.device) {
              throw new Error('WebGPU device cache unavailable. Call ensureDevice first.');
            }
            const device = cache.device;

            const features = device.features;
            const timestampSupported = features ? features.has('timestamp-query') : false;
            const timestampPeriod =
              device.limits && typeof device.limits.timestampPeriod === 'number'
                ? device.limits.timestampPeriod
                : 1;

            let querySet: any = null;
            if (timestampSupported) {
              querySet = device.createQuerySet({
                type: 'timestamp',
                count: _frameCount * 2,
              });
            }

            const frameTimesMs: number[] = [];
            const gpuTimesMs: number[] = [];
            let prevFrameStart: number | null = null;

            for (let i = 0; i < _frameCount; i++) {
              const frameStart = performance.now();
              await new Promise((resolve) => requestAnimationFrame(resolve));

              if (prevFrameStart !== null) {
                frameTimesMs.push(performance.now() - prevFrameStart);
              }
              prevFrameStart = frameStart;

              if (querySet) {
                // A minimal pass whose begin/end timestamps bracket the GPU
                // work of this frame.
                const beginIdx = i * 2;
                const endIdx = i * 2 + 1;
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginRenderPass({
                  colorAttachments: [],
                  timestampWrites: {
                    querySet,
                    beginningOfPassWriteIndex: beginIdx,
                    endOfPassWriteIndex: endIdx,
                  },
                });
                pass.end();
                device.queue.submit([encoder.finish()]);
                await device.queue.onSubmittedWorkDone();
              }
            }

            // Resolve timestamps into a mapped buffer and convert ticks → ns.
            if (querySet) {
              const dst = device.createBuffer({
                size: _frameCount * 2 * 8,
                usage:
                  ((globalThis as any).GPUBufferUsage?.COPY_DST || 0) |
                  ((globalThis as any).GPUBufferUsage?.MAP_READ || 0),
              });
              device.queue.resolveQuerySet(querySet, 0, _frameCount * 2, dst, 0);
              await device.queue.onSubmittedWorkDone();
              await dst.mapAsync((globalThis as any).GPUMapMode?.READ || 0);

              const arr = new BigUint64Array(dst.getMappedRange());
              for (let i = 0; i < _frameCount; i++) {
                const startTicks = Number(arr[i * 2] ?? 0n);
                const endTicks = Number(arr[i * 2 + 1] ?? 0n);
                const startNs = startTicks * timestampPeriod;
                const endNs = endTicks * timestampPeriod;
                gpuTimesMs.push(Math.max(0, endNs - startNs) / 1e6);
              }
              dst.destroy();
            }

            return {
              frameTimesMs,
              gpuTimesMs,
              timestampSupported,
              timestampPeriod,
            };
          },
          { _frameCount: frameCount },
        );

        const precision: 'gpu-timestamp' | 'cpu-roundtrip' = raw.timestampSupported
          ? 'gpu-timestamp'
          : 'cpu-roundtrip';

        const stats = computeFrameStats(raw.frameTimesMs, raw.gpuTimesMs, precision);

        if (includeTimestamps) {
          stats.frames = raw.frameTimesMs.map((frameMs: number, i: number) => ({
            frameIndex: i,
            frameMs,
            gpuMs: raw.gpuTimesMs[i] ?? null,
          }));
        }

        return stats;
      });
    });
  }

  private async getActivePage(): Promise<any> {
    if (!this.deps.pageController) {
      return null;
    }

    try {
      return await this.deps.pageController.getActivePage();
    } catch {
      return null;
    }
  }
}

// ─── Pure statistics (exported for testability) ──────────────────────────────

/**
 * Frame timing statistics computed from per-frame CPU intervals and per-frame
 * GPU durations. Pure function — no page/device access.
 */
export interface FrameTimingStats {
  frameCount: number;
  avgFrameMs: number;
  p95FrameMs: number;
  /** True GPU pass duration (ms); null when only CPU round-trip timing exists. */
  avgGpuMs: number | null;
  p95GpuMs: number | null;
  /** Frames whose interval exceeded max(34ms, 1.5×median). */
  droppedFrames: number;
  /** 'gpu-bound' when GPU time ≥ 80% of frame time, 'cpu-bound' ≤ 50%. */
  cpuOrGpuBound: 'gpu-bound' | 'cpu-bound' | 'balanced' | 'unknown';
  /** 'gpu-timestamp' = real timestamp queries; 'cpu-roundtrip' = degraded. */
  precision: 'gpu-timestamp' | 'cpu-roundtrip';
  /** Per-frame breakdown (populated by the handler when includeTimestamps). */
  frames?: Array<{ frameIndex: number; frameMs: number; gpuMs: number | null }>;
}

/** Dropped-frame threshold: a frame interval beyond this is considered a drop. */
const DROPPED_FRAME_HARD_MS = 34;

export function computeFrameStats(
  frameTimesMs: number[],
  gpuTimesMs: number[],
  precision: 'gpu-timestamp' | 'cpu-roundtrip',
): FrameTimingStats {
  const frameCount = frameTimesMs.length;
  const avgFrameMs = frameCount > 0 ? frameTimesMs.reduce((a, b) => a + b, 0) / frameCount : 0;
  const p95FrameMs = percentile(frameTimesMs, 0.95);
  const avgGpuMs =
    gpuTimesMs.length > 0 ? gpuTimesMs.reduce((a, b) => a + b, 0) / gpuTimesMs.length : null;
  const p95GpuMs = gpuTimesMs.length > 0 ? percentile(gpuTimesMs, 0.95) : null;
  const droppedFrames = countDroppedFrames(frameTimesMs);
  const cpuOrGpuBound = classifyBound(avgFrameMs, avgGpuMs, precision);

  return {
    frameCount,
    avgFrameMs,
    p95FrameMs,
    avgGpuMs,
    p95GpuMs,
    droppedFrames,
    cpuOrGpuBound,
    precision,
  };
}

/** p95 (or any p) of a numeric sample: sorted[floor(n × p)]. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

/** Median of a numeric sample. */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Count frames whose interval exceeds max(34ms, 1.5 × median). */
function countDroppedFrames(frameTimesMs: number[]): number {
  if (frameTimesMs.length === 0) {
    return 0;
  }
  const threshold = Math.max(DROPPED_FRAME_HARD_MS, median(frameTimesMs) * 1.5);
  return frameTimesMs.filter((ms) => ms > threshold).length;
}

/**
 * CPU- vs GPU-bound classification:
 *  - real GPU timings: ratio ≥ 0.8 → gpu-bound, ≤ 0.5 → cpu-bound, else balanced.
 *  - CPU round-trip only: cannot separate CPU and GPU cost → 'unknown'.
 */
function classifyBound(
  avgFrameMs: number,
  avgGpuMs: number | null,
  precision: 'gpu-timestamp' | 'cpu-roundtrip',
): FrameTimingStats['cpuOrGpuBound'] {
  if (precision !== 'gpu-timestamp' || avgGpuMs === null || avgFrameMs <= 0) {
    return 'unknown';
  }
  const ratio = avgGpuMs / avgFrameMs;
  if (ratio >= 0.8) {
    return 'gpu-bound';
  }
  if (ratio <= 0.5) {
    return 'cpu-bound';
  }
  return 'balanced';
}
