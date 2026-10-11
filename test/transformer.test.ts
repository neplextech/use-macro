import { afterEach, describe, expect, test } from 'bun:test';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MacroTransformer, type MacroTransformerOptions } from '../src/transformer.js';
import { esbuildMacroCompiler } from '../src/compiler.js';

const transformers: MacroTransformer[] = [];
const directories: string[] = [];

function createTransformer(options: MacroTransformerOptions = {}): MacroTransformer {
  const transformer = new MacroTransformer({
    ...options,
    execution: { mode: 'trusted', ...options.execution },
  });
  transformers.push(transformer);
  return transformer;
}

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'use-macro-test-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(transformers.splice(0).map((transformer) => transformer.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('source transformation', () => {
  test('returns ordinary modules without parsing or generating new code', async () => {
    const source = 'export const answer = 42;\n';
    const result = await createTransformer({ execution: { mode: 'restricted' } }).transform(source, '/tmp/plain.ts');
    expect(result).toEqual({ code: source, changed: false, watchFiles: [] });
  });

  test('passes call arguments and serializes the result as an expression', async () => {
    const result = await createTransformer().transform(
      `function multiply(a: number, b: number) { 'use macro'; return a * b; }
const result = multiply(6, 7);`,
      '/tmp/multiply.ts',
    );
    expect(result.code).toContain('const result = 42;');
    expect(result.code).not.toContain('function multiply');
    expect(result.map).toBeDefined();
  });

  test('evaluates nested static arguments and immutable local constants', async () => {
    const source = `
function identity<T>(value: T) { 'use macro'; return value; }
const input = { nested: [1, { enabled: true }], label: 'ready' } as const;
export const result = identity(input);
`;
    const result = await createTransformer().transform(source, '/tmp/nested-values.ts');
    expect(result.code).toContain('enabled: true');
    expect(result.code).toContain('label: "ready"');
  });

  test('supports arrow functions and named function expressions', async () => {
    const source = `
const increment = (value: number) => { 'use macro'; return value + 1; };
const twice = function named(value: number) { 'use macro'; return value * 2; };
export const results = [increment(4), twice(5)];
`;
    const result = await createTransformer().transform(source, '/tmp/functions.ts');
    expect(result.code).toContain('export const results = [5, 10];');
    expect(result.code).not.toContain('use macro');
  });

  test('removes only the macro declarator when a declaration contains runtime values', async () => {
    const source = `const get = () => { 'use macro'; return 42; }, runtimeValue = 7;\nexport const result = get() + runtimeValue;`;
    const result = await createTransformer().transform(source, '/tmp/mixed-declarators.ts');
    expect(result.code).toContain('const runtimeValue = 7;');
    expect(result.code).toContain('export const result = 42 + runtimeValue;');
  });

  test('awaits asynchronous macros and removes a redundant source await', async () => {
    const source = `
async function getData() { 'use macro'; return await Promise.resolve({ ok: true }); }
const result = await getData();
`;
    const result = await createTransformer().transform(source, '/tmp/async.ts');
    expect(result.code).toContain('ok: true');
    expect(result.code).not.toContain('await getData()');
  });

  test('executes nested macro calls inside out', async () => {
    const source = `
function double(value: number) { 'use macro'; return value * 2; }
function add(left: number, right: number) { 'use macro'; return left + right; }
const result = add(double(3), 4);
`;
    const result = await createTransformer().transform(source, '/tmp/calls.ts');
    expect(result.code).toContain('const result = 10;');
  });

  test('resolves shadowed identifiers by lexical binding', async () => {
    const source = `
function value() { 'use macro'; return 1; }
function invoke(value: () => number) { return value(); }
export const result = value();
export const runtime = invoke(() => 2);
`;
    const result = await createTransformer().transform(source, '/tmp/shadow.ts');
    expect(result.code).toContain('export const result = 1;');
    expect(result.code).toContain('function invoke(value: () => number)');
    expect(result.code).toContain('invoke(() => 2)');
  });

  test('does not execute unrelated top-level declarations while compiling a macro', async () => {
    const source = `
const macroInput = 9;
const unrelated = (() => { throw new Error('must not run'); })();
function get() { 'use macro'; return macroInput; }
export const result = get();
`;
    const result = await createTransformer().transform(source, '/tmp/closure.ts');
    expect(result.code).toContain('export const result = 9;');
    expect(result.code).toContain('must not run');
  });

  test('rejects non-static arguments with a call-site diagnostic', async () => {
    const source = `function macro(value: number) { 'use macro'; return value; }\nmacro(getValue());`;
    const filename = '/tmp/dynamic.ts';
    await expect(createTransformer().transform(source, filename)).rejects.toThrow(
      `${resolve(filename)}:2:1: TypeError: Macro arguments must be serializable compile-time values`,
    );
  });

  test('rejects runtime references to macro functions', async () => {
    const source = `function macro() { 'use macro'; return 1; }\nconst runtime = macro;`;
    await expect(createTransformer().transform(source, '/tmp/reference.ts')).rejects.toThrow(
      'referenced as a runtime value',
    );
  });

  test('rejects unbound macro expressions rather than leaving invalid code', async () => {
    const source = `const result = (() => { 'use macro'; return 1; })();`;
    await expect(createTransformer().transform(source, '/tmp/iife.ts')).rejects.toThrow(
      'A macro must be a function declaration',
    );
  });

  test('removes unused local macro definitions', async () => {
    const result = await createTransformer().transform(
      `function unused() { 'use macro'; return 1; }\nexport const runtime = 2;`,
      '/tmp/unused.ts',
    );
    expect(result.code).toBe('export const runtime = 2;');
    expect(result.changed).toBe(true);
  });

  test('removes pure local dependencies used only by macro definitions', async () => {
    const source = `
const compileTimeValue = 40;
function compileTimeHelper() { return compileTimeValue + 2; }
function getValue() { 'use macro'; return compileTimeHelper(); }
export const result = getValue();
`;
    const result = await createTransformer().transform(source, '/tmp/macro-dependencies.ts');
    expect(result.code).toContain('export const result = 42;');
    expect(result.code).not.toContain('compileTimeValue');
    expect(result.code).not.toContain('compileTimeHelper');
  });

  test('removes transitive imports and initializers used only by a macro', async () => {
    const directory = await project();
    const config = join(directory, 'config.json');
    await writeFile(config, JSON.stringify({ value: 'ready' }));
    await writeFile(join(directory, 'effects.ts'), `globalThis.sideEffect = true;`);
    const source = `
import './effects';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const configPath = resolve(globalThis.__dirname, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
function getValue() { 'use macro'; trackFile(configPath); return config.value; }
export const value = getValue();
`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('export const value = "ready";');
    expect(result.code).not.toContain('readFileSync');
    expect(result.code).not.toContain("from 'node:fs'");
    expect(result.code).not.toContain('configPath');
    expect(result.code).toContain('./effects');
    expect(result.watchFiles).toContain(config);
  });

  test('preserves source locations through an output source map', async () => {
    const source = `\nfunction value() { 'use macro'; return 4; }\nexport const result = value();\n`;
    const filename = '/tmp/source-map.ts';
    const result = await createTransformer().transform(source, filename);
    expect(result.map).toBeDefined();
    expect((result.map as { sources: string[] }).sources).toContain(resolve(filename).replaceAll('\\', '/'));
    const callOffset = source.indexOf('value();');
    const callColumn = callOffset - source.lastIndexOf('\n', callOffset) - 1;
    const generatedColumn = result.code.indexOf('4');
    const original = originalPositionFor(new TraceMap(result.map as any), { line: 1, column: generatedColumn });
    expect(original.line).toBe(3);
    expect(original.column).toBe(callColumn);
  });
});

