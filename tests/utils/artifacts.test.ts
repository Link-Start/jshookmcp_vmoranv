import { resolve, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = `${resolve('virtual-project-root')}${sep}`;

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  open: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
  realpath: vi.fn(async (p: string) => p),
}));

vi.mock('@src/utils/outputPaths', () => ({
  getProjectRoot: vi.fn(() => ROOT),
}));

import { mkdir, open, realpath } from 'node:fs/promises';
import {
  generateShortId,
  getArtifactDir,
  getArtifactsRoot,
  resolveArtifactPath,
} from '@utils/artifacts';

function eexistError(): NodeJS.ErrnoException {
  return Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
}

describe('artifacts utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-04T05:06:07.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });

  it('resolves category path and creates directory', async () => {
    const result = await resolveArtifactPath({
      category: 'har',
      toolName: 'network export',
      target: 'user?id=1',
      ext: 'json',
    });

    expect(result.absolutePath).toContain(resolve(ROOT, 'artifacts', 'har'));
    expect(result.displayPath).toMatch(/^artifacts\/har\//);
    expect(result.displayPath).toContain('network_export-user_id_1');
    expect(mkdir).toHaveBeenCalledWith(resolve(ROOT, 'artifacts', 'har'), { recursive: true });
  });

  it('normalizes extensions with leading dot', async () => {
    const result = await resolveArtifactPath({
      category: 'reports',
      toolName: 'reporter',
      ext: '.md',
    });

    expect(result.absolutePath.endsWith('.md')).toBe(true);
    expect(result.absolutePath.includes('..md')).toBe(false);
  });

  it('uses custom directory when inside project root', async () => {
    const result = await resolveArtifactPath({
      category: 'tmp',
      toolName: 'worker',
      ext: 'txt',
      customDir: 'custom/out',
    });

    expect(result.absolutePath).toContain(resolve(ROOT, 'custom', 'out'));
    expect(result.displayPath.startsWith('custom/out/')).toBe(true);
    expect(mkdir).toHaveBeenCalledWith(resolve(ROOT, 'custom', 'out'), { recursive: true });
  });

  it('blocks path traversal for custom directory outside project', async () => {
    await expect(
      resolveArtifactPath({
        category: 'tmp',
        toolName: 'worker',
        ext: 'txt',
        customDir: '../escape',
      }),
    ).rejects.toThrow('Path traversal blocked');
  });

  it('trims and sanitizes long file name parts', async () => {
    const result = await resolveArtifactPath({
      category: 'dumps',
      toolName: '***very long tool name***'.repeat(8),
      target: '///target///',
      ext: 'bin',
    });

    const filename = result.displayPath.split('/').pop() ?? '';
    const baseWithoutExt = filename.replace(/\.bin$/, '');
    const [toolPart] = baseWithoutExt.split('-');
    expect(toolPart!.length).toBeLessThanOrEqual(60);
    expect(filename).not.toContain('*');
    expect(filename).toContain('target');
  });

  it('returns artifact root helpers', () => {
    expect(getArtifactsRoot()).toBe(resolve(ROOT, 'artifacts'));
    expect(getArtifactDir('wasm')).toBe(resolve(ROOT, 'artifacts', 'wasm'));
  });

  it('generates a unique filename per call even with fixed timestamp and Math.random', async () => {
    const first = await resolveArtifactPath({ category: 'tmp', toolName: 'x', ext: 'txt' });
    const second = await resolveArtifactPath({ category: 'tmp', toolName: 'x', ext: 'txt' });
    // Same fake timestamp + constant Math.random: only the random ID differs
    // (a4-03 — the old 6-char base36 ID collided here, returning identical paths).
    expect(second.absolutePath).not.toBe(first.absolutePath);
  });

  it('uses an 8-char hex ID derived from randomUUID, not a 6-char base36 ID', async () => {
    const result = await resolveArtifactPath({ category: 'tmp', toolName: 'x', ext: 'txt' });
    expect(result.displayPath).toMatch(/[0-9a-f]{8}\.txt$/);
  });

  it('generateShortId produces unique 8-char hex IDs', () => {
    expect(generateShortId()).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(Array.from({ length: 20 }, () => generateShortId())).size).toBe(20);
  });

  it('reserves the file exclusively and retries once on EEXIST', async () => {
    const mockedOpen = vi.mocked(open);
    mockedOpen.mockClear();
    mockedOpen.mockRejectedValueOnce(eexistError());

    const result = await resolveArtifactPath({ category: 'tmp', toolName: 'x', ext: 'txt' });
    expect(result.absolutePath).toBeDefined();
    // First attempt collided, second attempt reserved the regenerated name.
    expect(mockedOpen).toHaveBeenCalledTimes(2);
    for (const call of mockedOpen.mock.calls) {
      expect(call[1]).toBe('wx');
    }
    expect(mockedOpen.mock.calls[1]?.[0]).not.toBe(mockedOpen.mock.calls[0]?.[0]);
  });

  it('validates and mkdirs a directory only once (process-level cache)', async () => {
    const mockedMkdir = vi.mocked(mkdir);
    const mockedRealpath = vi.mocked(realpath);
    mockedMkdir.mockClear();
    mockedRealpath.mockClear();

    for (let i = 0; i < 3; i++) {
      await resolveArtifactPath({
        category: 'tmp',
        toolName: 'x',
        ext: 'txt',
        customDir: 'cached-dir',
      });
    }

    // First validation performs realpath(root) + realpath(dir); the other two
    // resolutions hit the process-level cache (a4-04) with no further syscalls.
    expect(mockedMkdir).toHaveBeenCalledTimes(1);
    expect(mockedRealpath).toHaveBeenCalledTimes(2);
  });
});
