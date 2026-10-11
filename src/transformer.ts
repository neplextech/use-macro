import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { NodePath, Binding } from '@babel/traverse';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import { parse, parseExpression, type ParserOptions } from '@babel/parser';
import * as t from '@babel/types';
import { esbuildMacroCompiler, type CompileMacroResult, type MacroCompiler } from './compiler.js';
import { stringify } from './stringify.js';

declare global {
  /** Available while a trusted macro executes. Registers a non-module file as a build dependency. */
  function trackFile(...files: string[]): void;
}

const traverse = ((_traverse as any).default ?? _traverse) as typeof import('@babel/traverse').default;
const generate = ((_generate as any).default ?? _generate) as typeof import('@babel/generator').default;
type AnyPath = NodePath<any>;

export interface MacroExecutionOptions {
  /** Restricted execution fails closed until an enforceable isolation backend is configured. */
  mode?: 'restricted' | 'trusted';
  /** Maximum time for one macro call. The worker is terminated when this expires. */
  timeoutMs?: number;
  /** Maximum UTF-8 size of serialized arguments and results. Defaults to 1 MiB. */
  maxOutputBytes?: number;
  /** Environment passed to the macro worker. Defaults to an empty environment. */
  env?: Record<string, string>;
  /** Cancels compilation and active macro calls. */
  signal?: AbortSignal;
}

export interface MacroTransformerOptions {
  /** Transform macro calls from files in node_modules. Defaults to false. */
  transformDependencies?: boolean;
  /** Include/exclude decisions apply to source modules passed to transformSource. */
  include?: (filePath: string) => boolean;
  exclude?: (filePath: string) => boolean;
  execution?: MacroExecutionOptions;
  compiler?: MacroCompiler;
}

export interface TransformOptions {
  filename: string;
  source?: string;
  signal?: AbortSignal;
}

export interface TransformResult {
  code: string;
  map?: object | undefined;
  changed: boolean;
  /** Files imported by macros and files registered with trackFile(). */
  watchFiles: string[];
}

export interface AstTransformResult {
  ast: t.File;
  changed: boolean;
  watchFiles: string[];
}

export class MacroTransformError extends Error {
  readonly filePath: string;
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(
    message: string,
    filePath: string,
    loc?: { line: number; column: number },
    options?: { cause?: unknown },
  ) {
    super(`${filePath}${loc ? `:${loc.line}:${loc.column + 1}` : ''}: ${message}`);
    if (options && 'cause' in options)
      Object.defineProperty(this, 'cause', { configurable: true, value: options.cause });
    this.name = 'MacroTransformError';
    this.filePath = filePath;
    this.line = loc?.line;
    this.column = loc?.column;
  }
}

interface ModuleInfo {
  filePath: string;
  source: string;
  ast: t.File;
}

interface MacroDefinition {
  filePath: string;
  module: ModuleInfo;
  name: string;
  functionPath: AnyPath;
  bindingPath?: AnyPath | undefined;
  variablePath?: AnyPath | undefined;
  identity: string;
}

interface MacroCall {
  path: AnyPath;
  definition: MacroDefinition;
  binding?: Binding;
  namespaceBinding?: Binding;
}

class MacroCallFailure {
  constructor(
    readonly call: MacroCall,
    readonly error: unknown,
  ) {}
}

interface ParsedCacheEntry {
  hash: string;
  module: ModuleInfo;
}

interface CompiledCacheEntry {
  result: CompileMacroResult;
  dependencyHashes: Map<string, string>;
}

