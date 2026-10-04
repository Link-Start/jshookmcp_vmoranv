/**
 * expression-validator tests: computed-member bypasses must be blocked the
 * same way as dot-access (window.eval, obj.constructor, new Function).
 */
import { describe, expect, it } from 'vitest';
import { validateExpression } from '@server/domains/process/handlers/expression-validator';

function expectBlocked(expr: string, reason: string) {
  const r = validateExpression(expr);
  expect(r.valid, `expected ${expr} to be blocked (${reason})`).toBe(false);
}

function expectAllowed(expr: string) {
  const r = validateExpression(expr);
  expect(r.valid, `expected ${expr} to be allowed`).toBe(true);
}

describe('process/expression-validator computed-member bypasses', () => {
  it('blocks dot-access baseline cases', () => {
    expectBlocked('window.eval("1+1")', 'eval via dot access');
    expectBlocked('new Function("return 1")', 'Function via NewExpression');
    expectBlocked('obj.constructor', 'constructor property');
    expectBlocked('eval("x")', 'direct eval');
  });

  it('blocks computed-literal eval access', () => {
    expectBlocked('window["eval"]("1+1")', 'computed eval call');
  });

  it('blocks computed-literal constructor access', () => {
    expectBlocked('window["constructor"]', 'computed constructor member');
    expectBlocked('Object["constructor"]', 'computed Object.constructor pattern');
  });

  it('blocks NewExpression with computed / member callees', () => {
    expectBlocked('new window["Function"]("return 1")', 'computed Function instantiation');
    expectBlocked('new (window.Function)("return 1")', 'member callee instantiation');
  });

  it('blocks member callee eval calls', () => {
    expectBlocked('window.eval("1+1")', 'member callee eval');
  });

  it('does not over-block ordinary computed access', () => {
    expectAllowed('data["key"]');
    expectAllowed('new Foo()');
    expectAllowed('a["constructorProperty"]');
    expectAllowed('Math.max(1, 2)');
  });
});
