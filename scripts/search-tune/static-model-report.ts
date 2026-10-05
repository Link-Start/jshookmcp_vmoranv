/**
 * Persistence for static-embedding-model benchmark runs
 * (scripts/search-tune/compare-static-model.ts).
 *
 * The benchmark previously printed its JSON result to stdout only, so model
 * A/B decisions had no durable evidence trail — every comparison had to be
 * re-run from scratch. appendStaticModelReport keeps an append-only JSON
 * array so the decision chain (run → persist → compare → decide) survives
 * process exits.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One benchmark run. `model` distinguishes rows; extra fields are whatever
 *  compare-static-model measured (metrics, latency, RSS). */
export interface StaticModelReportEntry extends Record<string, unknown> {
  model: string;
  generatedAt: string;
}

export interface StaticModelReportFile {
  entries: StaticModelReportEntry[];
}

function isEntry(value: unknown): value is StaticModelReportEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.model === 'string' && typeof record.generatedAt === 'string';
}

/**
 * Append one entry to the report file and return the new entry count.
 *
 * A missing, empty, or corrupt existing file starts a fresh array (with a
 * stderr note for the corrupt case) — a damaged report must not block the
 * benchmark from persisting its result.
 */
export async function appendStaticModelReport(
  outPath: string,
  entry: StaticModelReportEntry,
): Promise<number> {
  await mkdir(dirname(outPath), { recursive: true });

  let entries: StaticModelReportEntry[] = [];
  try {
    const raw = await readFile(outPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(isEntry);
      if (valid.length !== parsed.length) {
        process.stderr.write(
          `[static-model-report] dropped ${parsed.length - valid.length} malformed row(s) from ${outPath}\n`,
        );
      }
      entries = valid;
    } else {
      process.stderr.write(
        `[static-model-report] ${outPath} is not a JSON array — starting fresh\n`,
      );
    }
  } catch {
    // Missing file is the normal first-run case; corrupt JSON also lands here
    // and starts fresh, which the stderr note below does not need to repeat.
  }

  entries.push(entry);
  await writeFile(outPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  return entries.length;
}
