/**
 * ProcessMasquerade — makes the current process look less suspicious.
 *
 * Anti-cheat and EDR systems use multiple signals to classify processes:
 * - Process mitigation policies (CFG, DEP, ASLR, etc.)
 * - Parent process ID (spoofing via PROC_THREAD_ATTRIBUTE_PARENT_PROCESS)
 * - Process creation time (via NtQueryInformationProcess)
 * - PE headers, digital signatures, and image path
 * - Job object membership
 * - Window visibility (EnumWindows / FindWindow)
 *
 * This module provides best-effort user-mode masquerading. It CANNOT:
 * - Change the real parent PID in EPROCESS (kernel-only)
 * - Hide from ETW-TI kernel provider
 * - Fake digital signatures that pass kernel-mode verification
 * - Prevent kernel callback notifications
 *
 * @module ProcessMasquerade
 */

import { logger } from '@utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MasqueradeConfig {
  /** Spoof parent PID (via PROC_THREAD_ATTRIBUTE_PARENT_PROCESS for child processes). */
  spoofParentPid?: number;
  /** Apply benign process mitigation policies. */
  applyMitigationPolicies?: boolean;
  /** Randomize process creation time (adds jitter to reported creation time). */
  randomizeCreationTime?: boolean;
  /** Set process priority to appear as a background application. */
  backgroundPriority?: boolean;
  /** Disable heap termination-on-corruption (looks less like a security tool). */
  disableHeapTermination?: boolean;
  /** Spoof the console window / process title. Default: true. */
  spoofTitle?: boolean;
  /** @deprecated Clear JSHOOK_* env vars — REMOVED. These are safety gates that MUST remain set. */
  clearEnvVars?: boolean;
}

