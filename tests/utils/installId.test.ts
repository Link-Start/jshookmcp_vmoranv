/**
 * Install-id tests (src/utils/installId.ts).
 *
 * One persistent anonymous UUID per installation; telemetry rules apply —
 * filesystem failures degrade to an ephemeral id and never throw.
 */
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getOrCreateInstallId, resetInstallIdCache } from '@utils/installId';

const cleanup: string[] = [];

afterEach(async () => {
  resetInstallIdCache();
  await Promise.allSettled(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  // Some chmod-based tests need the dir gone before the next case reuses it.
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jshook-install-id-'));
  cleanup.push(dir);
  return dir;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('getOrCreateInstallId', () => {
  it('creates a UUID file on first read and returns it', async () => {
    const dir = await makeTmpDir();
    const id = await getOrCreateInstallId(dir);
    expect(id).toMatch(UUID_RE);
    const stored = (await readFile(join(dir, 'install-id'), 'utf-8')).trim();
    expect(stored).toBe(id);
  });

  it('returns the SAME id across cache resets (persisted on disk)', async () => {
    const dir = await makeTmpDir();
    const first = await getOrCreateInstallId(dir);
    resetInstallIdCache();
    const second = await getOrCreateInstallId(dir);
    expect(second).toBe(first);
  });

  it('caches per process without touching the filesystem again', async () => {
    const dir = await makeTmpDir();
    const first = await getOrCreateInstallId(dir);
    // Corrupt the file AFTER the id is cached — the cache must win.
    await writeFile(join(dir, 'install-id'), 'garbage', 'utf-8');
    expect(await getOrCreateInstallId(dir)).toBe(first);
  });

  it('regenerates when the stored value is not a UUID', async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, 'install-id'), 'not-a-uuid', 'utf-8');
    const id = await getOrCreateInstallId(dir);
    expect(id).toMatch(UUID_RE);
    expect(id).not.toBe('not-a-uuid');
  });

  it('degrades to an ephemeral id when the state dir is unwritable', async () => {
    const dir = await makeTmpDir();
    await chmod(dir, 0o500); // remove write permission
    try {
      const id = await getOrCreateInstallId(dir);
      expect(id).toMatch(UUID_RE);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('different dirs carry different ids', async () => {
    const a = await getOrCreateInstallId(await makeTmpDir());
    const b = await getOrCreateInstallId(await makeTmpDir());
    expect(a).not.toBe(b);
  });
});
