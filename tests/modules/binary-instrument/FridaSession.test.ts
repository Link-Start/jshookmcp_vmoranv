import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FridaSession } from '@modules/binary-instrument/FridaSession';
import { probeCommand } from '@modules/external/ToolProbe';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file, _args, _options, cb) => {
    cb(null, 'mocked_output', '');
  }),
}));

vi.mock('@modules/external/ToolProbe', () => ({
  probeCommand: vi.fn(),
}));

describe('FridaSession', () => {
  let session: FridaSession;

  beforeEach(() => {
    vi.clearAllMocks();
    session = new FridaSession();
    (probeCommand as any).mockResolvedValue({
      available: true,
      path: '/usr/bin/frida',
      version: '16.0.0',
    });
  });

  it('attaches and detaches', async () => {
    const id = await session.attach('1234');
    expect(id).toBeDefined();
    expect(session.listSessions()).toHaveLength(1);
    expect(session.hasSession(id)).toBe(true);

    await session.detach();
    expect(session.listSessions()[0]?.status).toBe('detached');
  });

  it('fails to attach if frida is not available', async () => {
    (probeCommand as any).mockResolvedValue({
      available: false,
      reason: 'Not installed',
    });

    await expect(session.attach('1234')).rejects.toThrow('Not installed');
  });

  it('spawns a target for early instrumentation', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);

    const id = await session.spawn('com.example.app');
    expect(id).toBeDefined();
    expect(session.listSessions()[0]).toMatchObject({
      id,
      target: 'com.example.app',
      mode: 'spawn',
      resumed: false,
    });
    expect(execFile.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(['-f', 'com.example.app']),
    );
  });

  it('resumes a spawned target and records resumed state', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, args: any[], _options: any, cb: any) => {
      const script = args.at(-1);
      cb(
        null,
        script.includes('Process.resume') ? '__frida_resume_ok__' : '__frida_spawn_ok__',
        '',
      );
    });

    const id = await session.spawn('com.example.app');
    const result = await session.resume(id);

    expect(result.output).toBe('__frida_resume_ok__');
    expect(execFile.mock.calls.at(-1)?.[1]?.at(-1)).toContain('Process.resume');
    expect(session.listSessions()[0]).toMatchObject({
      id,
      mode: 'spawn',
      resumed: true,
    });
  });

  it('executes script', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, _args: any, _options: any, cb: any) => {
      cb(null, 'script_output', '');
    });

    await session.attach('1234');
    const result = await session.executeScript('console.log("hello");');
    expect(result.output).toBe('script_output');
    expect(result.error).toBeUndefined();
  });

  it('handles execution error', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile
      .mockImplementationOnce((_file: any, _args: any, _options: any, cb: any) => {
        cb(null, '__frida_attach_ok__', '');
      })
      .mockImplementationOnce((_file: any, _args: any, _options: any, cb: any) => {
        cb(new Error('frida crash'));
      });

    await session.attach('1234');
    const result = await session.executeScript('bad_script()');
    expect(result.error).toBe('frida crash');
    expect(session.listSessions()[0]?.status).toBe('error');
  });

  it('enumerates modules', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, _args: any, _options: any, cb: any) => {
      cb(
        null,
        '[{"name": "libfoo.so", "base": "0x1000", "size": 4096, "path": "/lib/libfoo.so"}]',
        '',
      );
    });

    await session.attach('1234');
    const modules = await session.enumerateModules();
    expect(modules).toHaveLength(1);
    expect(modules[0]).toEqual({
      name: 'libfoo.so',
      base: '0x1000',
      size: 4096,
      path: '/lib/libfoo.so',
    });
  });

  it('enumerates functions', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, _args: any, _options: any, cb: any) => {
      cb(null, '[{"name": "malloc", "address": "0x2000", "size": 0}]', '');
    });

    await session.attach('1234');
    const funcs = await session.enumerateFunctions('libc.so');
    expect(funcs).toHaveLength(1);
    expect(funcs[0]).toEqual({
      name: 'malloc',
      address: '0x2000',
      size: 0,
    });
    expect(execFile.mock.calls.at(-1)?.[1]?.at(-1)).toContain(
      'Process.getModuleByName("libc.so").enumerateExports()',
    );
    expect(execFile.mock.calls.at(-1)?.[1]?.at(-1)).not.toContain('Module.enumerateExportsSync');
  });

  it('finds symbols', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, _args: any, _options: any, cb: any) => {
      cb(null, '[{"name": "free", "address": "0x3000", "demangled": "free"}]', '');
    });

    await session.attach('1234');
    const symbols = await session.findSymbols('free');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toEqual({
      name: 'free',
      address: '0x3000',
      demangled: 'free',
    });
    expect(execFile.mock.calls.at(-1)?.[1]?.at(-1)).toContain('exports:*!free*');
  });

  it('preserves explicit symbol queries', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, _args: any, _options: any, cb: any) => {
      cb(null, '[{"name": "CreateFileW", "address": "0x4000"}]', '');
    });

    await session.attach('1234');
    await session.findSymbols('exports:KERNEL32.DLL!CreateFileW');

    expect(execFile.mock.calls.at(-1)?.[1]?.at(-1)).toContain('exports:KERNEL32.DLL!CreateFileW');
  });

  it('switches sessions', async () => {
    const id1 = await session.attach('1111');
    await session.attach('2222'); // attaches and sets to active

    expect(session.useSession('invalid')).toBe(false);
    expect(session.useSession(id1)).toBe(true);

    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, _args: any, _options: any, cb: any) => {
      cb(null, 'ok', '');
    });

    await session.executeScript('test');
    expect(execFile.mock.calls[execFile.mock.calls.length - 1]?.[1]).toContain('1111');
  });

  it('returns no modules and marks the session as error when execution fails', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile.mockImplementation((_file: any, _args: any, _options: any, cb: any) => {
      cb(new Error('crash'));
    });

    await expect(session.attach('/bin/ls')).rejects.toThrow('crash');
  });

  it('returns no modules when enumeration fails after a successful attach probe', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile
      .mockImplementationOnce((_file: any, _args: any, _options: any, cb: any) => {
        cb(null, '__frida_attach_ok__', '');
      })
      .mockImplementationOnce((_file: any, _args: any, _options: any, cb: any) => {
        cb(new Error('crash'));
      });

    await session.attach('/bin/ls');
    const modules = await session.enumerateModules();
    expect(modules).toEqual([]);
    expect(session.listSessions()[0]?.status).toBe('error');
  });

  it('builds target args correctly', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);

    await session.attach('1234');
    await session.executeScript('test');
    expect(execFile.mock.calls[execFile.mock.calls.length - 1]?.[1]).toContain('-p');

    await session.attach('/bin/ls');
    await session.executeScript('test');
    expect(execFile.mock.calls[execFile.mock.calls.length - 1]?.[1]).toContain('-f');

    await session.attach('com.example.app');
    await session.executeScript('test');
    expect(execFile.mock.calls[execFile.mock.calls.length - 1]?.[1]).toContain('-n');
  });
});

