/**
 * Unified artifact output management.
 * Ensures all tool outputs go to well-structured directories with consistent naming.
 */

import { mkdir, open, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, relative, normalize } from 'node:path';
import { getProjectRoot } from '@utils/outputPaths';
import { isPathWithinRoot } from '@utils/safeOutput';

export type ArtifactCategory =
  | 'wasm'
  | 'traces'
  | 'profiles'
  | 'dumps'
  | 'reports'
  | 'har'
  | 'captures'
  | 'sessions'
  | 'offloaded'
  | 'tmp'
  | 'heap-snapshots';

const ARTIFACT_BASE = 'artifacts';

/**
 * Unique short file ID: the first 8 hex chars of a random v4 UUID (32 random
 * bits ≈ 4.3B values). Replaces the 6-char Math.random base-36 ID whose
 * birthday bound collided at ~46k files within one second, silently
 * overwriting another session's artifact (a4-03 / a2-08).
 */
export function generateShortId(): string {
  return randomUUID().slice(0, 8);
}

// Per-process cache of validated artifact directories. customDir (or the
// category default) is fixed per caller, so after the first validation —
// realpath containment check + mkdir — later resolutions reuse the cached
// result and skip two realpath syscalls and one mkdir per request (a4-04).
// Rejected directories are evicted so a later fix-up can be retried; a
// symlink/junction planted inside the root AFTER first validation is not
// re-checked for the process lifetime (accepted trade-off of the cache).
const validatedDirs = new Map<string, Promise<string>>();

/**
 * Validate `dir` once per process (realpath containment + mkdir) and cache
 * the result. Kept separate from resolveArtifactPath's string-level guards:
 * those run per call, so traversal via ".." is still rejected upfront.
 */
async function prepareArtifactDir(dir: string, normalizedRoot: string): Promise<string> {
  const normalizedDir = normalize(dir);
  const cached = validatedDirs.get(normalizedDir);
  if (cached) {
    return cached;
  }
  const pending = validateArtifactDir(dir, normalizedRoot, normalizedDir).catch((error) => {
    validatedDirs.delete(normalizedDir);
    throw error;
  });
  validatedDirs.set(normalizedDir, pending);
  return pending;
}

async function validateArtifactDir(
  dir: string,
  normalizedRoot: string,
  normalizedDir: string,
): Promise<string> {
  // Realpath-aware containment: a symlink / Windows junction inside the root
  // that points outside it passes the string check while mkdir/writes would
  // land outside the root. Resolve the deepest existing ancestor of the
  // directory and require it to stay inside the root's real path.
  const realRoot = await realpathIfExists(normalizedRoot);
  if (realRoot) {
    const realDir = await resolveExistingAncestorRealPath(normalizedDir);
    if (!isPathWithinRoot(realRoot, realDir)) {
      throw new Error(`Path traversal blocked: artifact directory "${dir}" escapes project root`);
    }
  }

  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Reserve a fresh artifact filename with O_EXCL semantics ('wx'). A colliding
 * name fails with EEXIST instead of silently overwriting another session's
 * file; regenerate the ID once and retry. Any other error propagates.
 */
async function reserveArtifactFile(
  dir: string,
  buildFilename: (shortId: string) => string,
): Promise<{ filename: string; absolutePath: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const filename = buildFilename(generateShortId());
    const absolutePath = resolve(dir, filename);
    try {
      const handle = await open(absolutePath, 'wx');
      await handle.close();
      return { filename, absolutePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt === 0) {
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the second attempt either returns or throws.
  throw new Error(`[artifacts] could not reserve a unique file in ${dir}`);
}

/**
 * Generate a timestamped artifact path.
 *
 * @param category - Artifact subdirectory (wasm, traces, etc.)
 * @param toolName - Tool that produces this artifact
 * @param target - Target identifier (e.g., module name, URL hash)
 * @param ext - File extension (without dot)
 * @returns { absolutePath, displayPath }
 */
export async function resolveArtifactPath(options: {
  category: ArtifactCategory;
  toolName: string;
  target?: string;
  ext: string;
  customDir?: string;
}): Promise<{ absolutePath: string; displayPath: string }> {
  const { category, toolName, target, ext, customDir } = options;
  const root = getProjectRoot();

  // Raw-segment guard first: reject parent-directory segments outright so
  // lexical normalization quirks ("a/../../b") cannot confuse the
  // containment check. Nothing may be created before this passes.
  if (customDir) {
    const segments = customDir.split(/[\\/]+/).filter((segment) => segment.length > 0);
    if (segments.includes('..')) {
      throw new Error(
        'Path traversal blocked: artifact directory must not contain parent-directory segments',
      );
    }
  }

  const dir = customDir ? resolve(root, customDir) : resolve(root, ARTIFACT_BASE, category);

  // String-level containment (shared with safeOutput): the resolved
  // directory must stay inside the project root.
  const normalizedRoot = normalize(root);
  const normalizedDir = normalize(dir);
  if (!isPathWithinRoot(normalizedRoot, normalizedDir)) {
    throw new Error(
      `Path traversal blocked: artifact directory "${customDir}" escapes project root`,
    );
  }

  await prepareArtifactDir(dir, normalizedRoot);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const safeName = sanitizeFilename(toolName);
  const safeTarget = target ? `-${sanitizeFilename(target)}` : '';
  const safeExt = ext.replace(/^\./, '');

  const { absolutePath } = await reserveArtifactFile(
    dir,
    (shortId) => `${safeName}${safeTarget}-${ts}-${shortId}.${safeExt}`,
  );
  const displayPath = relative(root, absolutePath).replace(/\\/g, '/');

  return { absolutePath, displayPath };
}

/**
 * Get the artifacts root directory.
 */
export function getArtifactsRoot(): string {
  return resolve(getProjectRoot(), ARTIFACT_BASE);
}

/**
 * Get a specific artifact category directory.
 */
export function getArtifactDir(category: ArtifactCategory): string {
  return resolve(getProjectRoot(), ARTIFACT_BASE, category);
}

async function realpathIfExists(inputPath: string): Promise<string | null> {
  try {
    return await realpath(inputPath);
  } catch {
    // Missing path, or fs/promises is mocked without realpath — the
    // string-level containment check already covers non-existing paths.
    return null;
  }
}

async function resolveExistingAncestorRealPath(inputPath: string): Promise<string> {
  let currentPath = inputPath;
  while (true) {
    const existingPath = await realpathIfExists(currentPath);
    if (existingPath) {
      return existingPath;
    }
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return inputPath;
    }
    currentPath = parentPath;
  }
}

/**
 * Sanitize a string for use as a filename component.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 60);
}
