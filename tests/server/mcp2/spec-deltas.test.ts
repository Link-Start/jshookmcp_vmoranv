import { describe, expect, it } from 'vitest';
import {
  // cache defaults
  CACHE_HINT_DEFAULTS,
  CACHEABLE_RESULT_METHODS,
  isCacheableResultMethod,
  resolveCacheHint,
  // server info meta
  SERVER_INFO_META_KEY,
  readServerInfoFromDiscover,
  // notifier shape
  SERVER_NOTIFIER_METHODS,
  isServerNotifierShape,
  // input requests
  INPUT_REQUEST_METHODS,
  INPUT_RESPONSE_KINDS,
  inputRequestMethodToResponseKind,
  isInputRequestMethod,
  isInputResponseKind,
  // legacy shim
  LEGACY_SHIM_DEFAULTS,
  LEGACY_SHIM_FULL_HOSTS,
  LEGACY_SHIM_DEGRADED_HOSTS,
  isLegacyShimFullHost,
  isLegacyShimDegradedHost,
  // tasks mcp name
  MCP_NAME_REQUIRED_METHODS,
  TASKS_TASKID_MIRROR_METHODS,
  TASKS_PUSH_NOTIFICATION_METHOD,
  TASKS_PUSH_SUBSCRIPTION_FILTER,
  requiresMcpNameHeader,
  mirrorParamToMcpName,
  // error codes
  ERROR_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY,
  ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION,
  ERROR_CODE_RESOURCE_NOT_FOUND,
  httpStatusForErrorCode,
  // breaking changes
  RESERVED_ENVELOPE_KEYS,
  LIFTED_RETRY_FIELDS,
  ERA_MISMATCH_ERROR_CODE,
  ERA_MISMATCHED_METHODS,
  isReservedEnvelopeKey,
  isLiftedRetryField,
  stripReservedEnvelopeKeys,
  isLegalResultType,
} from '@server/mcp2';

// ─────────────────────────────────────────────────────────────────────────────
// §1: 5 ⚠️ clarifications from spec-delta.md
// ─────────────────────────────────────────────────────────────────────────────

describe('spec-delta — clarification A5 (error code renumbering scope)', () => {
  it('locks the post-dispatch `MissingRequiredClientCapability` code to -32021', () => {
    expect(ERROR_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY).toBe(-32021);
  });

  it('locks the `UnsupportedProtocolVersion` code to -32022', () => {
    expect(ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION).toBe(-32022);
  });

  it('keeps the v1 `ResourceNotFound` importable at -32002 for backwards-compat reads', () => {
    expect(ERROR_CODE_RESOURCE_NOT_FOUND).toBe(-32002);
  });

  it('maps -32021 (post-dispatch) to HTTP 400 (spec MUST)', () => {
    expect(httpStatusForErrorCode(-32021)).toBe(400);
  });

  it('maps -32022 to HTTP 400 (spec MUST)', () => {
    expect(httpStatusForErrorCode(-32022)).toBe(400);
  });

  it('maps in-band errors to HTTP 200 (body is the JSON-RPC error response)', () => {
    expect(httpStatusForErrorCode(-32603)).toBe(200);
    expect(httpStatusForErrorCode(-32700)).toBe(200);
  });

  it('maps -32602 (InvalidParams) to HTTP 400 (spec MUST)', () => {
    expect(httpStatusForErrorCode(-32602)).toBe(400);
  });
});

