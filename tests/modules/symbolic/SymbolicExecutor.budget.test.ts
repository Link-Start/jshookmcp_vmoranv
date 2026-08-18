import { describe, expect, it, vi } from 'vitest';
import { SymbolicExecutor } from '@modules/symbolic/SymbolicExecutor';

vi.mock('@modules/z3/Z3Solver', () => ({
  withZ3: vi.fn(async () => null),
  isZ3Failed: () => false,
}));

describe('SymbolicExecutor constraint-solving budget governance', () => {
  it('allocates per-path Z3 timeout from the remaining budget with a 1s floor', () => {
    const executor = new SymbolicExecutor() as any;
    // No paths: the whole remaining budget is available for the single solve.
    expect(executor.computePerPathTimeout(0, 30_000)).toBe(30_000);
    // 100 paths in 30s → 300ms each, floored to 1s.
    expect(executor.computePerPathTimeout(100, 30_000)).toBe(1_000);
    // 3 paths in 30s → 10s each.
    expect(executor.computePerPathTimeout(3, 30_000)).toBe(10_000);
    // A single path gets the whole remaining budget.
    expect(executor.computePerPathTimeout(1, 2_000)).toBe(2_000);
    // Below the 1s floor → floored to 1s.
    expect(executor.computePerPathTimeout(1, 500)).toBe(1_000);
  });

  it('skips constraint solving entirely when the executor budget is exhausted', async () => {
    const executor = new SymbolicExecutor();
    const result = await executor.execute({
      code: 'let x = 1; if (x) { x = 2; }',
      maxPaths: 5,
      maxDepth: 5,
      timeout: 0,
      enableConstraintSolving: true,
    });
    expect(result.warnings).toContain('Constraint solving skipped:budget');
  });
});
