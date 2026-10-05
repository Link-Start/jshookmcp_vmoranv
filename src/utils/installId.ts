/**
 * Persistent anonymous install identifier.
 *
 * One UUID per installation (`~/.jshookmcp/state/install-id`), created on
 * first read and stable across process restarts. Sent as the `install.id`
 * resource attribute by the OTLP exporter so distributed telemetry can
 * distinguish "one install used many times" from "many installs" (DAU /
 * retention style analysis) without collecting anything identifying — the
 * id is a random UUID with no link to the machine or user.
 *
 * Telemetry rules apply: this must never throw and never block — a read or
 * write failure degrades to an ephemeral in-memory id for this process.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readEnvNullableString } from '@src/config/environment';

const CACHE = new Map<string, string>();

function defaultStateDir(): string {
  const overridden = readEnvNullableString('JSHOOK_STATE_DIR', { trim: true });
  const base = overridden
    ? resolve(homedir(), overridden)
    : resolve(homedir(), '.jshookmcp', 'state');
  return base;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/**
 * Read (or create) the install id under `stateDir`. Falls back to an
 * ephemeral id cached per (dir, process) when the filesystem is not
 * cooperating — telemetry bookkeeping must never break the process.
 */
export async function getOrCreateInstallId(stateDir: string = defaultStateDir()): Promise<string> {
  const cached = CACHE.get(stateDir);
  if (cached !== undefined) return cached;

  const filePath = resolve(stateDir, 'install-id');
  try {
    const existing = (await readFile(filePath, 'utf-8')).trim();
    if (isUuidLike(existing)) {
      CACHE.set(stateDir, existing.toLowerCase());
      return CACHE.get(stateDir)!;
    }
  } catch {
    /* missing file: first run, create below */
  }

  const generated = randomUUID();
  try {
    await mkdir(stateDir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${generated}\n`, 'utf-8');
    await rename(tmpPath, filePath);
  } catch {
    /* unwritable state dir: use the ephemeral id for this process */
  }
  CACHE.set(stateDir, generated);
  return generated;
}

/** Test seam: drop the per-dir cache. */
export function resetInstallIdCache(): void {
  CACHE.clear();
}
