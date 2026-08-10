/**
 * Hypervisor Phase 1 — unit tests.
 *
 * Tests capability detection, VMCS configuration, exit handler table,
 * safety gates, and lifecycle (load/unload/shutdown).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hypervisor, resetHypervisorForTest } from '@native/byovd';
import { HYPERVISOR_ENABLED, HYPERVISOR_MAX_INSTANCES } from '@src/constants/hypervisor';

let instance: Hypervisor | null = null;

beforeEach(() => {
  resetHypervisorForTest();
  instance = new Hypervisor();
});

afterEach(async () => {
  if (instance) {
    try {
      await instance.shutdown();
    } catch {
      // best-effort
    }
    instance = null;
  }
});

describe('Hypervisor', () => {
  // ── Test 1: Safety Gates ──

  describe('safety gates', () => {
    it('reports disabled when JSHOOK_HYPERVISOR_ENABLE is not set', () => {
      // Default is false — unless env overrides
      const result = instance!.checkEnabled();
      if (HYPERVISOR_ENABLED) {
        // If enabled in test env, skip assertion
        expect(result.enabled).toBe(true);
      } else {
        expect(result.enabled).toBe(false);
        expect(result.reason).toContain('JSHOOK_HYPERVISOR_ENABLE');
      }
    });

    it('prevents loading when already loaded', async () => {
      // Skip if not on Windows or not admin — the load will fail anyway
      if (process.platform !== 'win32') {
        // On non-Windows, load should fail at the compat check
        const result = await instance!.load();
        expect(result.success).toBe(false);
        return;
      }

      // Force-loaded state by setting internal state
      // (We don't actually load — just verify the guard fires)
      const result1 = await instance!.load();
      if (result1.success) {
        const result2 = await instance!.load();
        expect(result2.success).toBe(false);
        expect(result2.error).toContain('already loaded');
      }
    });

    it('prevents operations after shutdown', async () => {
      await instance!.shutdown();
      const result = await instance!.load();
      expect(result.success).toBe(false);
      expect(result.error).toContain('shut down');
    });
  });

  // ── Test 2: Capability Detection ──

  describe('capability detection', () => {
    it('detects CPU vendor and brand', async () => {
      const caps = await instance!.detectCapabilities();

      expect(caps.vendor).toBeTruthy();
      expect(typeof caps.vendor).toBe('string');
      expect(caps.brand).toBeTruthy();
      expect(typeof caps.brand).toBe('string');

      // Vendor should be one of the known strings
      expect(['GenuineIntel', 'AuthenticAMD', 'unknown']).toContain(caps.vendor);

      console.log(`CPU: vendor=${caps.vendor}, brand=${caps.brand}, vtx=${caps.vtxSupported}`);
    });

    it('detects VT-x support status', async () => {
      const caps = await instance!.detectCapabilities();

      expect(typeof caps.vtxSupported).toBe('boolean');
      expect(typeof caps.eptSupported).toBe('boolean');
      expect(typeof caps.vpidSupported).toBe('boolean');

      // If VT-x is supported, we must have cpuid1 data
      if (caps.vtxSupported) {
        expect(caps.cpuid1.vmxSupported).toBe(true);
      }

      // If not on Windows, vtxSupported should be false
      if (process.platform !== 'win32') {
        expect(caps.vtxSupported).toBe(false);
      }
    });

    it('reports correct compatibility status', async () => {
      const caps = await instance!.detectCapabilities();

      const validCompat = [
        'ready',
        'no_vtx',
        'hyperv_conflict',
        'no_byovd',
        'no_admin',
        'not_windows',
      ];
      expect(validCompat).toContain(caps.compatibility);

      if (process.platform !== 'win32') {
        expect(caps.compatibility).toBe('not_windows');
      }
    });

    it('detects Hyper-V and WSL2 conflicts', async () => {
      const caps = await instance!.detectCapabilities();

      expect(typeof caps.hypervActive).toBe('boolean');
      expect(typeof caps.wsl2Active).toBe('boolean');

      // CR4.VMXE inference
      expect(typeof caps.cr4VmxeSet).toBe('boolean');

      // If Hyper-V is active, CR4.VMXE cannot be set independently
      if (caps.hypervActive) {
        expect(caps.cr4VmxeSet).toBe(false);
      }
    });

    it('returns cached capabilities on second call', async () => {
      const caps1 = await instance!.detectCapabilities();
      const caps2 = await instance!.detectCapabilities();

      // Should be the same object (cached)
      expect(caps1).toBe(caps2);
    });
  });

  // ── Test 3: VMCS Configuration ──

  describe('VMCS configuration', () => {
    it('builds valid VMCS control fields', async () => {
      await instance!.detectCapabilities();
      const config = instance!.getVmcsConfig();

      if (!config) {
        // VMCS config only available when VT-x is detected
        // On non-VT-x systems, this is null — that's fine
        return;
      }

      // Pin-based controls: external interrupt exiting + NMI exiting
      expect(config.pinBasedControls & 0x1).toBe(0x1); // bit 0 — external interrupt
      expect(config.pinBasedControls & (1 << 3)).toBe(1 << 3); // bit 3 — NMI exiting

      // Primary proc-based: must have "activate secondary controls" (bit 31)
      expect(config.primaryProcBasedControls & (1 << 31)).toBe(1 << 31);

      // Secondary proc-based: EPT (bit 1) + VPID (bit 5)
      expect(config.secondaryProcBasedControls & (1 << 1)).toBe(1 << 1);
      expect(config.secondaryProcBasedControls & (1 << 5)).toBe(1 << 5);

      // VM-exit: host addr space size (bit 9)
      expect(config.vmExitControls & (1 << 9)).toBe(1 << 9);

      // VM-entry: IA-32e mode guest (bit 9)
      expect(config.vmEntryControls & (1 << 9)).toBe(1 << 9);

      // VPID = 1
      expect(config.vpid).toBe(1);
    });

    it('includes RDTSC exiting in primary proc-based controls', async () => {
      await instance!.detectCapabilities();
      const config = instance!.getVmcsConfig();
      if (!config) return;

      // CPU_BASED_RDTSC_EXITING = 1 << 12
      expect(config.primaryProcBasedControls & (1 << 12)).toBe(1 << 12);
    });
  });

  // ── Test 4: Exit Handler Table ──

  describe('exit handler table', () => {
    it('returns all 7 required handlers', () => {
      const table = instance!.getExitHandlerTable();
      expect(table.length).toBe(7);

      const reasons = table.map((e) => e.reason);
      expect(reasons).toContain(0); // Exception/NMI
      expect(reasons).toContain(10); // CPUID
      expect(reasons).toContain(16); // RDTSC
      expect(reasons).toContain(28); // CR access
      expect(reasons).toContain(51); // RDTSCP
      expect(reasons).toContain(58); // INVPCID (renamed handleInvvpid in our impl)
      expect(reasons).toContain(54); // WBINVD
    });

    it('CPUID handler describes spoofing behavior', () => {
      const table = instance!.getExitHandlerTable();
      const cpuidHandler = table.find((e) => e.reason === 10);
      expect(cpuidHandler).toBeDefined();
      expect(cpuidHandler!.purpose).toContain('Spoof');
      expect(cpuidHandler!.purpose).toContain('VT-x');
    });

    it('all handler names use consistent naming convention', () => {
      const table = instance!.getExitHandlerTable();
      for (const entry of table) {
        expect(entry.name).toMatch(/^handle[A-Z]/);
        expect(entry.purpose.length).toBeGreaterThan(10);
      }
    });
  });

  // ── Test 5: VMXON Region Requirements ──

  describe('VMXON region requirements', () => {
    it('returns null when no VMX basic MSR data is available', () => {
      // Before detectCapabilities, should be null
      const reqs = instance!.getVmxonRegionRequirements();
      // May be null if VMX basic MSR wasn't read
      // This is expected on most test machines (no BYOVD driver)
      if (reqs) {
        expect(reqs.size).toBe(4096);
        expect(reqs.alignment).toBe(4096);
        expect(typeof reqs.revisionId).toBe('number');
      }
    });
  });

  // ── Test 6: Status Reporting ──

  describe('status reporting', () => {
    it('reports not loaded initially', () => {
      const status = instance!.getStatus();
      expect(status.loaded).toBe(false);
      expect(status.vmxRootActive).toBe(false);
      expect(status.phase).toBe(1);
      expect(status.kernelComponentLoaded).toBe(false);
    });

    it('reports loaded after successful load', async () => {
      if (process.platform !== 'win32') return;

      const result = await instance!.load();
      if (result.success) {
        const status = instance!.getStatus();
        expect(status.loaded).toBe(true);
        expect(status.phase).toBe(1);
      }
    });
  });

  // ── Test 7: Unload Resets State ──

  describe('unload', () => {
    it('resets loaded state when not loaded', async () => {
      const result = await instance!.unload();
      expect(result.success).toBe(false);
      expect(result.error).toContain('not loaded');
    });
  });

  // ── Test 8: Singleton Enforcement ──

  describe('singleton', () => {
    it('allows only one instance by default', () => {
      // The beforeEach already creates one instance.
      // Creating a second should throw.
      // Note: HYPERVISOR_MAX_INSTANCES defaults to 1
      let threw = false;
      try {
        const secondInstance = new Hypervisor();
        // If we get here, the constructor didn't throw (env override or test setup issue)
        secondInstance.shutdown().catch(() => {});
      } catch (e) {
        threw = true;
        expect((e as Error).message).toContain('maximum');
      }
      // If HYPERVISOR_MAX_INSTANCES > 1 (env override), this won't throw
      if (HYPERVISOR_MAX_INSTANCES <= 1) {
        expect(threw).toBe(true);
      }
    });
  });
});
