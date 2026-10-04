import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/server';

const state = vi.hoisted(() => ({
  allTools: [] as Tool[],
  embedBatchTexts: [] as string[][],
  getToolDomain: vi.fn((_name: string) => null),
}));

vi.mock('@server/ToolCatalog', () => ({
  get allTools() {
    return state.allTools;
  },
  getToolDomain: state.getToolDomain,
}));

vi.mock('@server/search/EmbeddingEngine', () => ({
  EmbeddingEngine: class {
    async embedBatch(texts: string[]) {
      state.embedBatchTexts.push([...texts]);
      return texts.map(() => new Float32Array([1, 0, 0]));
    }
    async embed() {
      return new Float32Array([1, 0, 0]);
    }
  },
}));

vi.mock('@src/constants', () => ({
  SEARCH_AFFINITY_BOOST_FACTOR: 0.2,
  SEARCH_AFFINITY_TOP_N: 3,
  SEARCH_DOMAIN_HUB_THRESHOLD: 2,
  SEARCH_QUERY_CACHE_CAPACITY: 8,
  SEARCH_TRIGRAM_WEIGHT: 0.15,
  SEARCH_TRIGRAM_THRESHOLD: 0.35,
  SEARCH_RRF_K: 60,
  SEARCH_RRF_RESCALE_FACTOR: 1000,
  SEARCH_RRF_BM25_BLEND: 0.5,
  SEARCH_SYNONYM_EXPANSION_LIMIT: 3,
  SEARCH_NAME_TOKEN_WEIGHT: 3,
  SEARCH_DOMAIN_TOKEN_WEIGHT: 2,
  SEARCH_DESC_TOKEN_WEIGHT: 1,
  SEARCH_PARAM_TOKEN_WEIGHT: 1.5,
  SEARCH_SCENE_KEYWORD_WEIGHT: 0.8,
  SEARCH_BM25_K1: 1.5,
  SEARCH_BM25_B: 0.75,
  SEARCH_CACHE_VECTOR_WEIGHT_TOLERANCE: 0.05,
  SEARCH_TIER_PENALTY: 1,
  SEARCH_TIER_PENALTY_SEARCH: 1,
  SEARCH_TIER_PENALTY_WORKFLOW: 1,
  SEARCH_TIER_PENALTY_FULL: 1,
  SEARCH_RECENCY_WINDOW_MS: 0,
  SEARCH_RECENCY_MAX_BOOST: 0,
  SEARCH_EXACT_NAME_MATCH_MULTIPLIER: 2.5,
  SEARCH_DOMAIN_HUB_BOOST_MULTIPLIER: 1.08,
  SEARCH_AFFINITY_BASE_WEIGHT: 0.3,
  SEARCH_COVERAGE_PRECISION_FACTOR: 0.5,
  SEARCH_PREFIX_MATCH_MULTIPLIER: 0.5,
  SEARCH_VECTOR_ENABLED: true,
  SEARCH_VECTOR_BM25_SKIP_THRESHOLD: 0,
  SEARCH_VECTOR_MODEL_ID: 'minishlab/potion-code-16M-v2',
  SEARCH_VECTOR_PREWARM: false,
  SEARCH_VECTOR_WORKER_IDLE_MS: 0,
  SEARCH_VECTOR_RETRY_COOLDOWN_MS: 60_000,
  SEARCH_VECTOR_CACHE_ENABLED: true,
  SEARCH_VECTOR_COSINE_WEIGHT: 0.4,
  SEARCH_VECTOR_DYNAMIC_WEIGHT: false,
  SEARCH_VECTOR_LEARN_UP: 0.1,
  SEARCH_VECTOR_LEARN_DOWN: 0.05,
  SEARCH_VECTOR_LEARN_TOP_N: 3,
  SEARCH_RECENCY_TRACKER_MAX: 200,
  SEARCH_SELF_RAG_ENABLED: false,
}));

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  };
}

describe('search/EmbeddingIncrementalWiring', () => {
  let cacheDir: string;

  beforeEach(() => {
    vi.resetModules();
    state.getToolDomain.mockClear();
    state.embedBatchTexts.length = 0;
    cacheDir = mkdtempSync(join(tmpdir(), 'jshook-embedding-wiring-'));
    process.env.JSHOOK_EMBEDDING_CACHE_DIR = cacheDir;
  });

  afterEach(() => {
    delete process.env.JSHOOK_EMBEDDING_CACHE_DIR;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('embeds the full catalog on first run, then only changed tools on subsequent runs', async () => {
    const firstCatalog = [
      makeTool('page_navigate', 'Navigate a page'),
      makeTool('page_click', 'Click an element'),
      makeTool('debug_pause', 'Pause execution'),
    ];

    state.allTools = firstCatalog;
    const { ToolSearchEngine } = await import('@server/search/ToolSearchEngineImpl');
    await new ToolSearchEngine().waitForEmbeddings();

    // Cold start: everything embedded.
    expect(state.embedBatchTexts.at(-1)).toHaveLength(3);

    // Same catalog in a fresh engine (process restart analogue): cache hit,
    // no embedding work at all.
    state.embedBatchTexts.length = 0;
    await new ToolSearchEngine().waitForEmbeddings();
    expect(state.embedBatchTexts).toHaveLength(0);

    // One description changed: only that tool is re-embedded.
    state.embedBatchTexts.length = 0;
    state.allTools = [
      firstCatalog[0]!,
      makeTool('page_click', 'Click an element on the page'),
      firstCatalog[2]!,
    ];
    await new ToolSearchEngine().waitForEmbeddings();

    expect(state.embedBatchTexts).toHaveLength(1);
    const reEmbedded = state.embedBatchTexts[0]!;
    expect(reEmbedded).toHaveLength(1);
    expect(reEmbedded[0]).toContain('Click an element on the page');
  });

  it('falls back to a full embed when only a v1 legacy cache file exists', async () => {
    const { writeFileSync } = await import('node:fs');
    const { getEmbeddingCachePath, buildEmbeddingFingerprint } =
      await import('@server/search/EmbeddingCache');

    state.allTools = [
      makeTool('page_navigate', 'Navigate a page'),
      makeTool('page_click', 'Click an element'),
    ];
    const descriptions = state.allTools.map(
      (tool) => `${tool.name.replace(/_/g, ' ')}: ${tool.description}`,
    );

    // Hand-write a v1 payload: full-catalog fingerprint, no per-tool items.
    writeFileSync(
      getEmbeddingCachePath('minishlab/potion-code-16M-v2'),
      JSON.stringify({
        version: 1,
        modelId: 'minishlab/potion-code-16M-v2',
        fingerprint: buildEmbeddingFingerprint('minishlab/potion-code-16M-v2', descriptions),
        dim: 3,
        count: 2,
        data: Buffer.from(new Float32Array([1, 0, 0, 0, 1, 0]).buffer).toString('base64'),
      }),
      'utf8',
    );

    const { ToolSearchEngine } = await import('@server/search/ToolSearchEngineImpl');
    await new ToolSearchEngine().waitForEmbeddings();

    // v1 is invisible to the partial loader → one-time full re-embed,
    // after which the file is v2 and incremental again.
    expect(state.embedBatchTexts.at(-1)).toHaveLength(2);
  });
});
