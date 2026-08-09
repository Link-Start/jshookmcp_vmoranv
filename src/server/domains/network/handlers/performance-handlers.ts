/**
 * Performance & profiling handlers — metrics, tracing, CPU profiling.
 *
 * Extracted from NetworkHandlersPerformance (handlers.base.performance.ts).
 * Coverage / heap snapshot / heap sampling were retired (superseded by
 * page_coverage_*, v8_heap_snapshot_capture, v8_heap_sampling).
 */

import { PerformanceMonitor } from '@server/domains/shared/modules';
import type { CodeCollector } from '@server/domains/shared/modules/collector';
import {
  asOptionalBoolean,
  asOptionalString,
  asOptionalStringArray,
  toCpuProfilePayload,
} from '../handlers.base.types';
import { handleSafe } from '@server/domains/shared/ResponseBuilder';
import type { ToolResponse } from '@server/types';

export interface PerformanceHandlerDeps {
  collector: CodeCollector;
  /** Lazy factory for PerformanceMonitor — avoids creating until first use. */
  getPerformanceMonitor: () => PerformanceMonitor;
}

export class PerformanceHandlers {
  constructor(private deps: PerformanceHandlerDeps) {}

  async handlePerformanceGetMetrics(args: Record<string, unknown>): Promise<ToolResponse> {
    return handleSafe(async () => {
      const includeTimeline = args.includeTimeline === true;
      const monitor = this.deps.getPerformanceMonitor();
      const metrics = await monitor.getPerformanceMetrics();
      const result: Record<string, unknown> = { metrics };
      if (includeTimeline) {
        result.timeline = await monitor.getPerformanceTimeline();
      }
      return result;
    });
  }

  async handlePerformanceTraceStart(args: Record<string, unknown>): Promise<ToolResponse> {
    return handleSafe(async () => {
      const monitor = this.deps.getPerformanceMonitor();
      const categories = asOptionalStringArray(args.categories);
      const screenshots = asOptionalBoolean(args.screenshots);
      await monitor.startTracing({ categories, screenshots });
      return {
        message:
          'Performance tracing started. Call performance_trace with action="stop" to save the trace.',
      };
    });
  }

  async handlePerformanceTraceStop(args: Record<string, unknown>): Promise<ToolResponse> {
    return handleSafe(async () => {
      const monitor = this.deps.getPerformanceMonitor();
      const artifactPath = asOptionalString(args.artifactPath);
      const result = await monitor.stopTracing({ artifactPath });
      return {
        artifactPath: result.artifactPath,
        eventCount: result.eventCount,
        sizeBytes: result.sizeBytes,
        sizeKB: (result.sizeBytes / 1024).toFixed(1),
        hint: 'Open the trace file in Chrome DevTools -> Performance tab -> Load profile',
      };
    });
  }

  async handleProfilerCpuStart(_args: Record<string, unknown>): Promise<ToolResponse> {
    return handleSafe(async () => {
      const monitor = this.deps.getPerformanceMonitor();
      await monitor.startCPUProfiling();
      return {
        message: 'CPU profiling started. Call profiler_cpu with action="stop" to save the profile.',
      };
    });
  }

  async handleProfilerCpuStop(args: Record<string, unknown>): Promise<ToolResponse> {
    return handleSafe(async () => {
      const monitor = this.deps.getPerformanceMonitor();
      const profileRaw = await monitor.stopCPUProfiling();

      const profile = toCpuProfilePayload(profileRaw);
      if (!profile) {
        // Never fall through with an unvalidated cast — nodes/startTime/endTime
        // may be missing and the shape validation exists for a reason.
        throw new Error(
          'CPU profile has an unexpected shape (expected nodes + startTime + endTime)',
        );
      }

      const { writeFile } = await import('node:fs/promises');
      const { resolveArtifactPath } = await import('@utils/artifacts');
      const artifactPath = asOptionalString(args.artifactPath);

      const profileJson = JSON.stringify(profile, null, 2);
      let savedPath: string;

      if (artifactPath) {
        await writeFile(artifactPath, profileJson, 'utf-8');
        savedPath = artifactPath;
      } else {
        const { absolutePath, displayPath } = await resolveArtifactPath({
          category: 'profiles',
          toolName: 'cpu-profile',
          ext: 'cpuprofile',
        });
        await writeFile(absolutePath, profileJson, 'utf-8');
        savedPath = displayPath;
      }

      const hotFunctions = profile.nodes
        .filter((n) => (n.hitCount || 0) > 0)
        .toSorted((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
        .slice(0, 20)
        .map((n) => ({
          functionName: n.callFrame?.functionName || '(anonymous)',
          url: n.callFrame?.url,
          line: n.callFrame?.lineNumber,
          hitCount: n.hitCount,
        }));

      return {
        artifactPath: savedPath,
        totalNodes: profile.nodes.length,
        totalSamples: profile.samples?.length || 0,
        durationMs: profile.endTime - profile.startTime,
        hotFunctions,
        hint: 'Open the .cpuprofile file in Chrome DevTools -> Performance tab',
      };
    });
  }
}
