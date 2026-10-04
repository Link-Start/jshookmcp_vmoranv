/**
 * Search-tune pruner + objective regularization.
 *
 * deriveFrozenParams: after a tuning phase, parameters whose value provably
 * does not move the objective (bucket-mean spread below a threshold) are
 * frozen to the best trial's value, so subsequent phases stop spending trial
 * budget exploring dead dimensions.
 *
 * regularizedScore: `objective − λ · Σ|v − default| / (max − min)` — a
 * continuous overfitting penalty that complements the binary RRSI holdout
 * gate. Candidates that win by drifting many parameters far from the shipped
 * defaults are discounted even when their evolve score edges out a
 * conservative neighbour.
 */
import {
  PARAM_DEFS,
  SEARCH_TUNE_DEFAULTS,
  type TrialParams,
  type TunableParamKey,
} from './search-space';

export interface TrialSummary {
  params: Record<string, number>;
  objectiveScore: number;
}

export interface FrozenRationaleEntry {
  key: string;
  /** Max bucket-mean minus min bucket-mean observed for this parameter. */
  spread: number;
  /** Number of distinct values observed. */
  buckets: number;
  /** Value the parameter was frozen to (always the shipped default). */
  frozenTo: number;
  source: 'shipped-default';
}

export interface PrunerResult {
  frozen: Partial<Record<TunableParamKey, number>>;
  rationale: FrozenRationaleEntry[];
}

export interface PrunerOptions {
  /** Max bucket-mean spread for a parameter to count as low-sensitivity. */
  sensitivityThreshold?: number;
  /** Minimum trials per bucket before the bucket is trusted. */
  minSamplesPerBucket?: number;
  /** Minimum total trials before any freezing happens at all. */
  minTrials?: number;
}

const DEFAULT_SENSITIVITY_THRESHOLD = 0.002;
const DEFAULT_MIN_SAMPLES_PER_BUCKET = 3;
const DEFAULT_MIN_TRIALS = 30;

/**
 * Freeze low-sensitivity parameters back to their SHIPPED DEFAULTS.
 *
 * Rationale: a parameter whose value provably does not move the objective has
 * no evidence justifying drift from the default, and freezing it to the
 * default (rather than to some sampled value) also minimizes the
 * regularization penalty. Freezing to the best trial's value instead would be
 * self-contradictory under bucket-mean spread: the best trial's bucket is by
 * construction the high-objective one, so its spread would exceed any tight
 * low-sensitivity threshold.
 *
 * Pure function — safe to unit-test and to call repeatedly as trials
 * accumulate.
 */
export function deriveFrozenParams(
  trials: readonly TrialSummary[],
  options: PrunerOptions = {},
): PrunerResult {
  const sensitivityThreshold = options.sensitivityThreshold ?? DEFAULT_SENSITIVITY_THRESHOLD;
  const minSamples = options.minSamplesPerBucket ?? DEFAULT_MIN_SAMPLES_PER_BUCKET;
  const minTrials = options.minTrials ?? DEFAULT_MIN_TRIALS;

  const frozen: Partial<Record<TunableParamKey, number>> = {};
  const rationale: FrozenRationaleEntry[] = [];

  if (trials.length < minTrials) return { frozen, rationale };

  for (const def of PARAM_DEFS) {
    const defDefault = SEARCH_TUNE_DEFAULTS[def.key];
    if (defDefault === undefined) continue;

    // Bucket objectives by the parameter's observed value.
    const buckets = new Map<number, number[]>();
    for (const trial of trials) {
      const value = trial.params[def.key];
      if (value === undefined) continue;
      const list = buckets.get(value) ?? [];
      list.push(trial.objectiveScore);
      buckets.set(value, list);
    }

    // Trust the spread only when every bucket has enough samples and at
    // least two distinct values were actually explored.
    if (buckets.size < 2) continue;
    if ([...buckets.values()].some((list) => list.length < minSamples)) continue;

    let minMean = Number.POSITIVE_INFINITY;
    let maxMean = Number.NEGATIVE_INFINITY;
    for (const list of buckets.values()) {
      const mean = list.reduce((s, v) => s + v, 0) / list.length;
      minMean = Math.min(minMean, mean);
      maxMean = Math.max(maxMean, mean);
    }
    const spread = maxMean - minMean;
    if (spread >= sensitivityThreshold) continue;

    frozen[def.key] = defDefault;
    rationale.push({
      key: def.key,
      spread,
      buckets: buckets.size,
      frozenTo: defDefault,
      source: 'shipped-default',
    });
  }

  return { frozen, rationale };
}

/**
 * Σ over tuned params of |value − shipped default| / (max − min).
 * Params without a default entry or outside the tuning space are skipped;
 * params not present in `params` cost nothing (untuned = still default).
 */
export function computeDefaultPenalty(params: TrialParams | Record<string, number>): number {
  let penalty = 0;
  for (const def of PARAM_DEFS) {
    const value = params[def.key];
    if (value === undefined) continue;
    const defDefault = SEARCH_TUNE_DEFAULTS[def.key];
    if (defDefault === undefined) continue;
    const span = def.max - def.min;
    if (span <= 0) continue;
    penalty += Math.abs(value - defDefault) / span;
  }
  return penalty;
}

/** objective − λ·penalty. λ=0 reproduces the raw objective ordering. */
export function regularizedScore(trial: TrialSummary, lambda: number): number {
  if (lambda <= 0) return trial.objectiveScore;
  return trial.objectiveScore - lambda * computeDefaultPenalty(trial.params);
}
