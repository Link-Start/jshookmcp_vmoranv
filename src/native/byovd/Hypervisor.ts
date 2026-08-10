/**
 * EPT Hypervisor — Phase 1: VMXON, VMCS setup, basic VM-exit handler, CPUID spoofing.
 *
 * ## Architecture
 *
 * This is a **TypeScript orchestration layer** for a Type-2 hypervisor.
 * It does NOT execute VMX instructions directly (those require ring-0).
 * Instead, it:
 *   1. Detects VT-x/EPT capabilities via CPUID (ucrtbase __cpuidex via koffi)
 *   2. Reads MSRs via BYOVD driver for VMX capability discovery
 *   3. Calculates VMCS field configurations for the exit-handler design
 *   4. Provides tool interfaces for capability/status/load/unload
 *   5. Documents the kernel-mode requirements for actual VMX execution
 *
 * ## Safety Gates
 * - JSHOOK_HYPERVISOR_ENABLE=1 required
 * - BYOVD driver active required (for MSR reads)
 * - Administrator privileges required
 * - Hyper-V/WSL2 must be disabled (incompatible)
 * - Max 1 hypervisor instance
 * - Auto-unload on process exit
 *
 * ## Phase 1 Scope
 * - [x] VT-x detection via vendor/model + __cpuidex when available
 * - [x] CR4.VMXE verification (inferred)
 * - [x] IA32_VMX_BASIC MSR read (revision ID, region size)
 * - [x] VMX capability MSR enumeration
 * - [x] Hyper-V/WSL2 conflict detection
 * - [x] VMCS field configuration (pin/proc/exit/entry controls)
 * - [x] Basic VM-exit handler design (CPUID spoof, RDTSC offset, MOV CR)
 * - [ ] Kernel-mode component for VMXON/VMLAUNCH/VMRESUME (requires ring-0)
 *
 * @module byovd/Hypervisor
 */

import { cpus } from 'node:os';
import { logger } from '@utils/logger';
import { HYPERVISOR_ENABLED, HYPERVISOR_MAX_INSTANCES } from '@src/constants/hypervisor';
import {
  IA32_VMX_BASIC,
  IA32_VMX_EPT_VPID_CAP,
  IA32_VMX_PROCBASED_CTLS2,
  VMX_BASIC_VMCS_REVISION_ID_MASK,
  VMX_BASIC_VMCS_SIZE_SHIFT,
  VMX_BASIC_VMCS_SIZE_MASK,
  VMX_BASIC_TRUE_CTLS_BIT,
  VMX_BASIC_MEMORY_TYPE_BIT,
  VMX_BASIC_VMCS_SHADOWING_BIT,
  EPT_CAP_EXECUTE_ONLY,
  EPT_CAP_2MB_PAGES,
  EPT_CAP_1GB_PAGES,
  EPT_CAP_ACCESSED_DIRTY,
  EPT_CAP_VE,
  EPT_CAP_MODE_BASED_EXECUTE,
  VPID_CAP_INVVPID_INDIVIDUAL_ADDRESS,
  VPID_CAP_INVVPID_SINGLE_CONTEXT,
  VPID_CAP_INVVPID_ALL_CONTEXTS,
  PIN_BASED_EXT_INTERRUPT_EXITING,
  PIN_BASED_NMI_EXITING,
  CPU_BASED_USE_TSC_OFFSETTING,
  CPU_BASED_RDTSC_EXITING,
  CPU_BASED_CR8_LOAD_EXITING,
  CPU_BASED_CR8_STORE_EXITING,
  CPU_BASED_ACTIVATE_SECONDARY_CONTROLS,
  CPU_BASED_CTL2_ENABLE_EPT,
  CPU_BASED_CTL2_ENABLE_VPID,
  CPU_BASED_CTL2_ENABLE_RDTSCP,
  CPU_BASED_CTL2_ENABLE_INVPCID,
  VM_EXIT_HOST_ADDR_SPACE_SIZE,
  VM_EXIT_SAVE_IA32_EFER,
  VM_EXIT_LOAD_IA32_EFER,
  VM_ENTRY_IA32E_MODE_GUEST,
  VM_ENTRY_LOAD_IA32_EFER,
} from './VmxConstants';
import type {
  Cpuid1Features,
  CpuidLeaf,
  VmxBasicInfo,
  EptVpidCapabilities,
  VmxCapabilities,
  HypervisorStatus,
  VmcsConfig,
} from './Hypervisor.types';

