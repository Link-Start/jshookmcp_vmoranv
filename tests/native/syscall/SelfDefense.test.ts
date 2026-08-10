import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySelfDefense,
  stopSelfDefense,
  getSuspiciousHandleCount,
} from '@src/native/syscall/SelfDefense';

describe('SelfDefense', () => {
  afterEach(() => {
    stopSelfDefense();
    vi.unstubAllEnvs();
  });

  describe('applySelfDefense', () => {
    it('returns a valid report with default config (no env flags)', () => {
      const report = applySelfDefense();

      expect(report).toHaveProperty('handleMonitorActive');
      expect(report).toHaveProperty('windowHidden');
      expect(report).toHaveProperty('terminationProtected');
      expect(report).toHaveProperty('priorityProtected');
      expect(report).toHaveProperty('suspiciousHandleCount');
      expect(report).toHaveProperty('limitations');

      // With no env flags, nothing should auto-activate
      expect(report.handleMonitorActive).toBe(false);
      expect(report.windowHidden).toBe(false);
      expect(report.terminationProtected).toBe(false);
      expect(report.priorityProtected).toBe(false);
      expect(report.suspiciousHandleCount).toBe(0);
    });

    it('includes honest limitations about what cannot be protected', () => {
      const report = applySelfDefense();

      const limitations = report.limitations.join(' ');
      expect(limitations).toMatch(/kernel/i);
    });

    it('explicit config can enable protections without env flags', () => {
      const report = applySelfDefense({
        monitorHandles: false, // don't start polling in tests
        hideWindow: true,
        protectPriority: true,
      });

      // windowHidden depends on Windows platform; priorityProtected depends on FFI
      expect(typeof report.windowHidden).toBe('boolean');
      expect(typeof report.priorityProtected).toBe('boolean');
      expect(report.terminationProtected).toBe(false); // requires extreme flag
    });

    it('BreakOnTermination requires JSHOOK_SELFDEFENSE_EXTREME', () => {
      const report = applySelfDefense({
        breakOnTermination: true,
      });

      // Without extreme flag, it should not activate
      expect(report.terminationProtected).toBe(false);
    });

    it('BreakOnTermination is permanently disabled (stub — no BSOD risk)', () => {
      vi.stubEnv('JSHOOK_SELFDEFENSE_EXTREME', '1');

      const report = applySelfDefense({
        breakOnTermination: true,
        monitorHandles: false,
      });

      // BreakOnTermination is PERMANENTLY DISABLED — see BSOD-CRITICAL_PROCESS_DIED-Analysis.md
      expect(report.terminationProtected).toBe(false);
      expect(report.limitations).toContain(
        'BreakOnTermination: BreakOnTermination disabled — irreversibly marks process as critical, causing BSOD on restart. This is NOT safe for user-mode MCP servers.',
      );
    });

    it('JSHOOK_SELFDEFENSE=1 enables auto-protection', () => {
      vi.stubEnv('JSHOOK_SELFDEFENSE', '1');

      const report = applySelfDefense({
        // Don't actually poll in tests
        monitorHandles: false,
      });

      // Window hiding and handle monitoring should be attempted
      expect(typeof report.handleMonitorActive).toBe('boolean');
      expect(typeof report.windowHidden).toBe('boolean');
    });
  });

  describe('getSuspiciousHandleCount', () => {
    it('returns 0 initially', () => {
      expect(getSuspiciousHandleCount()).toBe(0);
    });
  });

  describe('stopSelfDefense', () => {
    it('stops handle monitoring and resets count', () => {
      // Apply self defense with monitor handles disabled (no timer)
      applySelfDefense({ monitorHandles: false });

      // Should not throw
      expect(() => stopSelfDefense()).not.toThrow();
      expect(getSuspiciousHandleCount()).toBe(0);
    });

    it('is safe to call multiple times', () => {
      stopSelfDefense();
      stopSelfDefense();
      expect(() => stopSelfDefense()).not.toThrow();
    });
  });
});
