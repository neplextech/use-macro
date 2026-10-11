import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import { createBabelMacroPreprocessor } from '../src/babel.js';
import { esbuildPluginUseMacro } from '../src/macro.js';
import { rollupPluginUseMacro } from '../src/rollup.js';

const generate = ((_generate as any).default ?? _generate) as typeof import('@babel/generator').default;

const directories: string[] = [];

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'use-macro-integration-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('build-tool integrations', () => {
  test('transforms a bundled esbuild output and executes it', async () => {
    const directory = await project();
    const entry = join(directory, 'entry.ts');
    const output = join(directory, 'bundle.mjs');
    await writeFile(
      entry,
      `async function getData() { 'use macro'; return await Promise.resolve({ ok: true }); }\nexport const result = getData();`,
    );
    await build({
      bundle: true,
      entryPoints: [entry],
      outfile: output,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      plugins: [esbuildPluginUseMacro({ execution: { mode: 'trusted' } })],
    });
    const built = await readFile(output, 'utf8');
    expect(built).toContain('ok: true');
    const module = await import(`${pathToFileURL(output).href}?test=${Date.now()}`);
    expect(module.result).toEqual({ ok: true });
  });

  test('builds and executes the documented ESM import example', async () => {
    const directory = await project();
    const entry = fileURLToPath(new URL('../examples/src/index.ts', import.meta.url));
    const output = join(directory, 'example.mjs');
    await build({
      bundle: true,
      entryPoints: [entry],
      outfile: output,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      plugins: [esbuildPluginUseMacro({ execution: { mode: 'trusted' } })],
    });
    const module = await import(`${pathToFileURL(output).href}?test=${Date.now()}`);
    expect(module.message).toBe('Message: Hello World!');
    expect(module.version).toBe(
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
    );
  });

  test('preprocesses a Babel AST without reparsing it', async () => {
    const source = `async function getValue() { 'use macro'; return await Promise.resolve(42); }\nexport const result = await getValue();`;
    const ast = parse(source, { sourceType: 'module' });
    await using preprocessor = createBabelMacroPreprocessor({ execution: { mode: 'trusted' } });
    const result = await preprocessor.transform(ast, { filename: '/tmp/babel.ts', source });
    expect(result.changed).toBe(true);
    const output = generate(result.ast).code;
    expect(output).toContain('export const result = 42;');
    expect(output).not.toContain('function getValue');
  });

  test('registers macro dependencies with Rollup-compatible transform hooks', async () => {
    const directory = await project();
    const macroPath = join(directory, 'macros.ts');
    await writeFile(macroPath, `export async function get() { 'use macro'; return await Promise.resolve(42); }`);
    const plugin = rollupPluginUseMacro({ execution: { mode: 'trusted' } });
    const watched: string[] = [];
    const transformed = await plugin.transform.call(
      { addWatchFile: (filePath: string) => watched.push(filePath) },
      `import { get } from './macros'; export const result = await get();`,
      join(directory, 'app.ts'),
    );
    expect(transformed).not.toBeNull();
    expect(transformed?.code).toContain('export const result = 42;');
    expect(watched).toContain(macroPath);
    await plugin.closeBundle();
  });
});