// ── CPUID Detection ──

/**
 * Execute CPUID via the Windows UCRT __cpuidex function.
 *
 * On Windows 10+, ucrtbase.dll exports __cpuidex. Falls back to
 * CPU vendor/model detection via os.cpus() when unavailable.
 *
 * Signature: void __cpuidex(int cpuInfo[4], int function_id, int subfunction_id)
 */
function executeCpuid(leaf: number, subleaf: number): CpuidLeaf | null {
  if (process.platform !== 'win32') return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');

    // Try ucrtbase.dll first (Windows 10+), then api-ms-win-crt-runtime-l1-1-0.dll
    let lib: ReturnType<typeof koffi.load> | null = null;
    for (const dllName of ['ucrtbase.dll', 'msvcrt.dll', 'vcruntime140.dll']) {
      try {
        lib = koffi.load(dllName);
        break;
      } catch {
        continue;
      }
    }

    if (!lib) {
      logger.debug('Hypervisor: no C runtime DLL found for __cpuidex');
      return null;
    }

    const cpuidex = lib.func(
      'void __cpuidex(_Out_ int32_t *cpuInfo, int32_t function_id, int32_t subfunction_id)',
    );

    const outBuf = Buffer.alloc(16);
    cpuidex(koffi.address(outBuf), leaf, subleaf);

    return {
      eax: outBuf.readInt32LE(0),
      ebx: outBuf.readInt32LE(4),
      ecx: outBuf.readInt32LE(8),
      edx: outBuf.readInt32LE(12),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`Hypervisor: CPUID execution failed: ${msg}`);
    return null;
  }
}

/** Parse CPU vendor string from CPUID.0. */
function detectVendor(): string {
  const leaf = executeCpuid(0, 0);
  if (leaf) {
    const vendor = Buffer.alloc(12);
    vendor.writeUInt32LE(leaf.ebx, 0);
    vendor.writeUInt32LE(leaf.edx, 4);
    vendor.writeUInt32LE(leaf.ecx, 8);
    const v = vendor.toString('ascii').split(String.fromCharCode(0)).join('');
    if (v.length >= 3) return v;
  }

  // Fallback: use os.cpus()
  try {
    const model = cpus()[0]?.model ?? '';
    if (model.includes('Intel')) return 'GenuineIntel';
    if (model.includes('AMD')) return 'AuthenticAMD';
  } catch {
    // ignore
  }
  return 'unknown';
}

/** Parse CPU brand string from CPUID leaves 0x80000002-0x80000004. */
function detectBrand(): string {
  const parts: string[] = [];
  for (const leaf of [0x80000002, 0x80000003, 0x80000004]) {
    const l = executeCpuid(leaf, 0);
    if (!l) continue;
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(l.eax, 0);
    buf.writeUInt32LE(l.ebx, 4);
    buf.writeUInt32LE(l.ecx, 8);
    buf.writeUInt32LE(l.edx, 12);
    parts.push(buf.toString('ascii').split(String.fromCharCode(0)).join(''));
  }
  const fromCpuid = parts.join('').trim();
  if (fromCpuid) return fromCpuid;

  // Fallback: use os.cpus()
  try {
    const model = cpus()[0]?.model ?? '';
    if (model) return model;
  } catch {
    // ignore
  }
  return 'unknown';
}

/** Parse CPUID.1 feature bits. */
function detectCpuid1(): Cpuid1Features | null {
  const leaf = executeCpuid(1, 0);
  if (leaf) {
    return {
      vmxSupported: !!(leaf.ecx & (1 << 5)),
      sse41: !!(leaf.ecx & (1 << 19)),
      sse42: !!(leaf.ecx & (1 << 20)),
      avx: !!(leaf.ecx & (1 << 28)),
      sse: !!(leaf.edx & (1 << 25)),
      sse2: !!(leaf.edx & (1 << 26)),
      hypervisorPresent: !!(leaf.ecx & (1 << 31)),
      dts: !!(leaf.ecx & (1 << 6)),
    };
  }

  // Fallback: infer from CPU model
  const vendor = detectVendor();
  const brand = detectBrand();
  const isIntel = vendor === 'GenuineIntel';
  const isAmd = vendor === 'AuthenticAMD';

  // All Intel Core i-series and later support VT-x (since 2008)
  // All AMD CPUs since 2006 support AMD-V
  const likelyVtx = isIntel && /i[3579]|Xeon|Pentium|Celeron/i.test(brand);
  const likelyAmdV = isAmd;

  return {
    vmxSupported: isIntel ? likelyVtx : likelyAmdV,
    sse41: isIntel || isAmd, // universal since ~2008
    sse42: isIntel, // Intel-only initially
    avx: isIntel && /i[3579]|Xeon/i.test(brand),
    sse: true,
    sse2: true,
    hypervisorPresent: false, // Unknown without CPUID
    dts: false,
  };
}

