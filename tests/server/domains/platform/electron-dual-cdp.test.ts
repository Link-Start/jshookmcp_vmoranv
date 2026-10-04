import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());
const mockParseStringArg = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('@server/domains/platform/handlers/platform-utils', () => ({
  toTextResponse: (payload: Record<string, unknown>) => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }),
  toErrorResponse: (tool: string, error: unknown) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          tool,
          error: error instanceof Error ? error.message : String(error),
        }),
      },
    ],
  }),
  parseStringArg: mockParseStringArg,
  pathExists: mockPathExists,
}));

vi.stubGlobal('fetch', mockFetch);

type JsonPayload = Record<string, unknown>;

function parse(result: { content: Array<{ text?: string; type?: string }> }): JsonPayload {
  return JSON.parse(result.content[0]!.text!) as JsonPayload;
}

function makeFuseBuffer(
  overrides: Partial<{ runAsNode: boolean; inspectArgs: boolean; nodeOptions: boolean }> = {},
) {
  // Real @electron/fuses v2 wire: 32-byte ASCII sentinel + version(1) + length(1)
  // + one state byte per fuse in FuseV1Options order
  // (RunAsNode, EnableCookieEncryption, EnableNodeOptionsEnvironmentVariable,
  // EnableNodeCliInspectArguments, ...).
  const sentinel = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
  const buffer = Buffer.alloc(64);
  buffer.write(sentinel, 0, 'ascii');
  const base = sentinel.length;
  buffer[base] = 1; // fuse wire version (FuseVersion.V1)
  buffer[base + 1] = 9; // wire length (9 fuse values)
  const wire: number[] = [0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31];
  if (overrides.runAsNode === false) wire[0] = 0x30;
  if (overrides.nodeOptions === false) wire[2] = 0x30;
  if (overrides.inspectArgs === false) wire[3] = 0x30;
  wire.forEach((value, i) => {
    buffer[base + 2 + i] = value;
  });
  return buffer;
}

async function loadModule() {
  vi.resetModules();
  return await import('@server/domains/platform/handlers/electron-dual-cdp');
}

