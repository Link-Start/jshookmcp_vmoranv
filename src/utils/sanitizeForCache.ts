/**
 * sanitizeForCache — recursively replaces oversized string fields with compact
 * disk-backed placeholders BEFORE data enters the cache / a tool response.
 *
 * Motivation (issue #62): a captured network request whose `url` is an inline
 * `data:image/png;base64,...` blob can be several megabytes. Stored verbatim in
 * DetailedDataManager, any later `get_detailed_data` retrieval re-emits the full
 * base64 and overflows the LLM context window. This sanitizer intercepts such
 * fields, writes the raw bytes to `artifacts/offloaded/`, and leaves behind a
 * placeholder the LLM can still reason about:
 *
 *   { _offload: { type: 'file', path, size, mimeType?, sample } }
 *
 * Properties:
 *   - cycle-safe (WeakSet guards against circular references)
 *   - idempotent (an existing `{ _offload }` placeholder is returned untouched)
 *   - cheap for primitives / small strings (returned as-is, no allocation)
 *   - synchronous disk write (mkdirSync + writeFileSync) so callers like
 *     DetailedDataManager.store() keep their synchronous signature — matching the
 *     existing sync-write precedent in McpLogTransport / PersistentCache.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { generateShortId, getArtifactDir, getArtifactsRoot } from '@utils/artifacts';
import { getProjectRoot } from '@utils/outputPaths';
import { OFFLOAD_FIELD_SANITIZE_THRESHOLD_BYTES } from '@src/constants';
import { logger } from '@utils/logger';

/** Matches a base64 data URI prefix, capturing the MIME type. Shared across the offload pipeline. */
export const DATA_URI_RE = /^data:([a-zA-Z0-9/+.-]+);base64,/;

/** Length (chars) of the human-readable sample retained in the placeholder. */
const SAMPLE_LENGTH = 128;

/**
 * Object keys that must never be copied when sanitizing captured data. Hostile
 * page content can carry `__proto__` / `constructor` / `prototype` as own keys
 * (via JSON.parse); assigning them onto a plain result object would pollute
 * its prototype chain. Such keys are dropped — they are never legitimate
 * payload fields for caching.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface OffloadFilePlaceholder {
  _offload: {
    type: 'file';
    /** Project-relative path to the offloaded file (forward slashes). */
    path: string;
    /** Human-readable size of the offloaded payload. */
    size: string;
    /** MIME type, present only when the source was a data: URI. */
    mimeType?: string;
    /** Leading slice of the original string, so the LLM knows what was removed. */
    sample: string;
  };
}

export interface SanitizeOptions {
  /** Strings longer than this (chars) are offloaded. Default: constant (64KB). */
  threshold?: number;
  /** Override the directory for offloaded files (absolute). Default: artifacts/offloaded. */
  outputDir?: string;
  /**
   * When false, oversized values are replaced with a placeholder WITHOUT writing
   * a file (no `path`). Used by defensive call sites that only need to shrink the
   * payload, not preserve it. Default: true.
   */
  writeFile?: boolean;
}

