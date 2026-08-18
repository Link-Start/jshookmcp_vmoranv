import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeForCache } from '@utils/sanitizeForCache';
import { getProjectRoot } from '@utils/outputPaths';

// Call-through mock for the sync write: lets individual tests inject an EEXIST
// on the first attempt while every other test keeps the real implementation.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

const DATA_URI = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024);

function isPlaceholder(v: unknown): v is { _offload: Record<string, unknown> } {
  return typeof v === 'object' && v !== null && '_offload' in v;
}

describe('sanitizeForCache', () => {
  let outDir: string;

  beforeAll(async () => {
    // The offload dir must live inside the project root: the sanitizer now
    // refuses to write outside it (path-guard, mirroring resolveArtifactPath).
    outDir = join(getProjectRoot(), 'artifacts', `offloaded-test-${Date.now()}`);
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  const opts = () => ({ outputDir: outDir });

  it('leaves primitives and small strings untouched (same reference)', () => {
    expect(sanitizeForCache(42, opts())).toBe(42);
    expect(sanitizeForCache('hello', opts())).toBe('hello');
    expect(sanitizeForCache(null, opts())).toBe(null);
    expect(sanitizeForCache(true, opts())).toBe(true);

    const obj = { a: 1, b: 'short', c: { d: [1, 2, 3] } };
    // Nothing oversized → same reference returned (cheap no-op).
    expect(sanitizeForCache(obj, opts())).toBe(obj);
  });

  it('replaces a data: URI with a file placeholder regardless of size', () => {
    const small = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
    const out = sanitizeForCache({ url: small }, opts()) as { url: unknown };

    expect(isPlaceholder(out.url)).toBe(true);
    if (isPlaceholder(out.url)) {
      expect(out.url._offload.type).toBe('file');
      expect(out.url._offload.mimeType).toBe('image/gif');
      expect(out.url._offload.sample).toContain('data:image/gif;base64,');
      expect(typeof out.url._offload.path).toBe('string');
    }
  });

  it('replaces strings over the threshold', () => {
    const big = 'x'.repeat(100 * 1024);
    const out = sanitizeForCache({ blob: big }, { ...opts(), threshold: 64 * 1024 }) as {
      blob: unknown;
    };
    expect(isPlaceholder(out.blob)).toBe(true);
  });

  it('reproduces issue #62: a 3MB data: URI in a request url shrinks dramatically', () => {
    const requests = [
      { url: DATA_URI, method: 'GET', requestId: 'r1' },
      { url: 'https://example.com/api', method: 'POST', requestId: 'r2' },
    ];
    const out = sanitizeForCache(requests, opts());
    const serialized = JSON.stringify(out);

    // Was ~3MB; must now be tiny (the only base64 left is the 128-char sample).
    expect(serialized.length).toBeLessThan(2000);
    // The multi-MB bulk is gone — no long run survives beyond the short sample.
    expect(serialized).not.toContain('A'.repeat(500));
    expect(isPlaceholder((out as any[])[0].url)).toBe(true);
    // Untouched normal URL stays intact.
    expect((out as any[])[1].url).toBe('https://example.com/api');
  });

  it('writes the decoded bytes to disk under artifacts/offloaded and they are retrievable', async () => {
    // Use the real default dir so the placeholder path is project-relative — this
    // is exactly what get_offloaded_data depends on. Clean up the file afterward.
    const png1px =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const out = sanitizeForCache({ img: png1px }) as unknown as {
      img: { _offload: { path: string } };
    };

    const relPath = out.img._offload.path;
    expect(relPath).toContain('artifacts/offloaded');

    const absPath = join(getProjectRoot(), relPath);
    try {
      const written = await readFile(absPath);
      // Decoded PNG starts with the 8-byte PNG signature.
      expect(written[0]).toBe(0x89);
      expect(written.subarray(1, 4).toString('ascii')).toBe('PNG');
    } finally {
      await rm(absPath, { force: true });
    }
  });

  it('is idempotent — sanitizing twice does not double-wrap', () => {
    const once = sanitizeForCache({ url: DATA_URI }, opts()) as unknown as {
      url: { _offload: unknown };
    };
    const twice = sanitizeForCache(once, opts());
    // Second pass returns the same reference (placeholder left untouched).
    expect(twice).toBe(once);
  });

  it('handles circular references without infinite recursion', () => {
    const node: Record<string, unknown> = { name: 'root', big: 'y'.repeat(100 * 1024) };
    node.self = node;
    const out = sanitizeForCache(node, { ...opts(), threshold: 64 * 1024 }) as Record<
      string,
      unknown
    >;
    expect(isPlaceholder(out.big)).toBe(true);
    // Cycle preserved (points back to the sanitized root or original — not crashed).
    expect(out.self).toBeDefined();
  });

  it('does not write a file when writeFile=false but still shrinks', () => {
    const out = sanitizeForCache({ url: DATA_URI }, { ...opts(), writeFile: false }) as unknown as {
      url: { _offload: { path: string; sample: string } };
    };
    expect(out.url._offload.path).toBe('');
    expect(out.url._offload.sample).toContain('data:image/png;base64,');
  });

  it('does not pollute prototypes via __proto__ keys in captured data', () => {
    // JSON.parse creates __proto__ as an OWN key — exactly what hostile page
    // data can smuggle through the collector.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "data": "x"}');
    const out = sanitizeForCache(hostile, opts()) as Record<string, unknown>;

    expect((out as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).not.toHaveProperty('polluted');
    expect(Object.prototype.hasOwnProperty.call(out, 'data')).toBe(true);
  });

  it('drops constructor and prototype keys when sanitizing objects', () => {
    const hostile = JSON.parse(
      '{"constructor": {"prototype": {"hijacked": 1}}, "prototype": {"x": 1}, "blob": "' +
        'y'.repeat(100 * 1024) +
        '"}',
    );
    const out = sanitizeForCache(hostile, { ...opts(), threshold: 64 * 1024 }) as Record<
      string,
      unknown
    >;

    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'prototype')).toBe(false);
    expect((out as Record<string, unknown>).hijacked).toBeUndefined();
    // Legit fields still sanitized normally.
    expect(isPlaceholder(out.blob)).toBe(true);
  });

  it('nested objects with unsafe keys are also cleaned', () => {
    const hostile = JSON.parse('{"nested": {"__proto__": {"pwned": true}, "ok": 1}}');
    const out = sanitizeForCache(hostile, opts()) as {
      nested: Record<string, unknown>;
    };

    expect(out.nested.pwned).toBeUndefined();
    expect(Object.getPrototypeOf(out.nested)).not.toHaveProperty('pwned');
  });

  it('does not treat a polluted prototype chain as an offload placeholder', () => {
    const fake = JSON.parse('{"blob": "' + 'y'.repeat(100 * 1024) + '"}');
    // Prototype claims to be an offload placeholder with attacker data — the
    // idempotency check must only honor OWN _offload keys, so sanitizing still
    // runs on the real payload instead of passing it through untouched.
    Object.setPrototypeOf(fake, { _offload: { type: 'file', path: '../../etc/passwd' } });

    const out = sanitizeForCache(fake, { ...opts(), threshold: 64 * 1024 }) as Record<
      string,
      unknown
    >;
    expect(isPlaceholder(out.blob)).toBe(true);
  });

  it('refuses to write offload files outside the project root', async () => {
    const escapedDir = await mkdtemp(join(tmpdir(), 'sanitize-escape-'));
    const out = sanitizeForCache(
      { url: DATA_URI },
      { outputDir: escapedDir, writeFile: true },
    ) as unknown as { url: { _offload: { path: string } } };

    // Placeholder points back into the real offload dir, not the escaped dir…
    expect(out.url._offload.path).toContain('artifacts/offloaded');
    expect(out.url._offload.path.split('/')[0]).not.toBe('..');
    // …and nothing was written into the attacker-chosen directory.
    expect(await readdir(escapedDir)).toEqual([]);
    await rm(escapedDir, { recursive: true, force: true });
  });

  it('accepts a relative outputDir inside the project root', async () => {
    const out = sanitizeForCache(
      { url: DATA_URI },
      { outputDir: `artifacts/offloaded-test-rel-${Date.now()}` },
    ) as unknown as { url: { _offload: { path: string } } };

    expect(out.url._offload.path).toContain('artifacts/offloaded-test-rel');
    // Clean up the file written relative to the project root.
    const abs = join(getProjectRoot(), ...out.url._offload.path.split('/'));
    await rm(abs, { force: true });
  });

  it('uses an 8-char hex ID derived from randomUUID in offload filenames', async () => {
    const out = sanitizeForCache({ url: DATA_URI }, opts()) as unknown as {
      url: { _offload: { path: string } };
    };
    // a4-03/a2-08: the old 6-char Math.random base36 ID collided at high
    // write rates; the new ID is 8 hex chars from a v4 UUID.
    expect(out.url._offload.path).toMatch(
      /offload-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.(bin|txt)$/,
    );
    await rm(join(getProjectRoot(), ...out.url._offload.path.split('/')), { force: true });
  });

  it('writes exclusively (wx) and retries once when the reserved name collides', async () => {
    const mockedWrite = vi.mocked(writeFileSync);
    mockedWrite.mockImplementationOnce(() => {
      throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
    });

    const out = sanitizeForCache({ url: DATA_URI }, opts()) as unknown as {
      url: { _offload: { path: string } };
    };
    try {
      // The collision was retried with a regenerated name — the placeholder
      // must still point at a written file (the second attempt went through).
      expect(out.url._offload.path).toBeTruthy();
      expect(mockedWrite).toHaveBeenCalledTimes(2);
      for (const call of mockedWrite.mock.calls) {
        expect(call[2]).toMatchObject({ flag: 'wx' });
      }
    } finally {
      mockedWrite.mockRestore();
      if (out.url._offload.path) {
        await rm(join(getProjectRoot(), ...out.url._offload.path.split('/')), { force: true });
      }
    }
  });
});