describe('FridaSession task cancellation', () => {
  let session: FridaSession;

  beforeEach(() => {
    vi.clearAllMocks();
    session = new FridaSession();
    (probeCommand as any).mockResolvedValue({
      available: true,
      path: '/usr/bin/frida',
      version: '16.0.0',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('never spawns a child when the signal is already aborted', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    const controller = new AbortController();
    controller.abort();

    await session.attach('1234');
    const callsBefore = execFile.mock.calls.length;
    const result = await session.executeScript('test', { signal: controller.signal });

    expect(result.error).toContain('aborted before spawn');
    expect(execFile.mock.calls.length).toBe(callsBefore);
  });

  it('signals the whole process group and escalates to SIGKILL on cancel (POSIX)', async () => {
    if (process.platform === 'win32') return; // covered by the Windows test below
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.useFakeTimers();
    const controller = new AbortController();
    let storedCb: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    const childKill = vi.fn();
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile
      .mockImplementationOnce((_f: any, _a: any, _o: any, cb: any) => {
        // attach's own probe spawn — complete immediately
        cb(null, '__frida_attach_ok__', '');
      })
      .mockImplementationOnce((_f: any, _a: any, _o: any, cb: any) => {
        storedCb = cb;
        return { pid: 4242, kill: childKill };
      });

    await session.attach('1234');
    const pending = session.executeScript('long scan', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(storedCb).toBeTruthy();

    controller.abort();
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(1500);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

    storedCb!(new Error('terminated'), '', '');
    const result = await pending;
    expect(result.error).toContain('terminated');
  });

  it('kills immediately when the signal aborts during spawn (race window)', async () => {
    if (process.platform === 'win32') return;
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const controller = new AbortController();
    let storedCb: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    execFile
      .mockImplementationOnce((_f: any, _a: any, _o: any, cb: any) => {
        cb(null, '__frida_attach_ok__', '');
      })
      .mockImplementationOnce((_f: any, _a: any, _o: any, cb: any) => {
        storedCb = cb;
        controller.abort(); // lands between spawn and listener registration
        return { pid: 4242, kill: vi.fn() };
      });

    await session.attach('1234');
    const pending = session.executeScript('scan', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    storedCb!(new Error('terminated'), '', '');
    await pending;
  });

  it('uses taskkill tree kill on Windows', async () => {
    const execFile = await import('node:child_process').then((m) => m.execFile as any);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const controller = new AbortController();
      let storedCb: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      const childKill = vi.fn();
      execFile
        .mockImplementationOnce((_f: any, _a: any, _o: any, cb: any) => {
          cb(null, '__frida_attach_ok__', '');
        })
        .mockImplementationOnce((_f: any, _a: any, _o: any, cb: any) => {
          storedCb = cb;
          return { pid: 4242, kill: childKill };
        });

      await session.attach('1234');
      const pending = session.executeScript('scan', { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();

      const taskkillCall = execFile.mock.calls.find((c: any[]) => c[0] === 'taskkill');
      expect(taskkillCall).toBeTruthy();
      expect(taskkillCall![1]).toEqual(['/pid', '4242', '/T', '/F']);
      expect(childKill).not.toHaveBeenCalled();

      storedCb!(null, 'ok', '');
      await pending;
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
