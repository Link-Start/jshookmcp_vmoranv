import { describe, expect, it } from 'vitest';
import { v8InspectorTools } from '../../../../src/server/domains/v8-inspector/definitions';

describe('v8-inspector definitions', () => {
  it('uses scriptId schema for bytecode extraction and JIT inspection', () => {
    const bytecodeTool = v8InspectorTools.find((tool) => tool.name === 'v8_bytecode_extract');
    const turbofanTool = v8InspectorTools.find((tool) => tool.name === 'v8_turbofan_inspect');

    expect(bytecodeTool).toBeDefined();
    expect(turbofanTool).toBeDefined();

    expect(bytecodeTool?.inputSchema.properties).toHaveProperty('scriptId');
    expect(bytecodeTool?.inputSchema.required).toContain('scriptId');
    expect(bytecodeTool?.inputSchema.properties).toHaveProperty('functionOffset');
    expect(bytecodeTool?.inputSchema.properties).toHaveProperty('includeSourceFallback');
    expect(bytecodeTool?.inputSchema.properties).not.toHaveProperty('functionId');

    // v8_jit_inspect was retired (2026-08-09) — v8_turbofan_inspect covers
    // JIT status inspection with tier granularity (maglev vs turbofan).
    expect(v8InspectorTools.find((tool) => tool.name === 'v8_jit_inspect')).toBeUndefined();
    expect(turbofanTool?.inputSchema.properties).toHaveProperty('scriptId');
    expect(turbofanTool?.inputSchema.required).toContain('scriptId');
    expect(turbofanTool?.inputSchema.properties).not.toHaveProperty('functionId');
  });

  it('exposes a clamped samplingInterval on v8_heap_sampling', () => {
    const samplingTool = v8InspectorTools.find((tool) => tool.name === 'v8_heap_sampling');
    expect(samplingTool).toBeDefined();
    const props = samplingTool?.inputSchema.properties as Record<string, unknown>;
    const interval = props?.['samplingInterval'] as {
      default?: unknown;
      minimum?: unknown;
      maximum?: unknown;
    };

    expect(props).toHaveProperty('samplingInterval');
    expect(interval.default).toBe(32768);
    expect(interval.minimum).toBe(256);
    expect(interval.maximum).toBe(1048576);
  });
});
