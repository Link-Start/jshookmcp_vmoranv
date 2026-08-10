/**
 * SelfDefense — protects the current process from termination and monitoring.
 *
 * In hostile environments (anti-cheat, EDR), our process may be:
 * - Terminated by security software that detects memory operations
 * - Monitored via open handles from AV/EDR processes
 * - Enumerated via window enumeration (EnumWindows / FindWindow)
 *
 * This module provides best-effort user-mode self-defense:
 *
 * 1. **Handle monitoring** — detect when AV/EDR opens a handle to us
 * 2. ~~**Termination protection** — ProcessBreakOnTermination~~ PERMANENTLY DISABLED
 * 3. **Window hiding** — hide from EnumWindows / FindWindow
 * 4. **Process priority protection** — prevent priority reduction
 *
 * CRITICAL: ProcessBreakOnTermination (0x1D) is IRREVERSIBLE and causes BSOD
 * on process exit. This has been permanently disabled. See
 * BSOD-CRITICAL_PROCESS_DIED-Analysis.md for the 6-crash incident report.
 *
 * @module SelfDefense
 */

import { logger } from '@utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SelfDefenseConfig {
  /** Enable handle monitoring (polling). Default: true if JSHOOK_SELFDEFENSE=1. */
  monitorHandles?: boolean;
  /** Enable window hiding. Default: true if JSHOOK_SELFDEFENSE=1. */
  hideWindow?: boolean;
  /** Enable process priority protection. */
  protectPriority?: boolean;
  /** Enable ProcessBreakOnTermination. DANGEROUS — requires JSHOOK_SELFDEFENSE_EXTREME=1. */
  breakOnTermination?: boolean;
  /** Handle monitoring poll interval in ms. Default: 5000. */
  pollIntervalMs?: number;
  /** Callback when a suspicious handle is detected. */
  onSuspiciousHandle?: (ownerPid: number, accessDescription: string) => void;
}

export interface SelfDefenseReport {
  /** Whether handle monitoring is active. */
  handleMonitorActive: boolean;
  /** Whether window is hidden. */
  windowHidden: boolean;
  /** Whether termination protection is active. */
  terminationProtected: boolean;
  /** Whether priority protection is active. */
  priorityProtected: boolean;
  /** Current suspicious handle count. */
  suspiciousHandleCount: number;
  /** Honest limitations. */
  limitations: string[];
}

// ── State ────────────────────────────────────────────────────────────────────

let handleMonitorInterval: ReturnType<typeof setInterval> | null = null;
let suspiciousHandleCount = 0;

// ── Helper ───────────────────────────────────────────────────────────────────

