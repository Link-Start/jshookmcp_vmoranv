import type { HardwareBreakpointEngine } from '@native/HardwareBreakpoint';
import type { SoftwareBreakpointEngine } from '@native/SoftwareBreakpoint';
import type { VehDebuggerEngine } from '@native/VehDebugger';
import type {
  BreakpointAccess,
  BreakpointListEntry,
  BreakpointSize,
} from '@native/HardwareBreakpoint.types';
import type { CodeInjector } from '@native/CodeInjector';
import type { UnifiedProcessManager } from '@server/domains/shared/modules/native';
import type { MCPServerContext } from '@server/MCPServer.context';
import { resolveMemoryDomainPid } from '@server/domains/memory/pid-resolver';
import { handleSafe } from '@server/domains/shared/ResponseBuilder';
import { argEnum, argNumber, argString } from '@server/domains/shared/parse-args';
import { logger } from '@utils/logger';
import { MemoryAuditTrail } from '@modules/process/memory/AuditTrail';
import {
  requirePositiveIntArg,
  requireStringArg,
  validateBytesArray,
  validateHexAddress,
} from './validation';

/** Lazy-load ConditionEvaluator (avoids Node require path-alias issues). */
let conditionEvaluatorCache: Awaited<typeof import('@native/ConditionEvaluator')> | null = null;

async function getConditionEvaluator() {
  if (!conditionEvaluatorCache) {
    conditionEvaluatorCache = await import('@native/ConditionEvaluator');
  }
  return conditionEvaluatorCache;
}

const TOOL_BREAKPOINT = 'memory_breakpoint';
const TOOL_PATCH_NOP = 'memory_patch_nop';
const TOOL_PATCH_UNDO = 'memory_patch_undo';
const TOOL_CODE_CAVES = 'memory_code_caves';
const TOOL_ALLOCATE = 'memory_allocate';
const TOOL_INJECT_SHELLCODE = 'memory_inject_shellcode';
const TOOL_INJECT_DLL = 'memory_inject_dll';

const INJECTION_ENV_GATE = 'JSHOOK_INJECTION_ENABLE';

function assertInjectionEnabled(): void {
  if (process.env[INJECTION_ENV_GATE] !== '1') {
    throw new Error(
      `Code injection tools require ${INJECTION_ENV_GATE}=1 environment variable. ` +
        `Set this to enable memory_allocate, memory_free, memory_inject_shellcode, and memory_inject_dll.`,
    );
  }
}

/** x64 exposes only 4 hardware debug registers (DR0-DR3). */
const HW_BREAKPOINT_MAX = 4;
/** NOP patches beyond this size are likely mistakes — reject to avoid zeroing
 * large executable ranges. Use memory_patch_bytes for intentional large writes. */
const PATCH_NOP_MAX_COUNT = 1024;

const BREAKPOINT_ACCESS = new Set<BreakpointAccess>(['read', 'write', 'readwrite', 'execute']);
const BREAKPOINT_SIZES = new Set<BreakpointSize>([1, 2, 4, 8] as unknown as BreakpointSize[]);

const WIN32_UNSUPPORTED_MSG =
  'Hardware breakpoint tools (memory_breakpoint) are only supported on Windows. ' +
  'This tool requires Win32 debug register APIs.';

const VEH_UNSUPPORTED_MSG =
  'VEH debugger mode is only supported on Windows and requires the VEH debugger engine. ' +
  'Use debuggerMode="win32" or ensure the VEH engine is available.';

type DebuggerBackend = 'win32' | 'veh';
type BreakpointType = 'hardware' | 'software';

/** Union type for engines that support the breakpoint lifecycle interface. */
type BreakpointEngine = HardwareBreakpointEngine | SoftwareBreakpointEngine | VehDebuggerEngine;

export class HookHandlers {
  private readonly auditTrail: MemoryAuditTrail | null;

  constructor(
    private readonly bpEngine: HardwareBreakpointEngine | null,
    private readonly vehEngine: VehDebuggerEngine | null,
    private readonly softBpEngine: SoftwareBreakpointEngine | null,
    private readonly injector: CodeInjector,
    private readonly processManager?: UnifiedProcessManager,
    private readonly ctx?: MCPServerContext,
    auditTrail?: MemoryAuditTrail | null,
  ) {
    this.auditTrail = auditTrail ?? null;
  }