/** Format a byte count as a human-readable B/KB/MB string. Shared across the offload pipeline. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isOffloadPlaceholder(value: object): boolean {
  // Own-property check only: a polluted prototype chain must not be able to
  // make arbitrary objects look like placeholders (which would bypass the
  // idempotency guard and pass attacker data through untouched).
  return Object.prototype.hasOwnProperty.call(value, '_offload');
}

/** Write raw string bytes to artifacts/offloaded and return the project-relative path. */
function writeOffloadFile(raw: string, mimeType: string | undefined, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const ext = mimeType ? 'bin' : 'txt';
  // For a data: URI we persist the decoded bytes; otherwise the raw string.
  const dataUriMatch = mimeType ? raw.match(DATA_URI_RE) : null;
  const payload: string | Buffer = dataUriMatch
    ? Buffer.from(raw.slice(dataUriMatch[0].length), 'base64')
    : raw;

  // Exclusive create ('wx', same semantics as open with O_EXCL): a colliding
  // name fails with EEXIST instead of silently overwriting another session's
  // file (a2-08). Regenerate the UUID-derived ID once and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    const absolutePath = resolve(outputDir, `offload-${ts}-${generateShortId()}.${ext}`);
    try {
      writeFileSync(absolutePath, payload, { encoding: 'utf8', flag: 'wx' });
      return relative(getProjectRoot(), absolutePath).replace(/\\/g, '/');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt === 0) {
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the second attempt either returns or throws.
  throw new Error(`[sanitizeForCache] could not reserve a unique offload file in ${outputDir}`);
}

/** Build the compact placeholder for an oversized string, optionally writing the original to disk. */
function offloadString(value: string, opts: Required<SanitizeOptions>): OffloadFilePlaceholder {
  const mimeType = value.match(DATA_URI_RE)?.[1];
  const sample = value.slice(0, SAMPLE_LENGTH);

  let path = '';
  if (opts.writeFile) {
    try {
      path = writeOffloadFile(value, mimeType, opts.outputDir);
    } catch (error) {
      logger.warn(`[sanitizeForCache] Failed to offload field to disk: ${String(error)}`);
    }
  }

  return {
    _offload: {
      type: 'file',
      path,
      size: formatSize(Buffer.byteLength(value, 'utf8')),
      ...(mimeType ? { mimeType } : {}),
      sample,
    },
  };
}

/** True when a string should be offloaded: any data: URI, or any string over the threshold. */
function shouldOffloadString(value: string, threshold: number): boolean {
  return DATA_URI_RE.test(value) || value.length > threshold;
}

function sanitizeValue(
  value: unknown,
  opts: Required<SanitizeOptions>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return shouldOffloadString(value, opts.threshold) ? offloadString(value, opts) : value;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Idempotent: an already-offloaded placeholder is left untouched.
  if (isOffloadPlaceholder(value)) {
    return value;
  }

  // Cycle guard (stack-scoped): if this object is an ancestor of itself we've hit
  // a cycle — return the reference to break it. We delete on exit (below) rather
  // than keeping a persistent "seen" set, so that a shared object referenced from
  // two distinct branches (a DAG, which JSON.stringify would expand anyway) is
  // sanitized at every occurrence instead of leaking the original at the second.
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    let mutated = false;
    const result = value.map((item) => {
      const sanitized = sanitizeValue(item, opts, seen);
      if (sanitized !== item) mutated = true;
      return sanitized;
    });
    seen.delete(value);
    return mutated ? result : value;
  }

  let mutated = false;
  let skippedUnsafe = false;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) {
      skippedUnsafe = true;
      continue;
    }
    const sanitized = sanitizeValue(item, opts, seen);
    if (sanitized !== item) mutated = true;
    result[key] = sanitized;
  }
  seen.delete(value);
  // An unsafe key forces a fresh copy even when nothing else mutated, so the
  // original object (with its hostile own key) is never returned as-is.
  return mutated || skippedUnsafe ? result : value;
}

/** True when `target` resolves to `base` or a directory inside it. */
function isInsideDir(baseDir: string, targetPath: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** True when a path is absolute on this platform (incl. Windows drive letters). */
function isUserAbsolutePath(inputPath: string): boolean {
  return isAbsolute(inputPath) || /^[A-Za-z]:[\\/]/.test(inputPath) || inputPath.startsWith('\\\\');
}

/**
 * Recursively sanitize a value for caching. Oversized strings and data: URIs are
 * replaced with disk-backed `{ _offload }` placeholders. Returns the original
 * reference unchanged when nothing needed offloading (so callers can cheaply
 * detect "no-op").
 */
export function sanitizeForCache<T>(data: T, options: SanitizeOptions = {}): T {
  const projectRoot = getProjectRoot();
  const requestedDir = options.outputDir ?? getArtifactDir('offloaded');
  // Path-guard: offload files are only ever written inside the project root,
  // even when a caller supplies a custom outputDir (mirrors the guard in
  // resolveArtifactPath). A relative outputDir is resolved against the project
  // root; anything that escapes falls back to the default offload dir.
  const candidateDir = isUserAbsolutePath(requestedDir)
    ? resolve(requestedDir)
    : resolve(projectRoot, requestedDir);
  const outputDir = isInsideDir(projectRoot, candidateDir)
    ? candidateDir
    : (logger.warn(
        `[sanitizeForCache] Refusing outputDir outside project root (${requestedDir}); ` +
          `falling back to default offload dir`,
      ),
      getArtifactDir('offloaded'));

  const opts: Required<SanitizeOptions> = {
    threshold: options.threshold ?? OFFLOAD_FIELD_SANITIZE_THRESHOLD_BYTES,
    outputDir,
    writeFile: options.writeFile ?? true,
  };
  return sanitizeValue(data, opts, new WeakSet<object>()) as T;
}

/** Exposed for tests / callers that need the default offload directory. */
export function getOffloadDir(): string {
  return getArtifactDir('offloaded');
}

/** Exposed for the offloaded-data retrieval tool: the artifacts root for containment checks. */
export function getOffloadRoot(): string {
  return getArtifactsRoot();
}
