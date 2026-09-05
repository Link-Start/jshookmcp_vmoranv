/**
 * MCP 2.0 (2026-07-28) — spec-delta helpers barrel.
 *
 * STATUS: spec-pinned constants and pure predicates, currently UNWIRED —
 * nothing under `src/` imports this barrel yet; only the era-matrix tests
 * do. They exist to pin this project's understanding of one delta per
 * submodule before the modern (`/mcp/v2`) entry and the ElicitationBridge
 * refactor consume them. Consumers should import from here (not restate
 * the vocabulary) when those land.
 *
 *  - `cache-defaults.ts`     — SDK cache defaults + cacheable methods
 *  - `server-info-meta.ts`   — `serverInfo` in `_meta` (spec PR #3002)
 *  - `notifier-shape.ts`     — `handler.notify.*` exact SDK shape
 *  - `input-requests.ts`     — `inputRequests` map: 3 methods / 4 kinds
 *  - `legacy-shim.ts`        — legacy shim host capabilities
 *  - `tasks-mcp-name.ts`     — SEP-2243 `Mcp-Name` for tasks endpoints
 *  - `error-codes.ts`        — error code renumbering scope
 *  - `breaking-changes.ts`   — 6 breaking-change risk registry
 */

export * from './cache-defaults';
export * from './server-info-meta';
export * from './notifier-shape';
export * from './input-requests';
export * from './legacy-shim';
export * from './tasks-mcp-name';
export * from './error-codes';
export * from './breaking-changes';