describe('module resolution and caching', () => {
  test('resolves imported TypeScript macros, aliases, re-exports, and utility imports', async () => {
    const directory = await project();
    await writeFile(
      join(directory, 'helpers.ts'),
      `export function format(input: string) { return input.toUpperCase(); }`,
    );
    await writeFile(
      join(directory, 'macros.ts'),
      `import { format as normalize } from './helpers';\nexport function getValue() { 'use macro'; return normalize('hello'); }`,
    );
    await writeFile(join(directory, 'barrel.ts'), `export { getValue as sharedMacro } from './macros';`);
    const source = `import { sharedMacro as value } from './barrel';\nexport const result = value();`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('export const result = "HELLO";');
    expect(result.code).not.toContain('from "./barrel"');
    expect(result.watchFiles).toContain(join(directory, 'macros.ts'));
    expect(result.watchFiles).toContain(join(directory, 'helpers.ts'));
  });

  test('resolves default-exported macros', async () => {
    const directory = await project();
    await writeFile(join(directory, 'macros.ts'), `export default function () { 'use macro'; return 42; }`);
    const source = `import getValue from './macros'; export const result = getValue();`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('export const result = 42;');
    expect(result.code).not.toContain('getValue');
  });

  test('removes named macro-only re-exports from barrel modules', async () => {
    const directory = await project();
    await writeFile(join(directory, 'macros.ts'), `export function get() { 'use macro'; return 42; }`);
    const barrel = await createTransformer().transform(
      `export { get as shared } from './macros';`,
      join(directory, 'barrel.ts'),
    );
    expect(barrel.code).toBe('');
    expect(barrel.watchFiles).toContain(join(directory, 'macros.ts'));
  });

  test('keeps identical macro names from separate modules distinct', async () => {
    const directory = await project();
    await writeFile(join(directory, 'one.ts'), `export function get() { 'use macro'; return 1; }`);
    await writeFile(join(directory, 'two.ts'), `export function get() { 'use macro'; return 2; }`);
    const source = `import { get as one } from './one';\nimport { get as two } from './two';\nexport const values = [one(), two()];`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('export const values = [1, 2];');
  });

  test('supports namespace macro calls while preserving runtime namespace members', async () => {
    const directory = await project();
    await writeFile(
      join(directory, 'macros.ts'),
      `export function compileValue() { 'use macro'; return 42; }\nexport function runtimeValue() { return 7; }`,
    );
    const source = `import * as macros from './macros';\nexport const compiled = macros.compileValue();\nexport const runtime = macros.runtimeValue();`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain("import * as macros from './macros'");
    expect(result.code).toContain('export const compiled = 42;');
    expect(result.code).toContain('macros.runtimeValue()');
  });

  test('rejects namespace macro functions used as runtime values', async () => {
    const directory = await project();
    await writeFile(join(directory, 'macros.ts'), `export function compileValue() { 'use macro'; return 42; }`);
    const source = `import * as macros from './macros'; const runtime = macros.compileValue;`;
    await expect(createTransformer().transform(source, join(directory, 'app.ts'))).rejects.toThrow(
      'referenced as a runtime value',
    );
  });

  test('resolves static ESM imports of Node built-ins and registers tracked files', async () => {
    const directory = await project();
    const config = join(directory, 'config.json');
    await writeFile(config, '{"name":"tracked"}');
    const source = `
import { readFileSync } from 'node:fs';
function load() { 'use macro'; trackFile(${JSON.stringify(config)}); return JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8')); }
export const result = load();
`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('name: "tracked"');
    expect(result.code).not.toContain("from 'node:fs'");
    expect(result.code).not.toContain('readFileSync');
    expect(result.watchFiles).toContain(config);
  });

  test('bundles CommonJS utilities imported by an ESM macro', async () => {
    const directory = await project();
    await writeFile(join(directory, 'legacy.cjs'), `exports.format = (value) => value.toUpperCase();`);
    await writeFile(
      join(directory, 'macros.ts'),
      `import { format } from './legacy.cjs'; export function get() { 'use macro'; return format('hello'); }`,
    );
    const source = `import { get } from './macros'; export const result = get();`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('export const result = "HELLO";');
    expect(result.watchFiles).toContain(join(directory, 'legacy.cjs'));
  });

  test('allows trusted macros to import packages without transforming package source', async () => {
    const directory = await project();
    const dependency = join(directory, 'node_modules', 'fixture');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture', type: 'module', exports: './index.js' }),
    );
    await writeFile(join(dependency, 'index.js'), `export function format(value) { return value.toUpperCase(); }`);
    await writeFile(
      join(directory, 'macros.ts'),
      `import { format } from 'fixture'; export function get() { 'use macro'; return format('hello'); }`,
    );
    const source = `import { get } from './macros'; export const result = get();`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('export const result = "HELLO";');
    expect(result.watchFiles).toContain(join(dependency, 'index.js'));
  });

  test('supports transitive imports and circular dependency graphs in macro dependencies', async () => {
    const directory = await project();
    await writeFile(
      join(directory, 'a.ts'),
      `import { suffix } from './b'; export function format(input: string) { return input + suffix; }`,
    );
    await writeFile(
      join(directory, 'b.ts'),
      `import { format } from './a'; export const suffix = '!'; export const unused = () => format('cycle');`,
    );
    await writeFile(
      join(directory, 'macros.ts'),
      `import { format } from './a'; export function get() { 'use macro'; return format('cycle'); }`,
    );
    const source = `import { get } from './macros'; export const result = get();`;
    const result = await createTransformer().transform(source, join(directory, 'app.ts'));
    expect(result.code).toContain('export const result = "cycle!";');
    expect(result.watchFiles).toContain(join(directory, 'b.ts'));
  });

  test('does not discover macro exports under node_modules by default', async () => {
    const directory = await project();
    const dependency = join(directory, 'node_modules', 'fixture');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'index.js'), `export function value() { 'use macro'; return 42; }`);
    const source = `import { value } from 'fixture'; export const result = value();`;
    const result = await createTransformer().transform(source, join(directory, 'app.js'));
    expect(result.code).toContain('value()');
    expect(result.code).toContain("from 'fixture'");
  });

  test('allows dependency transformation only when explicitly enabled', async () => {
    const directory = await project();
    const dependency = join(directory, 'node_modules', 'fixture');
    await mkdir(dependency, { recursive: true });
    const source = `export function value() { 'use macro'; return 42; }\nexport const result = value();`;
    const result = await createTransformer({ transformDependencies: true }).transform(
      source,
      join(dependency, 'index.js'),
    );
    expect(result.code).toContain('export const result = 42;');
  });

  test('invalidates compiled macro modules when a transitive dependency changes', async () => {
    const directory = await project();
    const helper = join(directory, 'helper.ts');
    await writeFile(helper, `export const suffix = 'one';`);
    await writeFile(
      join(directory, 'macros.ts'),
      `import { suffix } from './helper'; export function get() { 'use macro'; return suffix; }`,
    );
    const source = `import { get } from './macros'; export const result = get();`;
    const transformer = createTransformer();
    const first = await transformer.transform(source, join(directory, 'app.ts'));
    await writeFile(helper, `export const suffix = 'two';`);
    const second = await transformer.transform(source, join(directory, 'app.ts'));
    expect(first.code).toContain('"one"');
    expect(second.code).toContain('"two"');
    await rm(helper);
    await expect(transformer.transform(source, join(directory, 'app.ts'))).rejects.toThrow();
  });

  test('compiles a shared macro module once and does not cache its results', async () => {
    const directory = await project();
    let compilations = 0;
    const source = `let count = 0; export function next() { 'use macro'; return ++count; }`;
    await writeFile(join(directory, 'macros.ts'), source);
    const compiler = {
      async compile(request: Parameters<typeof esbuildMacroCompiler.compile>[0]) {
        compilations += 1;
        return esbuildMacroCompiler.compile(request);
      },
    };
    const transformer = createTransformer({ compiler });
    const result = await transformer.transform(
      `import { next } from './macros'; export const values = [next(), next()];`,
      join(directory, 'app.ts'),
    );
    expect(result.code).toContain('export const values = [1, 2];');
    expect(compilations).toBe(1);
  });

  test('deduplicates concurrent compilation of the same imported macro', async () => {
    const directory = await project();
    await writeFile(
      join(directory, 'macros.ts'),
      `export function value(input: number) { 'use macro'; return input + 1; }`,
    );
    let compilations = 0;
    const compiler = {
      async compile(request: Parameters<typeof esbuildMacroCompiler.compile>[0]) {
        compilations += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return esbuildMacroCompiler.compile(request);
      },
    };
    const transformer = createTransformer({ compiler });
    const results = await Promise.all([
      transformer.transform(
        `import { value } from './macros'; export const result = value(1);`,
        join(directory, 'one.ts'),
      ),
      transformer.transform(
        `import { value } from './macros'; export const result = value(2);`,
        join(directory, 'two.ts'),
      ),
    ]);
    expect(results[0]?.code).toContain('result = 2');
    expect(results[1]?.code).toContain('result = 3');
    expect(compilations).toBe(1);
  });
});

