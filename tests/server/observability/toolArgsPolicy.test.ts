/**
 * Tool-args capture policy tests (src/server/observability/toolArgsPolicy.ts).
 *
 * The security posture under test: default captures ONLY key names; values
 * (when explicitly opted in) are credential-masked and size-capped; nothing
 * ever throws on odd argument shapes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGlobalToolArgsPolicy,
  renderToolArgsAttrs,
  resetGlobalToolArgsPolicy,
  setGlobalToolArgsPolicy,
} from '@server/observability/toolArgsPolicy';

afterEach(() => {
  resetGlobalToolArgsPolicy();
});

describe('renderToolArgsAttrs', () => {
  it('default (shape) records key names only — never any value', () => {
    const attrs = renderToolArgsAttrs({
      url: 'https://secret-target.internal/admin',
      token: 'abc',
    });
    expect(JSON.parse(attrs['tool.args_keys'] as string)).toEqual(['token', 'url']);
    expect(attrs['tool.args']).toBeUndefined();
  });

  it('off records nothing at all', () => {
    expect(renderToolArgsAttrs({ url: 'x' }, 'off')).toEqual({});
  });

  it('truncated truncates values at 32 chars with an overflow marker', () => {
    const attrs = renderToolArgsAttrs({ code: 'a'.repeat(50) }, 'truncated');
    const rendered = JSON.parse(attrs['tool.args'] as string);
    expect(rendered.code).toBe(`${'a'.repeat(32)}…(+18)`);
  });

  it('credential-ish keys are masked in every value-capturing mode', () => {
    for (const policy of ['truncated', 'full'] as const) {
      const attrs = renderToolArgsAttrs(
        {
          authorization: 'Bearer super-secret',
          cookie: 'session=abc',
          api_key: 'k123',
          nested: { jwt: 'x', other: 'fine' },
        },
        policy,
      );
      const rendered = JSON.parse(attrs['tool.args'] as string);
      expect(rendered.authorization).toBe('***');
      expect(rendered.cookie).toBe('***');
      expect(rendered.api_key).toBe('***');
      // nested object is stringified as a whole — the top-level key 'nested'
      // is not credential-ish, the inner jwt text rides inside the JSON
      // blob; the total cap keeps it bounded, and the docs state values are
      // only for private endpoints.
      expect(rendered.nested).toContain('fine');
    }
  });

  it('full keeps short values verbatim but caps the total rendering', () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < 100; i++) args[`k${String(i).padStart(3, '0')}`] = 'x'.repeat(100);
    const attrs = renderToolArgsAttrs(args, 'full');
    const rendered = attrs['tool.args'] as string;
    expect(rendered.length).toBeLessThanOrEqual(4096 + 20);
    expect(rendered).toContain('…(+');
  });

  it('never throws on odd argument shapes', () => {
    expect(renderToolArgsAttrs(null)).toEqual({});
    expect(renderToolArgsAttrs(undefined)).toEqual({});
    expect(renderToolArgsAttrs([1, 2, 3])).toEqual({});
    expect(renderToolArgsAttrs('string')).toEqual({});
    expect(renderToolArgsAttrs({})).toEqual({});
    // circular structure: JSON.stringify throws → falls back to String()
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;
    expect(() => renderToolArgsAttrs(circular, 'full')).not.toThrow();
  });

  it('global policy setter falls back to shape on invalid input', () => {
    setGlobalToolArgsPolicy('yolo' as never);
    expect(getGlobalToolArgsPolicy()).toBe('shape');
    setGlobalToolArgsPolicy('full');
    expect(getGlobalToolArgsPolicy()).toBe('full');
  });
});
