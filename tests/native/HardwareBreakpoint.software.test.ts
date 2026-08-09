/**
 * HardwareBreakpointEngine — software breakpoint (INT3) and conditional breakpoint tests.
 *
 * Tests the engine logic in isolation (mock Win32 APIs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HardwareBreakpointEngine } from '@native/HardwareBreakpoint';
import * as Win32Debug from '@native/Win32Debug';
import * as Win32API from '@native/Win32API';

// Mock Win32Debug
vi.mock('@native/Win32Debug', () => ({
  OpenThread: vi.fn(() => 1n),
  SuspendThread: vi.fn(() => 0),
  ResumeThread: vi.fn(() => 1),
  GetThreadContext: vi.fn(() => Buffer.alloc(1232)),
  SetThreadContext: vi.fn(),
  DebugActiveProcess: vi.fn(),
  DebugActiveProcessStop: vi.fn(),
  DebugSetProcessKillOnExit: vi.fn(),
  WaitForDebugEvent: vi.fn(() => null),
  ContinueDebugEvent: vi.fn(),
  EnumerateProcessThreads: vi.fn(() => [1001, 1002]),
  openThreadForDebug: vi.fn(() => 1n),
  parseContext: vi.fn(() => ({
    contextFlags: 0,
    eflags: 0x202,
    dr0: 0n,
    dr1: 0n,
    dr2: 0n,
    dr3: 0n,
    dr6: 0n,
    dr7: 0n,
    rax: 0n,
    rcx: 0n,
    rdx: 0n,
    rbx: 0n,
    rsp: 0n,
    rbp: 0n,
    rsi: 0n,
    rdi: 0n,
    r8: 0n,
    r9: 0n,
    r10: 0n,
    r11: 0n,
    r12: 0n,
    r13: 0n,
    r14: 0n,
    r15: 0n,
    rip: 0n,
  })),
  writeContext: vi.fn(),
  encodeDR7: vi.fn(() => 0n),
  CONTEXT_FLAGS: { ALL: 0x0010001f },
  CONTEXT_SIZE: 1232,
  EXCEPTION_CODE: {
    SINGLE_STEP: 0x80000004,
    BREAKPOINT: 0x80000003,
    ACCESS_VIOLATION: 0xc0000005,
  },
  DBG: { CONTINUE: 0x00010002, EXCEPTION_NOT_HANDLED: 0x80010001 },
  DEBUG_EVENT_CODE: { EXCEPTION_DEBUG_EVENT: 1 },
}));

// Mock Win32API
vi.mock('@native/Win32API', () => ({
  CloseHandle: vi.fn(() => true),
  OpenProcess: vi.fn(() => 0x100n),
  ReadProcessMemory: vi.fn(() => Buffer.from([0x90])),
  WriteProcessMemory: vi.fn(() => 4),
  VirtualQueryEx: vi.fn(() => ({
    success: true,
    info: {
      Protect: 0x20,
      BaseAddress: 0x401000n,
      AllocationBase: 0x400000n,
      AllocationProtect: 0x20,
      RegionSize: 0x1000n,
      State: 0x1000,
      Type: 0x1000000,
    },
  })),
  VirtualProtectEx: vi.fn(() => ({ success: true, oldProtect: 0x20 })),
  PAGE: {
    NOACCESS: 0x01,
    READONLY: 0x02,
    READWRITE: 0x04,
    EXECUTE: 0x10,
    EXECUTE_READ: 0x20,
    EXECUTE_READWRITE: 0x40,
    EXECUTE_WRITECOPY: 0x80,
  },
  PROCESS_ACCESS: {
    VM_READ: 0x0010,
    VM_WRITE: 0x0020,
    VM_OPERATION: 0x0008,
    QUERY_INFORMATION: 0x0400,
  },
}));

vi.mock('@src/constants', () => ({
  BREAKPOINT_HIT_TIMEOUT_MS: 5000,
  BREAKPOINT_TRACE_MAX_HITS: 10,
}));

describe('HardwareBreakpointEngine — software breakpoints', () => {
  let engine: HardwareBreakpointEngine;

  beforeEach(() => {
    engine = new HardwareBreakpointEngine();
    vi.clearAllMocks();
  });

  describe('setBreakpoint with type=software', () => {
    it('should set a software breakpoint with execute access', async () => {
      const bp = await engine.setBreakpoint(1234, '0x401000', 'execute', 4, 'software');
      expect(bp.id).toBeDefined();
      expect(bp.address).toBe('0x401000');
      expect(bp.type).toBe('software');

      // Should have opened the process and written INT3
      expect(Win32API.OpenProcess).toHaveBeenCalled();
      expect(Win32API.VirtualQueryEx).toHaveBeenCalled();
      expect(Win32API.ReadProcessMemory).toHaveBeenCalled();
      expect(Win32API.WriteProcessMemory).toHaveBeenCalled();
    });

    it('should be listed with type=software', async () => {
      await engine.setBreakpoint(1234, '0x401000', 'execute', 4, 'software');
      const list = engine.listBreakpoints();
      expect(list.length).toBe(1);
      expect(list[0]?.type).toBe('software');
    });

    it('should not consume a DR register', async () => {
      // Fill all 4 hardware breakpoints
      for (let i = 0; i < 4; i++) {
        await engine.setBreakpoint(1234, `0x${(i * 0x1000).toString(16)}`, 'write', 4);
      }
      // Software breakpoint should still work
      const bp = await engine.setBreakpoint(1234, '0x401000', 'execute', 4, 'software');
      expect(bp.id).toBeDefined();
      expect(engine.listBreakpoints().length).toBe(5);
    });

    it('should reject non-executable addresses', async () => {
      // Override VirtualQueryEx for this test to return non-executable memory
      vi.mocked(Win32API.VirtualQueryEx).mockReturnValueOnce({
        success: true,
        info: {
          BaseAddress: 0x500000n,
          AllocationBase: 0x500000n,
          AllocationProtect: 0x04,
          RegionSize: 0x1000n,
          State: 0x1000,
          Protect: 0x04, // PAGE_READWRITE — not executable
          Type: 0x20000,
        } as Win32API.MemoryBasicInfo,
      });

      await expect(
        engine.setBreakpoint(1234, '0x500000', 'execute', 4, 'software'),
      ).rejects.toThrow('not in executable memory');
    });

    it('should allow removal of software breakpoint', async () => {
      const bp = await engine.setBreakpoint(1234, '0x401000', 'execute', 4, 'software');
      const removed = await engine.removeBreakpoint(bp.id);
      expect(removed).toBe(true);
      expect(engine.listBreakpoints().length).toBe(0);
    });
  });

  describe('waitForHit with INT3 events', () => {
    it('should detect INT3 hit and return breakpoint info', async () => {
      // Use flag-based mock: returns null during attach() (which drains debug
      // events), then fires BREAKPOINT + SINGLE_STEP during waitForHit.
      let eventsEnabled = false;
      let eventCount = 0;
      vi.mocked(Win32Debug.WaitForDebugEvent).mockReset();
      vi.mocked(Win32Debug.WaitForDebugEvent).mockImplementation(() => {
        if (!eventsEnabled) {
          // During attach: return null to break immediately
          return null;
        }
        eventCount++;
        if (eventCount === 1) {
          return {
            processId: 1234,
            threadId: 1001,
            debugEventCode: 1,
            exceptionCode: Win32Debug.EXCEPTION_CODE.BREAKPOINT,
            exceptionAddress: 0x401000n,
          } as any;
        }
        if (eventCount === 2) {
          return {
            processId: 1234,
            threadId: 1001,
            debugEventCode: 1,
            exceptionCode: Win32Debug.EXCEPTION_CODE.SINGLE_STEP,
            exceptionAddress: 0x401000n,
          } as any;
        }
        return null;
      });

      const bp = await engine.setBreakpoint(1234, '0x401000', 'execute', 4, 'software');
      // Enable events AFTER setBreakpoint (and its internal attach) completes
      eventsEnabled = true;

      const hit = await engine.waitForHit(1000);
      expect(hit).not.toBeNull();
      expect(hit?.breakpointId).toBe(bp.id);
      expect(hit?.instructionAddress).toBe('0x401000');

      // Should have incremented hit count
      const list = engine.listBreakpoints();
      expect(list[0]?.hitCount).toBe(1);
    });

    it('should pass through unrecognized INT3 addresses', async () => {
      let eventsEnabled = false;
      vi.mocked(Win32Debug.WaitForDebugEvent).mockReset();
      vi.mocked(Win32Debug.WaitForDebugEvent).mockImplementation(() => {
        if (!eventsEnabled) return null;
        return {
          processId: 1234,
          threadId: 1001,
          debugEventCode: 1,
          exceptionCode: Win32Debug.EXCEPTION_CODE.BREAKPOINT,
          exceptionAddress: 0x999999n, // Not a registered breakpoint
        } as any;
      });

      await engine.setBreakpoint(1234, '0x401000', 'execute', 4, 'software');
      eventsEnabled = true;

      const hit = await engine.waitForHit(100);
      expect(hit).toBeNull();
      expect(Win32Debug.ContinueDebugEvent).toHaveBeenCalledWith(
        1234,
        1001,
        Win32Debug.DBG.EXCEPTION_NOT_HANDLED,
      );
    });
  });

  describe('hardware breakpoints still work', () => {
    it('should set hardware breakpoint by default', async () => {
      const bp = await engine.setBreakpoint(1234, '0x7FFE0000', 'write', 4);
      expect(bp.type).toBe('hardware');
    });

    it('should list hardware breakpoints with type field', async () => {
      await engine.setBreakpoint(1234, '0x1000', 'write', 4);
      const list = engine.listBreakpoints();
      expect(list[0]?.type).toBe('hardware');
    });
  });
});

describe('HardwareBreakpointEngine — conditional breakpoints', () => {
  let engine: HardwareBreakpointEngine;

  beforeEach(() => {
    engine = new HardwareBreakpointEngine();
    vi.clearAllMocks();
  });

  describe('setBreakpoint with condition', () => {
    it('should accept a condition expression', async () => {
      const bp = await engine.setBreakpoint(
        1234,
        '0x7FFE0000',
        'write',
        4,
        'hardware',
        'rax > 0x1000',
      );
      expect(bp.condition).toBe('rax > 0x1000');
    });

    it('should validate condition expression', async () => {
      await expect(
        engine.setBreakpoint(1234, '0x7FFE0000', 'write', 4, 'hardware', '=invalid='),
      ).rejects.toThrow('Invalid breakpoint condition');
    });

    it('should accept undefined condition', async () => {
      const bp = await engine.setBreakpoint(1234, '0x7FFE0000', 'write', 4);
      expect(bp.condition).toBeUndefined();
    });
  });

  describe('hardware BP condition evaluation on hit', () => {
    it('should return hit when condition is met', async () => {
      // Set up parseContext BEFORE setBreakpoint so it's ready
      vi.mocked(Win32Debug.parseContext).mockReturnValue({
        contextFlags: 0,
        eflags: 0x202,
        dr0: 0n,
        dr1: 0n,
        dr2: 0n,
        dr3: 0n,
        dr6: 1n, // DR0 hit
        dr7: 0n,
        rax: 1n,
        rcx: 0n,
        rdx: 0n,
        rbx: 0n,
        rsp: 0n,
        rbp: 0n,
        rsi: 0n,
        rdi: 0n,
        r8: 0n,
        r9: 0n,
        r10: 0n,
        r11: 0n,
        r12: 0n,
        r13: 0n,
        r14: 0n,
        r15: 0n,
        rip: 0x401000n,
      } as any);

      let eventsEnabled = false;
      vi.mocked(Win32Debug.WaitForDebugEvent).mockReset();
      vi.mocked(Win32Debug.WaitForDebugEvent).mockImplementation(() => {
        if (!eventsEnabled) return null;
        return {
          processId: 1234,
          threadId: 1001,
          exceptionCode: Win32Debug.EXCEPTION_CODE.SINGLE_STEP,
          exceptionAddress: 0x401000n,
        } as any;
      });

      const bp = await engine.setBreakpoint(
        1234,
        '0x7FFE0000',
        'write',
        4,
        'hardware',
        'rax == 0x1',
      );
      eventsEnabled = true;

      const hit = await engine.waitForHit(2000);
      expect(hit?.breakpointId).toBe(bp.id);
    });

    it('should suppress hit when condition is not met', async () => {
      // rax=1n but condition expects rax==0x9999 → suppressed
      vi.mocked(Win32Debug.parseContext).mockReturnValue({
        contextFlags: 0,
        eflags: 0x202,
        dr0: 0n,
        dr1: 0n,
        dr2: 0n,
        dr3: 0n,
        dr6: 1n,
        dr7: 0n,
        rax: 1n,
        rcx: 0n,
        rdx: 0n,
        rbx: 0n,
        rsp: 0n,
        rbp: 0n,
        rsi: 0n,
        rdi: 0n,
        r8: 0n,
        r9: 0n,
        r10: 0n,
        r11: 0n,
        r12: 0n,
        r13: 0n,
        r14: 0n,
        r15: 0n,
        rip: 0x401000n,
      } as any);

      let eventsEnabled = false;
      vi.mocked(Win32Debug.WaitForDebugEvent).mockReset();
      vi.mocked(Win32Debug.WaitForDebugEvent).mockImplementation(() => {
        if (!eventsEnabled) return null;
        return {
          processId: 1234,
          threadId: 1001,
          exceptionCode: Win32Debug.EXCEPTION_CODE.SINGLE_STEP,
          exceptionAddress: 0x401000n,
        } as any;
      });

      await engine.setBreakpoint(1234, '0x7FFE0000', 'write', 4, 'hardware', 'rax == 0x9999');
      eventsEnabled = true;

      const hit = await engine.waitForHit(2000);
      // Condition not met — hit suppressed
      expect(hit).toBeNull();
    });
  });

  describe('condition is listed and removed', () => {
    it('should show condition in listBreakpoints', async () => {
      await engine.setBreakpoint(1234, '0x1000', 'write', 4, 'hardware', 'rcx > 5');
      const list = engine.listBreakpoints();
      expect(list[0]?.condition).toBe('rcx > 5');
    });
  });
});