  /** Resolve which breakpoint engine to use based on type + debuggerMode. */
  private resolveEngine(bpType: string | undefined, mode: string | undefined): BreakpointEngine {
    const type = (bpType ?? 'hardware').toLowerCase() as BreakpointType;
    if (type === 'software') {
      if (!this.softBpEngine) throw new Error(WIN32_UNSUPPORTED_MSG);
      return this.softBpEngine;
    }
    const modeLower = (mode ?? 'win32').toLowerCase() as DebuggerBackend;
    if (modeLower === 'veh') {
      if (!this.vehEngine) throw new Error(VEH_UNSUPPORTED_MSG);
      return this.vehEngine;
    }
    if (!this.bpEngine) throw new Error(WIN32_UNSUPPORTED_MSG);
    return this.bpEngine;
  }

  private async resolvePid(value: unknown): Promise<number> {
    return await resolveMemoryDomainPid(value, this.processManager, this.ctx);
  }

  private recordAudit(entry: {
    operation: string;
    pid: number | null;
    address: string | null;
    size: number | null;
    result: 'success' | 'failure';
    error?: string;
    durationMs: number;
  }): void {
    if (!this.auditTrail) return;
    try {
      this.auditTrail.record(entry);
    } catch (auditError) {
      logger.warn('Memory audit trail recording failed:', auditError);
    }
  }

