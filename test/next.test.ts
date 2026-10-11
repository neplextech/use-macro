import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originalPositionFor, TraceMap, type SourceMapInput } from '@jridgewell/trace-mapping';
import { runNextMacroLoader, type NextLoaderCallback, type NextLoaderContext } from '../src/next-loader.js';
import {
  withMacro,
  type NextMacroOptions,
  type NextTurbopackOptions,
  type NextWebpackConfiguration,
  type NextWebpackHook,
} from '../src/next.js';

describe('Next.js integration', () => {
  test('adds both loader configurations and preserves existing settings', () => {
    let webpackCalls = 0;
    const existingRule = { test: /\.svg$/, use: ['svg-loader'] };
    const configured = withMacro(
      {
        reactStrictMode: true,
        turbopack: { rules: { '*.svg': existingRule } },
        webpack(config: NextWebpackConfiguration) {
          webpackCalls++;
          config.name = 'existing-webpack-config';
          return config;
        },
      },
      { execution: { mode: 'trusted' } },
    );
    const adapterConfig = configured as typeof configured & {
      webpack: NextWebpackHook;
      turbopack: NextTurbopackOptions;
    };

    const webpackConfig = adapterConfig.webpack({ module: { rules: [] } }, {});
    const webpackRules = webpackConfig.module?.rules ?? [];
    const macroWebpackRule = webpackRules[0] as {
      enforce: string;
      exclude: RegExp;
      use: Array<{ loader: string; options: { execution?: { mode?: string } } }>;
    };
    const turboRules = adapterConfig.turbopack.rules;
    const tsRule = turboRules['*.ts'] as {
      condition?: { not: string };
      loaders: Array<{ loader: string; options: { execution?: { mode?: string } } }>;
      as: string;
    };
    const svgRules = turboRules['*.svg'];

    expect(configured.reactStrictMode).toBe(true);
    expect(webpackCalls).toBe(1);
    expect(webpackConfig.name).toBe('existing-webpack-config');
    expect(macroWebpackRule.enforce).toBe('pre');
    expect(macroWebpackRule.exclude.test('/app/node_modules/pkg/index.ts')).toBe(true);
    expect(macroWebpackRule.use[0]?.options.execution?.mode).toBe('trusted');
    expect(tsRule.condition).toEqual({ not: 'foreign' });
    expect(tsRule.as).toBe('*.js');
    expect(tsRule.loaders[0]?.loader).toContain('next-loader.cjs');
    expect(svgRules).toBe(existingRule);
  });

  test('allows transforming node_modules only when explicitly enabled', () => {
    const configured = withMacro({}, { transformDependencies: true });
    const adapterConfig = configured as typeof configured & {
      webpack: NextWebpackHook;
      turbopack: NextTurbopackOptions;
    };
    const webpackConfig = adapterConfig.webpack({ module: { rules: [] } }, {});
    const webpackRule = webpackConfig.module?.rules?.[0] as { exclude?: RegExp };
    const tsRule = adapterConfig.turbopack.rules['*.ts'] as { condition?: unknown };

    expect(webpackRule.exclude).toBeUndefined();
    expect(tsRule.condition).toBeUndefined();
  });

  test('rejects options that cannot be passed safely to Next loaders', () => {
    expect(() => withMacro({}, { execution: { signal: new AbortController().signal } } as never)).toThrow(
      'plain objects and arrays',
    );
  });

  test('transforms a macro and strips TypeScript for Turbopack', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'use-macro-next-'));
    const resourcePath = join(directory, 'entry.ts');
    await writeFile(
      resourcePath,
      'function answer(value: number) { "use macro"; return value * 6; }\nexport const result: number = answer(7);',
    );

    try {
      const output = await runLoader(
        resourcePath,
        'function answer(value: number) { "use macro"; return value * 6; }\nexport const result: number = answer(7);',
        { execution: { mode: 'trusted' } },
      );

      expect(output.code).toContain('export const result = 42;');
      expect(output.code).not.toContain('function answer');
      expect(output.code).not.toContain(': number');
      expect(output.map).toBeDefined();
      expect(
        originalPositionFor(new TraceMap(output.map as unknown as SourceMapInput), {
          line: 1,
          column: 23,
        }).line,
      ).toBe(2);
      expect(output.dependencies).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('strips TypeScript syntax in Turbopack even when no macros are present', async () => {
    const output = await runLoader('/tmp/plain-next.ts', 'export const value: number = 42;', {});
    expect(output.code).toContain('export const value = 42;');
    expect(output.map).toBeDefined();
  });
});

async function runLoader(
  resourcePath: string,
  source: string,
  options: NextMacroOptions,
): Promise<{ code: string; map: object | undefined; dependencies: string[] }> {
  const dependencies: string[] = [];
  const context: NextLoaderContext = {
    resourcePath,
    getOptions: () => ({ ...options, __useMacroTurbopack: true }),
    addDependency: (path) => dependencies.push(path),
  };
  return await new Promise((resolve, reject) => {
    const callback: NextLoaderCallback = (error, code, map) => {
      if (error) reject(error);
      else resolve({ code: code ?? '', map, dependencies });
    };
    runNextMacroLoader(context, source, undefined, callback);
  });
}
