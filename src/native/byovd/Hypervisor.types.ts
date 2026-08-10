/**
 * EPT Hypervisor type definitions.
 *
 * Describes VT-x capability detection, VMCS configuration, and
 * hypervisor lifecycle state. All detection is done from user mode
 * via CPUID and MSR reads (through the BYOVD driver).
 *
 * Actual VMX instruction execution (VMXON, VMLAUNCH, VMRESUME)
 * requires a kernel-mode component — not yet implemented.
 */

/** Result of CPUID.1 feature bits relevant to VT-x. */
export interface Cpuid1Features {
  /** CPUID.1:ECX[5] — VMX (Virtual Machine Extensions) supported. */
  vmxSupported: boolean;
  /** CPUID.1:ECX[25] — SSE4.1 (required for host state). */
  sse41: boolean;
  /** CPUID.1:ECX[26] — SSE4.2. */
  sse42: boolean;
  /** CPUID.1:ECX[28] — AVX. */
  avx: boolean;
  /** CPUID.1:EDX[25] — SSE. */
  sse: boolean;
  /** CPUID.1:EDX[26] — SSE2. */
  sse2: boolean;
  /** CPUID.1:ECX[31] — Hypervisor present (should be 0 on bare metal). */
  hypervisorPresent: boolean;
  /** CPUID.1:ECX[6] — Debug Store (DTS) feature. */
  dts: boolean;
}

/** Raw CPUID leaf values returned by CPUID instruction. */
export interface CpuidLeaf {
  eax: number;
  ebx: number;
  ecx: number;
  edx: number;
}

/** VMX capability MSR values read via BYOVD driver. */
export interface VmxMsrValues {
  /** IA32_VMX_BASIC (0x480) — revision ID, region size, memory type. */
  vmxBasic: bigint;
  /** IA32_VMX_CR0_FIXED0 (0x486) — CR0 must-be-0 bits. */
  cr0Fixed0: bigint;
  /** IA32_VMX_CR0_FIXED1 (0x487) — CR0 must-be-1 bits. */
  cr0Fixed1: bigint;
  /** IA32_VMX_CR4_FIXED0 (0x488) — CR4 must-be-0 bits. */
  cr4Fixed0: bigint;
  /** IA32_VMX_CR4_FIXED1 (0x489) — CR4 must-be-1 bits. */
  cr4Fixed1: bigint;
  /** IA32_VMX_EPT_VPID_CAP (0x48c) — EPT and VPID capabilities. */
  eptVpidCap: bigint;
  /** IA32_VMX_PROCBASED_CTLS2 (0x48b) — secondary controls. */
  procBasedCtls2: bigint;
}

/** Parsed IA32_VMX_BASIC MSR fields. */
export interface VmxBasicInfo {
  /** VMCS revision identifier (bits 30:0). */
  revisionId: number;
  /** VMCS region size in bytes (bits 44:32, shifted value). */
  vmcsRegionSize: number;
  /** Memory type for VMCS: 0 = WB, 1 = UC. */
  memoryType: number;
  /** True control MSRs (0x48e-0x491) are supported. */
  trueControls: boolean;
  /** VMCS shadowing is supported. */
  vmcsShadowing: boolean;
}

/** Parsed EPT/VPID capabilities. */
export interface EptVpidCapabilities {
  /** Execute-only EPT translations supported. */
  executeOnly: boolean;
  /** 2MB large pages supported. */
  largePage2MB: boolean;
  /** 1GB large pages supported. */
  largePage1GB: boolean;
  /** Accessed/dirty flags supported. */
  accessedDirty: boolean;
  /** EPT violation #VE supported. */
  eptVe: boolean;
  /** Mode-based execute control for EPT supported. */
  modeBasedExecute: boolean;
  /** INVVPID individual-address supported. */
  invvpidIndividualAddress: boolean;
  /** INVVPID single-context supported. */
  invvpidSingleContext: boolean;
  /** INVVPID all-contexts supported. */
  invvpidAllContexts: boolean;
}

/** Comprehensive VT-x capability report. */
export interface VmxCapabilities {
  /** CPUID.1 feature bits. */
  cpuid1: Cpuid1Features;
  /** CPU vendor string (GenuineIntel / AuthenticAMD). */
  vendor: string;
  /** CPU brand string from CPUID leaves 0x80000002-0x80000004. */
  brand: string;
  /** Whether VT-x is fully supported (CPUID + BIOS enabled). */
  vtxSupported: boolean;
  /** Whether EPT is supported. */
  eptSupported: boolean;
  /** Whether VPID is supported. */
  vpidSupported: boolean;
  /** Whether unrestricted guest mode is supported. */
  unrestrictedGuest: boolean;
  /** Parsed VMX basic MSR info. */
  vmxBasic: VmxBasicInfo | null;
  /** Parsed EPT/VPID capabilities. */
  eptVpid: EptVpidCapabilities | null;
  /** Whether Hyper-V is detected (incompatible). */
  hypervActive: boolean;
  /** Whether WSL2 is detected (incompatible). */
  wsl2Active: boolean;
  /** Whether CR4.VMXE is set. */
  cr4VmxeSet: boolean;
  /** Whether BYOVD driver is active for MSR reads. */
  byovdActive: boolean;
  /** Human-readable summary of compatibility. */
  compatibility: 'ready' | 'no_vtx' | 'hyperv_conflict' | 'no_byovd' | 'no_admin' | 'not_windows';
}

/** Hypervisor runtime status. */
export interface HypervisorStatus {
  /** Whether the hypervisor has been loaded (VMX root active). */
  loaded: boolean;
  /** Whether VMX root operation was entered. */
  vmxRootActive: boolean;
  /** Whether EPT is enabled. */
  eptEnabled: boolean;
  /** Whether VPID is enabled. */
  vpidEnabled: boolean;
  /** Number of configured logical processors. */
  logicalProcessorCount: number;
  /** Phase implemented: 1 = VMXON+VMCS, 2 = EPT, 3 = stealth, 4 = production. */
  phase: 1 | 2 | 3 | 4;
  /** Whether kernel component is loaded (required for VMX instructions). */
  kernelComponentLoaded: boolean;
}

/** Phase 1 VMCS configuration summary. */
export interface VmcsConfig {
  pinBasedControls: number;
  primaryProcBasedControls: number;
  secondaryProcBasedControls: number;
  vmExitControls: number;
  vmEntryControls: number;
  exceptionBitmap: number;
  vpid: number;
}
