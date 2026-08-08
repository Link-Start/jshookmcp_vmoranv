/**
 * Unified artifact output management.
 * Ensures all tool outputs go to well-structured directories with consistent naming.
 */

import { mkdir, realpath } from 'node:fs/promises';
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

  // Realpath-aware containment: a symlink / Windows junction inside the root
  // that points outside it passes the string check while mkdir/writes would
  // land outside the root. Resolve the deepest existing ancestor of the
  // directory and require it to stay inside the root's real path.
  const realRoot = await realpathIfExists(normalizedRoot);
  if (realRoot) {
    const realDir = await resolveExistingAncestorRealPath(normalizedDir);
    if (!isPathWithinRoot(realRoot, realDir)) {
      throw new Error(
        `Path traversal blocked: artifact directory "${customDir}" escapes project root`,
      );
    }
  }

  await mkdir(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const shortId = Math.random().toString(36).substring(2, 8);
  const safeName = sanitizeFilename(toolName);
  const safeTarget = target ? `-${sanitizeFilename(target)}` : '';
  const safeExt = ext.replace(/^\./, '');

  const filename = `${safeName}${safeTarget}-${ts}-${shortId}.${safeExt}`;
  const absolutePath = resolve(dir, filename);
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