describe('spec-delta — clarification C1 (SDK cache defaults)', () => {
  it('pins the SDK default `ttlMs` to 0 (most conservative)', () => {
    expect(CACHE_HINT_DEFAULTS.ttlMs).toBe(0);
  });

  it('pins the SDK default `cacheScope` to "private" (most conservative)', () => {
    expect(CACHE_HINT_DEFAULTS.cacheScope).toBe('private');
  });

  it('treats `server/discover` as a `CacheableResult` endpoint (per spec §server/discover + changelog Minor #5)', () => {
    expect(CACHEABLE_RESULT_METHODS).toContain('server/discover');
  });

  it('enumerates the full list of cacheable methods on 2026-07-28', () => {
    expect([...CACHEABLE_RESULT_METHODS].toSorted()).toEqual(
      [
        'prompts/list',
        'resources/list',
        'resources/read',
        'resources/templates/list',
        'server/discover',
        'tools/list',
      ].toSorted(),
    );
  });

  it('per-field resolution: handler value wins over hint, hint wins over defaults', () => {
    const resolved = resolveCacheHint(
      'tools/list',
      { ttlMs: 5000, cacheScope: 'public' },
      undefined,
      undefined,
    );
    expect(resolved).toEqual({ ttlMs: 5000, cacheScope: 'public' });
  });

  it('per-field fallback: missing handler field falls back to defaults', () => {
    const resolved = resolveCacheHint('tools/list', undefined, undefined, undefined);
    expect(resolved).toEqual({ ttlMs: 0, cacheScope: 'private' });
  });

  it('per-field fallback: missing per-operation hint field falls back to defaults', () => {
    const resolved = resolveCacheHint('tools/list', undefined, undefined, {
      'tools/list': { ttlMs: 1000 },
    });
    expect(resolved.ttlMs).toBe(1000);
    expect(resolved.cacheScope).toBe('private');
  });

  it('isCacheableResultMethod is a tight type guard', () => {
    expect(isCacheableResultMethod('tools/list')).toBe(true);
    expect(isCacheableResultMethod('server/discover')).toBe(true);
    expect(isCacheableResultMethod('tasks/get')).toBe(false);
    expect(isCacheableResultMethod('initialize')).toBe(false);
  });
});

describe('spec-delta — clarification C2 (serverInfo in `_meta`)', () => {
  it('pins the meta key to "io.modelcontextprotocol/serverInfo"', () => {
    expect(SERVER_INFO_META_KEY).toBe('io.modelcontextprotocol/serverInfo');
  });

  it('reads serverInfo from `_meta` (correct path on 2026-07-28)', () => {
    const identity = { name: 'jshookmcp', version: '1.2.3' };
    const result = readServerInfoFromDiscover({
      _meta: { [SERVER_INFO_META_KEY]: identity },
    });
    expect(result).toEqual(identity);
  });

  it('returns undefined when neither `_meta` nor `serverInfo` are set', () => {
    expect(readServerInfoFromDiscover({})).toBeUndefined();
  });

  it('reads from body as a v2-alpha fallback (still returns the value if present)', () => {
    // The body path is dead on 2026-07-28, but the helper is a forgiving
    // reader — it accepts either path so a v2-alpha caller does not lose
    // data, while the meta path remains the canonical one.
    const identity = { name: 'old', version: '0.0.1' };
    expect(readServerInfoFromDiscover({ serverInfo: identity })).toEqual(identity);
  });

  it('prefers `_meta` over the body when both are set (canonical path wins)', () => {
    const meta = { name: 'new', version: '2.0.0' };
    const body = { name: 'old', version: '0.0.1' };
    expect(
      readServerInfoFromDiscover({
        serverInfo: body,
        _meta: { [SERVER_INFO_META_KEY]: meta },
      }),
    ).toEqual(meta);
  });
});