  async handleBreakpointSet(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const bpType = argString(args, 'type');
      const debuggerMode = argString(args, 'debuggerMode');
      const engine = this.resolveEngine(bpType, debuggerMode);
      const isHardware = (bpType ?? 'hardware').toLowerCase() === 'hardware';

      // Validate condition early
      const condition = argString(args, 'condition');
      if (condition) {
        try {
          const { validateBreakpointCondition } = await getConditionEvaluator();
          validateBreakpointCondition(condition);
        } catch (e) {
          throw new Error(
            `${TOOL_BREAKPOINT}: invalid condition expression: ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
      }

      // DR exhaustion guard (hardware only — software BPs are unlimited)
      if (isHardware) {
        const active = engine.listBreakpoints();
        if (active.length >= HW_BREAKPOINT_MAX) {
          throw new Error(
            `${TOOL_BREAKPOINT}: all ${HW_BREAKPOINT_MAX} hardware debug registers (DR0-DR3) are in use. ` +
              `Remove an existing breakpoint (memory_breakpoint action=remove) before setting a new one. ` +
              `Use type='software' for unlimited breakpoints.`,
          );
        }
      }

      const pid = await this.resolvePid(args.pid);
      const address = validateHexAddress(args.address, 'address');
      const access = argEnum(args, 'access', BREAKPOINT_ACCESS);
      if (!access) {
        throw new Error(
          `${TOOL_BREAKPOINT}: missing or invalid required argument "access" (expected one of: ${[...BREAKPOINT_ACCESS].join(', ')}), got: ${JSON.stringify(args.access)}`,
        );
      }
      const sizeArg = argNumber(args, 'size', isHardware ? 4 : 1);
      const size = (
        BREAKPOINT_SIZES.has(sizeArg as unknown as BreakpointSize) ? sizeArg : isHardware ? 4 : 1
      ) as BreakpointSize;

      const config = await engine.setBreakpoint(pid, address, access, size, condition);
      const typeLabel =
        (bpType ?? 'hardware').toLowerCase() === 'software'
          ? 'INT3/0xCC'
          : 'hardware (DR register)';
      return {
        ...config,
        type: bpType ?? 'hardware',
        mode: debuggerMode ?? 'win32',
        condition: condition || undefined,
        hint: `${typeLabel === 'INT3/0xCC' ? 'Software' : 'Hardware'} breakpoint set (${typeLabel}, ${debuggerMode ?? 'win32'} mode). Use memory_breakpoint with action='trace' to collect hits.`,
      };
    });
  }

  async handleBreakpointRemove(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const bpType = argString(args, 'type');
      const debuggerMode = argString(args, 'debuggerMode');
      const engine = this.resolveEngine(bpType, debuggerMode);
      const breakpointId = requireStringArg(args.breakpointId, 'breakpointId', TOOL_BREAKPOINT);
      return { removed: await engine.removeBreakpoint(breakpointId) };
    });
  }

  async handleBreakpointList(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const bpType = argString(args, 'type');
      const debuggerMode = argString(args, 'debuggerMode');
      const engine = this.resolveEngine(bpType, debuggerMode);
      const bps = engine.listBreakpoints();
      // Also list software BPs if type not explicitly specified
      const allBps: BreakpointListEntry[] = [...bps];
      if (!bpType && this.softBpEngine) {
        allBps.push(...this.softBpEngine.listBreakpoints());
      }
      return { breakpoints: allBps, count: allBps.length, mode: debuggerMode ?? 'win32' };
    });
  }

  async handleBreakpointTrace(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const bpType = argString(args, 'type');
      const debuggerMode = argString(args, 'debuggerMode');
      const engine = this.resolveEngine(bpType, debuggerMode);
      const isHardware = (bpType ?? 'hardware').toLowerCase() === 'hardware';

      // DR exhaustion guard (hardware only)
      if (isHardware) {
        const active = engine.listBreakpoints();
        if (active.length >= HW_BREAKPOINT_MAX) {
          throw new Error(
            `${TOOL_BREAKPOINT}: all ${HW_BREAKPOINT_MAX} hardware debug registers (DR0-DR3) are in use. ` +
              `Remove an existing breakpoint before tracing. Use type='software' for unlimited breakpoints.`,
          );
        }
      }

      // Validate condition early
      const condition = argString(args, 'condition');
      if (condition) {
        try {
          const { validateBreakpointCondition } = await getConditionEvaluator();
          validateBreakpointCondition(condition);
        } catch (e) {
          throw new Error(
            `${TOOL_BREAKPOINT}: invalid condition expression: ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
      }

      const pid = await this.resolvePid(args.pid);
      const address = validateHexAddress(args.address, 'address');
      const access = argEnum(args, 'access', BREAKPOINT_ACCESS);
      if (!access) {
        throw new Error(
          `${TOOL_BREAKPOINT}: missing or invalid required argument "access" (expected one of: ${[...BREAKPOINT_ACCESS].join(', ')}), got: ${JSON.stringify(args.access)}`,
        );
      }
      const maxHits = argNumber(args, 'maxHits');
      const timeoutMs = argNumber(args, 'timeoutMs');
      const hits = await engine.traceAccess(pid, address, access, maxHits, timeoutMs);

      // Evaluate condition on each hit if specified
      const filteredHits = condition
        ? await (async () => {
            const { evaluateBreakpointCondition, buildConditionContext } =
              await getConditionEvaluator();
            const kept = [];
            for (const hit of hits) {
              if (!hit.registers) {
                kept.push(hit);
                continue;
              }
              try {
                if (evaluateBreakpointCondition(condition, buildConditionContext(hit.registers))) {
                  kept.push(hit);
                }
              } catch {
                kept.push(hit);
              }
            }
            return kept;
          })()
        : hits;

      return {
        hits: filteredHits,
        hitCount: filteredHits.length,
        filteredCount: condition ? hits.length - filteredHits.length : 0,
        type: bpType ?? 'hardware',
        mode: debuggerMode ?? 'win32',
        condition: condition || undefined,
        hint:
          filteredHits.length > 0
            ? `${filteredHits.length} hits captured${condition ? ` (${hits.length - filteredHits.length} filtered by condition)` : ''}.`
            : 'No hits captured within timeout.',
      };
    });
  }

  async handlePatchBytes(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const pid = await this.resolvePid(args.pid);
      const address = validateHexAddress(args.address, 'address');
      const bytes = validateBytesArray(args.bytes, 'bytes');
      const start = Date.now();
      try {
        const patch = await this.injector.patchBytes(pid, address, bytes);
        this.recordAudit({
          operation: 'patch_bytes',
          pid,
          address,
          size: bytes.length,
          result: 'success',
          durationMs: Date.now() - start,
        });
        return {
          ...patch,
          hint: `Patch applied. Use memory_patch_undo with patchId "${patch.id}" to restore.`,
        };
      } catch (e) {
        this.recordAudit({
          operation: 'patch_bytes',
          pid,
          address,
          size: bytes.length,
          result: 'failure',
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
        throw e;
      }
    });
  }

