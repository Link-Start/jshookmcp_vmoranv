import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
// TS 7.0 ships no compiler API; use the TS 6 compat package for AST access.
import ts from 'typescript6';

const TYPED_READER_NAMES = new Set([
  'autoInt',
  'bool',
  'csv',
  'float',
  'int',
  'list',
  'readEnvBoolean',
  'readEnvCsv',
  'readEnvFloat',
  'readEnvInteger',
  'readEnvIntegerList',
  'readEnvNullableString',
  'readEnvString',
  'str',
]);

const CONFIG_FALLBACK_HELPERS = new Set([
  'envBool',
  'envFloat',
  'envInt',
  'envString',
  'positiveEnvInt',
  'ratioEnvFloat',
]);

const CONFIG_EFFECTIVE_DEFAULTS = new Map<string, string>([
  ['MCP_TRANSPORT', 'stdio'],
  ['MCP_LOG_LEVEL', 'info'],
  ['MCP_TOOL_PROFILE', 'search'],
  ['MCP_BROWSER_FLEET_WORKERS_JSON', '[{"id":"local"}]'],
  ['SEARCH_VECTOR_ENABLED', 'false'],
  ['SEARCH_VECTOR_MODEL_ID', 'minishlab/potion-code-16M-v2'],
  ['MCP_PLUGIN_SIGNATURE_REQUIRED', 'false'],
  ['MCP_PLUGIN_STRICT_LOAD', 'false'],
]);

export interface StaticEnvironmentDefault {
  key: string;
  value?: string;
  expression: string;
  file: string;
  reader: string;
  nullable: boolean;
}

export interface DynamicEnvironmentReader {
  argument: string;
  file: string;
  reader: string;
}

export interface ProcessEnvironmentAccess {
  file: string;
  key: string;
}

interface SourceContext {
  declarations: ReadonlyMap<string, ts.Expression>;
  file: string;
  sourceFile: ts.SourceFile;
}

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
}

function propertyValue(object: unknown, key: string): unknown {
  return typeof object === 'object' && object !== null
    ? (object as Record<string, unknown>)[key]
    : undefined;
}

function evaluate(
  expression: ts.Expression,
  declarations: ReadonlyMap<string, ts.Expression>,
  seen = new Set<string>(),
): unknown {
  const node = unwrap(expression);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => evaluate(element as ts.Expression, declarations, seen));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property)) return [];
        const name = property.name.getText().replace(/^['"]|['"]$/gu, '');
        return [[name, evaluate(property.initializer, declarations, seen)]];
      }),
    );
  }
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined' || seen.has(node.text)) return undefined;
    const initializer = declarations.get(node.text);
    if (!initializer) return undefined;
    return evaluate(initializer, declarations, new Set(seen).add(node.text));
  }
  if (ts.isPropertyAccessExpression(node)) {
    return propertyValue(evaluate(node.expression, declarations, seen), node.name.text);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluate(node.operand, declarations, seen);
    if (typeof operand !== 'number') return undefined;
    if (node.operator === ts.SyntaxKind.MinusToken) return -operand;
    if (node.operator === ts.SyntaxKind.PlusToken) return operand;
    if (node.operator === ts.SyntaxKind.TildeToken) return ~operand;
    return undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left, declarations, seen);
    const right = evaluate(node.right, declarations, seen);
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return typeof left === 'number' && typeof right === 'number'
        ? left + right
        : typeof left === 'string' && typeof right === 'string'
          ? left + right
          : undefined;
    }
    if (typeof left !== 'number' || typeof right !== 'number') return undefined;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.SlashToken:
        return left / right;
      case ts.SyntaxKind.PercentToken:
        return left % right;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return left ** right;
      case ts.SyntaxKind.LessThanLessThanToken:
        return left << right;
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        return left >> right;
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        return left >>> right;
      case ts.SyntaxKind.BarToken:
        return left | right;
      case ts.SyntaxKind.AmpersandToken:
        return left & right;
      case ts.SyntaxKind.CaretToken:
        return left ^ right;
      default:
        return undefined;
    }
  }
  return undefined;
}

function serializeEnvironmentValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.replaceAll('\n', '\\n');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => ['string', 'number'].includes(typeof entry))) {
    return value.join(',');
  }
  return undefined;
}

function sourceContext(path: string, projectRoot: string): SourceContext {
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.Expression>();

  function index(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, index);
  }
  index(sourceFile);

  return {
    declarations,
    file: relative(projectRoot, path).replaceAll('\\', '/'),
    sourceFile,
  };
}