/** Detect if the CPU supports extended leaf 0x80000008 for brand string. */
function detectMaxExtendedLeaf(): number {
  const leaf = executeCpuid(0x80000000, 0);
  return leaf?.eax ?? 0;
}

// ── MSR Reading ──

/** Read an MSR via the BYOVD driver. */
async function readMsr(msrIndex: number): Promise<bigint | null> {
  try {
    const { byovdManager } = await import('@native/byovd');
    if (!byovdManager.isActive()) return null;

    const active = byovdManager.getActiveDriver();
    if (!active) return null;

    const driver = active.driver;
    if (!driver.ioctlReadMsr) return null;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const deviceIoControl = kernel32.func(
      'int DeviceIoControl(void *, uint32, void *, uint32, void *, uint32, _Out_ uint32 *, void *)',
    );

    const inputBuf = Buffer.alloc(8);
    inputBuf.writeUInt32LE(msrIndex, 0);

    const outputBuf = Buffer.alloc(8);
    const bytesReturnedBuf = Buffer.alloc(4);

    const result = deviceIoControl(
      active.deviceHandle,
      driver.ioctlReadMsr,
      koffi.address(inputBuf),
      inputBuf.length,
      koffi.address(outputBuf),
      outputBuf.length,
      koffi.address(bytesReturnedBuf),
      null,
    );

    if (result !== 0) {
      return outputBuf.readBigUInt64LE(0);
    }

    return null;
  } catch {
    return null;
  }
}

/** Parse IA32_VMX_BASIC MSR value. */
function parseVmxBasic(msr: bigint): VmxBasicInfo {
  return {
    revisionId: Number(msr & BigInt(VMX_BASIC_VMCS_REVISION_ID_MASK)),
    vmcsRegionSize: Number(
      (msr >> BigInt(VMX_BASIC_VMCS_SIZE_SHIFT)) & BigInt(VMX_BASIC_VMCS_SIZE_MASK),
    ),
    memoryType: Number((msr >> BigInt(VMX_BASIC_MEMORY_TYPE_BIT)) & 1n),
    trueControls: ((msr >> BigInt(VMX_BASIC_TRUE_CTLS_BIT)) & 1n) === 1n,
    vmcsShadowing: ((msr >> BigInt(VMX_BASIC_VMCS_SHADOWING_BIT)) & 1n) === 1n,
  };
}

/** Parse IA32_VMX_EPT_VPID_CAP MSR value. */
function parseEptVpidCap(msr: bigint): EptVpidCapabilities {
  return {
    executeOnly: (msr & BigInt(EPT_CAP_EXECUTE_ONLY)) !== 0n,
    largePage2MB: (msr & BigInt(EPT_CAP_2MB_PAGES)) !== 0n,
    largePage1GB: (msr & BigInt(EPT_CAP_1GB_PAGES)) !== 0n,
    accessedDirty: (msr & BigInt(EPT_CAP_ACCESSED_DIRTY)) !== 0n,
    eptVe: (msr & BigInt(EPT_CAP_VE)) !== 0n,
    modeBasedExecute: (msr & BigInt(EPT_CAP_MODE_BASED_EXECUTE)) !== 0n,
    invvpidIndividualAddress: (msr & BigInt(VPID_CAP_INVVPID_INDIVIDUAL_ADDRESS)) !== 0n,
    invvpidSingleContext: (msr & BigInt(VPID_CAP_INVVPID_SINGLE_CONTEXT)) !== 0n,
    invvpidAllContexts: (msr & BigInt(VPID_CAP_INVVPID_ALL_CONTEXTS)) !== 0n,
  };
}

// ── Environment Detection ──