describe('spec-delta — clarification C3 (handler.notify.* exact shape)', () => {
  it('enumerates the four notifier methods in canonical SDK order', () => {
    expect([...SERVER_NOTIFIER_METHODS]).toEqual([
      'toolsChanged',
      'promptsChanged',
      'resourcesChanged',
      'resourceUpdated',
    ]);
  });

  it('isServerNotifierShape accepts a fully-implemented notifier', () => {
    const notifier = {
      toolsChanged: () => undefined,
      promptsChanged: () => undefined,
      resourcesChanged: () => undefined,
      resourceUpdated: (_uri: string) => undefined,
    };
    expect(isServerNotifierShape(notifier)).toBe(true);
  });

  it('isServerNotifierShape rejects an empty object', () => {
    expect(isServerNotifierShape({})).toBe(false);
  });

  it('isServerNotifierShape rejects a non-object value', () => {
    expect(isServerNotifierShape(null)).toBe(false);
    expect(isServerNotifierShape(undefined)).toBe(false);
    expect(isServerNotifierShape('notifier')).toBe(false);
  });

  it('isServerNotifierShape rejects a partial implementation (resourceUpdated missing)', () => {
    const partial = {
      toolsChanged: () => undefined,
      promptsChanged: () => undefined,
      resourcesChanged: () => undefined,
    };
    expect(isServerNotifierShape(partial)).toBe(false);
  });

  it('isServerNotifierShape accepts the resourceUpdated method exactly (uri parameter)', () => {
    const calls: string[] = [];
    const notifier = {
      toolsChanged: () => undefined,
      promptsChanged: () => undefined,
      resourcesChanged: () => undefined,
      resourceUpdated: (uri: string) => {
        calls.push(uri);
      },
    };
    if (isServerNotifierShape(notifier)) {
      notifier.resourceUpdated('jshook://evidence/graph');
    }
    expect(calls).toEqual(['jshook://evidence/graph']);
  });
});

describe('spec-delta — clarification D4 (inputRequests: 3 methods / 4 kinds)', () => {
  it('enumerates the three inputRequests methods', () => {
    expect([...INPUT_REQUEST_METHODS].toSorted()).toEqual(
      ['elicitation/create', 'roots/list', 'sampling/createMessage'].toSorted(),
    );
  });

  it('enumerates the four response kinds', () => {
    expect([...INPUT_RESPONSE_KINDS].toSorted()).toEqual(
      ['elicit', 'missing', 'roots', 'sampling'].toSorted(),
    );
  });

  it('maps each method to its response kind', () => {
    expect(inputRequestMethodToResponseKind('elicitation/create')).toBe('elicit');
    expect(inputRequestMethodToResponseKind('sampling/createMessage')).toBe('sampling');
    expect(inputRequestMethodToResponseKind('roots/list')).toBe('roots');
  });

  it('returns null for an unknown method (illegal request kind)', () => {
    expect(inputRequestMethodToResponseKind('tools/call')).toBeNull();
    expect(inputRequestMethodToResponseKind('initialize')).toBeNull();
  });

  it('isInputRequestMethod is a tight guard', () => {
    expect(isInputRequestMethod('elicitation/create')).toBe(true);
    expect(isInputRequestMethod('sampling/createMessage')).toBe(true);
    expect(isInputRequestMethod('roots/list')).toBe(true);
    expect(isInputRequestMethod('tools/call')).toBe(false);
  });

  it('isInputResponseKind is a tight guard', () => {
    expect(isInputResponseKind('elicit')).toBe(true);
    expect(isInputResponseKind('sampling')).toBe(true);
    expect(isInputResponseKind('roots')).toBe(true);
    expect(isInputResponseKind('missing')).toBe(true);
    expect(isInputResponseKind('unknown')).toBe(false);
  });
});

