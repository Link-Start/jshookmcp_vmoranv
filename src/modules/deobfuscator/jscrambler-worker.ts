/**
 * Off-thread JScrambler deobfuscation for the `deobfuscate` tool's
 * `engine: 'jscrambler'` path.
 *
 * `JScramblerDeobfuscator.deobfuscate` runs a Babel parse plus five
 * traverse/generate passes (self-defending removal, string decryption,
 * control-flow restoration, dead-code removal, expression simplification) —
 * ~189ms of event-loop blocking on real samples. This module moves that work
 * into a `WorkerPool`-backed worker thread (the same `eval: true`
 * self-contained script pattern as the v8-inspector heap-parse worker and
 * `webcrack-worker`).
 *
 * ── IMPORTANT: keep the inlined plain-JS port in `JSCRAMBLER_WORKER_SCRIPT` in
 * sync with `JScramblerDeobfuscator.deobfuscate` and its private helpers in
 * `./JScramblerDeobfuscator.ts` — the worker runs the same passes; the main
 * thread only posts `{ code, options }` and receives the result. Any change to
 * one must be mirrored in the other. ──
 */

import { WorkerPool } from '@utils/WorkerPool';
import type { BabelWorkerUrls } from './babel-urls';

export interface JscramblerWorkerOptions {
  removeDeadCode: boolean;
  restoreControlFlow: boolean;
  decryptStrings: boolean;
  simplifyExpressions: boolean;
}

export interface JscramblerWorkerPayload extends Record<string, unknown> {
  code: string;
  babelUrls: BabelWorkerUrls;
  options: JscramblerWorkerOptions;
}

export interface JscramblerWorkerResult {
  code: string;
  success: boolean;
  transformations: string[];
  warnings: string[];
  confidence: number;
}

/** Minimal pool surface the handler depends on; injectable for tests. */
export interface JscramblerPool {
  submit(payload: JscramblerWorkerPayload, timeoutMs?: number): Promise<JscramblerWorkerResult>;
}

const JSCRAMBLER_POOL_MIN_WORKERS = 1;
const JSCRAMBLER_POOL_MAX_WORKERS = 2;
const JSCRAMBLER_POOL_IDLE_TIMEOUT_MS = 30_000;
export const JSCRAMBLER_JOB_TIMEOUT_MS = 60_000;
/** Babel parse + five traverse passes over up-to-5MB code. */
const JSCRAMBLER_POOL_MAX_OLD_GEN_MB = 512;
const JSCRAMBLER_POOL_MAX_YOUNG_GEN_MB = 64;

/**
 * Self-contained worker script. Bootstraps `parentPort` via dynamic import and
 * loads `@babel/*` from the `file://` URLs the main thread resolved (see
 * `babel-urls.ts`).
 *
 * Message protocol (matches `WorkerPool`):
 *   → { jobId, payload: { code, babelUrls, options } }
 *   ← { jobId, ok: true,  result: JscramblerWorkerResult }
 *   ← { jobId, ok: false, error: string }
 */