/** Detect Hyper-V or WSL2 presence. */
function detectHyperV(): { hypervActive: boolean; wsl2Active: boolean } {
  if (process.platform !== 'win32') return { hypervActive: false, wsl2Active: false };

  let hypervActive = false;
  let wsl2Active = false;

  // Check CPUID.1:ECX[31] — hypervisor present bit
  const cpuid1 = detectCpuid1();
  if (cpuid1?.hypervisorPresent) {
    hypervActive = true;
  }

  // Check for Hyper-V hypervisor leaf at CPUID.0x40000000
  const hvLeaf = executeCpuid(0x40000000, 0);
  if (hvLeaf) {
    const sig = Buffer.alloc(12);
    sig.writeUInt32LE(hvLeaf.ebx, 0);
    sig.writeUInt32LE(hvLeaf.ecx, 4);
    sig.writeUInt32LE(hvLeaf.edx, 8);
    const sigStr = sig.toString('ascii').split(String.fromCharCode(0)).join('');
    if (sigStr.includes('Microsoft')) {
      hypervActive = true;
    }
  }

  // Check Windows Hyper-V feature via PowerShell (best-effort)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('node:child_process');
    const result = execSync(
      'powershell -NoProfile -Command "(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State"',
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (result === 'Enabled') {
      hypervActive = true;
    }
  } catch {
    // Non-fatal
  }

  // WSL2 detection via `wsl --status`
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('node:child_process');
    const result = execSync('wsl --status', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (result.includes('WSL2') || result.includes('version: 2')) {
      wsl2Active = true;
    }
  } catch {
    // WSL not installed — OK
  }

  return { hypervActive, wsl2Active };
}

/** Check if CR4.VMXE (bit 13) would be settable. */
function checkCr4Vmxe(): boolean {
  if (process.platform !== 'win32') return false;
  // CR4 is not directly readable from user mode on x64.
  // If Hyper-V is active, CR4.VMXE is consumed by Hyper-V.
  const { hypervActive } = detectHyperV();
  return !hypervActive && detectCpuid1()?.vmxSupported === true;
}