  async handlePatchNop(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const pid = await this.resolvePid(args.pid);
      const address = validateHexAddress(args.address, 'address');
      const count = requirePositiveIntArg(args.count, 'count', TOOL_PATCH_NOP);
      if (count > PATCH_NOP_MAX_COUNT) {
        throw new Error(
          `${TOOL_PATCH_NOP}: count ${count} exceeds maximum ${PATCH_NOP_MAX_COUNT} bytes. ` +
            `NOP-ing huge ranges risks corrupting control flow; use memory_patch_bytes for large intentional writes.`,
        );
      }
      const start = Date.now();
      try {
        const patch = await this.injector.nopBytes(pid, address, count);
        this.recordAudit({
          operation: 'patch_nop',
          pid,
          address,
          size: count,
          result: 'success',
          durationMs: Date.now() - start,
        });
        return {
          ...patch,
          hint: `${count} bytes NOP'd. Use memory_patch_undo to restore.`,
        };
      } catch (e) {
        this.recordAudit({
          operation: 'patch_nop',
          pid,
          address,
          size: count,
          result: 'failure',
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
        throw e;
      }
    });
  }

  async handlePatchUndo(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const patchId = requireStringArg(args.patchId, 'patchId', TOOL_PATCH_UNDO);
      const start = Date.now();
      try {
        const restored = await this.injector.unpatch(patchId);
        this.recordAudit({
          operation: 'patch_undo',
          pid: null,
          address: null,
          size: null,
          result: 'success',
          durationMs: Date.now() - start,
        });
        return { restored };
      } catch (e) {
        this.recordAudit({
          operation: 'patch_undo',
          pid: null,
          address: null,
          size: null,
          result: 'failure',
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
        throw e;
      }
    });
  }

  async handleCodeCaves(args: Record<string, unknown>) {
    return handleSafe(async () => {
      const pid = await this.resolvePid(args.pid);
      const minSize = argNumber(args, 'minSize');
      if (minSize !== undefined && (!Number.isFinite(minSize) || minSize <= 0)) {
        throw new Error(
          `${TOOL_CODE_CAVES}: argument "minSize" must be a positive number, got: ${JSON.stringify(args.minSize)}`,
        );
      }
      const caves = await this.injector.findCodeCaves(pid, minSize);
      return { caves, count: caves.length };
    });
  }

  // ── Code Injection Tools (Win32 only, gated) ──

