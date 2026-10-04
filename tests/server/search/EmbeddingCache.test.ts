import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('search/EmbeddingCache', () => {
  let cacheDir: string;

  beforeEach(async () => {
    vi.resetModules();
    cacheDir = await mkdtemp(join(tmpdir(), 'jshook-emb-cache-'));
    process.env.JSHOOK_EMBEDDING_CACHE_DIR = cacheDir;
    vi.doMock('@src/constants', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@src/constants')>()),
      SEARCH_VECTOR_CACHE_ENABLED: true,
      SEARCH_VECTOR_MODEL_ID: 'test-model',
    }));
  });

  afterEach(async () => {
    delete process.env.JSHOOK_EMBEDDING_CACHE_DIR;
    vi.doUnmock('@src/constants');
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('round-trips aligned embeddings through the disk cache', async () => {
    const {
      buildEmbeddingFingerprint,
      decodeEmbeddings,
      encodeEmbeddings,
      loadToolEmbeddingsCache,
      saveToolEmbeddingsCache,
    } = await import('@server/search/EmbeddingCache');
    const descriptions = ['page navigate: open url', 'page click: click element'];
    const embeddings = [
      new Float32Array([0.1, 0.2, 0.3, 0.4]),
      new Float32Array([0.5, 0.6, 0.7, 0.8]),
    ];

    expect(buildEmbeddingFingerprint('test-model', descriptions)).toHaveLength(64);
    const encoded = encodeEmbeddings(embeddings);
    const decoded = decodeEmbeddings(encoded.data, embeddings.length, encoded.dim);
    expect(decoded?.[0]?.[0]).toBeCloseTo(0.1, 5);
    expect(decoded?.[1]?.[3]).toBeCloseTo(0.8, 5);

    await saveToolEmbeddingsCache('test-model', descriptions, embeddings);
    const loaded = await loadToolEmbeddingsCache('test-model', descriptions);
    expect(loaded).toHaveLength(2);
    expect(loaded?.[0]?.[1]).toBeCloseTo(0.2, 5);
    expect(loaded?.[1]?.[2]).toBeCloseTo(0.7, 5);
  });

  it('misses when the model or catalog fingerprint changes', async () => {
    const { loadToolEmbeddingsCache, saveToolEmbeddingsCache } =
      await import('@server/search/EmbeddingCache');
    const descriptions = ['a: one', 'b: two'];
    const embeddings = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    await saveToolEmbeddingsCache('test-model', descriptions, embeddings);

    expect(await loadToolEmbeddingsCache('test-model', ['a: one', 'b: changed'])).toBeNull();
    expect(await loadToolEmbeddingsCache('other-model', descriptions)).toBeNull();
  });

  it('rejects malformed dimensions without allocating unsafe typed arrays', async () => {
    const { decodeEmbeddings } = await import('@server/search/EmbeddingCache');
    expect(decodeEmbeddings('AAAA', 1, 1)).toBeNull();
    expect(decodeEmbeddings('', 0, 0)).toEqual([]);
    expect(decodeEmbeddings('AAAA', Number.MAX_SAFE_INTEGER, 2)).toBeNull();
  });

  it('v2 save → partial full hit with reordered tools and detached buffers', async () => {
    const { loadToolEmbeddingsCachePartial, saveToolEmbeddingsCacheV2 } =
      await import('@server/search/EmbeddingCache');
    const tools = [
      { name: 'page_navigate', description: 'page navigate: open url' },
      { name: 'page_click', description: 'page click: click element' },
      { name: 'page_screenshot', description: 'page screenshot: capture image' },
    ];
    const embeddings = [
      new Float32Array([0.1, 0.2, 0.3, 0.4]),
      new Float32Array([0.5, 0.6, 0.7, 0.8]),
      new Float32Array([0.9, 0.1, 0.2, 0.3]),
    ];
    await saveToolEmbeddingsCacheV2('test-model', tools, embeddings);

    // 顺序重排：仍按 name 对齐返回各自 embedding
    const partial = await loadToolEmbeddingsCachePartial('test-model', [
      tools[2]!,
      tools[0]!,
      tools[1]!,
    ]);
    expect(partial).not.toBeNull();
    expect(partial?.[0]?.[0]).toBeCloseTo(0.9, 5);
    expect(partial?.[1]?.[1]).toBeCloseTo(0.2, 5);
    expect(partial?.[2]?.[2]).toBeCloseTo(0.7, 5);

    // 命中项不共享可变底层 buffer
    expect(partial?.[0]?.buffer).not.toBe(partial?.[1]?.buffer);
  });

  it('changed description → only that slot is null, others reused', async () => {
    const { loadToolEmbeddingsCachePartial, saveToolEmbeddingsCacheV2 } =
      await import('@server/search/EmbeddingCache');
    const tools = [
      { name: 'page_navigate', description: 'page navigate: open url' },
      { name: 'page_click', description: 'page click: click element' },
    ];
    const embeddings = [
      new Float32Array([0.1, 0.2, 0.3, 0.4]),
      new Float32Array([0.5, 0.6, 0.7, 0.8]),
    ];
    await saveToolEmbeddingsCacheV2('test-model', tools, embeddings);

    const partial = await loadToolEmbeddingsCachePartial('test-model', [
      { name: 'page_navigate', description: 'page navigate: open url v2' },
      tools[1]!,
    ]);
    expect(partial?.[0]).toBeNull();
    expect(partial?.[1]?.[0]).toBeCloseTo(0.5, 5);
    expect(partial?.[1]?.[3]).toBeCloseTo(0.8, 5);
  });

  it('added tool → new slot null, existing slots reused', async () => {
    const { loadToolEmbeddingsCachePartial, saveToolEmbeddingsCacheV2 } =
      await import('@server/search/EmbeddingCache');
    const tools = [
      { name: 'page_navigate', description: 'page navigate: open url' },
      { name: 'page_click', description: 'page click: click element' },
    ];
    const embeddings = [
      new Float32Array([0.1, 0.2, 0.3, 0.4]),
      new Float32Array([0.5, 0.6, 0.7, 0.8]),
    ];
    await saveToolEmbeddingsCacheV2('test-model', tools, embeddings);

    const partial = await loadToolEmbeddingsCachePartial('test-model', [
      tools[0]!,
      tools[1]!,
      { name: 'new_tool', description: 'brand new tool' },
    ]);
    expect(partial).toHaveLength(3);
    expect(partial?.[0]?.[1]).toBeCloseTo(0.2, 5);
    expect(partial?.[1]?.[2]).toBeCloseTo(0.7, 5);
    expect(partial?.[2]).toBeNull();
  });

  it('v1 file → partial null; legacy load still reads v1 and unnamed v2', async () => {
    const {
      buildEmbeddingFingerprint,
      encodeEmbeddings,
      getEmbeddingCachePath,
      loadToolEmbeddingsCache,
      loadToolEmbeddingsCachePartial,
      saveToolEmbeddingsCache,
    } = await import('@server/search/EmbeddingCache');
    const descriptions = ['a: one', 'b: two'];
    const embeddings = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const { dim, data } = encodeEmbeddings(embeddings);

    // 手写 v1 缓存文件（模拟升级前留下的旧缓存）
    const path = getEmbeddingCachePath('test-model');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        modelId: 'test-model',
        fingerprint: buildEmbeddingFingerprint('test-model', descriptions),
        dim,
        count: 2,
        data,
      }),
      'utf8',
    );

    // v1：旧 load 命中，partial 不支持 → null
    const legacyV1 = await loadToolEmbeddingsCache('test-model', descriptions);
    expect(legacyV1?.[0]?.[0]).toBeCloseTo(1, 5);
    expect(legacyV1?.[1]?.[1]).toBeCloseTo(1, 5);
    expect(
      await loadToolEmbeddingsCachePartial('test-model', [{ name: 'a', description: 'a: one' }]),
    ).toBeNull();

    // 无名 save 覆写为 v2：旧 load 全匹配命中，任一 description 变更 → null
    await saveToolEmbeddingsCache('test-model', descriptions, embeddings);
    const legacyV2 = await loadToolEmbeddingsCache('test-model', descriptions);
    expect(legacyV2?.[0]?.[0]).toBeCloseTo(1, 5);
    expect(await loadToolEmbeddingsCache('test-model', ['a: one', 'b: changed'])).toBeNull();
  });

  it('corrupted byte length → partial null', async () => {
    const { getEmbeddingCachePath, loadToolEmbeddingsCachePartial, saveToolEmbeddingsCacheV2 } =
      await import('@server/search/EmbeddingCache');
    const tools = [
      { name: 'page_navigate', description: 'page navigate: open url' },
      { name: 'page_click', description: 'page click: click element' },
    ];
    const embeddings = [
      new Float32Array([0.1, 0.2, 0.3, 0.4]),
      new Float32Array([0.5, 0.6, 0.7, 0.8]),
    ];
    await saveToolEmbeddingsCacheV2('test-model', tools, embeddings);

    // 篡改 data：字节数与 count*dim*4 不符
    const path = getEmbeddingCachePath('test-model');
    const payload = JSON.parse(await readFile(path, 'utf8')) as { data: string };
    payload.data = 'AAAA';
    await writeFile(path, JSON.stringify(payload), 'utf8');

    expect(await loadToolEmbeddingsCachePartial('test-model', tools)).toBeNull();
  });
});