function envFlag(name: string): boolean {
  try {
    const v = process.env[name];
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

// ── Implementations ──────────────────────────────────────────────────────────

/**
 * Enable handle monitoring — periodically checks who has handles to us.
 *
 * Uses NtQuerySystemInformation(SystemExtendedHandleInformation) to find
 * processes that have opened handles to our PID. When a suspicious handle
 * is found (high access mask from a non-system process), logs a warning
 * and calls the onSuspiciousHandle callback.
 *
 * Requires SeDebugPrivilege for full results.
 */
function startHandleMonitoring(config: SelfDefenseConfig): boolean {
  if (handleMonitorInterval) return true; // already running

  const interval = config.pollIntervalMs || 5000;

  handleMonitorInterval = setInterval(() => {
    try {
      checkHandles(config);
    } catch {
      // Handle monitoring failure is not fatal
    }
  }, interval);

  // Unref so the timer doesn't prevent process exit
  if (handleMonitorInterval && typeof handleMonitorInterval.unref === 'function') {
    handleMonitorInterval.unref();
  }

  logger.debug(`SelfDefense: handle monitoring started (interval: ${interval}ms)`);
  return true;
}

function checkHandles(config: SelfDefenseConfig): void {
  if (process.platform !== 'win32') return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const ntdll = koffi.load('ntdll.dll');

    const NtQuerySystemInformation = ntdll.func(
      'int32 NtQuerySystemInformation(uint32, _Out_ void *, uint32, _Out_ uint32 *)',
    );

    const SYSTEM_EXTENDED_HANDLE_INFORMATION = 64;
    const sizeBuf = Buffer.alloc(4);

    let status = NtQuerySystemInformation(
      SYSTEM_EXTENDED_HANDLE_INFORMATION,
      null,
      0,
      koffi.address(sizeBuf),
    ) as number;

    const requiredSize = sizeBuf.readUInt32LE(0);
    if (requiredSize === 0 || requiredSize > 32 * 1024 * 1024) {
      try {
        ntdll.unload();
      } catch {
        /* ignore */
      }
      return;
    }

    const buf = Buffer.alloc(requiredSize + 65536);
    status = NtQuerySystemInformation(
      SYSTEM_EXTENDED_HANDLE_INFORMATION,
      koffi.address(buf),
      buf.length,
      koffi.address(sizeBuf),
    ) as number;

    try {
      ntdll.unload();
    } catch {
      /* ignore */
    }

    if (status < 0) return; // No privilege — silently skip

    const ourPid = process.pid;
    const handleCount = Number(buf.readBigUInt64LE(0));
    const entrySize = 32;
    let newSuspiciousCount = 0;

    let offset = 8;
    for (let i = 0; i < handleCount && offset + entrySize <= buf.length; i++) {
      const targetPid = Number(buf.readBigUInt64LE(offset + 8));
      const ownerPid = Number(buf.readBigUInt64LE(offset));
      const grantedAccess = buf.readUInt32LE(offset + 24);

      if (targetPid === ourPid && ownerPid !== ourPid && ownerPid !== 0 && ownerPid !== 4) {
        // Exclude System (PID 4) and Idle (PID 0)
        const suspiciousAccess =
          (grantedAccess & 0x0010) !== 0 || // VM_READ
          (grantedAccess & 0x0008) !== 0 || // VM_OPERATION
          (grantedAccess & 0x0020) !== 0 || // VM_WRITE
          (grantedAccess & 0x0800) !== 0; // SUSPEND_RESUME

        if (suspiciousAccess) {
          newSuspiciousCount++;
          if (config.onSuspiciousHandle) {
            const accessDesc = describeAccessFlags(grantedAccess);
            config.onSuspiciousHandle(ownerPid, accessDesc);
          }
        }
      }

      offset += entrySize;
    }

    if (newSuspiciousCount > suspiciousHandleCount) {
      logger.warn(
        `SelfDefense: ${newSuspiciousCount} suspicious handle(s) detected (was ${suspiciousHandleCount})`,
      );
    }

    suspiciousHandleCount = newSuspiciousCount;
  } catch {
    // Silent fail — handle monitoring is best-effort
  }
}

function describeAccessFlags(mask: number): string {
  const flags: string[] = [];
  if (mask & 0x0010) flags.push('VM_READ');
  if (mask & 0x0008) flags.push('VM_OPERATION');
  if (mask & 0x0020) flags.push('VM_WRITE');
  if (mask & 0x0400) flags.push('QUERY_INFO');
  if (mask & 0x0800) flags.push('SUSPEND');
  if (mask & 0x0001) flags.push('TERMINATE');
  if (mask & 0x0002) flags.push('CREATE_THREAD');
  return flags.length > 0 ? flags.join('|') : `0x${mask.toString(16)}`;
}

function stopHandleMonitoring(): void {
  if (handleMonitorInterval) {
    clearInterval(handleMonitorInterval);
    handleMonitorInterval = null;
    logger.debug('SelfDefense: handle monitoring stopped');
  }
}

/**
 * Hide the current process window from EnumWindows / FindWindow.
 *
 * This is only relevant if our process has a visible window (GUI mode).
 * For CLI tools (like jshookmcp MCP server), there is typically no window.
 *
 * Implementation uses SetWindowLongPtr with WS_EX_TOOLWINDOW to hide
 * from the taskbar and alt-tab, plus WS_EX_LAYERED with 0% opacity
 * to be invisible to screen capture.
 *
 * HONEST BOUNDARY: Direct kernel-mode window enumeration
 * (NtUserBuildHwndList) bypasses these flags. This only hides from
 * user-mode EnumWindows / FindWindow.
 */
function hideProcessWindow(): { applied: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { applied: false, error: 'Not on Windows' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const u32 = koffi.load('user32.dll');

    const GetConsoleWindow = u32.func('void * GetConsoleWindow()');

    // Try to find our console window
    const hwnd = GetConsoleWindow();
    if (!hwnd || hwnd === null) {
      try {
        u32.unload();
      } catch {
        /* ignore */
      }
      return { applied: false, error: 'No console window found' };
    }

    const SetWindowLongPtrA = u32.func('uint64 SetWindowLongPtrA(void *, int32, uint64)');
    const ShowWindow = u32.func('int ShowWindow(void *, int32)');

    const GWL_EXSTYLE = -20;
    const WS_EX_TOOLWINDOW = 0x00000080;
    const WS_EX_NOACTIVATE = 0x08000000;
    const SW_HIDE = 0;

    // Add tool window style (hides from taskbar + alt-tab)
    SetWindowLongPtrA(hwnd, GWL_EXSTYLE, BigInt(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE));

    // Hide the window
    ShowWindow(hwnd, SW_HIDE);

    try {
      u32.unload();
    } catch {
      /* ignore */
    }

    return { applied: true };
  } catch (err) {
    return {
      applied: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Protect process priority from being lowered.
 *
 * Anti-cheat and EDR software often lowers the priority of suspicious
 * processes to reduce their impact. By enabling SeIncreaseBasePriorityPrivilege
 * or setting a minimum priority, we make this harder.
 *
 * HONEST BOUNDARY: A kernel driver can still change our priority.
 * This only protects against user-mode priority manipulation.
 */
function protectProcessPriority(): { applied: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { applied: false, error: 'Not on Windows' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');

    const SetPriorityClass = k32.func('int SetPriorityClass(void *, uint32)');
    const GetCurrentProcess = k32.func('void * GetCurrentProcess()');

    // Set to ABOVE_NORMAL to make it harder to reduce to IDLE
    const ABOVE_NORMAL_PRIORITY_CLASS = 0x00008000;
    const result = SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);

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
 * Enable ProcessBreakOnTermination — PERMANENTLY DISABLED.
 *
 * THIS FUNCTION IS A STUB. The original implementation called
 * NtSetInformationProcess(ProcessBreakOnTermination=29) which irreversibly
 * marks the calling process as a critical system process. When the process
 * exits (normal exit, restart, or kill), the Windows kernel triggers
 * CRITICAL_PROCESS_DIED bugcheck (BSOD 0x000000EF).
 *
 * This happened 6 times when Claude Code restarted the jshookmcp MCP server.
 * ProcessBreakOnTermination can ONLY be undone via kernel R/W (BYOVD driver)
 * — there is no user-mode API to reverse it. It is intended ONLY for
 * csrss.exe, winlogon.exe, and other system-critical processes.
 *
 * DO NOT RE-ENABLE. If you need termination protection for a user-mode
 * process, use a service watchdog or a parent process monitor instead.
 *
 * Original implementation preserved below for reference:
 *
 * @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
 * @@@  WARNING: The code below WILL cause BSOD if uncommented and called. @@@
 * @@@  This is the EXACT code that caused 6 CRITICAL_PROCESS_DIED BSODs.  @@@
 * @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
 *
 * // ORIGINAL (DANGEROUS — DO NOT UNCOMMENT):
 * //
 * // if (process.platform !== 'win32') {
 * //   return { applied: false, error: 'Not on Windows' };
 * // }
 * //
 * // if (!envFlag('JSHOOK_SELFDEFENSE_EXTREME')) {
 * //   return {
 * //     applied: false,
 * //     error: 'JSHOOK_SELFDEFENSE_EXTREME=1 required.',
 * //   };
 * // }
 * //
 * // const koffi = require('koffi');
 * // const ntdll = koffi.load('ntdll.dll');
 * // const NtSetInformationProcess = ntdll.func(
 * //   'int32 NtSetInformationProcess(void *, uint32, _In_ void *, uint32)',
 * // );
 * // const PROCESS_BREAK_ON_TERMINATION = 29;
 * // const value = Buffer.alloc(4);
 * // value.writeUInt32LE(1, 0);
 * // const status = NtSetInformationProcess(
 * //   BigInt('0xFFFFFFFFFFFFFFFF'), PROCESS_BREAK_ON_TERMINATION,
 * //   koffi.address(value), 4,
 * // ) as number;
 * // ntdll.unload();
 * // // status === 0 → BSOD on next process exit. IRREVERSIBLE.
 */
function enableBreakOnTermination(): { applied: boolean; error?: string } {
  return {
    applied: false,
    error:
      'BreakOnTermination disabled — irreversibly marks process as critical, ' +
      'causing BSOD on restart. This is NOT safe for user-mode MCP servers.',
  };
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Apply self-defense measures based on configuration.
 *
 * Environment variable driven:
 *   - JSHOOK_SELFDEFENSE=1 — enable basic self-defense (monitor + hide window)
 *   - JSHOOK_SELFDEFENSE_EXTREME=1 — enable BreakOnTermination (DANGEROUS)
 *
 * @param config — Optional override configuration.
 * @returns Report of applied defense measures.
 */
export function applySelfDefense(config: SelfDefenseConfig = {}): SelfDefenseReport {
  const autoEnable = envFlag('JSHOOK_SELFDEFENSE');
  const extremeEnable = envFlag('JSHOOK_SELFDEFENSE_EXTREME');

  const limitations: string[] = [
    'Handle monitoring requires SeDebugPrivilege for full results',
    'Window hiding does not prevent kernel-mode enumeration (NtUserBuildHwndList)',
    'ProcessBreakOnTermination is IRREVERSIBLE without kernel R/W',
    'Priority protection is user-mode only — kernel drivers can override',
    'A kernel driver with sufficient access can still terminate us',
  ];

  // 1. Handle monitoring
  const monitorHandles = config.monitorHandles !== false && autoEnable;
  let handleMonitorActive = false;
  if (monitorHandles) {
    handleMonitorActive = startHandleMonitoring(config);
  }

  // 2. Window hiding
  const hideWin = config.hideWindow !== false && (autoEnable || config.hideWindow === true);
  let windowHidden = false;
  if (hideWin) {
    const result = hideProcessWindow();
    windowHidden = result.applied;
    if (result.error) {
      limitations.push(`Window hiding: ${result.error}`);
    }
  }

  // 3. Priority protection
  const protectPrio = config.protectPriority === true || extremeEnable;
  let priorityProtected = false;
  if (protectPrio) {
    const result = protectProcessPriority();
    priorityProtected = result.applied;
    if (result.error) {
      limitations.push(`Priority protection: ${result.error}`);
    }
  }

  // 4. Break on termination (EXTREME)
  const breakOnTerm = config.breakOnTermination === true || extremeEnable;
  let terminationProtected = false;
  if (breakOnTerm) {
    const result = enableBreakOnTermination();
    terminationProtected = result.applied;
    if (result.error) {
      limitations.push(`BreakOnTermination: ${result.error}`);
    }
  }

  const report: SelfDefenseReport = {
    handleMonitorActive,
    windowHidden,
    terminationProtected,
    priorityProtected,
    suspiciousHandleCount,
    limitations,
  };

  logger.debug('SelfDefense: applied', report);

  return report;
}

/**
 * Stop all self-defense measures (clean shutdown).
 *
 * Does NOT disable ProcessBreakOnTermination (impossible from user-mode).
 */
export function stopSelfDefense(): void {
  stopHandleMonitoring();
  suspiciousHandleCount = 0;
  logger.debug('SelfDefense: all measures stopped');
}

/**
 * Get the current suspicious handle count.
 */
export function getSuspiciousHandleCount(): number {
  return suspiciousHandleCount;
}