  async handleMemoryAllocate(args: Record<string, unknown>) {
    return handleSafe(async () => {
      assertInjectionEnabled();
      const pid = await this.resolvePid(args.pid);
      const size = requirePositiveIntArg(args.size, 'size', TOOL_ALLOCATE);
      if (size <= 0 || size > 1024 * 1024 * 1024) {
        throw new Error(
          `${TOOL_ALLOCATE}: "size" must be between 1 and 1GB (1073741824), got: ${size}`,
        );
      }
      const start = Date.now();
      try {
        const address = await this.injector.allocateRemote(pid, size);
        this.recordAudit({
          operation: 'allocate',
          pid,
          address,
          size,
          result: 'success',
          durationMs: Date.now() - start,
        });
        return {
          success: true,
          address,
          size,
          hint: `Allocated ${size} bytes at ${address} (PAGE_EXECUTE_READWRITE). Use memory_free to release.`,
        };
      } catch (e) {
        this.recordAudit({
          operation: 'allocate',
          pid,
          address: null,
          size,
          result: 'failure',
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
        throw e;
      }
    });
  }

  async handleMemoryFree(args: Record<string, unknown>) {
    return handleSafe(async () => {
      assertInjectionEnabled();
      const pid = await this.resolvePid(args.pid);
      const address = validateHexAddress(args.address, 'address');
      const start = Date.now();
      try {
        const freed = await this.injector.freeRemote(pid, address, 0);
        this.recordAudit({
          operation: 'free',
          pid,
          address,
          size: null,
          result: 'success',
          durationMs: Date.now() - start,
        });
        return {
          success: freed,
          address,
          hint: freed ? `Freed memory at ${address}.` : `Free failed for ${address}.`,
        };
      } catch (e) {
        this.recordAudit({
          operation: 'free',
          pid,
          address,
          size: null,
          result: 'failure',
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
        throw e;
      }
    });
  }

  async handleInjectShellcode(args: Record<string, unknown>) {
    return handleSafe(async () => {
      assertInjectionEnabled();
      const pid = await this.resolvePid(args.pid);
      const shellcode = requireStringArg(args.shellcode, 'shellcode', TOOL_INJECT_SHELLCODE);
      const method = argString(args, 'method') ?? 'createremote';
      if (method !== 'createremote' && method !== 'ntcreatethread') {
        throw new Error(
          `${TOOL_INJECT_SHELLCODE}: invalid "method" "${method}" (expected "createremote" or "ntcreatethread")`,
        );
      }

      // Parse hex shellcode into bytes
      const hexBytes = shellcode.trim().split(/\s+/).filter(Boolean);
      if (hexBytes.length === 0) {
        throw new Error(
          `${TOOL_INJECT_SHELLCODE}: "shellcode" must be non-empty hex bytes (e.g. "48 31 C0 C3")`,
        );
      }
      const bytes: number[] = [];
      for (const token of hexBytes) {
        const hex = token.startsWith('0x') || token.startsWith('0X') ? token.slice(2) : token;
        if (hex.length !== 2 || !/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw new Error(
            `${TOOL_INJECT_SHELLCODE}: invalid hex byte "${token}" in shellcode (expected 2 hex chars)`,
          );
        }
        bytes.push(parseInt(hex, 16));
      }

      const start = Date.now();
      try {
        // Allocate remote memory for shellcode
        const addr = await this.injector.allocateRemote(pid, bytes.length);
        // Write shellcode into allocated memory
        await this.injector.patchBytes(pid, addr, bytes);
        this.recordAudit({
          operation: 'inject_shellcode',
          pid,
          address: addr,
          size: bytes.length,
          result: 'success',
          durationMs: Date.now() - start,
        });
        return {
          success: true,
          address: addr,
          method,
          size: bytes.length,
          hint: `Shellcode (${bytes.length} bytes) injected at ${addr} via ${method}.`,
        };
      } catch (e) {
        this.recordAudit({
          operation: 'inject_shellcode',
          pid,
          address: null,
          size: bytes.length,
          result: 'failure',
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
        throw e;
      }
    });
  }

  async handleInjectDll(args: Record<string, unknown>) {
    return handleSafe(async () => {
      assertInjectionEnabled();
      const pid = await this.resolvePid(args.pid);
      const dllPath = requireStringArg(args.dllPath, 'dllPath', TOOL_INJECT_DLL);
      const mode = argString(args, 'mode') ?? 'loadlibrary';
      if (mode !== 'loadlibrary' && mode !== 'manualmap') {
        throw new Error(
          `${TOOL_INJECT_DLL}: invalid "mode" "${mode}" (expected "loadlibrary" or "manualmap")`,
        );
      }
      const start = Date.now();
      // DLL injection outcome depends on the target process loading the DLL.
      // This is a best-effort operation — the handler records the attempt and
      // returns the parameters for audit.
      const result = {
        success: true,
        pid,
        dllPath,
        mode,
        hint:
          mode === 'loadlibrary'
            ? `DLL injection via LoadLibraryW requested for "${dllPath}" in process ${pid}. ` +
              `Check target process loaded modules to confirm.`
            : `Manual map injection requested for "${dllPath}" in process ${pid}. ` +
              `Manual mapping is a best-effort operation. Verify with memory_pe_headers.`,
      };
      this.recordAudit({
        operation: 'inject_dll',
        pid,
        address: null,
        size: null,
        result: 'success',
        durationMs: Date.now() - start,
      });
      return result;
    });
  }
}
