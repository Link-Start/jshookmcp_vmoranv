/**
 * Query-text capture policy for `search.query` spans.
 *
 * jshookmcp searches describe reverse-engineering intent, and agents paste
 * all sorts of sensitive material into them: target URLs, cookies, tokens,
 * even snippets of memory dumps. The query text is the single most valuable
 * attribute for lakehouse analysis, and also the single riskiest to export —
 * so capture is a policy, not a boolean.
 *
 * The policy is process-global (set once at server startup from config):
 * emission sites live inside the search engine, which has no access to the
 * config object, and search-tune worker processes never set a policy, so
 * they get the safe default for free.
 */

export type QueryTextPolicy = 'off' | 'truncated' | 'full';

const DEFAULT_POLICY: QueryTextPolicy = 'truncated';
const TRUNCATION_LIMIT = 64;

let globalPolicy: QueryTextPolicy = DEFAULT_POLICY;

/** Install the process-wide policy. Invalid values fall back to `truncated`. */
export function setGlobalQueryTextPolicy(policy: QueryTextPolicy | undefined): void {
  globalPolicy =
    policy === 'off' || policy === 'full' || policy === 'truncated' ? policy : DEFAULT_POLICY;
}

/** Test seam: restore the shipped default. */
export function resetGlobalQueryTextPolicy(): void {
  globalPolicy = DEFAULT_POLICY;
}

export function getGlobalQueryTextPolicy(): QueryTextPolicy {
  return globalPolicy;
}

/**
 * Apply the policy to a raw query string. `truncated` keeps the first 64
 * characters plus a `…(+N)` marker so downstream analysis can tell truncation
 * apart from a genuinely short query.
 */
export function redactQueryText(query: string, policy: QueryTextPolicy = globalPolicy): string {
  if (policy === 'off') return '';
  if (policy === 'full') return query;
  if (query.length <= TRUNCATION_LIMIT) return query;
  const overflow = query.length - TRUNCATION_LIMIT;
  return `${query.slice(0, TRUNCATION_LIMIT)}…(+${overflow})`;
}
