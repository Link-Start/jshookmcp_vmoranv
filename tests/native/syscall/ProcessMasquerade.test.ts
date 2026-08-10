import { describe, it, expect } from 'vitest';
import { applyProcessMasquerade } from '@src/native/syscall/ProcessMasquerade';
import type { MasqueradeConfig } from '@src/native/syscall/ProcessMasquerade';

describe('ProcessMasquerade', () => {
  describe('applyProcessMasquerade', () => {
    it('returns a valid structure with default config', () => {
      const result = applyProcessMasquerade();

      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('limitations');
      expect(result).toHaveProperty('applied');
      expect(typeof result.applied).toBe('boolean');
      expect(Array.isArray(result.limitations)).toBe(true);

      // Should have results for each enabled setting
      expect(result.results).toHaveProperty('mitigationPolicies');
      expect(result.results).toHaveProperty('backgroundPriority');
      expect(result.results).toHaveProperty('heapTermination');
      expect(result.results).toHaveProperty('parentPid');
    });

    it('includes honest limitations', () => {
      const result = applyProcessMasquerade();

      const limitations = result.limitations.join(' ');
      expect(limitations).toMatch(/EPROCESS/i);
      expect(limitations).toMatch(/ETW-TI/i);
      expect(limitations).toMatch(/digital signature/i);
    });

    it('accepts custom config to disable settings', () => {
      const config: MasqueradeConfig = {
        applyMitigationPolicies: false,
        backgroundPriority: false,
        disableHeapTermination: false,
        randomizeCreationTime: false,
      };

      const result = applyProcessMasquerade(config);

      // When all settings are disabled, only parentPid remains
      const keys = Object.keys(result.results);
      // parentPid is always checked
      expect(keys).toContain('parentPid');
    });

    it('creation time randomization is disabled by default', () => {
      const result = applyProcessMasquerade();
      // creationTime should NOT be in results when config.randomizeCreationTime is false
      expect(result.results).not.toHaveProperty('creationTime');
    });

    it('creation time randomization enabled with config', () => {
      const config: MasqueradeConfig = { randomizeCreationTime: true };
      const result = applyProcessMasquerade(config);
      expect(result.results).toHaveProperty('creationTime');

      const ctResult = result.results['creationTime']!;
      expect(ctResult.applied).toBe(false);
      // Should explain why it cannot be applied from pure user-mode
      expect(ctResult.error).toBeDefined();
      expect(ctResult.error).toMatch(/native trampoline|in-process API hooking/i);
    });

    it('parentPid result always present with current PID info', () => {
      const result = applyProcessMasquerade();
      expect(result.results['parentPid']).toBeDefined();
      const ppid = result.results['parentPid']!;
      expect(ppid.applied).toBe(true);
    });

    it('applyProcessMasquerade on non-Windows still returns valid structure', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const result = applyProcessMasquerade();
      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('limitations');
      // parentPid is not added on non-Windows (getParentPid returns error)
      expect(result.limitations.some((l) => l.includes('Parent PID'))).toBe(true);

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });
  });
});
