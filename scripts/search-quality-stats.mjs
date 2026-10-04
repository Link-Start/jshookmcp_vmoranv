#!/usr/bin/env node
/**
 * Search quality traffic statistics — feeds the vector-eligibility decision.
 *
 * Reads the persisted SearchQualityTracker snapshot
 * (`~/.jshookmcp/state/search-quality.json`, written by the
 * RuntimeSnapshotScheduler) and prints the share of real queries whose top
 * raw BM25 score falls below the vector skip threshold
 * (SEARCH_VECTOR_BM25_SKIP_THRESHOLD, default 8 — env-overridable here).
 *
 * Decision guidance (see .ccg memory "search-engine-improvements-acbd"):
 *   - weakRatio ≈ 0  → the vector path never engages on real traffic;
 *                      re-evaluate D-3 (disable vector by default for http
 *                      too, keep it an explicit opt-in).
 *   - weakRatio significant → tune the skip threshold before touching the
 *                      embedding model; model strength is the last lever.
 *
 * Quick-path records (exact/prefix matches) carry no raw BM25 score and are
 * excluded from the ratio denominator by design — they never reach the skip
 * decision the statistic exists to inform.
 *
 * Usage: node scripts/search-quality-stats.mjs [--json]
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const THRESHOLD = Number(process.env.SEARCH_VECTOR_BM25_SKIP_THRESHOLD ?? 8);
const STATE_PATH = resolve(homedir(), '.jshookmcp', 'state', 'search-quality.json');

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main() {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch (error) {
    console.error(
      `Cannot read snapshot at ${STATE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error('Run the server against real traffic first; snapshots persist on shutdown.');
    process.exit(1);
  }

  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  if (records.length === 0) {
    console.log('Snapshot is empty — no searches recorded yet.');
    process.exit(0);
  }

  const fullPath = records.filter((r) => typeof r.bm25TopScore === 'number');
  const quickPath = records.length - fullPath.length;
  const weak = fullPath.filter((r) => r.bm25TopScore < THRESHOLD);
  const confident = fullPath.filter((r) => r.bm25TopScore >= THRESHOLD);
  const participated = fullPath.filter((r) => r.vectorParticipated === true);

  const histogram = [0, 2, 4, 8, 16, 32, 64];
  const buckets = histogram.map((lo, i) => {
    const hi = histogram[i + 1] ?? Infinity;
    const count = fullPath.filter((r) => r.bm25TopScore >= lo && r.bm25TopScore < hi).length;
    return { range: hi === Infinity ? `>=${lo}` : `${lo}-${hi}`, count };
  });

  const used = fullPath.filter(
    (r) => typeof r.usedTool === 'string' && typeof r.usedToolRank === 'number',
  );
  const weakRatio = fullPath.length > 0 ? weak.length / fullPath.length : 0;

  const summary = {
    statePath: STATE_PATH,
    threshold: THRESHOLD,
    totalRecords: records.length,
    quickPathRecords: quickPath,
    fullPathRecords: fullPath.length,
    bm25WeakQueries: weak.length,
    bm25ConfidentQueries: confident.length,
    bm25WeakRatio: Number(weakRatio.toFixed(4)),
    vectorParticipatedRate: Number(
      (fullPath.length > 0 ? participated.length / fullPath.length : 0).toFixed(4),
    ),
    mrr: Number(
      (used.length > 0
        ? used.reduce((s, r) => s + 1 / r.usedToolRank, 0) / used.length
        : 0
      ).toFixed(4),
    ),
    toolUsedRate: Number((used.length / records.length).toFixed(4)),
    p50LatencyMs: percentile(
      records.map((r) => r.latencyMs).toSorted((a, b) => a - b),
      50,
    ),
    histogram: buckets.filter((b) => b.count > 0),
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  console.log(`Search-quality traffic stats (threshold=${THRESHOLD})`);
  console.log(
    `  records: ${records.length} (quick-path ${quickPath}, full-path ${fullPath.length})`,
  );
  console.log(
    `  BM25-weak (<${THRESHOLD}): ${weak.length}  |  confident: ${confident.length}  |  weakRatio: ${(weakRatio * 100).toFixed(1)}%`,
  );
  console.log(
    `  vector participated: ${participated.length}/${fullPath.length} full-path queries (${(summary.vectorParticipatedRate * 100).toFixed(1)}%)`,
  );
  console.log(
    `  MRR: ${summary.mrr}  |  toolUsedRate: ${summary.toolUsedRate}  |  p50 latency: ${summary.p50LatencyMs}ms`,
  );
  if (buckets.some((b) => b.count > 0)) {
    console.log('  BM25 top-score histogram:');
    for (const b of buckets) {
      if (b.count > 0) console.log(`    [${b.range.padStart(6)}]: ${b.count}`);
    }
  }
  if (fullPath.length === 0) {
    console.log('  (no full-path samples yet — quick-path/exact-match traffic only)');
  } else if (weakRatio < 0.05) {
    console.log(
      `  → weakRatio ${(weakRatio * 100).toFixed(1)}% ≈ 0: vector rarely engages on real traffic. Re-evaluate making http disable vector by default (D-3).`,
    );
  } else {
    console.log(
      `  → weakRatio ${(weakRatio * 100).toFixed(1)}% is material: tune SEARCH_VECTOR_BM25_SKIP_THRESHOLD before touching the model.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