describe('electron_launch_debug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathExists.mockResolvedValue(false);
    mockParseStringArg.mockImplementation((args: Record<string, unknown>, key: string) => {
      const value = args[key];
      return typeof value === 'string' ? value : undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should error on non-existent exePath', async () => {
    const { handleElectronLaunchDebug } = await loadModule();

    const result = parse(
      await handleElectronLaunchDebug({
        exePath: 'C:\\nonexistent\\path\\app.exe',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('should require exePath', async () => {
    const { handleElectronLaunchDebug } = await loadModule();
    const result = parse(await handleElectronLaunchDebug({}));
    expect(result.success).toBe(false);
  });

  it('should launch with fuse warnings and register a status session', async () => {
    const { handleElectronLaunchDebug, handleElectronDebugStatus } = await loadModule();

    mockPathExists.mockResolvedValueOnce(true);
    mockReadFile.mockResolvedValueOnce(
      makeFuseBuffer({ runAsNode: false, inspectArgs: false, nodeOptions: false }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => 'ready',
    });
    mockSpawn.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const launch = parse(
      await handleElectronLaunchDebug({
        exePath: 'C:\\Electron\\electron.exe',
        mainPort: 9333,
        rendererPort: 9334,
        args: ['--foo'],
        waitMs: 0,
      }),
    );

    expect(launch.success).toBe(true);
    expect(launch.sessionId).toBe('electron-4242');
    expect(launch.fuseWarnings).toHaveLength(3);
    expect(mockSpawn).toHaveBeenCalledWith(
      'C:\\Electron\\electron.exe',
      ['--inspect=9333', '--remote-debugging-port=9334', '--foo'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );

    const status = parse(await handleElectronDebugStatus({ sessionId: 'electron-4242' }));
    expect(status.success).toBe(true);
    // @ts-expect-error
    expect(status.main.alive).toBe(true);
    // @ts-expect-error
    expect(status.renderer.alive).toBe(true);
  });

  it('should report no fuse warnings when all debug fuses are enabled (real fuse wire format)', async () => {
    const { handleElectronLaunchDebug } = await loadModule();

    // Real wire: sentinel + version byte + length byte + fixed-order fuse bytes.
    // The old layout read the version byte (0x01) as RunAsNode and the
    // EnableCookieEncryption byte as InspectArgs, misreporting enabled fuses.
    mockPathExists.mockResolvedValueOnce(true);
    mockReadFile.mockResolvedValueOnce(makeFuseBuffer());
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'ready' });
    mockSpawn.mockReturnValue({ pid: 7777, unref: vi.fn() });

    const launch = parse(
      await handleElectronLaunchDebug({
        exePath: 'C:\\Electron\\electron.exe',
        mainPort: 9333,
        rendererPort: 9334,
        waitMs: 0,
      }),
    );

    expect(launch.success).toBe(true);
    // Empty warning list is serialized as undefined (omitted field).
    expect(launch.fuseWarnings).toBeUndefined();
  });

  it('should accept renamed exe when Electron companion files exist', async () => {
    const { handleElectronLaunchDebug } = await loadModule();

    // First call: pathExists(exePath) → true
    // Subsequent calls: structural checks — resources/app.asar exists
    mockPathExists
      .mockResolvedValueOnce(true) // exePath exists
      .mockResolvedValueOnce(true) // resources/app.asar
      .mockResolvedValueOnce(false) // resources/app
      .mockResolvedValueOnce(false) // ffmpeg.dll
      .mockResolvedValueOnce(false) // libEGL.dll
      .mockResolvedValueOnce(false) // libGLESv2.dll
      .mockResolvedValueOnce(false) // vk_swiftshader.dll
      .mockResolvedValueOnce(false); // Frameworks/...
    mockReadFile.mockResolvedValueOnce(makeFuseBuffer());
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'ready' });
    mockSpawn.mockReturnValue({ pid: 5555, unref: vi.fn() });

    const result = parse(
      await handleElectronLaunchDebug({
        exePath: 'C:\\EchoPet\\EchoPet.exe',
        waitMs: 0,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('electron-5555');
  });

  it('should reject renamed exe without Electron companion files', async () => {
    const { handleElectronLaunchDebug } = await loadModule();

    // First call: pathExists(exePath) → true
    // All structural checks fail
    mockPathExists.mockResolvedValueOnce(true);
    // Remaining calls all return false
    mockPathExists.mockResolvedValue(false);

    const result = parse(
      await handleElectronLaunchDebug({
        exePath: 'C:\\Random\\random.exe',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not appear to be an Electron binary');
    expect(result.error).toContain('skipBinaryCheck:true');
  });

  it('should accept any exe when skipBinaryCheck is true', async () => {
    const { handleElectronLaunchDebug } = await loadModule();

    // pathExists(exePath) → true, all structural checks return false
    mockPathExists.mockResolvedValueOnce(true);
    mockPathExists.mockResolvedValue(false);
    mockReadFile.mockResolvedValueOnce(makeFuseBuffer());
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'ready' });
    mockSpawn.mockReturnValue({ pid: 6666, unref: vi.fn() });

    const result = parse(
      await handleElectronLaunchDebug({
        exePath: 'C:\\Suspicious\\malware.exe',
        skipBinaryCheck: true,
        waitMs: 0,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('electron-6666');
  });
});

describe('electron_debug_status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathExists.mockResolvedValue(false);
    mockParseStringArg.mockImplementation((args: Record<string, unknown>, key: string) => {
      const value = args[key];
      return typeof value === 'string' ? value : undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return empty sessions list when no sessions launched', async () => {
    const { handleElectronDebugStatus } = await loadModule();
    const result = parse(await handleElectronDebugStatus({}));

    expect(result.success).toBe(true);
    expect(Array.isArray(result.sessions)).toBe(true);
    expect((result.sessions as unknown[]).length).toBe(0);
  });

  it('should return error for non-existent session ID', async () => {
    const { handleElectronDebugStatus } = await loadModule();
    const result = parse(
      await handleElectronDebugStatus({
        sessionId: 'electron-nonexistent',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No session found');
  });
});
