/**
 * Tests for off-thread JScrambler deobfuscation (A2).
 *
 * Two concerns:
 *   1. `JScramblerDeobfuscator.deobfuscate` submits the job to an injected pool
 *      instead of running Babel on the main thread.
 *   2. The self-contained worker script's inlined JScrambler port produces
 *      output identical to the main-thread class on the existing fixtures.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerPool } from '@utils/WorkerPool';
import { JScramberDeobfuscator } from '@modules/deobfuscator/JScramblerDeobfuscator';
import {
  JSCRAMBLER_JOB_TIMEOUT_MS,
  JSCRAMBLER_WORKER_SCRIPT,
  type JscramblerPool,
  type JscramblerWorkerResult,
} from '@modules/deobfuscator/jscrambler-worker';
import { resolveBabelUrls } from '@modules/deobfuscator/babel-urls';

const FIXTURES = [
  {
    name: 'self-defending debugger',
    code: `
function guard(){ debugger; return 1; }
setInterval(function(){ debugger; }, 1000);
guard();
`,
    options: {},
  },
  {
    name: 'unresolvable decrypt call left in place',
    code: `
function dec(s){ return s.split('').map(c=>String.fromCharCode(c.charCodeAt(0))).join(''); }
const value = dec("abc");
`,
    options: { decryptStrings: true },
  },
  {
    name: 'while-switch control-flow pattern',
    code: `
while (true) {
  switch (state) {
    case 0: a(); break;
    case 1: b(); break;
  }
}
`,
    options: { restoreControlFlow: true },
  },
  {
    name: 'dead branch + arithmetic simplification',
    code: `
if (false) { drop(); } else { keep(); }
const n = 2 + 3;
`,
    options: {},
  },
  {
    name: 'parse failure',
    code: 'function broken( {',
    options: {},
  },
];

describe('JScramblerDeobfuscator worker-pool path', () => {
  it('submits the deobfuscation job to the pool instead of running Babel on the main thread', async () => {
    const mockPool: JscramblerPool = {
      submit: vi.fn().mockResolvedValue({
        code: 'from-worker',
        success: true,
        transformations: [],
        warnings: [],
        confidence: 0,
      }),
    };

    const result = await new JScramberDeobfuscator().deobfuscate(
      { code: 'obfuscated()' },
      mockPool,
    );

    expect(result.code).toBe('from-worker');
    expect(mockPool.submit).toHaveBeenCalledTimes(1);
    expect(mockPool.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'obfuscated()',
        babelUrls: expect.objectContaining({
          parser: expect.stringContaining('file://'),
        }),
        options: {
          removeDeadCode: true,
          restoreControlFlow: true,
          decryptStrings: true,
          simplifyExpressions: true,
        },
      }),
      JSCRAMBLER_JOB_TIMEOUT_MS,
    );
  });
});

describe('jscrambler worker runtime', () => {
  const pools: Array<WorkerPool<Record<string, unknown>, JscramblerWorkerResult>> = [];

  afterEach(async () => {
    await Promise.allSettled(pools.splice(0).map((pool) => pool.close()));
  });

  for (const fixture of FIXTURES) {
    it(`matches the main-thread class for: ${fixture.name}`, async () => {
      const pool = new WorkerPool<Record<string, unknown>, JscramblerWorkerResult>({
        name: 'jscrambler-runtime-test',
        workerScript: JSCRAMBLER_WORKER_SCRIPT,
        minWorkers: 0,
        maxWorkers: 1,
        idleTimeoutMs: 1000,
      });
      pools.push(pool);

      const mainThread = await new JScramberDeobfuscator().deobfuscate({ code: fixture.code });

      const workerResult = await pool.submit(
        {
          code: fixture.code,
          babelUrls: resolveBabelUrls(),
          options: {
            removeDeadCode: true,
            restoreControlFlow: true,
            decryptStrings: true,
            simplifyExpressions: true,
          },
        },
        JSCRAMBLER_JOB_TIMEOUT_MS,
      );

      expect(workerResult.code).toBe(mainThread.code);
      expect(workerResult.success).toBe(mainThread.success);
      expect(workerResult.transformations).toEqual(mainThread.transformations);
      expect(workerResult.warnings).toEqual(mainThread.warnings);
      expect(workerResult.confidence).toBeCloseTo(mainThread.confidence);
    });
  }
});
