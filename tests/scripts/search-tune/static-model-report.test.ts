/**
 * Static-model benchmark persistence tests
 * (scripts/search-tune/static-model-report.ts).
 *
 * The benchmark results previously existed only on stdout; these tests lock
 * the append-only JSON behavior that makes model A/B decisions auditable.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendStaticModelReport } from '../../../scripts/search-tune/static-model-report';

const cleanupPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jshook-static-model-report-'));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.allSettled(
    cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

function entry(model: string) {
  return { model, generatedAt: new Date().toISOString(), mrrAt10: 0.8, semantic: { mrrAt10: 0.6 } };
}

describe('search-tune/static-model-report', () => {
  it('creates the report file (and nested dirs) on first append', async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, 'nested', 'deep', 'static-model-report.json');
    const count = await appendStaticModelReport(outPath, entry('minishlab/potion-code-16M-v2'));
    expect(count).toBe(1);
    const parsed = JSON.parse(await readFile(outPath, 'utf-8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ model: 'minishlab/potion-code-16M-v2' });
  });

  it('appends to an existing report and returns the new count', async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, 'static-model-report.json');
    expect(await appendStaticModelReport(outPath, entry('lexical'))).toBe(1);
    expect(
      await appendStaticModelReport(outPath, entry('futur/Qwen3-Embedding-0.6B-model2vec-onnx')),
    ).toBe(2);
    const parsed = JSON.parse(await readFile(outPath, 'utf-8'));
    expect(parsed.map((e: { model: string }) => e.model)).toEqual([
      'lexical',
      'futur/Qwen3-Embedding-0.6B-model2vec-onnx',
    ]);
  });

  it('starts fresh when the existing file is corrupt JSON', async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, 'static-model-report.json');
    await writeFile(outPath, '{not json', 'utf-8');
    const count = await appendStaticModelReport(outPath, entry('lexical'));
    expect(count).toBe(1);
    const parsed = JSON.parse(await readFile(outPath, 'utf-8'));
    expect(parsed).toHaveLength(1);
  });

  it('drops malformed rows from a partially valid array but keeps valid ones', async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, 'static-model-report.json');
    await writeFile(
      outPath,
      JSON.stringify([
        { model: 'lexical', generatedAt: '2026-10-04T00:00:00.000Z' },
        { no: 'model field' },
        42,
      ]),
      'utf-8',
    );
    const count = await appendStaticModelReport(outPath, entry('new-model'));
    // 1 valid survivor + 1 new entry.
    expect(count).toBe(2);
    const parsed = JSON.parse(await readFile(outPath, 'utf-8'));
    expect(parsed.map((e: { model: string }) => e.model)).toEqual(['lexical', 'new-model']);
  });

  it('starts fresh when the existing file is valid JSON but not an array', async () => {
    const dir = await makeTempDir();
    const outPath = join(dir, 'static-model-report.json');
    await writeFile(outPath, JSON.stringify({ model: 'lexical' }), 'utf-8');
    const count = await appendStaticModelReport(outPath, entry('lexical'));
    expect(count).toBe(1);
  });
});
