# V8 检查器

域名：`v8-inspector`

V8 检查器域，提供堆快照分析、CPU 分析和内存检查。

## Profile

- workflow
- full

## 典型场景

- 堆快照分析
- CPU 性能分析
- 内存泄漏检测

## 常见组合

- v8-inspector + browser
- v8-inspector + debugger

## 工具清单（21）

| 工具 | 说明 |
| --- | --- |
| `v8_heap_snapshot_capture` | 待补充中文：Capture a V8 heap snapshot for offline analysis. The snapshot is persisted to artifacts/heap-snapshots/ (data + sidecar meta) so it survives a server restart; set persist=false to keep it in-memory only. |
| `v8_heap_snapshot_analyze` | 待补充中文：Analyze a heap snapshot: class histogram (object count/sizes by constructor), statistics (total objects, detached DOM nodes), optional dominator tree, and leak detection. |
| `v8_heap_diff` | 待补充中文：Compare two heap snapshots to find allocation changes. |
| `v8_object_inspect` | 待补充中文：Inspect a live JS object by objectId with property enumeration. |
| `v8_heap_stats` | 待补充中文：Report V8 heap statistics: used, total, external. |
| `v8_bytecode_extract` | 待补充中文：Extract V8 bytecode for a script by scriptId, with source fallback. |
| `v8_version_detect` | 待补充中文：Detect V8 engine version, flags, and runtime capabilities. |
| `v8_heap_find_leaks` | 待补充中文：Find suspected memory leaks in a heap snapshot. Returns leak candidates sorted by confidence, including detached DOM nodes, large arrays, closure leaks, and unexpectedly large retained objects. |
| `v8_heap_retainers` | 待补充中文：Trace retainer chains from suspect leak objects back to GC roots. For each nodeId, walks the immediate-dominator chain to produce a "what keeps it alive" path: leaf → ... → GC root. Each step includes nodeId, name, className, shallowSize, retainedSize, and distance from the leaf. Use after v8_heap_find_leaks or v8_heap_snapshot_analyze to understand why a specific object is not being collected. |
| `v8_deopt_trace` | 待补充中文：Trace V8 deoptimization events during a capture window. Enables %TraceDeoptimizations via natives syntax and captures deopt events (function name, reason, bailout position). Requires V8 natives syntax. Falls back gracefully when unavailable. |
| `v8_turbofan_inspect` | 待补充中文：Inspect TurboFan compilation state for functions in a script. Reports optimization tier (interpreted/maglev/turbofan). Supports actions: inspect (default), optimize (%OptimizeFunctionOnNextCall), deoptimize (%DeoptimizeFunction). Requires V8 natives syntax. |
| `v8_turbofan_graph` | 待补充中文：Collect and visualize V8 TurboFan IR (sea-of-nodes / Turboshaft graph). Two modes: (1) Provide JS source code — spawns an isolated V8 child with --trace-turbo to generate IR JSON, then parses nodes, edges, phases, and opcode histogram. (2) Provide a traceDir path to read already-generated turbo-*.json files (e.g. from a browser launched with --trace-turbo). Returns per-function graph summaries with phase-level node/edge counts, sample nodes, and opcode distribution. |
| `v8_function_retained` | 待补充中文：Find all heap objects retained by functions matching a name pattern. Walks the dominator tree to find objects whose constructor/class name matches the given pattern, then returns each with its retainer chain. Useful for understanding which objects a specific function/class is holding alive. |
| `v8_object_compare` | 待补充中文：Compare heap objects by shallow/retained size, class name, and property count. Same-snapshot mode (objectIds only) does all-pairs comparison (n-choose-2). Cross-snapshot mode (anotherSnapshotId + anotherObjectIds) does pairwise A[i]↔B[i] comparison. Use to track object growth over time, find memory regression candidates, or compare leaked vs healthy objects of the same class. |
| `v8_wasm_inspect` | 待补充中文：Inspect WebAssembly modules and garbage-collected WASM objects in the page. Discovers .wasm script resources via performance.getEntriesByType, detects WASM GC (struct/array/ref-types) availability, and enumerates feature flags (gc/threads/simd). Supports optional scriptId filter to inspect a specific WASM module. Requires browser/page CDP context. Note: structural type enumeration (includeStructs) requires Chrome ≥ M119 with --enable-features=WebAssemblyGC; absent that, returns gcAvailable flag and script-level summary only. |
| `v8_heap_sampling` | 待补充中文：Collect a V8 allocation sampling profile via CDP HeapProfiler. Starts sampling for a capture window (default 5s), then returns the aggregated allocation call tree: per-function self/total bytes + sample count, sorted by total bytes allocated. Useful for finding hot allocation sites without a full heap snapshot. Requires browser/page CDP context. |
| `v8_allocation_track` | 待补充中文：Track live V8 allocations via CDP HeapProfiler object tracking. Starts allocation tracking for a capture window (default 3s), then returns currently-live objects seen during the window with their allocation stack (top frame + size). Useful for finding objects that survive GC during a specific interaction. Requires browser/page CDP context and V8 natives for full stack resolution. |
| `v8_weakrefs_inspect` | 待补充中文：Enumerate WeakRef and FinalizationRegistry instances in the page via Runtime.evaluate. Inspects registered finalization callbacks and live WeakRef targets, reporting how many WeakRefs are dereferenced vs cleared and which FinalizationRegistry callbacks have pending entries. Useful for diagnosing cleanup logic in long-lived pages. Requires browser/page CDP context. |
| `v8_heap_snapshot_list` | 待补充中文：List V8 heap snapshots — both in-memory (current session) and persisted to artifacts/heap-snapshots/ (survive a server restart). Reports id, capture time, size, source (in-memory/persisted), simulated flag, and expiry status, plus aggregate stats. Snapshot payloads are NOT returned (only metadata). |
| `v8_heap_snapshot_delete` | 待补充中文：Delete persisted V8 heap snapshot artifact files (.heapsnapshot data + .meta.json sidecar) and drop the matching in-memory cache entry. Use deleteAll=true to remove every persisted snapshot. Does not affect the live V8 heap. |
| `v8_heap_snapshot_export` | 待补充中文：Export a heap snapshot as a complete .heapsnapshot JSON file under artifacts/heap-snapshots/, loadable by the Chrome DevTools Memory panel. The file path is returned; the snapshot content is written to disk, not injected into the response (it can be very large). |