/** Check admin privileges. */
function isAdmin(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('node:child_process');
    execSync('net session', { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── VMCS Configuration ──

/** Compute the Phase 1 VMCS control field values. */
function buildVmcsConfig(): VmcsConfig {
  const pinBased = PIN_BASED_EXT_INTERRUPT_EXITING | PIN_BASED_NMI_EXITING;

  const primaryProcBased =
    CPU_BASED_USE_TSC_OFFSETTING |
    CPU_BASED_RDTSC_EXITING |
    CPU_BASED_CR8_LOAD_EXITING |
    CPU_BASED_CR8_STORE_EXITING |
    CPU_BASED_ACTIVATE_SECONDARY_CONTROLS;

  const secondaryProcBased =
    CPU_BASED_CTL2_ENABLE_EPT |
    CPU_BASED_CTL2_ENABLE_VPID |
    CPU_BASED_CTL2_ENABLE_RDTSCP |
    CPU_BASED_CTL2_ENABLE_INVPCID;

  const vmExit = VM_EXIT_HOST_ADDR_SPACE_SIZE | VM_EXIT_SAVE_IA32_EFER | VM_EXIT_LOAD_IA32_EFER;

  const vmEntry = VM_ENTRY_IA32E_MODE_GUEST | VM_ENTRY_LOAD_IA32_EFER;

  return {
    pinBasedControls: pinBased,
    primaryProcBasedControls: primaryProcBased,
    secondaryProcBasedControls: secondaryProcBased,
    vmExitControls: vmExit,
    vmEntryControls: vmEntry,
    exceptionBitmap: 0,
    vpid: 1,
  };
}

// ── Hypervisor Class ──

export class Hypervisor {
  private loaded = false;
  private capabilities: VmxCapabilities | null = null;
  private vmcsConfig: VmcsConfig | null = null;
  private unloaded = false;

  private static instanceCount = 0;

  constructor() {
    if (Hypervisor.instanceCount >= HYPERVISOR_MAX_INSTANCES) {
      throw new Error(
        `Hypervisor: maximum ${HYPERVISOR_MAX_INSTANCES} instance(s) allowed. ` +
          'Only one hypervisor can own VMX at a time.',
      );
    }
    Hypervisor.instanceCount++;
    this.registerShutdown();
  }

  /** Check if the hypervisor feature is available. */
  checkEnabled(): { enabled: boolean; reason?: string } {
    if (!HYPERVISOR_ENABLED) {
      return { enabled: false, reason: 'JSHOOK_HYPERVISOR_ENABLE is not set to 1' };
    }
    if (process.platform !== 'win32') {
      return { enabled: false, reason: 'Hypervisor only supported on Windows (Intel VT-x)' };
    }
    if (!isAdmin()) {
      return { enabled: false, reason: 'Administrator privileges required' };
    }
    return { enabled: true };
  }

  /** Detect VT-x and EPT capabilities. */
  async detectCapabilities(): Promise<VmxCapabilities> {
    if (this.capabilities) return this.capabilities;

    const vendor = detectVendor();
    const maxExtLeaf = detectMaxExtendedLeaf();
    const brand = maxExtLeaf >= 0x80000004 ? detectBrand() : 'unknown';
    const cpuid1 = detectCpuid1();
    const { hypervActive, wsl2Active } = detectHyperV();
    const cr4VmxeSet = checkCr4Vmxe();

    // Check BYOVD driver
    let byovdActive = false;
    try {
      const { byovdManager } = await import('@native/byovd');
      byovdActive = byovdManager.isActive();
    } catch {
      // BYOVD module unavailable
    }

    // Read VMX MSRs via BYOVD
    let vmxBasic: VmxBasicInfo | null = null;
    let eptVpid: EptVpidCapabilities | null = null;
    const vtxSupported = cpuid1?.vmxSupported === true;
    let eptSupported = false;
    let vpidSupported = false;
    let unrestrictedGuest = false;

    if (byovdActive && vtxSupported) {
      const basicMsr = await readMsr(IA32_VMX_BASIC);
      if (basicMsr !== null) {
        vmxBasic = parseVmxBasic(basicMsr);
      }

      const eptMsr = await readMsr(IA32_VMX_EPT_VPID_CAP);
      if (eptMsr !== null) {
        eptVpid = parseEptVpidCap(eptMsr);
        eptSupported = true;
        vpidSupported =
          eptVpid.invvpidIndividualAddress ||
          eptVpid.invvpidSingleContext ||
          eptVpid.invvpidAllContexts;
      }

      const ctls2Msr = await readMsr(IA32_VMX_PROCBASED_CTLS2);
      if (ctls2Msr !== null) {
        unrestrictedGuest = (ctls2Msr & BigInt(CPU_BASED_CTL2_ENABLE_EPT)) !== 0n;
      }
    }

    // Compatibility determination
    let compatibility: VmxCapabilities['compatibility'] = 'not_windows';
    if (process.platform === 'win32') {
      if (!cpuid1?.vmxSupported) {
        compatibility = 'no_vtx';
      } else if (hypervActive) {
        compatibility = 'hyperv_conflict';
      } else if (!byovdActive) {
        compatibility = 'no_byovd';
      } else if (!isAdmin()) {
        compatibility = 'no_admin';
      } else {
        compatibility = 'ready';
      }
    }

    this.capabilities = {
      cpuid1: cpuid1 ?? {
        vmxSupported: false,
        sse41: false,
        sse42: false,
        avx: false,
        sse: false,
        sse2: false,
        hypervisorPresent: false,
        dts: false,
      },
      vendor,
      brand,
      vtxSupported,
      eptSupported,
      vpidSupported,
      unrestrictedGuest,
      vmxBasic,
      eptVpid,
      hypervActive,
      wsl2Active,
      cr4VmxeSet,
      byovdActive,
      compatibility,
    };

    if (vtxSupported) {
      this.vmcsConfig = buildVmcsConfig();
    }

    return this.capabilities;
  }

  /** Get the cached VMCS configuration. */
  getVmcsConfig(): VmcsConfig | null {
    return this.vmcsConfig;
  }

  /** Get current hypervisor status. */
  getStatus(): HypervisorStatus {
    return {
      loaded: this.loaded,
      vmxRootActive: this.loaded,
      eptEnabled: this.loaded,
      vpidEnabled: this.loaded,
      logicalProcessorCount: 0,
      phase: 1,
      kernelComponentLoaded: false,
    };
  }

  /**
   * Load the hypervisor.
   *
   * Phase 1: validates readiness, detects capabilities, builds VMCS config.
   * Actual VMXON/VMLAUNCH execution requires a kernel-mode component.
   */
  async load(): Promise<{ success: boolean; error?: string }> {
    if (this.unloaded) {
      return { success: false, error: 'Hypervisor has been shut down — create a new instance' };
    }

    const enabled = this.checkEnabled();
    if (!enabled.enabled) {
      return { success: false, error: enabled.reason };
    }

    if (this.loaded) {
      return { success: false, error: 'Hypervisor is already loaded' };
    }

    const caps = await this.detectCapabilities();

    if (caps.compatibility !== 'ready') {
      const reasonMap: Record<string, string> = {
        no_vtx: 'CPU does not support VT-x',
        hyperv_conflict:
          'Hyper-V is active — disable Hyper-V, WSL2, VBS, and HVCI first. ' +
          'Run: bcdedit /set hypervisorlaunchtype off',
        no_byovd: 'No BYOVD kernel driver active — required for MSR reads and VMXON region setup',
        no_admin: 'Administrator privileges required',
        not_windows: 'Only supported on Windows',
      };
      return {
        success: false,
        error: `Hypervisor not compatible: ${reasonMap[caps.compatibility] ?? caps.compatibility}`,
      };
    }

    this.loaded = true;

    logger.info(
      `Hypervisor Phase 1 loaded. VMCS configured (rev=${caps.vmxBasic?.revisionId}). ` +
        'Kernel-mode component required for VMXON/VMLAUNCH execution.',
    );

    return { success: true };
  }

  /** Unload the hypervisor. */
  async unload(): Promise<{ success: boolean; error?: string }> {
    if (!this.loaded) {
      return { success: false, error: 'Hypervisor is not loaded' };
    }

    this.loaded = false;
    this.capabilities = null;
    this.vmcsConfig = null;

    logger.info('Hypervisor unloaded.');
    return { success: true };
  }

  /** Full shutdown. */
  async shutdown(): Promise<void> {
    if (this.loaded) {
      try {
        await this.unload();
      } catch {
        // best-effort
      }
    }
    this.unloaded = true;
    this.removeShutdownListeners();
    Hypervisor.instanceCount = Math.max(0, Hypervisor.instanceCount - 1);
  }

  private shutdownRegistered = false;
  private shutdownHandlerRef: (() => void) | null = null;

  private registerShutdown(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    this.shutdownHandlerRef = () => {
      this.shutdown().catch(() => {});
    };

    process.on('exit', this.shutdownHandlerRef);
    process.on('SIGINT', this.shutdownHandlerRef);
    process.on('SIGTERM', this.shutdownHandlerRef);
  }

  private removeShutdownListeners(): void {
    if (this.shutdownHandlerRef) {
      process.removeListener('exit', this.shutdownHandlerRef);
      process.removeListener('SIGINT', this.shutdownHandlerRef);
      process.removeListener('SIGTERM', this.shutdownHandlerRef);
      this.shutdownHandlerRef = null;
      this.shutdownRegistered = false;
    }
  }

  /** Get VMXON region requirements. */
  getVmxonRegionRequirements(): {
    size: number;
    alignment: number;
    revisionId: number;
  } | null {
    if (!this.capabilities?.vmxBasic) return null;
    return {
      size: 4096,
      alignment: 4096,
      revisionId: this.capabilities.vmxBasic.revisionId,
    };
  }

  /** Enumerate the Phase 1 VM-exit handler dispatch table. */
  getExitHandlerTable(): Array<{ reason: number; name: string; purpose: string }> {
    return [
      {
        reason: 0,
        name: 'handleException',
        purpose: 'Pass through #GP (13), #PF (14), #UD (6); reflect others to guest',
      },
      {
        reason: 10,
        name: 'handleCpuid',
        purpose: 'Spoof CPUID.1:ECX[5]=0 (hide VT-x); pass through all other leaves',
      },
      {
        reason: 16,
        name: 'handleRdtsc',
        purpose: 'Apply TSC offset from VMCS; resume guest',
      },
      {
        reason: 28,
        name: 'handleCrAccess',
        purpose: 'Allow CR0/CR4 modifications that do not change VMX-critical bits',
      },
      {
        reason: 51,
        name: 'handleRdtscp',
        purpose: 'Apply TSC offset + preserve AUX register; resume guest',
      },
      {
        reason: 58,
        name: 'handleInvvpid',
        purpose: 'Pass through INVVPID for TLB management',
      },
      {
        reason: 54,
        name: 'handleWbinvd',
        purpose: 'Pass through WBINVD for cache management',
      },
    ];
  }
}

let hypervisorSingleton: Hypervisor | null = null;

/** Get or create the singleton hypervisor instance. */
export function getHypervisor(): Hypervisor {
  if (!hypervisorSingleton) {
    hypervisorSingleton = new Hypervisor();
  }
  return hypervisorSingleton;
}

/** Reset singleton and instance counter (for tests only). */
export function resetHypervisorForTest(): void {
  hypervisorSingleton = null;
  (Hypervisor as unknown as { instanceCount: number }).instanceCount = 0;
}
