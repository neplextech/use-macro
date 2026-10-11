import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacroTransformer } from '../src/transformer.js';

const directory = await mkdtemp(join(tmpdir(), 'use-macro-bench-'));
const options = { execution: { mode: 'trusted' as const } };
const results: Array<{ name: string; iterations: number; totalMs: number; averageMs: number; opsPerSecond: number }> =
  [];

async function measure(
  name: string,
  iterations: number,
  operation: (index: number) => Promise<unknown>,
): Promise<void> {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) await operation(index);
  const totalMs = performance.now() - start;
  results.push({
    name,
    iterations,
    totalMs,
    averageMs: totalMs / iterations,
    opsPerSecond: (iterations * 1000) / totalMs,
  });
}

async function withTransformer<T>(operation: (transformer: MacroTransformer) => Promise<T>): Promise<T> {
  const transformer = new MacroTransformer(options);
  try {
    return await operation(transformer);
  } finally {
    await transformer.dispose();
  }
}

try {
  const macroPath = join(directory, 'macros.ts');
  const asyncMacroPath = join(directory, 'async-macros.ts');
  await writeFile(macroPath, `export function value(input: number) { 'use macro'; return input * 2; }`);
  await writeFile(
    asyncMacroPath,
    `export async function value(input: number) { 'use macro'; return await Promise.resolve(input * 2); }`,
  );

  const plainTransformer = new MacroTransformer(options);
  const plainSource = 'export const answer = 42;\n';
  await measure('no macros, 500 source transforms', 500, (index) =>
    plainTransformer.transform(plainSource, join(directory, `plain-${index}.ts`)),
  );
  await measure('unchanged source, 500 repeated transforms', 500, () =>
    plainTransformer.transform(plainSource, join(directory, 'plain.ts')),
  );
  await plainTransformer.dispose();

  await withTransformer(async (transformer) => {
    await measure('100 modules, one imported macro each', 100, (index) =>
      transformer.transform(
        `import { value } from './macros'; export const result = value(${index});`,
        join(directory, `app-${index}.ts`),
      ),
    );
  });

  await withTransformer(async (transformer) => {
    const repeatedCalls = Array.from({ length: 100 }, (_, index) => `value(${index})`).join(', ');
    await measure('one macro, repeated calls with different arguments', 10, () =>
      transformer.transform(
        `import { value } from './macros'; export const values = [${repeatedCalls}];`,
        join(directory, 'repeated.ts'),
      ),
    );
  });

  await withTransformer(async (transformer) => {
    const start = performance.now();
    await transformer.transform(
      `import { value } from './macros'; export const result = value(1);`,
      join(directory, 'cold.ts'),
    );
    const coldMs = performance.now() - start;
    const warmStart = performance.now();
    await transformer.transform(
      `import { value } from './macros'; export const result = value(1);`,
      join(directory, 'cold.ts'),
    );
    const warmMs = performance.now() - warmStart;
    results.push({
      name: 'cold macro compilation',
      iterations: 1,
      totalMs: coldMs,
      averageMs: coldMs,
      opsPerSecond: 1000 / coldMs,
    });
    results.push({
      name: 'warm unchanged macro transform',
      iterations: 1,
      totalMs: warmMs,
      averageMs: warmMs,
      opsPerSecond: 1000 / warmMs,
    });
  });

  await withTransformer(async (transformer) => {
    await measure('imported macro calls', 100, (index) =>
      transformer.transform(
        `import { value } from './macros'; export const result = value(${index});`,
        join(directory, `imported-${index}.ts`),
      ),
    );
  });

  await withTransformer(async (transformer) => {
    await measure('async macros', 50, (index) =>
      transformer.transform(
        `import { value } from './async-macros'; export const result = value(${index});`,
        join(directory, `async-${index}.ts`),
      ),
    );
  });

  const runtime = typeof Bun === 'undefined' ? process.version : `Bun ${Bun.version} (Node ${process.version})`;
  process.stdout.write(`${JSON.stringify({ runtime, results }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
