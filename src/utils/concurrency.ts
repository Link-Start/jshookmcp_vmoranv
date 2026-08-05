/**
 * Global concurrency limiters for different resource categories.
 * Prevents OOM and event-loop starvation under heavy load.
 *
 * Usage:
 *   import { ioLimit, cpuLimit, cdpLimit } from '@utils/concurrency';
 *   const result = await ioLimit(() => runExternalTool(...));
 */

// Lightweight p-limit compatible concurrency limiter

type LimitFunction = <T>(fn: () => Promise<T> | T) => Promise<T>;

/** Default concurrency per resource category. */
const IO_CONCURRENCY_DEFAULT = 4;
const CPU_CONCURRENCY_DEFAULT = 2;
const CDP_CONCURRENCY_DEFAULT = 2;

/**
 * Parse a concurrency env value, falling back to `fallback` when the value is
 * missing, non-numeric, or not a positive integer. A raw `parseInt` result of
 * NaN slips past `concurrency < 1` and deadlocks the limiter (every task stays
 * queued because `activeCount < NaN` is always false), so it must be guarded.
 */
function parseConcurrency(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function pLimit(concurrency: number): LimitFunction {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be an integer >= 1');
  }

  let activeCount = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (queue.length > 0 && activeCount < concurrency) {
      activeCount++;
      const resolve = queue.shift()!;
      resolve();
    }
  }

  function run<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          activeCount--;
          next();
        }
      };

      if (activeCount < concurrency) {
        activeCount++;
        void execute();
      } else {
        queue.push(() => {
          void execute();
        });
      }
    });
  }

  return run;
}

/** External CLI calls, HAR export, large file I/O */
export const ioLimit = pLimit(
  parseConcurrency(process.env.jshook_IO_CONCURRENCY, IO_CONCURRENCY_DEFAULT),
);

/** CPU-heavy: AST parsing, deobfuscation, binary decoding */
export const cpuLimit = pLimit(
  parseConcurrency(process.env.jshook_CPU_CONCURRENCY, CPU_CONCURRENCY_DEFAULT),
);

/** CDP-heavy: heap snapshots, traces, profiling */
export const cdpLimit = pLimit(
  parseConcurrency(process.env.jshook_CDP_CONCURRENCY, CDP_CONCURRENCY_DEFAULT),
);
