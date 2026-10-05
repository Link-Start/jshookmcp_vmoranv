/**
 * Query-text capture policy tests (src/server/observability/queryTextPolicy.ts).
 *
 * The policy bounds what leaves the process in `search.query` spans: reverse-
 * engineering queries can embed target URLs, cookies, and tokens, so capture
 * is `truncated` by default and every mode must be deterministic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGlobalQueryTextPolicy,
  redactQueryText,
  resetGlobalQueryTextPolicy,
  setGlobalQueryTextPolicy,
} from '@server/observability/queryTextPolicy';

afterEach(() => {
  resetGlobalQueryTextPolicy();
});

describe('redactQueryText', () => {
  it('truncates to 64 chars with an overflow marker by default', () => {
    const long = 'x'.repeat(100);
    const out = redactQueryText(long);
    expect(out).toHaveLength(64 + `…(+36)`.length);
    expect(out.endsWith('…(+36)')).toBe(true);
  });

  it('keeps short queries verbatim in truncated mode', () => {
    expect(redactQueryText('hook fetch requests')).toBe('hook fetch requests');
  });

  it('full mode returns the query untouched', () => {
    const long = 'y'.repeat(200);
    expect(redactQueryText(long, 'full')).toBe(long);
  });

  it('off mode emits an empty string — metrics still carry query_length', () => {
    expect(redactQueryText('anything at all', 'off')).toBe('');
  });

  it('honours the process-global policy installed at server startup', () => {
    setGlobalQueryTextPolicy('full');
    expect(getGlobalQueryTextPolicy()).toBe('full');
    const long = 'z'.repeat(80);
    expect(redactQueryText(long)).toBe(long);
  });

  it('falls back to the safe default on an invalid policy value', () => {
    setGlobalQueryTextPolicy('sure, why not' as never);
    expect(getGlobalQueryTextPolicy()).toBe('truncated');
  });
});