interface MacroRunResult {
  source: string;
  trackedFiles: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const PARSED_MODULE_CACHE_LIMIT = 256;
const nodeBuiltins = new Set(
  builtinModules.flatMap((moduleName) => {
    const bareName = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
    return [bareName, `node:${bareName}`];
  }),
);

const hash = (source: string): string => createHash('sha256').update(source).digest('hex');
const isNodeModulesPath = (path: string): boolean => path.split(sep).includes('node_modules');
const isMacroDirective = (node: t.Function): boolean =>
  t.isBlockStatement(node.body) && node.body.directives.some((directive) => directive.value.value === 'use macro');

function parserOptions(filePath: string): ParserOptions {
  const extension = extname(filePath).toLowerCase();
  return {
    sourceType: 'unambiguous',
    sourceFilename: filePath,
    plugins: [
      ...(['.ts', '.tsx', '.mts', '.cts'].includes(extension) ? ['typescript' as const] : []),
      ...(['.jsx', '.tsx'].includes(extension) ? ['jsx' as const] : []),
      'decorators-legacy',
      'importAttributes',
      'explicitResourceManagement',
      'topLevelAwait',
    ],
  };
}

function sourceLooksRelevant(source: string): boolean {
  return source.includes('use macro') || /\b(?:import|export)\b/.test(source);
}

function isPathInside(candidate: AnyPath, parent: AnyPath): boolean {
  let current: AnyPath | null = candidate;
  while (current) {
    if (current.node === parent.node) return true;
    current = current.parentPath;
  }
  return false;
}

function sourcePosition(path: AnyPath): number {
  return path.node.start ?? Number.MAX_SAFE_INTEGER;
}

function unwrapTypeScriptNode(path: AnyPath): AnyPath {
  let current = path;
  while (
    current.isTSAsExpression() ||
    current.isTSTypeAssertion() ||
    current.isTSNonNullExpression() ||
    current.isTSSatisfiesExpression() ||
    current.isTypeCastExpression() ||
    current.isParenthesizedExpression()
  ) {
    current = current.get('expression') as AnyPath;
  }
  return current;
}

function evaluateStatic(path: AnyPath, resolving = new Set<Binding>()): unknown {
  const valuePath = unwrapTypeScriptNode(path);
  const node = valuePath.node;

  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isBigIntLiteral(node)) return BigInt(node.value);
  if (t.isRegExpLiteral(node)) return new RegExp(node.pattern, node.flags);
  if (t.isIdentifier(node)) {
    if (node.name === 'undefined') return undefined;
    const binding = valuePath.scope.getBinding(node.name);
    if (!binding) throw new TypeError(`Identifier ${node.name} is not a static value.`);
    if (resolving.has(binding)) throw new TypeError(`Static value ${node.name} is circular.`);
    if (!binding.constant || !binding.path.isVariableDeclarator() || !binding.path.get('init').node) {
      throw new TypeError(`Identifier ${node.name} is not an immutable static constant.`);
    }
    const declaration = binding.path.parentPath;
    if (!declaration?.isVariableDeclaration({ kind: 'const' })) {
      throw new TypeError(`Identifier ${node.name} must be declared with const to be used as a macro argument.`);
    }
    resolving.add(binding);
    try {
      return evaluateStatic(binding.path.get('init') as AnyPath, resolving);
    } finally {
      resolving.delete(binding);
    }
  }
  if (t.isTemplateLiteral(node)) {
    let result = node.quasis[0]?.value.cooked ?? '';
    for (let index = 0; index < node.expressions.length; index += 1) {
      const expression = evaluateStatic(valuePath.get(`expressions.${index}`) as AnyPath, resolving);
      if (expression !== null && !['string', 'number', 'bigint', 'boolean', 'undefined'].includes(typeof expression)) {
        throw new TypeError('Template substitutions in macro arguments must be primitive static values.');
      }
      result += String(expression) + (node.quasis[index + 1]?.value.cooked ?? '');
    }
    return result;
  }
  if (t.isArrayExpression(node)) {
    const result: unknown[] = new Array(node.elements.length);
    for (let index = 0; index < node.elements.length; index += 1) {
      const element = node.elements[index];
      if (element === null) continue;
      if (t.isSpreadElement(element))
        throw new TypeError('Spread elements are not supported in static macro arguments.');
      result[index] = evaluateStatic(valuePath.get(`elements.${index}`) as AnyPath, resolving);
    }
    return result;
  }
  if (t.isObjectExpression(node)) {
    const result: Record<string, unknown> = {};
    for (let index = 0; index < node.properties.length; index += 1) {
      const property = node.properties[index];
      if (!t.isObjectProperty(property)) {
        throw new TypeError('Static macro arguments cannot contain spreads, methods, getters, or setters.');
      }
      const propertyPath = valuePath.get(`properties.${index}`) as AnyPath;
      const key = property.computed
        ? evaluateStatic(propertyPath.get('key') as AnyPath, resolving)
        : t.isIdentifier(property.key)
          ? property.key.name
          : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
            ? property.key.value
            : undefined;
      if (!['string', 'number', 'bigint'].includes(typeof key)) {
        throw new TypeError('Object keys in static macro arguments must be static strings or numbers.');
      }
      const propertyValue = property.shorthand
        ? evaluateStatic(propertyPath.get('value') as AnyPath, resolving)
        : evaluateStatic(propertyPath.get('value') as AnyPath, resolving);
      Object.defineProperty(result, String(key), {
        configurable: true,
        enumerable: true,
        writable: true,
        value: propertyValue,
      });
    }
    return result;
  }
  if (t.isUnaryExpression(node)) {
    const argument = evaluateStatic(valuePath.get('argument') as AnyPath, resolving) as any;
    switch (node.operator) {
      case '+':
        return +argument;
      case '-':
        return -argument;
      case '!':
        return !argument;
      case '~':
        return ~argument;
      case 'void':
        return undefined;
      case 'typeof':
        return typeof argument;
      default:
        throw new TypeError(`Unary operator ${node.operator} is not supported in static macro arguments.`);
    }
  }
  if (t.isBinaryExpression(node)) {
    const left = evaluateStatic(valuePath.get('left') as AnyPath, resolving) as any;
    const right = evaluateStatic(valuePath.get('right') as AnyPath, resolving) as any;
    switch (node.operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return left / right;
      case '%':
        return left % right;
      case '**':
        return left ** right;
      case '===':
        return left === right;
      case '!==':
        return left !== right;
      case '==':
        // biome-ignore lint/suspicious/noDoubleEquals: Static macro expressions must match JavaScript semantics.
        return left == right;
      case '!=':
        // biome-ignore lint/suspicious/noDoubleEquals: Static macro expressions must match JavaScript semantics.
        return left != right;
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      case '|':
        return left | right;
      case '&':
        return left & right;
      case '^':
        return left ^ right;
      case '<<':
        return left << right;
      case '>>':
        return left >> right;
      case '>>>':
        return left >>> right;
      default:
        throw new TypeError(`Binary operator ${node.operator} is not supported in static macro arguments.`);
    }
  }
  if (t.isLogicalExpression(node)) {
    const left = evaluateStatic(valuePath.get('left') as AnyPath, resolving) as any;
    if (node.operator === '&&') return left && evaluateStatic(valuePath.get('right') as AnyPath, resolving);
    if (node.operator === '||') return left || evaluateStatic(valuePath.get('right') as AnyPath, resolving);
    return left ?? evaluateStatic(valuePath.get('right') as AnyPath, resolving);
  }
  if (t.isConditionalExpression(node)) {
    return evaluateStatic(valuePath.get('test') as AnyPath, resolving)
      ? evaluateStatic(valuePath.get('consequent') as AnyPath, resolving)
      : evaluateStatic(valuePath.get('alternate') as AnyPath, resolving);
  }
  if (t.isSequenceExpression(node)) {
    let result: unknown;
    for (let index = 0; index < node.expressions.length; index += 1) {
      result = evaluateStatic(valuePath.get(`expressions.${index}`) as AnyPath, resolving);
    }
    return result;
  }
  if (t.isMemberExpression(node) && !node.optional) {
    const object = evaluateStatic(valuePath.get('object') as AnyPath, resolving);
    const property = node.computed
      ? evaluateStatic(valuePath.get('property') as AnyPath, resolving)
      : t.isIdentifier(node.property)
        ? node.property.name
        : undefined;
    if ((typeof object !== 'object' && typeof object !== 'string') || object === null) {
      throw new TypeError('Member access in macro arguments requires a static object or string.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, String(property));
    if (!descriptor || !('value' in descriptor))
      throw new TypeError('Macro arguments cannot read getters or missing properties.');
    return descriptor.value;
  }
  if (t.isNewExpression(node)) {
    const args = node.arguments.map((argument, index) => {
      if (t.isSpreadElement(argument))
        throw new TypeError('Spread elements are not supported in static macro arguments.');
      return evaluateStatic(valuePath.get(`arguments.${index}`) as AnyPath, resolving);
    });
    if (t.isIdentifier(node.callee)) {
      switch (node.callee.name) {
        case 'Date':
          return new Date(...(args as [any]));
        case 'RegExp':
          return new RegExp(...(args as [any, any]));
        case 'URL':
          return new URL(...(args as [any, any]));
        case 'URLSearchParams':
          return new URLSearchParams(...(args as [any]));
        case 'Map':
          return new Map(...(args as [any]));
        case 'Set':
          return new Set(...(args as [any]));
        case 'Uint8Array':
          return new Uint8Array(...(args as [any]));
        case 'Int8Array':
          return new Int8Array(...(args as [any]));
        case 'Uint16Array':
          return new Uint16Array(...(args as [any]));
        case 'Int16Array':
          return new Int16Array(...(args as [any]));
        case 'Uint32Array':
          return new Uint32Array(...(args as [any]));
        case 'Int32Array':
          return new Int32Array(...(args as [any]));
        case 'Float32Array':
          return new Float32Array(...(args as [any]));
        case 'Float64Array':
          return new Float64Array(...(args as [any]));
        default:
          break;
      }
    }
    throw new TypeError(
      'Only Date, RegExp, URL, URLSearchParams, Map, Set, and typed-array constructors are supported in static macro arguments.',
    );
  }
  throw new TypeError(`Expression ${node.type} is not a supported static macro argument.`);
}

function getFunctionBinding(
  path: AnyPath,
): { name: string; bindingPath?: AnyPath | undefined; variablePath?: AnyPath | undefined } | undefined {
  if (path.isFunctionDeclaration() && path.node.id) {
    const name = path.node.id.name;
    const binding = path.scope.getBinding(name);
    return { name, bindingPath: binding?.path as AnyPath | undefined };
  }
  const variable = path.parentPath?.isVariableDeclarator() ? path.parentPath : undefined;
  if (variable && t.isIdentifier(variable.node.id) && variable.node.init === path.node) {
    const name = variable.node.id.name;
    const binding = variable.scope.getBinding(name);
    return { name, bindingPath: binding?.path as AnyPath | undefined, variablePath: variable };
  }
  const defaultExport = path.parentPath?.isExportDefaultDeclaration();
  if (defaultExport) {
    return { name: 'default' };
  }
  return undefined;
}

function moduleStatementFor(bindingPath: AnyPath): AnyPath | undefined {
  let current: AnyPath | null = bindingPath;
  while (current?.parentPath && !current.parentPath.isProgram()) current = current.parentPath;
  return current?.parentPath?.isProgram() ? current : undefined;
}

function moduleImportSpecifier(path: AnyPath): AnyPath | undefined {
  if (path.isImportSpecifier() || path.isImportDefaultSpecifier() || path.isImportNamespaceSpecifier()) return path;
  return undefined;
}

function locationOf(path: AnyPath): { line: number; column: number } | undefined {
  const start = path.node.loc?.start;
  return start ? { line: start.line, column: start.column } : undefined;
}

function mapExpressionToCallSite(expression: t.Expression, callPath: AnyPath): void {
  const { loc, start, end } = callPath.node;
  if (!loc) return;
  t.traverseFast(expression, (node) => {
    node.loc = structuredClone(loc);
    node.start = start;
    node.end = end;
  });
}

function memberReference(node: t.Node): { object: t.Identifier; name: string } | undefined {
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return undefined;
  if (!t.isIdentifier(node.object)) return undefined;
  if (node.computed && !t.isStringLiteral(node.property)) return undefined;
  const name = node.computed ? (node.property as t.StringLiteral).value : (node.property as t.Identifier).name;
  return { object: node.object, name };
}

function encodeDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const macroWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
globalThis.__dirname = workerData.dirname;
globalThis.__filename = workerData.filename;
globalThis.require = createRequire(workerData.filename);
let currentTracked = new Set();
const sensitiveValues = Object.entries(process.env)
  .filter(([name, value]) => value && /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|API_KEY|AUTH)/i.test(name))
  .map(([, value]) => value)
  .filter((value) => value.length >= 8);
const redact = (message) => sensitiveValues.reduce((result, value) => result.replaceAll(value, '[redacted]'), message);
globalThis.trackFile = (...files) => {
  for (const file of files) {
    if (typeof file !== 'string') throw new TypeError('trackFile() expects string paths.');
    currentTracked.add(resolve(workerData.dirname, file));
  }
};
let macro;
let stringify;
parentPort.on('message', async ({ id, argsUrl, maxOutputBytes }) => {
  currentTracked = new Set();
  try {
    if (!macro) {
      const module = await import(workerData.moduleUrl);
      macro = module.__useMacro;
      ({ stringify } = await import(workerData.serializerUrl));
    }
    const argsModule = await import(argsUrl);
    const result = await macro(...argsModule.default);
    const source = await stringify(result);
    if (Buffer.byteLength(source, 'utf8') > maxOutputBytes) {
      throw new Error('Serialized macro result exceeds the ' + maxOutputBytes + ' byte limit.');
    }
    if (sensitiveValues.some((value) => source.includes(value))) {
      throw new Error('Macro result contains a configured secret value and was not emitted.');
    }
    parentPort.postMessage({ id, source, trackedFiles: [...currentTracked] });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        name: redact(String(error && error.name || 'Error')),
        message: redact(String(error && error.message || 'Macro execution failed.')),
      },
      trackedFiles: [...currentTracked],
    });
  }
});
`;

class MacroWorkerRunner {
  private worker: Worker | undefined;
  private current:
    | {
        id: number;
        resolve: (result: MacroRunResult) => void;
        reject: (error: Error) => void;
        cleanup: () => void;
      }
    | undefined;
  private nextId = 1;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly moduleUrl: string,
    private readonly dirname: string,
    private readonly filename: string,
    private readonly serializerUrl: string,
    private readonly timeoutMs: number,
    private readonly environment: Record<string, string>,
  ) {}

  run(argumentSources: string[], signal: AbortSignal | undefined, maxOutputBytes: number): Promise<MacroRunResult> {
    const task = this.queue.then(() => this.runOne(argumentSources, signal, maxOutputBytes));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(macroWorkerSource, {
      eval: true,
      workerData: {
        moduleUrl: this.moduleUrl,
        dirname: this.dirname,
        filename: this.filename,
        serializerUrl: this.serializerUrl,
      },
      env: this.environment,
    });
    worker.unref();
    worker.on('message', (message: any) => {
      if (!this.current || message.id !== this.current.id) return;
      const pending = this.current;
      this.current = undefined;
      pending.cleanup();
      worker.unref();
      if (message.error) {
        const error = new Error(`${message.error.name}: ${message.error.message}`);
        error.name = 'MacroExecutionError';
        pending.reject(error);
      } else {
        pending.resolve({ source: message.source, trackedFiles: message.trackedFiles ?? [] });
      }
    });
    worker.on('error', (error) => {
      if (this.worker === worker) this.failCurrent(error instanceof Error ? error : new Error(String(error)));
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      if (code !== 0) this.failCurrent(new Error(`Macro worker exited with code ${code}.`));
      this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private failCurrent(error: Error): void {
    if (!this.current) return;
    const pending = this.current;
    this.current = undefined;
    pending.cleanup();
    pending.reject(error);
  }

  private async runOne(
    argumentSources: string[],
    signal: AbortSignal | undefined,
    maxOutputBytes: number,
  ): Promise<MacroRunResult> {
    if (signal?.aborted) throw new Error('Macro execution was cancelled.');
    const argsSource = `export default [${argumentSources.join(',')}];`;
    if (Buffer.byteLength(argsSource, 'utf8') > maxOutputBytes) {
      throw new Error(`Serialized macro arguments exceed the ${maxOutputBytes} byte limit.`);
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const argsUrl = encodeDataUrl(argsSource);
    return await new Promise<MacroRunResult>((resolveResult, rejectResult) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const terminate = (error: Error) => {
        finish(() => {
          if (this.current?.id === id) this.current = undefined;
          this.worker = undefined;
          void worker.terminate();
          rejectResult(error);
        });
      };
      const onAbort = () => terminate(new Error('Macro execution was cancelled.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      timeout = setTimeout(
        () => terminate(new Error(`Macro execution exceeded ${this.timeoutMs} ms.`)),
        this.timeoutMs,
      );
      this.current = {
        id,
        cleanup: () => {
          if (timeout) clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
        },
        resolve: (result) => finish(() => resolveResult(result)),
        reject: (error) => finish(() => rejectResult(error)),
      };
      worker.ref();
      worker.postMessage({ id, argsUrl, maxOutputBytes });
    });
  }
}

export class MacroTransformer implements AsyncDisposable {
  private readonly compiler: MacroCompiler;
  private readonly parsedModules = new Map<string, ParsedCacheEntry>();
  private readonly compiledMacros = new Map<string, CompiledCacheEntry>();
  private readonly compileInFlight = new Map<string, Promise<CompiledCacheEntry>>();
  private readonly workers = new Map<string, MacroWorkerRunner>();
  private readonly execution: {
    mode: 'restricted' | 'trusted';
    timeoutMs: number;
    maxOutputBytes: number;
    env: Record<string, string>;
    signal: AbortSignal | undefined;
  };
  private readonly transformDependencies: boolean;
  private readonly include: ((filePath: string) => boolean) | undefined;
  private readonly exclude: ((filePath: string) => boolean) | undefined;

  constructor(options: MacroTransformerOptions = {}) {
    this.compiler = options.compiler ?? esbuildMacroCompiler;
    this.execution = {
      mode: options.execution?.mode ?? 'restricted',
      timeoutMs: options.execution?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.execution?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      env: { ...(options.execution?.env ?? {}) },
      signal: options.execution?.signal,
    };
    if (this.execution.timeoutMs <= 0) throw new TypeError('execution.timeoutMs must be greater than zero.');
    if (this.execution.maxOutputBytes <= 0) throw new TypeError('execution.maxOutputBytes must be greater than zero.');
    this.transformDependencies = options.transformDependencies ?? false;
    this.include = options.include;
    this.exclude = options.exclude;
  }

  /** Parse, transform, and generate source. Unchanged sources are returned without generation. */
  async transformSource(
    source: string,
    filename: string,
    options: Omit<TransformOptions, 'filename' | 'source'> = {},
  ): Promise<TransformResult> {
    const absolutePath = resolve(filename);
    if (this.isExcluded(absolutePath) || !sourceLooksRelevant(source)) {
      return { code: source, changed: false, watchFiles: [] };
    }
    const sourceHash = hash(source);
    let ast: t.File;
    const cached = this.parsedModules.get(absolutePath);
    if (cached?.hash === sourceHash) {
      this.parsedModules.delete(absolutePath);
      this.parsedModules.set(absolutePath, cached);
      ast = t.cloneNode(cached.module.ast, true);
    } else {
      try {
        ast = parse(source, parserOptions(absolutePath));
      } catch (error) {
        throw this.asDiagnostic(error, absolutePath);
      }
      this.cacheParsedModule(absolutePath, source, ast);
      ast = t.cloneNode(ast, true);
    }
    return this.transformAst(ast, {
      filename: absolutePath,
      source,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** Backwards-compatible standalone transform method. The result is bundler-independent. */
  transform(source: string, filename: string): Promise<TransformResult> {
    return this.transformSource(source, filename);
  }

  /**
   * Transform a Babel File/Program AST and generate source maps for standalone callers.
   */
  async transformAst(ast: t.File | t.Program, options: TransformOptions): Promise<TransformResult> {
    const source = options.source ?? generate(t.isFile(ast) ? ast : t.file(ast)).code;
    const transformed = await this.transformAstInPlace(ast, { ...options, source });
    if (!transformed.changed) return { code: source, changed: false, watchFiles: transformed.watchFiles };
    const output = generate(
      transformed.ast,
      {
        sourceMaps: true,
        sourceFileName: resolve(options.filename),
        retainLines: false,
        comments: true,
      },
      source,
    );
    return { code: output.code, map: output.map ?? undefined, changed: true, watchFiles: transformed.watchFiles };
  }

  /**
   * Mutate a Babel AST without parsing or generating the host source. Babel can generate
   * the transformed AST once in its own pipeline after this asynchronous preprocessing step.
   */
  async transformAstInPlace(ast: t.File | t.Program, options: TransformOptions): Promise<AstTransformResult> {
    const filename = resolve(options.filename);
    const fileAst = t.isFile(ast) ? ast : t.file(ast);
    if (this.isExcluded(filename)) {
      return { ast: fileAst, changed: false, watchFiles: [] };
    }
    const source = options.source ?? '';
    const module: ModuleInfo = { filePath: filename, source, ast: fileAst };
    let definitions: MacroDefinition[];
    try {
      definitions = this.collectDefinitions(module);
    } catch (error) {
      throw this.asDiagnostic(error, filename);
    }

    const calls: MacroCall[] = [];
    const importedMacroBindings = new Map<Binding, MacroDefinition>();
    const importedNamespaceBindings = new Map<Binding, string>();
    const namespaceMemberDefinitions = new Map<Binding, Map<string, MacroDefinition>>();
    const macroReexports = new Set<t.ExportSpecifier>();
    const watchFiles = new Set<string>();

    await this.discoverImportedMacros(
      module,
      fileAst,
      importedMacroBindings,
      importedNamespaceBindings,
      namespaceMemberDefinitions,
      macroReexports,
      watchFiles,
    );

    const macroDefinitionsByBinding = new Map<Binding, MacroDefinition>();
    for (const definition of definitions) {
      if (definition.bindingPath) {
        const binding = definition.bindingPath.scope.getBinding(definition.name);
        if (binding) macroDefinitionsByBinding.set(binding, definition);
      }
    }

    traverse(fileAst, {
      CallExpression: (path) =>
        this.collectCall(
          path,
          definitions,
          macroDefinitionsByBinding,
          importedMacroBindings,
          importedNamespaceBindings,
          namespaceMemberDefinitions,
          calls,
        ),
      OptionalCallExpression: (path) =>
        this.collectCall(
          path,
          definitions,
          macroDefinitionsByBinding,
          importedMacroBindings,
          importedNamespaceBindings,
          namespaceMemberDefinitions,
          calls,
        ),
      NewExpression: (path) => {
        if (definitions.some((definition) => isPathInside(path, definition.functionPath))) return;
        const member = memberReference(path.node.callee);
        const binding = t.isIdentifier(path.node.callee)
          ? path.scope.getBinding(path.node.callee.name)
          : member
            ? path.scope.getBinding(member.object.name)
            : undefined;
        const macro = binding
          ? (macroDefinitionsByBinding.get(binding) ??
            importedMacroBindings.get(binding) ??
            (member ? namespaceMemberDefinitions.get(binding)?.get(member.name) : undefined))
          : undefined;
        if (macro)
          throw new MacroTransformError(`Macro ${macro.name} cannot be called with new.`, filename, locationOf(path));
      },
    });

    this.validateMacroReferences(filename, definitions, importedMacroBindings, namespaceMemberDefinitions, calls);

    const localDefinitionCalls = calls.filter((call) => definitions.includes(call.definition));
    const importedCalls = calls.filter((call) => !definitions.includes(call.definition));
    if (
      !localDefinitionCalls.length &&
      !importedCalls.length &&
      !definitions.length &&
      importedMacroBindings.size === 0 &&
      macroReexports.size === 0
    ) {
      return { ast: fileAst, changed: false, watchFiles: [...watchFiles].sort() };
    }

    const activeSignal = options.signal ?? this.execution.signal;
    const macroOnlyBindings = this.collectMacroOnlyBindings(definitions);
    try {
      await this.executeCalls(calls, activeSignal, watchFiles);
    } catch (error) {
      if (error instanceof MacroCallFailure) {
        throw new MacroTransformError(this.errorMessage(error.error), filename, locationOf(error.call.path), {
          cause: error.error,
        });
      }
      throw this.asDiagnostic(error, filename);
    }

    this.removeMacroReexports(
      fileAst,
      macroDefinitionsByBinding,
      importedMacroBindings,
      importedNamespaceBindings,
      macroReexports,
    );
    this.removeMacroOnlyImports(fileAst, definitions, importedMacroBindings, importedNamespaceBindings);
    for (const definition of definitions) this.removeMacroDefinition(definition);
    this.removeImportedMacroReferences(fileAst, importedMacroBindings, importedNamespaceBindings);
    this.removeUnusedMacroDependencies(fileAst, macroOnlyBindings);
    this.removeMacroDependencyImports(fileAst, macroOnlyBindings);

    return { ast: fileAst, changed: true, watchFiles: [...watchFiles].sort() };
  }

  /** Stop retained macro workers and release in-memory caches. */
  async dispose(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.dispose()));
    this.workers.clear();
    this.compiledMacros.clear();
    this.compileInFlight.clear();
    this.parsedModules.clear();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  private isExcluded(filename: string): boolean {
    if (this.exclude?.(filename)) return true;
    if (this.include && !this.include(filename)) return true;
    return !this.transformDependencies && isNodeModulesPath(filename);
  }

  private cacheParsedModule(filePath: string, source: string, ast: t.File): void {
    this.parsedModules.delete(filePath);
    this.parsedModules.set(filePath, { hash: hash(source), module: { filePath, source, ast } });
    while (this.parsedModules.size > PARSED_MODULE_CACHE_LIMIT) {
      const oldest = this.parsedModules.keys().next().value as string | undefined;
      if (!oldest) break;
      this.parsedModules.delete(oldest);
    }
  }

  private async loadModule(filePath: string): Promise<ModuleInfo | undefined> {
    const absolutePath = resolve(filePath);
    if (this.isExcluded(absolutePath)) return undefined;
    let source: string;
    try {
      source = await readFile(absolutePath, 'utf8');
    } catch {
      return undefined;
    }
    const sourceHash = hash(source);
    const cached = this.parsedModules.get(absolutePath);
    if (cached?.hash === sourceHash) {
      this.parsedModules.delete(absolutePath);
      this.parsedModules.set(absolutePath, cached);
      return cached.module;
    }
    let ast: t.File;
    try {
      ast = parse(source, parserOptions(absolutePath));
    } catch {
      return undefined;
    }
    this.cacheParsedModule(absolutePath, source, ast);
    return { filePath: absolutePath, source, ast };
  }

  private async resolveModule(importerPath: string, specifier: string): Promise<string | undefined> {
    if (nodeBuiltins.has(specifier)) return undefined;
    const base = isAbsolute(specifier)
      ? specifier
      : specifier.startsWith('.')
        ? resolve(dirname(importerPath), specifier)
        : undefined;
    if (base) {
      const candidates = [base];
      const extension = extname(base);
      if (extension) {
        const replacement = base.slice(0, -extension.length);
        if (['.js', '.mjs', '.cjs'].includes(extension))
          candidates.push(`${replacement}.ts`, `${replacement}.tsx`, `${replacement}.mts`, `${replacement}.cts`);
      } else {
        for (const item of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
          candidates.push(`${base}${item}`);
      }
      candidates.push(...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((item) => resolve(base, `index${item}`)));
      for (const candidate of candidates) {
        try {
          await readFile(candidate);
          return resolve(candidate);
        } catch {
          // Try the next Node/TypeScript source extension.
        }
      }
      return undefined;
    }
    try {
      return createRequire(importerPath).resolve(specifier);
    } catch {
      return undefined;
    }
  }

  private collectDefinitions(module: ModuleInfo): MacroDefinition[] {
    const definitions: MacroDefinition[] = [];
    traverse(module.ast, {
      FunctionDeclaration: (path) => this.addDefinitionIfMacro(path, module, definitions),
      FunctionExpression: (path) => this.addDefinitionIfMacro(path, module, definitions),
      ArrowFunctionExpression: (path) => this.addDefinitionIfMacro(path, module, definitions),
    });
    return definitions;
  }

  private addDefinitionIfMacro(path: AnyPath, module: ModuleInfo, definitions: MacroDefinition[]): void {
    if (!t.isFunction(path.node) || !isMacroDirective(path.node)) return;
    const declaration = getFunctionBinding(path);
    if (!declaration) {
      throw new MacroTransformError(
        'A macro must be a function declaration or a function assigned directly to a variable.',
        module.filePath,
        locationOf(path),
      );
    }
    const bindingPath = declaration.bindingPath;
    if (!path.parentPath?.isExportDefaultDeclaration() && (!bindingPath || !moduleStatementFor(bindingPath))) {
      throw new MacroTransformError(
        'Macros must be declared at module scope so their dependencies can be resolved.',
        module.filePath,
        locationOf(path),
      );
    }
    const start = path.node.start ?? 0;
    definitions.push({
      filePath: module.filePath,
      module,
      name: declaration.name,
      functionPath: path,
      bindingPath,
      variablePath: declaration.variablePath,
      identity: `${module.filePath}#${declaration.name}:${start}`,
    });
  }

  private async resolveExportedMacro(
    filePath: string,
    exportName: string,
    visited = new Set<string>(),
  ): Promise<MacroDefinition | undefined> {
    const absolutePath = resolve(filePath);
    const visitKey = `${absolutePath}#${exportName}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);
    const module = await this.loadModule(absolutePath);
    if (!module) return undefined;
    const definitions = this.collectDefinitions(module);
    const programPath = module.ast.program;

    for (const statement of programPath.body) {
      if (t.isExportDefaultDeclaration(statement) && exportName === 'default') {
        const direct = definitions.find((definition) => definition.functionPath.node === statement.declaration);
        if (direct) return direct;
        if (t.isIdentifier(statement.declaration)) {
          return this.resolveLocalMacro(module, definitions, statement.declaration.name, visited);
        }
      }
      if (!t.isExportNamedDeclaration(statement)) continue;
      if (statement.declaration) {
        const declaredNames = this.declaredNames(statement.declaration);
        if (declaredNames.includes(exportName)) {
          const direct = definitions.find((definition) => definition.name === exportName);
          if (direct) return direct;
        }
      }
      for (const specifier of statement.specifiers) {
        if (!t.isExportSpecifier(specifier) || this.exportedName(specifier.exported) !== exportName) continue;
        const localName = this.exportedName(specifier.local);
        if (statement.source) {
          const target = await this.resolveModule(absolutePath, statement.source.value);
          if (target) return this.resolveExportedMacro(target, localName, visited);
        } else {
          return this.resolveLocalMacro(module, definitions, localName, visited);
        }
      }
    }

    for (const statement of programPath.body) {
      if (!t.isExportAllDeclaration(statement)) continue;
      const target = await this.resolveModule(absolutePath, statement.source.value);
      if (target) {
        const result = await this.resolveExportedMacro(target, exportName, visited);
        if (result) return result;
      }
    }
    return undefined;
  }

  private async resolveNamespaceExport(
    filePath: string,
    exportName: string,
    visited = new Set<string>(),
  ): Promise<string | undefined> {
    const absolutePath = resolve(filePath);
    const visitKey = `${absolutePath}#namespace:${exportName}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);
    const module = await this.loadModule(absolutePath);
    if (!module) return undefined;
    for (const statement of module.ast.program.body) {
      if (!t.isExportNamedDeclaration(statement) || !statement.source) continue;
      for (const specifier of statement.specifiers) {
        if (t.isExportNamespaceSpecifier(specifier) && this.exportedName(specifier.exported) === exportName) {
          return this.resolveModule(absolutePath, statement.source.value);
        }
      }
    }
    return undefined;
  }

  private async resolveLocalMacro(
    module: ModuleInfo,
    definitions: MacroDefinition[],
    localName: string,
    visited: Set<string>,
  ): Promise<MacroDefinition | undefined> {
    const definition = definitions.find((item) => item.name === localName);
    if (definition) return definition;
    let imported: { source: string; name: string; namespace: boolean } | undefined;
    for (const statement of module.ast.program.body) {
      if (!t.isImportDeclaration(statement)) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.local.name !== localName) continue;
        if (t.isImportNamespaceSpecifier(specifier))
          imported = { source: statement.source.value, name: '*', namespace: true };
        else if (t.isImportDefaultSpecifier(specifier))
          imported = { source: statement.source.value, name: 'default', namespace: false };
        else
          imported = { source: statement.source.value, name: this.exportedName(specifier.imported), namespace: false };
      }
    }
    if (!imported) return undefined;
    const target = await this.resolveModule(module.filePath, imported.source);
    if (!target) return undefined;
    if (imported.namespace) return undefined;
    return this.resolveExportedMacro(target, imported.name, visited);
  }

  private declaredNames(node: t.Declaration): string[] {
    if ((t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) && node.id) return [node.id.name];
    if (t.isVariableDeclaration(node))
      return node.declarations.flatMap((declaration) => (t.isIdentifier(declaration.id) ? [declaration.id.name] : []));
    return [];
  }

  private exportedName(node: t.Identifier | t.StringLiteral): string {
    return t.isIdentifier(node) ? node.name : node.value;
  }

  private async discoverImportedMacros(
    module: ModuleInfo,
    ast: t.File,
    importedMacros: Map<Binding, MacroDefinition>,
    importedNamespaces: Map<Binding, string>,
    namespaceMembers: Map<Binding, Map<string, MacroDefinition>>,
    macroReexports: Set<t.ExportSpecifier>,
    watchFiles: Set<string>,
  ): Promise<void> {
    let programPath: AnyPath | undefined;
    traverse(ast, {
      Program(path) {
        programPath = path;
        path.stop();
      },
    });
    if (!programPath) return;

    const namespaceImports: Array<{ binding: Binding; modulePath: string }> = [];
    for (const declaration of ast.program.body) {
      if (!t.isImportDeclaration(declaration) || declaration.importKind === 'type') continue;
      for (const specifier of declaration.specifiers) {
        const binding = programPath.scope.getBinding(specifier.local.name);
        if (!binding) continue;
        const target = await this.resolveModule(module.filePath, declaration.source.value);
        if (!target) continue;
        if (t.isImportNamespaceSpecifier(specifier)) {
          namespaceImports.push({ binding, modulePath: target });
          continue;
        }
        const importName = t.isImportDefaultSpecifier(specifier) ? 'default' : this.exportedName(specifier.imported);
        const macro = await this.resolveExportedMacro(target, importName);
        if (macro) {
          importedMacros.set(binding, macro);
          watchFiles.add(macro.filePath);
        } else {
          const namespacePath = await this.resolveNamespaceExport(target, importName);
          if (namespacePath) {
            namespaceImports.push({ binding, modulePath: namespacePath });
          }
        }
      }
    }

    for (const statement of ast.program.body) {
      if (!t.isExportNamedDeclaration(statement) || !statement.source || statement.exportKind === 'type') continue;
      const target = await this.resolveModule(module.filePath, statement.source.value);
      if (!target) continue;
      for (const specifier of statement.specifiers) {
        if (!t.isExportSpecifier(specifier)) continue;
        const macro = await this.resolveExportedMacro(target, this.exportedName(specifier.local));
        if (!macro) continue;
        macroReexports.add(specifier);
        watchFiles.add(macro.filePath);
      }
    }

    const namespaceCalls: Array<{ binding: Binding; name: string }> = [];
    traverse(ast, {
      MemberExpression: (path) => this.collectNamespaceMember(path, namespaceCalls),
      OptionalMemberExpression: (path) => this.collectNamespaceMember(path, namespaceCalls),
    });
    for (const { binding, modulePath } of namespaceImports) {
      const members = [...new Set(namespaceCalls.filter((call) => call.binding === binding).map((call) => call.name))];
      for (const member of members) {
        const macro = await this.resolveExportedMacro(modulePath, member);
        if (macro) {
          const definitions = namespaceMembers.get(binding) ?? new Map<string, MacroDefinition>();
          definitions.set(member, macro);
          namespaceMembers.set(binding, definitions);
          importedNamespaces.set(binding, modulePath);
          watchFiles.add(macro.filePath);
        }
      }
    }
  }

  private collectNamespaceMember(path: AnyPath, output: Array<{ binding: Binding; name: string }>): void {
    const member = memberReference(path.node);
    if (!member) return;
    const binding = path.scope.getBinding(member.object.name);
    if (binding) output.push({ binding, name: member.name });
  }

  private collectCall(
    path: AnyPath,
    localDefinitionList: MacroDefinition[],
    localDefinitions: Map<Binding, MacroDefinition>,
    importedMacros: Map<Binding, MacroDefinition>,
    importedNamespaces: Map<Binding, string>,
    namespaceMembers: Map<Binding, Map<string, MacroDefinition>>,
    calls: MacroCall[],
  ): void {
    if (localDefinitionList.some((definition) => isPathInside(path, definition.functionPath))) return;
    const callee = path.node.callee;
    if (t.isIdentifier(callee)) {
      const binding = path.scope.getBinding(callee.name);
      if (!binding) return;
      const definition = localDefinitions.get(binding) ?? importedMacros.get(binding);
      if (definition) calls.push({ path, definition, binding });
      return;
    }
    const member = memberReference(callee);
    if (!member) return;
    const name = member.name;
    const binding = path.scope.getBinding(member.object.name);
    if (!binding || !importedNamespaces.has(binding)) return;
    const definition = namespaceMembers.get(binding)?.get(name);
    if (definition) calls.push({ path, definition, namespaceBinding: binding });
  }

  private validateMacroReferences(
    filename: string,
    definitions: MacroDefinition[],
    importedMacros: Map<Binding, MacroDefinition>,
    namespaceMembers: Map<Binding, Map<string, MacroDefinition>>,
    calls: MacroCall[],
  ): void {
    const bindings = new Map<Binding, MacroDefinition>();
    for (const definition of definitions) {
      if (!definition.bindingPath) continue;
      const binding = definition.bindingPath.scope.getBinding(definition.name);
      if (binding) bindings.set(binding, definition);
    }
    for (const [binding, definition] of importedMacros) bindings.set(binding, definition);
    for (const [binding, members] of namespaceMembers) {
      for (const definition of members.values()) bindings.set(binding, definition);
    }
    const calledReferenceNodes = new Set<any>();
    for (const call of calls) {
      if (call.binding) calledReferenceNodes.add((call.path.get('callee') as AnyPath).node);
      if (
        call.namespaceBinding &&
        (t.isMemberExpression(call.path.node.callee) || t.isOptionalMemberExpression(call.path.node.callee))
      ) {
        calledReferenceNodes.add((call.path.get('callee.object') as AnyPath).node);
      }
    }
    const namespaceBindings = new Set(namespaceMembers.keys());

    for (const [binding, definition] of bindings) {
      for (const reference of binding.referencePaths) {
        if (calledReferenceNodes.has(reference.node)) continue;
        if (definitions.some((item) => isPathInside(reference, item.functionPath))) continue;
        if (namespaceBindings.has(binding)) {
          const member = reference.parentPath && memberReference(reference.parentPath.node);
          if (member && member.object === reference.node && namespaceMembers.get(binding)?.has(member.name)) {
            throw new MacroTransformError(
              `Macro ${member.name} is referenced as a runtime value. Macro functions can only be called during compilation.`,
              filename,
              locationOf(reference),
            );
          }
          if (reference.parentPath?.isExportSpecifier()) {
            throw new MacroTransformError(
              'A namespace containing macros cannot be re-exported as a runtime value.',
              filename,
              locationOf(reference),
            );
          }
          continue;
        }
        if (reference.isExportNamedDeclaration() || reference.isExportDefaultDeclaration()) continue;
        const parent = reference.parentPath;
        if (parent?.isExportSpecifier() || parent?.isExportDefaultDeclaration()) continue;
        throw new MacroTransformError(
          `Macro ${definition.name} is referenced as a runtime value. Macro functions can only be called during compilation.`,
          filename,
          locationOf(reference),
        );
      }
    }
  }

  private collectMacroOnlyBindings(definitions: MacroDefinition[]): Set<Binding> {
    const macroBindings = new Set<Binding>();
    for (const definition of definitions) {
      const binding = definition.bindingPath?.scope.getBinding(definition.name);
      if (binding) macroBindings.add(binding);
    }

    const dependencies = new Set<Binding>();
    const scanned = new Set<t.Node>();
    const pending = definitions.map((definition) => definition.functionPath);
    while (pending.length > 0) {
      const current = pending.pop() as AnyPath;
      if (!current.node || scanned.has(current.node)) continue;
      scanned.add(current.node);
      current.traverse({
        ReferencedIdentifier: (reference) => {
          const binding = reference.scope.getBinding(reference.node.name);
          if (!binding) return;
          if (!binding.scope.path.isProgram() || macroBindings.has(binding) || dependencies.has(binding)) return;
          dependencies.add(binding);
          const declaration = binding.path as AnyPath;
          if (
            declaration.isFunctionDeclaration() ||
            declaration.isClassDeclaration() ||
            declaration.isVariableDeclarator()
          ) {
            pending.push(declaration);
          }
        },
      });
    }
    return dependencies;
  }

  private removeUnusedMacroDependencies(ast: t.File, candidates: Set<Binding>): void {
    if (candidates.size === 0) return;
    let programScope: AnyPath['scope'] | undefined;
    traverse(ast, {
      Program(path) {
        programScope = path.scope;
      },
    });
    if (!programScope) return;

    let changed = true;
    while (changed) {
      changed = false;
      programScope.crawl();
      for (const candidate of candidates) {
        const binding = programScope.getBinding(candidate.identifier.name);
        if (!binding || binding.referencePaths.length > 0 || !binding.scope.path.isProgram()) continue;
        const declaration = binding.path as AnyPath;
        const statement = moduleStatementFor(declaration);
        if (!statement || statement.isExportNamedDeclaration() || statement.isExportDefaultDeclaration()) continue;

        if (declaration.isFunctionDeclaration()) {
          declaration.remove();
          changed = true;
        } else if (declaration.isVariableDeclarator()) {
          this.removeVariableDeclarator(declaration);
          changed = true;
        } else if (declaration.isClassDeclaration()) {
          declaration.remove();
          changed = true;
        }
      }
    }
  }

  private async executeCalls(
    calls: MacroCall[],
    signal: AbortSignal | undefined,
    watchFiles: Set<string>,
  ): Promise<void> {
    const callNodes = new Set(calls.map((call) => call.path.node));
    const roots = calls
      .filter((call) => {
        let parent: AnyPath | null = call.path.parentPath;
        while (parent) {
          if (callNodes.has(parent.node)) return false;
          parent = parent.parentPath;
        }
        return true;
      })
      .sort((left, right) => sourcePosition(left.path) - sourcePosition(right.path));

    const executeTree = async (call: MacroCall): Promise<void> => {
      const children = calls
        .filter((candidate) => {
          if (candidate.path.node === call.path.node || !isPathInside(candidate.path, call.path)) return false;
          let parent: AnyPath | null = candidate.path.parentPath;
          while (parent && parent.node !== call.path.node) {
            if (callNodes.has(parent.node)) return false;
            parent = parent.parentPath;
          }
          return true;
        })
        .sort((left, right) => sourcePosition(left.path) - sourcePosition(right.path));
      for (const child of children) await executeTree(child);

      if (!call.path.node || call.path.removed) return;
      try {
        const argumentPaths = call.path.get('arguments') as AnyPath[];
        const args: unknown[] = [];
        for (const argument of argumentPaths) {
          if (t.isSpreadElement(argument.node)) {
            throw new TypeError('Spread arguments are not supported in macro calls.');
          }
          try {
            args.push(evaluateStatic(argument));
          } catch (error) {
            const message = error instanceof Error ? error.message : 'argument is not static';
            throw new TypeError(`Macro arguments must be serializable compile-time values: ${message}`);
          }
        }

        const argumentSources: string[] = [];
        for (const argument of args) argumentSources.push(await stringify(argument));
        const compiled = await this.compileMacro(call.definition);
        for (const dependency of compiled.result.dependencies) watchFiles.add(dependency);
        const runner = this.getWorker(call.definition, compiled.result.code);
        const run = await runner.run(argumentSources, signal, this.execution.maxOutputBytes);
        for (const dependency of run.trackedFiles) watchFiles.add(dependency);
        if (Buffer.byteLength(run.source, 'utf8') > this.execution.maxOutputBytes) {
          throw new Error(`Serialized macro result exceeds the ${this.execution.maxOutputBytes} byte limit.`);
        }
        let expression: t.Expression;
        try {
          expression = parseExpression(run.source, parserOptions(call.definition.filePath)) as t.Expression;
        } catch (error) {
          const serializationError = new Error('The macro serializer returned invalid JavaScript.') as Error & {
            cause?: unknown;
          };
          serializationError.cause = error;
          throw serializationError;
        }
        mapExpressionToCallSite(expression, call.path);
        const awaitParent = call.path.parentPath;
        if (awaitParent?.isAwaitExpression() && awaitParent.node.argument === call.path.node) {
          awaitParent.replaceWith(expression);
        } else {
          call.path.replaceWith(expression);
        }
      } catch (error) {
        if (error instanceof MacroCallFailure) throw error;
        throw new MacroCallFailure(call, error);
      }
    };

    for (const root of roots) await executeTree(root);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return 'Macro execution failed.';
  }

  private asDiagnostic(error: unknown, filePath: string): Error {
    if (error instanceof MacroTransformError) return error;
    if (error instanceof Error) {
      const loc = (error as Error & { loc?: { line: number; column: number } }).loc;
      return new MacroTransformError(error.message, filePath, loc, { cause: error });
    }
    return new MacroTransformError('Macro transformation failed.', filePath);
  }

  private async buildMacroModule(definition: MacroDefinition): Promise<string> {
    const selectedImports = new Map<t.ImportDeclaration, Set<t.ImportDeclaration['specifiers'][number]>>();
    const selectedVariables = new Map<t.VariableDeclaration, Set<t.VariableDeclarator>>();
    const selectedStatements = new Map<t.Node, number>();
    const scannedBindings = new Set<Binding>();
    const pending: AnyPath[] = [];

    const addBinding = (binding: Binding): void => {
      if (scannedBindings.has(binding)) return;
      scannedBindings.add(binding);
      const bindingPath = binding.path as AnyPath;
      if (moduleImportSpecifier(bindingPath)) {
        const importPath = bindingPath.parentPath;
        if (!importPath?.isImportDeclaration()) {
          throw new MacroTransformError(
            `Cannot resolve imported macro dependency ${binding.identifier.name}.`,
            definition.filePath,
            locationOf(bindingPath),
          );
        }
        const specifiers = selectedImports.get(importPath.node) ?? new Set<t.ImportDeclaration['specifiers'][number]>();
        specifiers.add(bindingPath.node);
        selectedImports.set(importPath.node, specifiers);
        return;
      }

      const statement = moduleStatementFor(bindingPath);
      if (!statement) {
        throw new MacroTransformError(
          `Macro ${definition.name} closes over a non-module local (${binding.identifier.name}). Declare the macro at module scope or move the value to module scope.`,
          definition.filePath,
          locationOf(bindingPath),
        );
      }
      let declarationPath: AnyPath = statement;
      if (statement.isExportNamedDeclaration() || statement.isExportDefaultDeclaration()) {
        const declarationNode = statement.get('declaration') as AnyPath;
        if (!declarationNode.node) {
          throw new MacroTransformError(
            `Cannot include ${binding.identifier.name} from this re-export in a macro module.`,
            definition.filePath,
            locationOf(bindingPath),
          );
        }
        declarationPath = declarationNode;
      }
      if (declarationPath.isVariableDeclaration()) {
        const declaratorPath = bindingPath.isVariableDeclarator()
          ? bindingPath
          : (bindingPath.findParent((parent) => parent.isVariableDeclarator()) as AnyPath | undefined);
        if (!declaratorPath?.isVariableDeclarator()) {
          throw new MacroTransformError(
            `Cannot isolate variable dependency ${binding.identifier.name}.`,
            definition.filePath,
            locationOf(bindingPath),
          );
        }
        const declarators = selectedVariables.get(declarationPath.node) ?? new Set<t.VariableDeclarator>();
        declarators.add(declaratorPath.node);
        selectedVariables.set(declarationPath.node, declarators);
        pending.push(declaratorPath);
        return;
      }
      if (
        declarationPath.isFunctionDeclaration() ||
        declarationPath.isClassDeclaration() ||
        declarationPath.isTSEnumDeclaration()
      ) {
        selectedStatements.set(declarationPath.node, statement.node.start ?? declarationPath.node.start ?? 0);
        pending.push(declarationPath);
        return;
      }
      throw new MacroTransformError(
        `Cannot include macro dependency ${binding.identifier.name} (${declarationPath.node.type}).`,
        definition.filePath,
        locationOf(bindingPath),
      );
    };

    const macroBinding = definition.bindingPath?.scope.getBinding(definition.name);
    if (macroBinding) {
      addBinding(macroBinding);
    } else if (definition.functionPath.isFunctionDeclaration() && definition.functionPath.node.id) {
      const declaration = t.cloneNode(definition.functionPath.node, true);
      selectedStatements.set(declaration, definition.functionPath.node.start ?? 0);
      pending.push(definition.functionPath);
    } else if (definition.functionPath.isFunctionDeclaration()) {
      const original = definition.functionPath.node;
      const params = original.params.map((parameter) => t.cloneNode(parameter, true));
      const body = t.cloneNode(original.body, true) as t.BlockStatement;
      const expression = t.functionExpression(null, params, body, original.generator, original.async);
      const declaration = t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier('__useMacro'), expression),
      ]);
      selectedStatements.set(declaration, original.start ?? 0);
      pending.push(definition.functionPath);
    } else if (
      definition.name === 'default' &&
      (definition.functionPath.isFunctionExpression() || definition.functionPath.isArrowFunctionExpression())
    ) {
      const expression = t.cloneNode(definition.functionPath.node, true) as t.Expression;
      const declaration = t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier('__useMacro'), expression),
      ]);
      selectedStatements.set(declaration, definition.functionPath.node.start ?? 0);
      pending.push(definition.functionPath);
    } else {
      throw new MacroTransformError(
        `Cannot create an execution module for macro ${definition.name}.`,
        definition.filePath,
        locationOf(definition.functionPath),
      );
    }

    while (pending.length) {
      const current = pending.pop() as AnyPath;
      current.traverse({
        ReferencedIdentifier: (reference) => {
          const binding = reference.scope.getBinding(reference.node.name);
          if (!binding || isPathInside(binding.path as AnyPath, current)) return;
          addBinding(binding);
        },
      });
    }

    const items: Array<{ node: t.Node; start: number }> = [];
    for (const [declaration, specifiers] of selectedImports) {
      const clone = t.cloneNode(declaration, true);
      clone.specifiers = clone.specifiers.filter((specifier) => {
        const original = declaration.specifiers.find((item) => item.local.name === specifier.local.name);
        return original !== undefined && specifiers.has(original);
      });
      items.push({ node: clone, start: declaration.start ?? 0 });
    }
    for (const [declaration, declarators] of selectedVariables) {
      const clone = t.cloneNode(declaration, true);
      clone.declarations = clone.declarations.filter((_, index) => {
        const original = declaration.declarations[index];
        return original !== undefined && declarators.has(original);
      });
      items.push({ node: clone, start: declaration.start ?? 0 });
    }
    for (const [statement, start] of selectedStatements) items.push({ node: t.cloneNode(statement, true), start });
    items.sort((left, right) => left.start - right.start);

    let exportName: string | undefined;
    if (definition.variablePath && t.isIdentifier(definition.variablePath.node.id))
      exportName = definition.variablePath.node.id.name;
    else if (definition.functionPath.isFunctionDeclaration() && definition.functionPath.node.id)
      exportName = definition.functionPath.node.id.name;
    else if (definition.functionPath.isFunctionExpression() && definition.functionPath.node.id)
      exportName = definition.functionPath.node.id.name;
    else if (definition.name === 'default' && definition.functionPath.isFunctionDeclaration())
      exportName = '__useMacro';
    if (!exportName)
      throw new MacroTransformError(
        `Macro ${definition.name} must have a module-level binding.`,
        definition.filePath,
        locationOf(definition.functionPath),
      );

    const file = t.file(t.program(items.map((item) => item.node as t.Statement)));
    file.program.body.push(
      t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(exportName), t.identifier('__useMacro'))]),
    );
    return generate(file, { comments: false, compact: false }).code;
  }

  private async compileMacro(definition: MacroDefinition): Promise<CompiledCacheEntry> {
    if (this.execution.mode === 'restricted') {
      throw new Error(
        'Restricted macro execution is unavailable because no enforceable isolation backend is configured. Set execution.mode to "trusted" only for macros and dependencies you trust.',
      );
    }
    const source = await this.buildMacroModule(definition);
    const key = hash(`${definition.identity}\0${source}`);
    const cached = this.compiledMacros.get(key);
    if (cached && (await this.dependenciesAreFresh(cached.dependencyHashes))) return cached;
    if (cached) this.compiledMacros.delete(key);
    const active = this.compileInFlight.get(key);
    if (active) return active;

    const pending = (async () => {
      const result = await this.compiler.compile({
        source,
        resolveDir: dirname(definition.filePath),
        extension: extname(definition.filePath) || '.ts',
        identity: definition.identity,
      });
      const dependencyHashes = new Map<string, string>();
      for (const dependency of result.dependencies) {
        try {
          dependencyHashes.set(resolve(dependency), hash(await readFile(dependency, 'utf8')));
        } catch {
          // Custom compilers may report virtual files that cannot be watched by this process.
        }
      }
      const entry = { result, dependencyHashes };
      this.compiledMacros.set(key, entry);
      while (this.compiledMacros.size > 256)
        this.compiledMacros.delete(this.compiledMacros.keys().next().value as string);
      return entry;
    })();
    this.compileInFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.compileInFlight.delete(key);
    }
  }

  private async dependenciesAreFresh(dependencies: Map<string, string>): Promise<boolean> {
    for (const [filePath, expectedHash] of dependencies) {
      try {
        if (hash(await readFile(filePath, 'utf8')) !== expectedHash) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private getWorker(definition: MacroDefinition, code: string): MacroWorkerRunner {
    const identity = `${definition.filePath}\0${hash(code)}`;
    const existing = this.workers.get(identity);
    if (existing) {
      this.workers.delete(identity);
      this.workers.set(identity, existing);
      return existing;
    }
    const worker = new MacroWorkerRunner(
      encodeDataUrl(code),
      dirname(definition.filePath),
      definition.filePath,
      new URL('./stringify.js', import.meta.url).href,
      this.execution.timeoutMs,
      this.execution.env,
    );
    this.workers.set(identity, worker);
    while (this.workers.size > 32) {
      const oldestKey = this.workers.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.workers.get(oldestKey);
      this.workers.delete(oldestKey);
      void oldest?.dispose();
    }
    return worker;
  }

  private removeMacroDefinition(definition: MacroDefinition): void {
    const functionPath = definition.functionPath;
    if (functionPath.parentPath?.isExportDefaultDeclaration()) {
      functionPath.parentPath.remove();
      return;
    }
    if (definition.variablePath) {
      this.removeVariableDeclarator(definition.variablePath);
      return;
    }
    if (functionPath.isFunctionDeclaration()) {
      const parent = functionPath.parentPath;
      if (parent?.isExportNamedDeclaration()) parent.remove();
      else functionPath.remove();
    }
  }

  private removeVariableDeclarator(path: AnyPath): void {
    const declaration = path.parentPath;
    if (!declaration?.isVariableDeclaration()) return;
    const declarationNode = declaration.node;
    const parent = declaration.parentPath;
    path.remove();
    if (declarationNode.declarations.length === 0 && parent) {
      parent.remove();
    }
  }

  private removeMacroOnlyImports(
    ast: t.File,
    definitions: MacroDefinition[],
    importedMacros: Map<Binding, MacroDefinition>,
    importedNamespaces: Map<Binding, string>,
  ): void {
    let programScope: AnyPath['scope'] | undefined;
    const imports: AnyPath[] = [];
    traverse(ast, {
      Program(path) {
        programScope = path.scope;
      },
      ImportDeclaration(path) {
        imports.push(path);
      },
    });
    if (!programScope) return;
    programScope.crawl();
    const protectedBindings = new Set([...importedMacros.keys(), ...importedNamespaces.keys()]);
    for (const statementPath of imports) {
      if (!statementPath.node || !statementPath.isImportDeclaration()) continue;
      const hadSpecifiers = statementPath.node.specifiers.length > 0;
      for (const specifier of [...(statementPath.get('specifiers') as AnyPath[])]) {
        const binding = programScope.getBinding(specifier.node.local.name);
        if (!binding || binding.referencePaths.length === 0) continue;
        if (protectedBindings.has(binding)) continue;
        const onlyMacroReferences = binding.referencePaths.every((reference) =>
          definitions.some((definition) => isPathInside(reference, definition.functionPath)),
        );
        if (onlyMacroReferences) specifier.remove();
      }
      if (hadSpecifiers && statementPath.node?.specifiers.length === 0) statementPath.remove();
    }
  }

  private removeMacroDependencyImports(ast: t.File, candidates: Set<Binding>): void {
    if (candidates.size === 0) return;
    const candidateNames = new Set([...candidates].map((candidate) => candidate.identifier.name));
    let programScope: AnyPath['scope'] | undefined;
    const imports: AnyPath[] = [];
    traverse(ast, {
      Program(path) {
        programScope = path.scope;
      },
      ImportDeclaration(path) {
        imports.push(path);
      },
    });
    if (!programScope) return;
    programScope.crawl();
    for (const importPath of imports) {
      if (!importPath.node || !importPath.isImportDeclaration()) continue;
      const hadSpecifiers = importPath.node.specifiers.length > 0;
      for (const specifier of [...(importPath.get('specifiers') as AnyPath[])]) {
        const binding = programScope.getBinding(specifier.node.local.name);
        if (binding && candidateNames.has(binding.identifier.name) && binding.referencePaths.length === 0) {
          specifier.remove();
        }
      }
      if (hadSpecifiers && importPath.node.specifiers.length === 0) importPath.remove();
    }
  }

  private removeImportedMacroReferences(
    ast: t.File,
    importedMacros: Map<Binding, MacroDefinition>,
    importedNamespaces: Map<Binding, string>,
  ): void {
    let programScope: AnyPath['scope'] | undefined;
    traverse(ast, {
      Program(path) {
        programScope = path.scope;
        path.stop();
      },
    });
    programScope?.crawl();
    const macroBindings = new Set(importedMacros.keys());
    const namespaceBindings = new Set(importedNamespaces.keys());
    for (const originalBinding of new Set([...macroBindings, ...namespaceBindings])) {
      const binding = programScope?.getBinding(originalBinding.identifier.name) ?? originalBinding;
      if (
        namespaceBindings.has(originalBinding) &&
        !macroBindings.has(originalBinding) &&
        binding.referencePaths.length > 0
      )
        continue;
      const importSpecifier = binding.path as AnyPath;
      if (!moduleImportSpecifier(importSpecifier)) continue;
      const declaration = importSpecifier.parentPath;
      importSpecifier.remove();
      if (declaration?.isImportDeclaration() && declaration.node.specifiers.length === 0) declaration.remove();
    }
  }

  private removeMacroReexports(
    ast: t.File,
    localMacros: Map<Binding, MacroDefinition>,
    importedMacros: Map<Binding, MacroDefinition>,
    importedNamespaces: Map<Binding, string>,
    macroReexports: Set<t.ExportSpecifier>,
  ): void {
    const macroBindings = new Set<Binding>([
      ...localMacros.keys(),
      ...importedMacros.keys(),
      ...importedNamespaces.keys(),
    ]);
    traverse(ast, {
      ExportSpecifier: (path) => {
        if (macroReexports.has(path.node)) {
          const parent = path.parentPath;
          path.remove();
          if (parent?.isExportNamedDeclaration() && parent.node.specifiers.length === 0 && !parent.node.declaration)
            parent.remove();
          return;
        }
        const local = path.node.local;
        if (!t.isIdentifier(local)) return;
        const binding = path.scope.getBinding(local.name);
        if (!binding || !macroBindings.has(binding)) return;
        const parent = path.parentPath;
        path.remove();
        if (parent?.isExportNamedDeclaration() && parent.node.specifiers.length === 0 && !parent.node.declaration)
          parent.remove();
      },
    });
  }
}