export const JSCRAMBLER_WORKER_SCRIPT = `
const __bootstrap = async () => {
  const { parentPort } = await import('node:worker_threads');
  if (!parentPort) throw new Error('worker parentPort is unavailable');

  let parser;
  let traverse;
  let generate;
  let t;
  let loadedBabelUrls = '';

  async function loadBabel(babelUrls) {
    if (!babelUrls || loadedBabelUrls === babelUrls.parser) return;
    const parserNs = await import(babelUrls.parser);
    parser = parserNs.default ?? parserNs;
    const traverseNs = await import(babelUrls.traverse);
    traverse = traverseNs.default ?? traverseNs;
    const genNs = await import(babelUrls.generator);
    generate = genNs.default ?? genNs;
    t = await import(babelUrls.types);
    loadedBabelUrls = babelUrls.parser;
  }

  const CONFIDENCE_DIVISOR = 5;
  const DEFAULT_PARSE_INT_RADIX = 10;

  function calculateConfidence(transformationCount) {
    return Math.min(transformationCount / CONFIDENCE_DIVISOR, 1.0);
  }

  function detectSelfDefending(ast) {
    let hasSelfDefending = false;
    traverse(ast, {
      FunctionDeclaration(path) {
        if (path.node.body.body.some((stmt) => t.isDebuggerStatement(stmt))) {
          hasSelfDefending = true;
        }
        const code = generate(path.node).code;
        if (code.includes('toString') && code.includes('constructor')) {
          hasSelfDefending = true;
        }
      },
    });
    return hasSelfDefending;
  }

  function removeSelfDefending(ast) {
    traverse(ast, {
      DebuggerStatement(path) {
        path.remove();
      },
      CallExpression(path) {
        if (
          t.isIdentifier(path.node.callee) &&
          (path.node.callee.name === 'setInterval' || path.node.callee.name === 'setTimeout')
        ) {
          const arg = path.node.arguments[0];
          if (t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg)) {
            const body = arg.body;
            if (t.isBlockStatement(body)) {
              if (body.body.some((stmt) => t.isDebuggerStatement(stmt))) {
                if (path.parentPath && path.parentPath.isExpressionStatement()) {
                  path.remove();
                } else {
                  path.replaceWith(t.identifier('undefined'));
                }
              }
            }
          }
        }
      },
    });
  }

  function forEachFunctionAssignment(decl, onAssignment) {
    const id = decl.id;
    const init = decl.init;
    if (t.isIdentifier(id) && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) {
      onAssignment(id.name, init);
    }
  }

  function collectFunctionDefs(ast) {
    const defs = new Map();
    traverse(ast, {
      FunctionDeclaration(path) {
        if (path.node.id) {
          defs.set(path.node.id.name, path.node);
        }
      },
      VariableDeclarator(path) {
        forEachFunctionAssignment(path.node, (name, fn) => defs.set(name, fn));
      },
    });
    return defs;
  }

  function collectGlobalArrays(ast) {
    const arrays = new Map();
    traverse(ast, {
      VariableDeclarator(path) {
        const node = path.node;
        if (t.isIdentifier(node.id) && t.isArrayExpression(node.init)) {
          arrays.set(node.id.name, node.init);
        }
      },
    });
    return arrays;
  }

  function looksLikeDecryptFunction(fn, arrays) {
    const code = generate(fn).code;
    if (code.includes('fromCharCode') || code.includes('charCodeAt')) {
      return true;
    }
    for (const name of arrays.keys()) {
      if (new RegExp('\\\\b' + name + '\\\\s*\\\\[').test(code)) {
        return true;
      }
    }
    return false;
  }

  function findDecryptFunctions(ast, arrays) {
    const decryptFunctions = new Set();
    const register = (fn, name) => {
      if (name && looksLikeDecryptFunction(fn, arrays)) {
        decryptFunctions.add(name);
      }
    };
    traverse(ast, {
      FunctionDeclaration(path) {
        register(path.node, path.node.id ? path.node.id.name : null);
      },
      VariableDeclarator(path) {
        forEachFunctionAssignment(path.node, (name, fn) => register(fn, name));
      },
    });
    return decryptFunctions;
  }

  function comparable(value) {
    if (value === null || typeof value === 'boolean') {
      return Number(value);
    }
    return value;
  }

  function evalBinary(operator, left, right) {
    switch (operator) {
      case '+':
        return typeof left === 'string' || typeof right === 'string'
          ? String(left) + String(right)
          : left + right;
      case '-':
        return typeof left === 'number' && typeof right === 'number' ? left - right : undefined;
      case '*':
        return typeof left === 'number' && typeof right === 'number' ? left * right : undefined;
      case '/':
        return typeof left === 'number' && typeof right === 'number' ? left / right : undefined;
      case '%':
        return typeof left === 'number' && typeof right === 'number' ? left % right : undefined;
      case '**':
        return typeof left === 'number' && typeof right === 'number' ? left ** right : undefined;
      case '<<':
        return typeof left === 'number' && typeof right === 'number' ? left << right : undefined;
      case '>>':
        return typeof left === 'number' && typeof right === 'number' ? left >> right : undefined;
      case '>>>':
        return typeof left === 'number' && typeof right === 'number' ? left >>> right : undefined;
      case '&':
        return typeof left === 'number' && typeof right === 'number' ? left & right : undefined;
      case '|':
        return typeof left === 'number' && typeof right === 'number' ? left | right : undefined;
      case '^':
        return typeof left === 'number' && typeof right === 'number' ? left ^ right : undefined;
      case '<':
        return comparable(left) < comparable(right);
      case '>':
        return comparable(left) > comparable(right);
      case '<=':
        return comparable(left) <= comparable(right);
      case '>=':
        return comparable(left) >= comparable(right);
      case '===':
        return left === right;
      case '!==':
        return left !== right;
      case '==':
        return left == right; // eslint-disable-line eqeqeq
      case '!=':
        return left != right; // eslint-disable-line eqeqeq
      default:
        return undefined;
    }
  }

  function evalArray(node, env, arrays) {
    const values = [];
    for (const el of node.elements) {
      if (!el || t.isSpreadElement(el)) {
        return undefined;
      }
      const value = evalExpr(el, env, arrays);
      if (value === undefined) {
        return undefined;
      }
      values.push(value);
    }
    return values;
  }

  function evalCall(node, env, arrays) {
    const evalArgs = () => {
      const values = [];
      for (const arg of node.arguments) {
        if (!t.isExpression(arg)) {
          return [];
        }
        const value = evalExpr(arg, env, arrays);
        if (value === undefined || value === null || Array.isArray(value)) {
          return [];
        }
        values.push(value);
      }
      return values;
    };

    const callee = node.callee;
    if (t.isIdentifier(callee)) {
      if (callee.name === 'String') {
        const values = evalArgs();
        return values.length === 1 ? String(values[0]) : undefined;
      }
      if (callee.name === 'Number') {
        const values = evalArgs();
        return values.length === 1 && typeof values[0] !== 'boolean'
          ? Number(values[0])
          : undefined;
      }
      if (callee.name === 'parseInt' || callee.name === 'parseFloat') {
        const values = evalArgs();
        if (values.length === 0) {
          return undefined;
        }
        return callee.name === 'parseInt'
          ? Number.parseInt(
              String(values[0]),
              typeof values[1] === 'number' ? values[1] : DEFAULT_PARSE_INT_RADIX,
            )
          : Number.parseFloat(String(values[0]));
      }
      return undefined;
    }

    if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
      const method = callee.property.name;
      if (
        t.isIdentifier(callee.object) &&
        callee.object.name === 'String' &&
        method === 'fromCharCode'
      ) {
        const values = evalArgs();
        if (values.length !== node.arguments.length || values.some((v) => typeof v !== 'number')) {
          return undefined;
        }
        return String.fromCharCode.apply(String, values);
      }
      const obj = evalExpr(callee.object, env, arrays);
      if (obj === undefined || obj === null) {
        return undefined;
      }
      if (typeof obj === 'string') {
        const values = evalArgs();
        switch (method) {
          case 'charCodeAt': {
            const idx = values[0];
            if (typeof idx !== 'number') {
              return undefined;
            }
            return obj.charCodeAt(idx);
          }
          case 'charAt': {
            const idx = values[0];
            if (typeof idx !== 'number') {
              return undefined;
            }
            return obj.charAt(idx);
          }
          case 'split': {
            const sep = values[0];
            if (typeof sep !== 'string') {
              return undefined;
            }
            return obj.split(sep);
          }
          case 'substr':
          case 'substring':
          case 'slice': {
            const from = values[0];
            const to = values[1];
            if (typeof from !== 'number' || (to !== undefined && typeof to !== 'number')) {
              return undefined;
            }
            return method === 'substr'
              ? obj.substr(from, to)
              : method === 'substring'
                ? obj.substring(from, to)
                : obj.slice(from, to);
          }
          case 'concat': {
            if (
              values.length !== node.arguments.length ||
              values.some((v) => typeof v !== 'string')
            ) {
              return undefined;
            }
            return obj.concat.apply(obj, values);
          }
          case 'indexOf': {
            const needle = values[0];
            if (typeof needle !== 'string') {
              return undefined;
            }
            return obj.indexOf(needle, typeof values[1] === 'number' ? values[1] : undefined);
          }
          case 'toLowerCase':
            return values.length === 0 ? obj.toLowerCase() : undefined;
          case 'toUpperCase':
            return values.length === 0 ? obj.toUpperCase() : undefined;
          case 'trim':
            return values.length === 0 ? obj.trim() : undefined;
          case 'replace': {
            if (
              values.length !== 2 ||
              typeof values[0] !== 'string' ||
              typeof values[1] !== 'string'
            ) {
              return undefined;
            }
            return obj.split(values[0]).join(values[1]);
          }
          default:
            return undefined;
        }
      }
    }
    return undefined;
  }

  function evalExpr(node, env, arrays) {
    if (t.isStringLiteral(node)) return node.value;
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isBooleanLiteral(node)) return node.value;
    if (t.isNullLiteral(node)) return null;
    if (t.isIdentifier(node)) {
      if (env.has(node.name)) return env.get(node.name);
      const arr = arrays.get(node.name);
      return arr ? evalArray(arr, env, arrays) : undefined;
    }
    if (t.isMemberExpression(node)) {
      const obj = evalExpr(node.object, env, arrays);
      if (obj === undefined || obj === null) return undefined;
      if (!node.computed) return undefined;
      const prop = evalExpr(node.property, env, arrays);
      if (typeof obj === 'string' && typeof prop === 'number') {
        return obj.charAt(prop);
      }
      if (Array.isArray(obj) && typeof prop === 'number') {
        return obj[prop] == null ? null : obj[prop];
      }
      return undefined;
    }
    if (t.isArrayExpression(node)) return evalArray(node, env, arrays);
    if (t.isBinaryExpression(node)) {
      const left = evalExpr(node.left, env, arrays);
      const right = evalExpr(node.right, env, arrays);
      if (left === undefined || right === undefined || Array.isArray(left) || Array.isArray(right)) {
        return undefined;
      }
      return evalBinary(node.operator, left, right);
    }
    if (t.isUnaryExpression(node)) {
      const value = evalExpr(node.argument, env, arrays);
      if (value === undefined) return undefined;
      switch (node.operator) {
        case '!':
          return !value;
        case '-':
          return typeof value === 'number' ? -value : undefined;
        case '+':
          return typeof value === 'number' ? value : undefined;
        case '~':
          return typeof value === 'number' ? ~value : undefined;
        case 'typeof':
          return typeof value;
        default:
          return undefined;
      }
    }
    if (t.isLogicalExpression(node)) {
      const left = evalExpr(node.left, env, arrays);
      if (left === undefined) return undefined;
      if (node.operator === '&&') {
        return left ? evalExpr(node.right, env, arrays) : left;
      }
      if (node.operator === '||') {
        return left ? left : evalExpr(node.right, env, arrays);
      }
      return left !== null ? left : evalExpr(node.right, env, arrays);
    }
    if (t.isConditionalExpression(node)) {
      const test = evalExpr(node.test, env, arrays);
      if (test === undefined) return undefined;
      return evalExpr(test ? node.consequent : node.alternate, env, arrays);
    }
    if (t.isTemplateLiteral(node)) {
      let result = '';
      for (let i = 0; i < node.quasis.length; i += 1) {
        const q = node.quasis[i];
        result += q.value.cooked ?? q.value.raw;
        const expr = node.expressions[i];
        if (expr) {
          const value = evalExpr(expr, env, arrays);
          if (value === undefined || value === null) return undefined;
          result += String(value);
        }
      }
      return result;
    }
    if (t.isCallExpression(node)) return evalCall(node, env, arrays);
    return undefined;
  }

  function evalBlock(body, env, arrays) {
    for (const stmt of body.body) {
      if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
          if (!t.isIdentifier(decl.id) || !decl.init) return undefined;
          const value = evalExpr(decl.init, env, arrays);
          if (value === undefined) return undefined;
          env.set(decl.id.name, value);
        }
        continue;
      }
      if (
        t.isExpressionStatement(stmt) &&
        t.isAssignmentExpression(stmt.expression) &&
        t.isIdentifier(stmt.expression.left)
      ) {
        const value = evalExpr(stmt.expression.right, env, arrays);
        if (value === undefined) return undefined;
        env.set(stmt.expression.left.name, value);
        continue;
      }
      if (t.isReturnStatement(stmt)) {
        if (!stmt.argument) return undefined;
        const value = evalExpr(stmt.argument, env, arrays);
        return Array.isArray(value) ? undefined : value;
      }
      return undefined;
    }
    return undefined;
  }

  function evaluateDecryptCall(fn, args, arrays) {
    const env = new Map();
    const params = fn.params;
    for (let i = 0; i < params.length; i += 1) {
      const param = params[i];
      const arg = args[i];
      if (!param || !t.isIdentifier(param) || !arg || !t.isExpression(arg)) {
        return undefined;
      }
      const value = evalExpr(arg, env, arrays);
      if (value === undefined) return undefined;
      env.set(param.name, value);
    }
    if (t.isBlockStatement(fn.body)) {
      return evalBlock(fn.body, env, arrays);
    }
    const bodyValue = evalExpr(fn.body, env, arrays);
    return Array.isArray(bodyValue) ? undefined : bodyValue;
  }

  function valueToNode(value) {
    if (typeof value === 'string') return t.stringLiteral(value);
    if (typeof value === 'number') return t.numericLiteral(value);
    return t.booleanLiteral(value);
  }

  function decryptStrings(ast, warnings) {
    let count = 0;
    const arrays = collectGlobalArrays(ast);
    const decryptFunctions = findDecryptFunctions(ast, arrays);
    if (decryptFunctions.size === 0) return 0;
    const defs = collectFunctionDefs(ast);

    traverse(ast, {
      CallExpression: (path) => {
        if (!t.isIdentifier(path.node.callee) || !decryptFunctions.has(path.node.callee.name)) {
          return;
        }
        const def = defs.get(path.node.callee.name);
        if (!def) return;
        const result = evaluateDecryptCall(def, path.node.arguments, arrays);
        if (result === undefined || result === null) {
          warnings.push(
            'Unable to statically decrypt ' + path.node.callee.name + '(...) call; left in place',
          );
          return;
        }
        path.replaceWith(valueToNode(result));
        count += 1;
      },
    });

    return count;
  }

  function extractStateUpdate(stmt, stateName) {
    if (
      !t.isExpressionStatement(stmt) ||
      !t.isAssignmentExpression(stmt.expression) ||
      !t.isIdentifier(stmt.expression.left) ||
      stmt.expression.left.name !== stateName
    ) {
      return undefined;
    }
    const right = stmt.expression.right;
    if (t.isNumericLiteral(right) || t.isStringLiteral(right)) {
      return right.value;
    }
    return undefined;
  }

  function caseTestValue(c) {
    const test = c.test;
    if (t.isNumericLiteral(test) || t.isStringLiteral(test)) {
      return test.value;
    }
    return null;
  }

  function unflattenControlFlowPattern(path) {
    const whileStmt = path.node;
    if (!t.isBlockStatement(whileStmt.body)) return false;
    const switchStmt = whileStmt.body.body[0];
    if (!t.isSwitchStatement(switchStmt)) return false;
    if (!t.isIdentifier(switchStmt.discriminant)) return false;
    const stateName = switchStmt.discriminant.name;
    const cases = switchStmt.cases;
    const first = cases[0];
    if (!first || first.test === null) return false;

    const sequence = [];
    const visited = new Set();
    let current = first;

    while (current) {
      if (visited.has(current)) return false;
      visited.add(current);
      sequence.push(current);

      let nextValue = null;
      for (const stmt of current.consequent) {
        const update = extractStateUpdate(stmt, stateName);
        if (update !== undefined) nextValue = update;
      }
      if (nextValue === null) break;
      const nextCase = cases.find((c) => c.test !== null && caseTestValue(c) === nextValue);
      if (nextCase === undefined) return false;
      current = nextCase;
    }

    if (visited.size !== cases.length) return false;

    const flattened = sequence.flatMap((c) =>
      c.consequent.filter(
        (stmt) =>
          extractStateUpdate(stmt, stateName) === undefined &&
          !t.isBreakStatement(stmt) &&
          !t.isContinueStatement(stmt),
      ),
    );

    if (flattened.length === 0) return false;

    path.replaceWithMultiple(flattened);
    return true;
  }

  function isControlFlowFlatteningPattern(node) {
    if (!t.isBooleanLiteral(node.test) || !node.test.value) return false;
    if (!t.isBlockStatement(node.body)) return false;
    const firstStmt = node.body.body[0];
    return t.isSwitchStatement(firstStmt);
  }

  function restoreControlFlow(ast, warnings) {
    let count = 0;
    traverse(ast, {
      WhileStatement: (path) => {
        if (isControlFlowFlatteningPattern(path.node)) {
          try {
            if (!unflattenControlFlowPattern(path)) {
              warnings.push(
                'Unable to linearize while-switch control-flow pattern (cyclic or unreachable states); left in place',
              );
            } else {
              count += 1;
            }
          } catch {
            // Failed to unflatten a control-flow pattern; left in place.
          }
        }
      },
    });
    return count;
  }

  function removeDeadCode(ast) {
    let count = 0;
    traverse(ast, {
      IfStatement(path) {
        if (t.isBooleanLiteral(path.node.test)) {
          if (path.node.test.value) {
            path.replaceWith(path.node.consequent);
          } else {
            if (path.node.alternate) {
              path.replaceWith(path.node.alternate);
            } else {
              path.remove();
            }
          }
          count += 1;
        }
      },
    });
    return count;
  }

  function simplifyExpressions(ast) {
    let count = 0;
    traverse(ast, {
      BinaryExpression(path) {
        if (t.isNumericLiteral(path.node.left) && t.isNumericLiteral(path.node.right)) {
          const left = path.node.left.value;
          const right = path.node.right.value;
          let result;
          switch (path.node.operator) {
            case '+':
              result = left + right;
              break;
            case '-':
              result = left - right;
              break;
            case '*':
              result = left * right;
              break;
            case '/':
              result = left / right;
              break;
          }
          if (result !== undefined) {
            path.replaceWith(t.numericLiteral(result));
            count += 1;
          }
        }
      },
    });
    return count;
  }

  function deobfuscate(payload) {
    const options = payload.options || {};
    const code = payload.code;
    const removeDeadCodeFlag = options.removeDeadCode !== false;
    const restoreControlFlowFlag = options.restoreControlFlow !== false;
    const decryptStringsFlag = options.decryptStrings !== false;
    const simplifyExpressionsFlag = options.simplifyExpressions !== false;

    const transformations = [];
    const warnings = [];
    let currentCode = code;

    try {
      const ast = parser.parse(currentCode, {
        sourceType: 'unambiguous',
        plugins: ['jsx', 'typescript'],
        errorRecovery: true,
      });

      if (detectSelfDefending(ast)) {
        removeSelfDefending(ast);
        transformations.push('');
      }

      if (decryptStringsFlag) {
        const decrypted = decryptStrings(ast, warnings);
        if (decrypted > 0) {
          transformations.push(': ' + decrypted);
        }
      }

      if (restoreControlFlowFlag) {
        const restored = restoreControlFlow(ast, warnings);
        if (restored > 0) {
          transformations.push(': ' + restored);
        }
      }

      if (removeDeadCodeFlag) {
        const removed = removeDeadCode(ast);
        if (removed > 0) {
          transformations.push(': ' + removed);
        }
      }

      if (simplifyExpressionsFlag) {
        const simplified = simplifyExpressions(ast);
        if (simplified > 0) {
          transformations.push(': ' + simplified);
        }
      }

      const output = generate(ast, { comments: true, compact: false });
      currentCode = output.code;

      return {
        code: currentCode,
        success: true,
        transformations,
        warnings,
        confidence: calculateConfidence(transformations.length),
      };
    } catch (error) {
      return {
        code: currentCode,
        success: false,
        transformations,
        warnings: warnings.concat([String(error)]),
        confidence: 0,
      };
    }
  }

  parentPort.on('message', async (msg) => {
    const jobId = msg && msg.jobId;
    const payload = msg && msg.payload;
    try {
      await loadBabel(payload && payload.babelUrls);
      const code = payload && typeof payload.code === 'string' ? payload.code : '';
      const result = deobfuscate({ code, options: payload && payload.options });
      parentPort.postMessage({ jobId, ok: true, result });
    } catch (err) {
      parentPort.postMessage({
        jobId,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  });
};
__bootstrap().catch((error) => {
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error(
      'jscrambler worker bootstrap failed:',
      error && error.message ? error.message : String(error),
    );
  }
});
`;

let sharedPool: WorkerPool<Record<string, unknown>, JscramblerWorkerResult> | null = null;

/** Lazily create (and reuse) the shared JScrambler worker pool. */
export function getJscramblerPool(): JscramblerPool {
  if (!sharedPool) {
    sharedPool = new WorkerPool<Record<string, unknown>, JscramblerWorkerResult>({
      name: 'jscrambler',
      workerScript: JSCRAMBLER_WORKER_SCRIPT,
      minWorkers: JSCRAMBLER_POOL_MIN_WORKERS,
      maxWorkers: JSCRAMBLER_POOL_MAX_WORKERS,
      idleTimeoutMs: JSCRAMBLER_POOL_IDLE_TIMEOUT_MS,
      resourceLimits: {
        maxOldGenerationSizeMb: JSCRAMBLER_POOL_MAX_OLD_GEN_MB,
        maxYoungGenerationSizeMb: JSCRAMBLER_POOL_MAX_YOUNG_GEN_MB,
      },
    });
  }
  return sharedPool as JscramblerPool;
}