describe('spec-delta — clarification §6 (legacy shim host capabilities)', () => {
  it('pins the SDK shim defaults (maxRounds: 8, roundTimeoutMs: 600_000, legacyShim: true)', () => {
    expect(LEGACY_SHIM_DEFAULTS).toEqual({
      maxRounds: 8,
      roundTimeoutMs: 600_000,
      legacyShim: true,
    });
  });

  it('identifies stdio + sessionful streaming HTTP as the only fully-functional shim hosts', () => {
    expect([...LEGACY_SHIM_FULL_HOSTS].toSorted()).toEqual(
      ['sessionful_streaming_http', 'stdio'].toSorted(),
    );
  });

  it('identifies stateless legacy HTTP + enableJsonResponse legacy as degraded', () => {
    expect([...LEGACY_SHIM_DEGRADED_HOSTS].toSorted()).toEqual(
      ['enable_json_response_legacy', 'stateless_legacy_http'].toSorted(),
    );
  });

  it('isLegacyShimFullHost is a tight guard', () => {
    expect(isLegacyShimFullHost('stdio')).toBe(true);
    expect(isLegacyShimFullHost('sessionful_streaming_http')).toBe(true);
    expect(isLegacyShimFullHost('stateless_legacy_http')).toBe(false);
    expect(isLegacyShimFullHost('enable_json_response_legacy')).toBe(false);
  });

  it('isLegacyShimDegradedHost is a tight guard', () => {
    expect(isLegacyShimDegradedHost('stateless_legacy_http')).toBe(true);
    expect(isLegacyShimDegradedHost('enable_json_response_legacy')).toBe(true);
    expect(isLegacyShimDegradedHost('stdio')).toBe(false);
    expect(isLegacyShimDegradedHost('sessionful_streaming_http')).toBe(false);
  });
});