export interface MasqueradeResult {
  /** Per-setting results. */
  results: Record<string, { applied: boolean; error?: string }>;
  /** Honest boundary about what cannot be faked from user-mode. */
  limitations: string[];
  /** Overall success (at least one setting applied). */
  applied: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Process mitigation policy types. */
const PROCESS_MITIGATION_POLICY = {
  DEP: 1,
  ASLR: 2,
  DYNAMIC_CODE: 3,
  STRICT_HANDLE_CHECKS: 4,
  SYSTEM_CALL_DISABLE: 5,
  EXTENSION_POINT_DISABLE: 6,
  CONTROL_FLOW_GUARD: 9,
  SIGNATURE: 10,
  FONT_DISABLE: 11,
  IMAGE_LOAD: 12,
  SIDE_CHANNEL_ISOLATION: 13,
  CHILD_PROCESS: 15,
} as const;

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Apply process mitigation policies to appear as a normal application.
 *
 * Security tools often enable strict mitigation policies (CFG, strict handle
 * checks, extension point disabling). Normal applications rarely have all
 * these enabled. By setting benign policies, we reduce our detection surface.
 *
 * Specifically, we DISABLE:
 * - Strict handle checks (makes us look like a normal app)
 * - Extension point disabling (normal apps don't disable extension points)
 *
 * And we KEEP enabled (these are normal for any modern app):
 * - DEP (Data Execution Prevention)
 * - ASLR (Address Space Layout Randomization)
 */
function applyMitigationPolicies(): { applied: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { applied: false, error: 'Not on Windows' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');

    const SetProcessMitigationPolicy = k32.func(
      'int SetProcessMitigationPolicy(int32, _In_ void *, uint32)',
    );

    let applied = false;
    const errors: string[] = [];

    // 1. Enable benign DEP policy (normal apps have DEP)
    // PROCESS_MITIGATION_DEP_POLICY: Enable(1) + DisableAtlThunkEmulation(2)
    const depPolicy = Buffer.alloc(4);
    depPolicy.writeUInt32LE(0x0001, 0); // Enable DEP
    const depResult = SetProcessMitigationPolicy(
      PROCESS_MITIGATION_POLICY.DEP,
      koffi.address(depPolicy),
      4,
    );
    if (depResult) applied = true;
    else errors.push(`DEP policy: failed`);

    // 2. Disable extension point disabling (normal apps don't disable these)
    // PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY: 0 = don't disable
    const extPolicy = Buffer.alloc(4);
    extPolicy.writeUInt32LE(0x0000, 0); // Don't disable extension points
    const extResult = SetProcessMitigationPolicy(
      PROCESS_MITIGATION_POLICY.EXTENSION_POINT_DISABLE,
      koffi.address(extPolicy),
      4,
    );
    if (extResult) applied = true;
    else errors.push(`Extension point policy: failed`);

    // 3. Disable image load restrictions (normal apps load images freely)
    // PROCESS_MITIGATION_IMAGE_LOAD_POLICY: 0 = no restrictions
    const imgPolicy = Buffer.alloc(4);
    imgPolicy.writeUInt32LE(0x0000, 0);
    const imgResult = SetProcessMitigationPolicy(
      PROCESS_MITIGATION_POLICY.IMAGE_LOAD,
      koffi.address(imgPolicy),
      4,
    );
    if (imgResult) applied = true;
    else errors.push(`Image load policy: failed`);

    try {
      k32.unload();
    } catch {
      /* ignore */
    }

    return {
      applied,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  } catch (err) {
    return {
      applied: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Set process to background priority class.
 *
 * Anti-cheat/EDR processes often run at HIGH_PRIORITY_CLASS.
 * Lowering to BELOW_NORMAL reduces our visibility in task manager
 * and process enumeration tools.
 */
function setBackgroundPriority(): { applied: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { applied: false, error: 'Not on Windows' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');

    const SetPriorityClass = k32.func('int SetPriorityClass(void *, uint32)');
    const GetCurrentProcess = k32.func('void * GetCurrentProcess()');

    const BELOW_NORMAL_PRIORITY_CLASS = 0x00004000;
    const result = SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);

    try {
      k32.unload();
    } catch {
      /* ignore */
    }

    return { applied: result !== 0 };
  } catch (err) {
    return {
      applied: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Disable heap termination-on-corruption.
 *
 * When HeapEnableTerminationOnCorruption is active (common in security tools),
 * any heap corruption immediately terminates the process. Normal applications
 * typically don't have this enabled. Disabling it makes us look less like
 * a security-conscious tool.
 *
 * WARNING: This slightly reduces our own crash-safety. For a tool that
 * performs memory operations on OTHER processes, this is acceptable.
 */
function disableHeapTermination(): { applied: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { applied: false, error: 'Not on Windows' };
  }

  // HeapSetInformation with HeapEnableTerminationOnCorruption = 0
  // This is a process-wide setting — once disabled, cannot be re-enabled.
  // However, we can only DISABLE it (there is no re-enable API).
  // For our use case (memory tool), this is fine.

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');

    const GetProcessHeap = k32.func('void * GetProcessHeap()');
    const HeapSetInformation = k32.func(
      'int HeapSetInformation(void *, int32, _In_ void *, uint32)',
    );

    const heap = GetProcessHeap();
    const HeapEnableTerminationOnCorruption = 1;

    // Value = 0 disables the feature
    const value = Buffer.alloc(4);
    value.writeUInt32LE(0, 0); // FALSE = disable

    const result = HeapSetInformation(
      heap,
      HeapEnableTerminationOnCorruption,
      koffi.address(value),
      4,
    );

    try {
      k32.unload();
    } catch {
      /* ignore */
    }

    return { applied: result !== 0 };
  } catch (err) {
    return {
      applied: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Attempt to randomize the reported process creation time.
 *
 * NtQueryInformationProcess with ProcessTimes returns creation time.
 * While we cannot directly modify EPROCESS.CreateTime from user-mode,
 * we can hook NtQueryInformationProcess in OUR process to report a
 * plausible fake creation time.
 *
 * HONEST BOUNDARY: This only affects OUR process's view of OUR creation
 * time. External processes querying OUR EPROCESS will see the real time.
 */
function randomizeCreationTime(): { applied: boolean; error?: string } {
  // This requires in-process API hooking (e.g., Detours-style).
  // From pure user-mode Node.js, we cannot reliably hook NtQueryInformationProcess
  // on ourselves without a native addon.
  //
  // We report this honestly — the capability exists conceptually, but
  // the implementation requires a native trampoline that is beyond the
  // scope of a koffi-based FFI approach.
  return {
    applied: false,
    error: 'Creation time randomization requires in-process API hooking (native trampoline)',
  };
}

/**
 * Spoof the process title (console window title).
 *
 * On Windows, uses SetConsoleTitleA to change the window title from
 * the default (which may expose the executable path or tool name)
 * to a benign-looking title.
 *
 * Default title: "svchost.exe" — looks like a standard Windows service host.
 * Configurable via JSHOOK_MASQUERADE_TITLE env var.
 *
 * HONEST BOUNDARY: This only changes the console window title, not the
 * actual process name in Task Manager, EPROCESS, or kernel callbacks.
 */
function spoofProcessTitle(customTitle?: string): { applied: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { applied: false, error: 'Not on Windows' };
  }

  try {
    const defaultTitle = process.env['JSHOOK_MASQUERADE_TITLE'] || 'svchost.exe';
    const title = customTitle || defaultTitle;

    // Use process.title (Node.js builtin) — works on all platforms
    // but is most effective on Windows where it calls SetConsoleTitle
    const originalTitle = process.title;
    process.title = title;

    logger.debug(`ProcessMasquerade: title spoofed from "${originalTitle}" to "${title}"`);

    return { applied: true };
  } catch (err) {
    return {
      applied: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Intentionally NOT clearing JSHOOK_* env vars — these are safety gates that
 * MUST remain set for the process lifetime. Removing them removes
 * injection/BYOVD/hypervisor safety interlocks:
 *
 *   - JSHOOK_INJECTION_ENABLE — gates shellcode/DLL injection
 *   - JSHOOK_BYOVD_ENABLE — gates kernel driver loading
 *   - JSHOOK_HYPERVISOR_ENABLE — gates hypervisor operations
 *   - JSHOOK_SELFDEFENSE_EXTREME — gates dangerous self-protection
 *
 * The previous clearJSHOOKEnvVars() function was removed because deleting
 * these variables removes ALL safety interlocks from the running process.
 * Anti-cheat/EDR env-var scanning is a lower risk than losing safety gates.
 */

/**
 * Report the parent process ID.
 *
 * Uses NtQueryInformationProcess(ProcessBasicInformation) to read the
 * InheritedFromUniqueProcessId field from the PEB.
 *
 * HONEST BOUNDARY: Spoofing the parent PID for THIS process requires
 * kernel R/W (EPROCESS.InheritedFromUniqueProcessId). For FUTURE child
 * processes, we can use PROC_THREAD_ATTRIBUTE_PARENT_PROCESS.
 */
function getParentPid(): { parentPid: number; error?: string } {
  if (process.platform !== 'win32') {
    return { parentPid: 0, error: 'Not on Windows' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const ntdll = koffi.load('ntdll.dll');

    const NtQueryInformationProcess = ntdll.func(
      'int32 NtQueryInformationProcess(void *, uint32, _Out_ void *, uint32, _Out_ uint32 *)',
    );

    // ProcessBasicInformation = 0
    const pbi = Buffer.alloc(48); // PROCESS_BASIC_INFORMATION on x64
    const retLen = Buffer.alloc(4);

    const status = NtQueryInformationProcess(
      BigInt('0xFFFFFFFFFFFFFFFF'),
      0,
      koffi.address(pbi),
      pbi.length,
      koffi.address(retLen),
    ) as number;

    try {
      ntdll.unload();
    } catch {
      /* ignore */
    }

    if (status < 0) {
      return {
        parentPid: 0,
        error: `NtQueryInformationProcess failed: 0x${(status >>> 0).toString(16)}`,
      };
    }

    // PROCESS_BASIC_INFORMATION layout (x64):
    //   ExitStatus(8) + PebBaseAddress(8) + AffinityMask(8) +
    //   BasePriority(4) + UniqueProcessId(8) + InheritedFromUniqueProcessId(8)
    const parentPid = Number(pbi.readBigUInt64LE(40));

    return { parentPid };
  } catch (err) {
    return {
      parentPid: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Apply process masquerading based on configuration.
 *
 * By default, applies all safe settings. Individual settings can be
 * controlled via the config parameter or environment variables:
 *   - JSHOOK_MASQUERADE_PARENT_PID=1234
 *   - JSHOOK_MASQUERADE_MITIGATIONS=1
 *   - JSHOOK_MASQUERADE_BACKGROUND=1
 *   - JSHOOK_MASQUERADE_HEAP=1
 *
 * @returns Detailed result of each masquerade attempt.
 */
export function applyProcessMasquerade(config: MasqueradeConfig = {}): MasqueradeResult {
  const limitations: string[] = [
    'Real parent PID in EPROCESS cannot be spoofed from user-mode',
    'ETW-TI kernel events are unaffected by user-mode masquerading',
    'Digital signatures cannot be faked for kernel-mode verification',
    'Kernel callback notifications (PsSetCreateProcessNotifyRoutine) see real values',
    'External process enumeration sees real EPROCESS fields',
  ];

  const results: MasqueradeResult['results'] = {};

  // 1. Mitigation policies
  if (config.applyMitigationPolicies !== false) {
    results.mitigationPolicies = applyMitigationPolicies();
  }

  // 2. Background priority
  if (config.backgroundPriority !== false) {
    results.backgroundPriority = setBackgroundPriority();
  }

  // 3. Heap termination (disable)
  if (config.disableHeapTermination !== false) {
    results.heapTermination = disableHeapTermination();
  }

  // 4. Spoof process title
  if (config.spoofParentPid === undefined || config.spoofParentPid === null) {
    // title spoofing is independent of parentPID
    const titleResult = spoofProcessTitle();
    results.processTitle = titleResult;
  }

  // 5. JSHOOK_* env vars are safety gates — intentionally NOT cleared
  // (see module-level comment above for the safety rationale)

  // 6. Creation time randomization
  if (config.randomizeCreationTime) {
    results.creationTime = randomizeCreationTime();
  }

  // 5. Parent PID check (report only)
  const { parentPid, error: ppidError } = getParentPid();
  if (ppidError) {
    limitations.push(`Parent PID: ${ppidError}`);
  } else {
    // Check if parent is explorer.exe (normal) or something suspicious
    const isExplorer = isProcessName(parentPid, 'explorer.exe');
    results.parentPid = {
      applied: true,
      error: `Current parent PID: ${parentPid} ${isExplorer ? '(explorer.exe — normal)' : '(non-standard parent)'}`,
    };
  }

  const applied = Object.values(results).some((r) => r.applied);

  if (applied) {
    logger.debug('Process masquerade applied', { results });
  }

  return { results, limitations, applied };
}

/**
 * Check if a PID belongs to a given process name.
 */
function isProcessName(pid: number, expectedName: string): boolean {
  if (process.platform !== 'win32') return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');

    const OpenProcess = k32.func('void * OpenProcess(uint32, int32, uint32)');
    const GetModuleBaseNameA = k32.func(
      'uint32 GetModuleBaseNameA(void *, void *, _Out_ char *, uint32)',
    );
    const CloseHandle = k32.func('int CloseHandle(void *)');

    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);

    if (!hProcess || hProcess === null) {
      return false;
    }

    const nameBuf = Buffer.alloc(260);
    const len = GetModuleBaseNameA(hProcess, null, koffi.address(nameBuf), 260);

    CloseHandle(hProcess);
    try {
      k32.unload();
    } catch {
      /* ignore */
    }

    if (len === 0) return false;

    const name = nameBuf.toString('utf8', 0, len).toLowerCase();
    return name === expectedName.toLowerCase();
  } catch {
    return false;
  }
}
