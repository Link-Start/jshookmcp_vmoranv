import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/server';

const state = vi.hoisted(() => ({
  allTools: [] as Tool[],
  /** Mutable so individual tests can flip the BM25-skip behaviour. */
  skipThreshold: 0,
  getToolDomain: vi.fn((name: string) => {
    if (name.startsWith('page_')) return 'browser';
    if (name.startsWith('debug_')) return 'debugger';
    return null;
  }),
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
  get SEARCH_VECTOR_BM25_SKIP_THRESHOLD() {
    return state.skipThreshold;
  },
  SEARCH_VECTOR_MODEL_ID: 'minishlab/potion-code-16M-v2',
  SEARCH_VECTOR_PREWARM: false,
  SEARCH_VECTOR_WORKER_IDLE_MS: 0,
  SEARCH_VECTOR_RETRY_COOLDOWN_MS: 60_000,
  SEARCH_VECTOR_CACHE_ENABLED: false,
  SEARCH_VECTOR_COSINE_WEIGHT: 0.4,
  SEARCH_VECTOR_DYNAMIC_WEIGHT: true,
  SEARCH_VECTOR_LEARN_UP: 0.1,
  SEARCH_VECTOR_LEARN_DOWN: 0.05,
  SEARCH_VECTOR_LEARN_TOP_N: 3,
  SEARCH_RECENCY_TRACKER_MAX: 200,
  SEARCH_SELF_RAG_ENABLED: true,
}));

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  };
}

describe('search/FeedbackSignal', () => {
  beforeEach(() => {
    vi.resetModules();
    state.getToolDomain.mockClear();
    state.skipThreshold = 0;
    state.allTools = [
      makeTool('page_navigate', 'Navigate a page to a URL in browser'),
      makeTool('page_click', 'Click an element on page'),
      makeTool('debug_pause', 'Pause JavaScript execution'),
    ];
  });

  it('keeps the vector weight untouched when the BM25-skip threshold fired', async () => {
    // Any query with results produces a top BM25 score above this threshold,
    // so the vector signal is skipped for the whole search.
    state.skipThreshold = 0.001;

    const { ToolSearchEngine } = await import('@server/search/ToolSearchEngineImpl');
    const engine = new ToolSearchEngine();

    const results = await engine.search('navigate page url', 5);
    expect(results.length).toBeGreaterThan(0);

    const before = engine.getFeedbackTracker().getVectorWeight();
    engine.recordToolCallFeedback(results[0]!.name, '');
    // RED pre-fix: the skipped search stored an EMPTY ranking (not null), so
    // this feedback took a constant down-step and eroded the vector weight on
    // strong-BM25 queries even though the vector signal never participated.
    expect(engine.getFeedbackTracker().getVectorWeight()).toBe(before);
  });

  it('clears the stale vector ranking when the quick path is taken', async () => {
    // Vector participates on the first (full-path) query...
    state.skipThreshold = 0;

    const { ToolSearchEngine } = await import('@server/search/ToolSearchEngineImpl');
    const engine = new ToolSearchEngine();

    const full = await engine.search('navigate page url', 5);
    expect(full.length).toBeGreaterThan(0);
    const before = engine.getFeedbackTracker().getVectorWeight();
    engine.recordToolCallFeedback(full[0]!.name, '');
    expect(engine.getFeedbackTracker().getVectorWeight()).not.toBe(before);

    // ...then an exact-name query takes the self-RAG quick path, which never
    // consults the vector signal. The next feedback must not learn from the
    // STALE full-path ranking.
    const after = engine.getFeedbackTracker().getVectorWeight();
    await engine.search('page_navigate', 5);
    engine.recordToolCallFeedback('page_navigate', '');
    expect(engine.getFeedbackTracker().getVectorWeight()).toBe(after);
  });

  it('still learns when the vector signal genuinely participates', async () => {
    state.skipThreshold = 0;

    const { ToolSearchEngine } = await import('@server/search/ToolSearchEngineImpl');
    const engine = new ToolSearchEngine();

    const results = await engine.search('navigate page url', 5);
    const before = engine.getFeedbackTracker().getVectorWeight();
    engine.recordToolCallFeedback(results[0]!.name, '');

    // With every tool embedding identical, the selected tool sits in the
    // vector ranking, so a participating signal must still move the weight.
    expect(engine.getFeedbackTracker().getVectorWeight()).not.toBe(before);
  });
});