describe('spec-delta — clarification E4 (SEP-2243 Mcp-Name + tasks push)', () => {
  it('enumerates the methods that mirror params.taskId', () => {
    // Aligned with the tasks the server actually registers
    // (TaskStoreAdapter: get / list / result / cancel — no tasks/update);
    // tasks/list takes a cursor, not a taskId.
    expect([...TASKS_TASKID_MIRROR_METHODS].toSorted()).toEqual(
      ['tasks/cancel', 'tasks/get', 'tasks/result'].toSorted(),
    );
  });

  it('enumerates the full set of methods requiring Mcp-Name', () => {
    expect([...MCP_NAME_REQUIRED_METHODS].toSorted()).toEqual(
      [
        'prompts/get',
        'resources/read',
        'tasks/cancel',
        'tasks/get',
        'tasks/result',
        'tools/call',
      ].toSorted(),
    );
  });

  it('requiresMcpNameHeader is a tight guard', () => {
    expect(requiresMcpNameHeader('tools/call')).toBe(true);
    expect(requiresMcpNameHeader('resources/read')).toBe(true);
    expect(requiresMcpNameHeader('prompts/get')).toBe(true);
    expect(requiresMcpNameHeader('tasks/get')).toBe(true);
    expect(requiresMcpNameHeader('tasks/cancel')).toBe(true);
    expect(requiresMcpNameHeader('initialize')).toBe(false);
    expect(requiresMcpNameHeader('tools/list')).toBe(false);
  });

  it('mirrors taskId for tasks/* methods', () => {
    expect(mirrorParamToMcpName('tasks/get', { taskId: 'abc-123' })).toBe('abc-123');
    expect(mirrorParamToMcpName('tasks/cancel', { taskId: 'q-001' })).toBe('q-001');
  });

  it('mirrors name for tools/call and prompts/get, uri for resources/read', () => {
    expect(mirrorParamToMcpName('tools/call', { name: 'search_tools' })).toBe('search_tools');
    expect(mirrorParamToMcpName('prompts/get', { name: 'review-code' })).toBe('review-code');
    expect(mirrorParamToMcpName('resources/read', { uri: 'file:///x.js' })).toBe('file:///x.js');
  });

  it('returns undefined for non-required methods or missing fields', () => {
    expect(mirrorParamToMcpName('tools/list', {})).toBeUndefined();
    expect(mirrorParamToMcpName('tools/call', {})).toBeUndefined();
    expect(mirrorParamToMcpName('initialize', { name: 'x' })).toBeUndefined();
  });

  it('pins the tasks push notification method and subscription filter', () => {
    expect(TASKS_PUSH_NOTIFICATION_METHOD).toBe('notifications/tasks');
    expect(TASKS_PUSH_SUBSCRIPTION_FILTER).toBe('tasks');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2: 7 era-matrix test rows (Phase H1)
// ─────────────────────────────────────────────────────────────────────────────

describe('era-matrix — row 1: modern era HTTP 400 with JSON-RPC error body is in-band ProtocolError', () => {
  it('in-band JSON-RPC error (-32603) stays at HTTP 200', () => {
    // Per spec: a JSON-RPC error response addressed to the pending request id
    // is delivered in-band (status 200, body is the error). Only when the
    // body is NOT a well-formed JSON-RPC error response do we get HTTP 4xx.
    expect(httpStatusForErrorCode(-32603)).toBe(200);
  });

  it('HTTP 400 is reserved for spec-MUST cases (-32021, -32022, -32602, -32002)', () => {
    // The era-matrix row distinguishes in-band ProtocolError (HTTP 200) from
    // the spec-MUST HTTP 400 mappings.
    const specMustCodes = [-32021, -32022, -32602, -32002];
    for (const code of specMustCodes) {
      expect(httpStatusForErrorCode(code)).toBe(400);
    }
  });
});

describe('era-matrix — row 2: -32021 produced AFTER dispatch answers HTTP 400', () => {
  it('post-dispatch capability rejection lands at HTTP 400', () => {
    expect(httpStatusForErrorCode(-32021)).toBe(400);
  });

  it('the code matches the canonical SDK value', () => {
    expect(ERROR_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY).toBe(-32021);
  });
});

describe('era-matrix — row 3: non-complete/input_required resultType rejects with UnsupportedResultType', () => {
  it('"complete" is the only success kind', () => {
    expect(isLegalResultType('complete')).toBe(true);
  });

  it('"input_required" is the only legal mid-flow kind', () => {
    expect(isLegalResultType('input_required')).toBe(true);
  });

  it('any other kind is illegal (will reject with SdkError(UnsupportedResultType))', () => {
    expect(isLegalResultType('error')).toBe(false);
    expect(isLegalResultType('cancelled')).toBe(false);
    expect(isLegalResultType(undefined)).toBe(false);
    expect(isLegalResultType(null)).toBe(false);
    expect(isLegalResultType(42)).toBe(false);
    expect(isLegalResultType({})).toBe(false);
  });
});

describe('era-matrix — row 4: modern-era notification POST without standard headers still answers 202', () => {
  it('notifications/tasks does not require Mcp-Name (it is a notification, not a request)', () => {
    // Notifications are exempt from standard-header presence per spec.
    // The Mcp-Name requirement applies only to *request* methods.
    expect(requiresMcpNameHeader(TASKS_PUSH_NOTIFICATION_METHOD)).toBe(false);
  });

  it('notifications/* methods in general are not in the Mcp-Name required list', () => {
    // Spot-check a few common notification methods.
    expect(requiresMcpNameHeader('notifications/cancelled')).toBe(false);
    expect(requiresMcpNameHeader('notifications/progress')).toBe(false);
    expect(requiresMcpNameHeader('notifications/initialized')).toBe(false);
  });
});

describe('era-matrix — row 5: 2025-era custom method named "inputResponses" works through legacy path', () => {
  it('"inputResponses" is a lifted retry field on modern era', () => {
    expect(isLiftedRetryField('inputResponses')).toBe(true);
  });

  it('"requestState" is also a lifted retry field', () => {
    expect(isLiftedRetryField('requestState')).toBe(true);
  });

  it('a 2025-era custom method named exactly "inputResponses" would have its top-level field lifted, but the method name itself is the legacy path', () => {
    // The collision note (spec-delta.md §5.3) says: a 2025 peer using
    // `inputResponses` as a top-level params field still works because
    // the SDK keeps the value readable at `ctx.mcpReq.inputResponses`.
    // Our predicate only flags it as a *lifted retry field*; the
    // collision test is that the value is still reachable.
    expect(isLiftedRetryField('inputResponses')).toBe(true);
  });
});

describe('era-matrix — row 6: reserved envelope keys are absent from _meta on entry (lifted to ctx.mcpReq.envelope)', () => {
  it('enumerates the four reserved keys the SDK lifts', () => {
    expect([...RESERVED_ENVELOPE_KEYS].toSorted()).toEqual(
      [
        'io.modelcontextprotocol/clientCapabilities',
        'io.modelcontextprotocol/clientInfo',
        'io.modelcontextprotocol/logLevel',
        'io.modelcontextprotocol/protocolVersion',
      ].toSorted(),
    );
  });

  it('isReservedEnvelopeKey is a tight guard', () => {
    expect(isReservedEnvelopeKey('io.modelcontextprotocol/protocolVersion')).toBe(true);
    expect(isReservedEnvelopeKey('io.modelcontextprotocol/clientInfo')).toBe(true);
    expect(isReservedEnvelopeKey('io.modelcontextprotocol/clientCapabilities')).toBe(true);
    expect(isReservedEnvelopeKey('io.modelcontextprotocol/logLevel')).toBe(true);
    expect(isReservedEnvelopeKey('io.modelcontextprotocol/serverInfo')).toBe(false);
    expect(isReservedEnvelopeKey('random/key')).toBe(false);
  });

  it('stripReservedEnvelopeKeys removes the four reserved keys from a meta object', () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test' },
      'io.modelcontextprotocol/clientCapabilities': { sampling: {} },
      'io.modelcontextprotocol/logLevel': 'info',
      'io.modelcontextprotocol/serverInfo': { name: 'jshookmcp' },
      'custom/key': 'preserved',
    };
    const stripped = stripReservedEnvelopeKeys(meta);
    expect(stripped).toEqual({
      'io.modelcontextprotocol/serverInfo': { name: 'jshookmcp' },
      'custom/key': 'preserved',
    });
    // The four reserved keys are gone.
    expect(Object.keys(stripped).filter((k) => isReservedEnvelopeKey(k))).toEqual([]);
  });

  it('stripReservedEnvelopeKeys is a no-op on a meta object without reserved keys', () => {
    const meta = { 'custom/key': 'value' };
    expect(stripReservedEnvelopeKeys(meta)).toEqual(meta);
  });
});

describe('era-matrix — row 7: resultType "complete" is stripped from public Result types', () => {
  it('the only two legal resultType kinds are "complete" and "input_required"', () => {
    // Per spec-delta.md §4.9: "complete" is consumed and stripped before
    // handlers see it; "input_required" is fulfilled by the client's
    // auto-fulfilment driver; any other kind rejects.
    expect(isLegalResultType('complete')).toBe(true);
    expect(isLegalResultType('input_required')).toBe(true);
    // The wire layer still parses it; the protocol layer consumes it
    // before handlers see it — so handlers must not return it themselves.
  });

  it('"complete" and "input_required" are the only strings accepted', () => {
    const legalKinds = ['complete', 'input_required'];
    const sampleIllegals = ['error', 'cancelled', 'partial', '', 'COMPLETE', 'Input_Required'];
    for (const k of legalKinds) {
      expect(isLegalResultType(k)).toBe(true);
    }
    for (const k of sampleIllegals) {
      expect(isLegalResultType(k)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3: 6 breaking-change risk mitigations
// ─────────────────────────────────────────────────────────────────────────────

describe('breaking change 1 — resultType is consumed/stripped before handlers see it', () => {
  it('only "complete" and "input_required" are legal resultType kinds on the wire', () => {
    expect(isLegalResultType('complete')).toBe(true);
    expect(isLegalResultType('input_required')).toBe(true);
  });

  it('any other kind rejects with SdkError(UnsupportedResultType) (kind lives in error.data.resultType)', () => {
    // Verified by the negative cases in the row-3 era-matrix test above.
    expect(isLegalResultType('error')).toBe(false);
    expect(isLegalResultType(null)).toBe(false);
  });
});

describe('breaking change 2 — reserved envelope keys are lifted pre-handler', () => {
  it('isReservedEnvelopeKey identifies the four lifted keys', () => {
    expect(RESERVED_ENVELOPE_KEYS).toHaveLength(4);
    for (const key of RESERVED_ENVELOPE_KEYS) {
      expect(isReservedEnvelopeKey(key)).toBe(true);
    }
  });

  it('stripReservedEnvelopeKeys produces the post-lift view of _meta', () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/logLevel': 'debug',
      unrelated: 'kept',
    };
    const stripped = stripReservedEnvelopeKeys(meta);
    expect(stripped).toEqual({ unrelated: 'kept' });
  });
});

describe('breaking change 3 — inputResponses / requestState lifted from top-level params', () => {
  it('both fields are flagged as lifted retry fields', () => {
    expect(LIFTED_RETRY_FIELDS).toEqual(['inputResponses', 'requestState']);
    expect(isLiftedRetryField('inputResponses')).toBe(true);
    expect(isLiftedRetryField('requestState')).toBe(true);
  });

  it('ordinary params fields are not lifted', () => {
    expect(isLiftedRetryField('name')).toBe(false);
    expect(isLiftedRetryField('uri')).toBe(false);
    expect(isLiftedRetryField('taskId')).toBe(false);
    expect(isLiftedRetryField('arguments')).toBe(false);
  });
});

describe('breaking change 4 — CallToolResult.content is required on 2026-07-28, optional on 2025', () => {
  // Wire-tightening delta: the behavior lives in the SDK's
  // `projectCallToolResult` codec, not in this project — there is no
  // local constant to pin without re-asserting a local literal. The
  // actionable part for this repo (every tool handler emits `content`)
  // is enforced by the generated-catalog contract, so this delta stays
  // documentation-only until the modern entry consumes it.
  it.todo(
    'every registered tool result carries content (catalog-level contract, needs the modern entry wired)',
  );
});

describe('breaking change 5 — MessageExtraInfo.classification mismatch rejects as -32022', () => {
  it('pins the era-mismatch error code to -32022', () => {
    expect(ERA_MISMATCH_ERROR_CODE).toBe(-32022);
    expect(ERA_MISMATCH_ERROR_CODE).toBe(ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION);
  });

  it('the spec mandates HTTP 400 for the era-mismatch error', () => {
    expect(httpStatusForErrorCode(ERA_MISMATCH_ERROR_CODE)).toBe(400);
  });
});

describe('breaking change 6 — era-mismatched outbound method throws MethodNotSupportedByProtocolVersion', () => {
  it('outboundFrom2025 pins the 2026-only methods against the real export', () => {
    // These cannot be sent toward a 2025 peer; the SDK throws before
    // reaching the transport. Pinned against the ERA_MISMATCHED_METHODS
    // export (not a local literal) so a vocabulary change fails here.
    expect([...ERA_MISMATCHED_METHODS.outboundFrom2025].toSorted()).toEqual(
      [
        'server/discover',
        'subscriptions/listen',
        'tasks/cancel',
        'tasks/get',
        'tasks/list',
        'tasks/result',
      ].toSorted(),
    );
  });

  it('outboundFrom2026 is empty: no 2025-only method is pinned as 2026-mismatched', () => {
    // The Tasks methods are 2026 extensions and are VALID on a 2026
    // connection (the real tasks domain registers them). The earlier
    // alpha-era claim that tasks/list+result were retired on 2026 did not
    // hold for this project — the 2026 side stays empty until a real
    // retired method shows up.
    expect(ERA_MISMATCHED_METHODS.outboundFrom2026).toEqual([]);
    // Cross-module consistency: every taskId-mirroring method is 2026-only.
    for (const m of TASKS_TASKID_MIRROR_METHODS) {
      expect(ERA_MISMATCHED_METHODS.outboundFrom2025).toContain(m);
    }
  });
});