function staticEnvironmentKey(node: ts.Expression | undefined): string | undefined {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    /^[A-Z][A-Z0-9_]*$/u.test(node.text)
    ? node.text
    : undefined;
}

export function collectTypedEnvironmentReaders(
  paths: readonly string[],
  projectRoot: string,
): {
  defaults: StaticEnvironmentDefault[];
  dynamic: DynamicEnvironmentReader[];
} {
  const defaults: StaticEnvironmentDefault[] = [];
  const dynamic: DynamicEnvironmentReader[] = [];

  for (const path of paths) {
    const context = sourceContext(path, projectRoot);
    if (context.file === 'src/config/environment.ts') continue;

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const reader = node.expression.text;
        if (TYPED_READER_NAMES.has(reader)) {
          const key = staticEnvironmentKey(node.arguments[0]);
          if (key === undefined) {
            dynamic.push({
              argument: node.arguments[0]?.getText(context.sourceFile) ?? '<missing>',
              file: context.file,
              reader,
            });
          } else {
            const nullable = reader === 'readEnvNullableString';
            const fallback = nullable ? undefined : node.arguments[1];
            defaults.push({
              key,
              value: nullable
                ? ''
                : fallback === undefined
                  ? undefined
                  : serializeEnvironmentValue(evaluate(fallback, context.declarations)),
              expression: fallback?.getText(context.sourceFile) ?? '',
              file: context.file,
              reader,
              nullable,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(context.sourceFile);
  }

  return { defaults, dynamic };
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function findConfigFallback(node: ts.Node): ts.Expression | undefined {
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && CONFIG_FALLBACK_HELPERS.has(node.expression.text)) {
      return node.arguments[0];
    }
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'default') {
      return node.arguments[0];
    }
  }

  let found: ts.Expression | undefined;
  ts.forEachChild(node, (child) => {
    found ??= findConfigFallback(child);
  });
  return found;
}

export function collectCentralConfigDefaults(
  configPath: string,
  projectRoot: string,
): StaticEnvironmentDefault[] {
  const context = sourceContext(configPath, projectRoot);
  let configObject: ts.ObjectLiteralExpression | undefined;

  function findSchema(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ConfigSchema' &&
      node.initializer !== undefined
    ) {
      const initializer = unwrap(node.initializer);
      const firstArgument = ts.isCallExpression(initializer) ? initializer.arguments[0] : undefined;
      const objectArgument =
        firstArgument !== undefined && ts.isObjectLiteralExpression(firstArgument)
          ? firstArgument
          : undefined;
      if (objectArgument) configObject = objectArgument;
    }
    if (!configObject) ts.forEachChild(node, findSchema);
  }
  findSchema(context.sourceFile);

  if (!configObject) throw new Error('ConfigSchema must remain statically discoverable');

  return configObject.properties.flatMap((property): StaticEnvironmentDefault[] => {
    if (!ts.isPropertyAssignment(property)) return [];
    const key = propertyName(property.name);
    if (key === undefined || key === 'NODE_ENV' || key === 'MCP_SERVER_VERSION') return [];

    const effectiveDefault = CONFIG_EFFECTIVE_DEFAULTS.get(key);
    const fallback = findConfigFallback(property.initializer);
    const evaluated = fallback === undefined ? undefined : evaluate(fallback, context.declarations);
    const value = effectiveDefault ?? serializeEnvironmentValue(evaluated) ?? '';

    return [
      {
        key,
        value,
        expression: effectiveDefault ?? fallback?.getText(context.sourceFile) ?? '<optional>',
        file: context.file,
        reader: 'ConfigSchema',
        nullable: fallback === undefined,
      },
    ];
  });
}

function isProcessEnvironment(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

export function collectProcessEnvironmentAccesses(
  paths: readonly string[],
  projectRoot: string,
): ProcessEnvironmentAccess[] {
  const accesses: ProcessEnvironmentAccess[] = [];

  for (const path of paths) {
    const context = sourceContext(path, projectRoot);

    function visit(node: ts.Node): void {
      if (isProcessEnvironment(node)) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          accesses.push({ file: context.file, key: parent.name.text });
        } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
          const argument = parent.argumentExpression;
          accesses.push({
            file: context.file,
            key:
              argument &&
              (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
                ? argument.text
                : '<dynamic>',
          });
        } else {
          accesses.push({ file: context.file, key: '<all>' });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(context.sourceFile);
  }

  return accesses;
}