describe('execution policy', () => {
  test('restricted mode fails closed without an isolation backend', async () => {
    const transformer = createTransformer({ execution: { mode: 'restricted' } });
    await expect(
      transformer.transform(`function value() { 'use macro'; return 1; } value();`, '/tmp/restricted.ts'),
    ).rejects.toThrow('Restricted macro execution is unavailable');
  });

  test('starts with an empty worker environment and blocks configured secrets in output and errors', async () => {
    const transformer = createTransformer({ execution: { env: { USE_MACRO_API_TOKEN: 'test-secret-value' } } });
    const source = `function leak() { 'use macro'; return process.env.USE_MACRO_API_TOKEN; } leak();`;
    await expect(transformer.transform(source, '/tmp/secret-output.ts')).rejects.toThrow(
      'contains a configured secret value and was not emitted',
    );
    const failure = `function fail() { 'use macro'; throw new Error(process.env.USE_MACRO_API_TOKEN); } fail();`;
    let error: unknown;
    try {
      await transformer.transform(failure, '/tmp/secret-error.ts');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain('test-secret-value');
  });

  test('does not inherit the parent environment by default', async () => {
    const previous = process.env.USE_MACRO_INHERIT_TEST;
    process.env.USE_MACRO_INHERIT_TEST = 'parent-secret-value';
    try {
      const result = await createTransformer().transform(
        `function get() { 'use macro'; return process.env.USE_MACRO_INHERIT_TEST; } export const value = get();`,
        '/tmp/environment.ts',
      );
      expect(result.code).toContain('value = void 0');
      expect(result.code).not.toContain('parent-secret-value');
    } finally {
      if (previous === undefined) delete process.env.USE_MACRO_INHERIT_TEST;
      else process.env.USE_MACRO_INHERIT_TEST = previous;
    }
  });

  test('terminates a macro that exceeds its execution timeout', async () => {
    const transformer = createTransformer({ execution: { timeoutMs: 250 } });
    await expect(
      transformer.transform(`function hang() { 'use macro'; while (true) {} } hang();`, '/tmp/timeout.ts'),
    ).rejects.toThrow('exceeded 250 ms');
  });

  test('rejects serialized results above the configured output size', async () => {
    const transformer = createTransformer({ execution: { maxOutputBytes: 64 } });
    await expect(
      transformer.transform(
        `function large() { 'use macro'; return 'x'.repeat(100); } large();`,
        '/tmp/large-output.ts',
      ),
    ).rejects.toThrow('Serialized macro result exceeds the 64 byte limit');
  });

  test('cancels an active macro worker', async () => {
    const controller = new AbortController();
    const transformer = createTransformer({ execution: { signal: controller.signal, timeoutMs: 5_000 } });
    const pending = transformer.transform(`function hang() { 'use macro'; while (true) {} } hang();`, '/tmp/cancel.ts');
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow('cancelled');
  });

  test('does not let a terminated worker reject the next queued macro call', async () => {
    const controller = new AbortController();
    const transformer = createTransformer();
    const filename = '/tmp/cancel-queued.ts';
    const first = transformer.transformSource(
      `function value(hang: boolean) { 'use macro'; if (hang) while (true) {} return 42; } value(true);`,
      filename,
      { signal: controller.signal },
    );
    const second = transformer.transformSource(
      `function value(hang: boolean) { 'use macro'; if (hang) while (true) {} return 42; } value(false);`,
      filename,
    );
    setTimeout(() => controller.abort(), 100);

    await expect(first).rejects.toThrow('cancelled');
    const result = await second;
    expect(result.code).toContain('42;');
  });

  test('reports rejected async macros at the call site without a worker stack', async () => {
    const source = `async function fail() { 'use macro'; throw new Error('expected failure'); }\nfail();`;
    const filename = '/tmp/fail.ts';
    await expect(createTransformer().transform(source, filename)).rejects.toThrow(
      `${resolve(filename)}:2:1: MacroExecutionError: Error: expected failure`,
    );
  });

  test('keeps call-site diagnostics isolated across concurrent transforms', async () => {
    const transformer = createTransformer();
    const [left, right] = await Promise.allSettled([
      transformer.transform(
        `function fail(message: string) { 'use macro'; throw new Error(message); }\nfail('left failure');`,
        '/tmp/left-failure.ts',
      ),
      transformer.transform(
        `function fail(message: string) { 'use macro'; throw new Error(message); }\n\nfail('right failure');`,
        '/tmp/right-failure.ts',
      ),
    ]);

    expect(left.status).toBe('rejected');
    expect(right.status).toBe('rejected');
    if (left.status === 'rejected') {
      expect(left.reason).toBeInstanceOf(Error);
      expect(left.reason.message).toContain(`${resolve('/tmp/left-failure.ts')}:2:1`);
      expect(left.reason.message).toContain('left failure');
      expect(left.reason.message).not.toContain('right failure');
    }
    if (right.status === 'rejected') {
      expect(right.reason).toBeInstanceOf(Error);
      expect(right.reason.message).toContain(`${resolve('/tmp/right-failure.ts')}:3:1`);
      expect(right.reason.message).toContain('right failure');
      expect(right.reason.message).not.toContain('left failure');
    }
  });
});
