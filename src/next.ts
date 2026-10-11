import { fileURLToPath } from 'node:url';
import type { MacroExecutionOptions } from './transformer.js';

export type NextMacroOptions = {
  /** Transform macro calls from files in node_modules. Defaults to false. */
  transformDependencies?: boolean;
  /** Next.js loader options cannot contain AbortSignal values. */
  execution?: Omit<MacroExecutionOptions, 'signal'>;
};

export interface NextWebpackConfiguration {
  module?: {
    rules?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NextWebpackContext {
  [key: string]: unknown;
}

export type NextWebpackHook = (
  config: NextWebpackConfiguration,
  context: NextWebpackContext,
) => NextWebpackConfiguration;

export interface NextTurbopackRule {
  condition?: unknown;
  loaders: Array<{ loader: string; options: NextMacroOptions }>;
  as: string;
}

export interface NextTurbopackOptions {
  rules: Record<string, unknown>;
  [key: string]: unknown;
}

interface NextConfigShape {
  webpack?: NextWebpackHook;
  turbopack?: NextTurbopackOptions;
}

const loaderPath = fileURLToPath(new URL('./next-loader.cjs', import.meta.url));
const sourceExtensions = [
  { pattern: '*.js', output: '*.js' },
  { pattern: '*.jsx', output: '*.jsx' },
  { pattern: '*.mjs', output: '*.js' },
  { pattern: '*.cjs', output: '*.js' },
  { pattern: '*.ts', output: '*.js' },
  { pattern: '*.tsx', output: '*.jsx' },
  { pattern: '*.mts', output: '*.js' },
  { pattern: '*.cts', output: '*.js' },
];

/** Add the macro loader to Next.js Webpack and Turbopack configurations. */
export function withMacro<T extends object>(nextConfig: T, options: NextMacroOptions = {}): T {
  assertJsonValue(options, 'options');
  const safeOptions = JSON.parse(JSON.stringify(options)) as NextMacroOptions;
  const webpackLoaderOptions = { ...safeOptions, __useMacroTurbopack: false };
  const turbopackLoaderOptions = { ...safeOptions, __useMacroTurbopack: true };
  const current = nextConfig as T & NextConfigShape;
  const previousWebpack = current.webpack;
  const transformDependencies = options.transformDependencies ?? false;

  const webpack: NextWebpackHook = (initialConfig, context) => {
    const config = previousWebpack?.(initialConfig, context) ?? initialConfig;
    if (isPromiseLike(config)) {
      throw new TypeError('Next.js webpack configuration hooks must be synchronous.');
    }
    const moduleConfig = config.module ?? { rules: [] };
    const rules = moduleConfig.rules ?? [];
    const macroRule = {
      test: /\.[cm]?[jt]sx?$/,
      enforce: 'pre',
      ...(!transformDependencies ? { exclude: /[\\/]node_modules[\\/]/ } : {}),
      use: [{ loader: loaderPath, options: webpackLoaderOptions }],
    };
    config.module = { ...moduleConfig, rules: [...rules, macroRule] };
    return config;
  };

  const existingTurbopack = current.turbopack;
  const turbopack: NextTurbopackOptions = {
    ...existingTurbopack,
    rules: addTurbopackRules(existingTurbopack?.rules, turbopackLoaderOptions, transformDependencies),
  };

  return { ...nextConfig, webpack, turbopack } as T;
}

function addTurbopackRules(
  existing: Record<string, unknown> | undefined,
  options: NextMacroOptions & { __useMacroTurbopack: boolean },
  transformDependencies: boolean,
): Record<string, unknown> {
  const rules = { ...existing };
  for (const extension of sourceExtensions) {
    const macroRule: NextTurbopackRule = {
      ...(transformDependencies ? {} : { condition: { not: 'foreign' } }),
      loaders: [{ loader: loaderPath, options }],
      as: extension.output,
    };
    const previousRule = rules[extension.pattern];
    rules[extension.pattern] =
      previousRule === undefined
        ? macroRule
        : Array.isArray(previousRule)
          ? [macroRule, ...previousRule]
          : [macroRule, previousRule];
  }
  return rules;
}

function assertJsonValue(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError(`Next macro ${path} must contain only JSON values.`);
  if (seen.has(value)) throw new TypeError(`Next macro ${path} cannot contain circular values.`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Next macro ${path} must contain only plain objects and arrays.`);
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`, seen);
  seen.delete(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}
