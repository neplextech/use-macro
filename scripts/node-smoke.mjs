import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacroTransformer } from '../dist/transformer.js';

const directory = await mkdtemp(join(tmpdir(), 'use-macro-node-smoke-'));
const previous = process.env.USE_MACRO_NODE_SMOKE;
process.env.USE_MACRO_NODE_SMOKE = 'parent-environment-value';
const transformer = new MacroTransformer({ execution: { mode: 'trusted' } });

try {
  const trackedFile = join(directory, 'message.json');
  await writeFile(trackedFile, JSON.stringify({ value: 'node' }));
  await writeFile(join(directory, 'helper.mjs'), `export function format(value) { return value.toUpperCase(); }`);
  await writeFile(
    join(directory, 'macros.mjs'),
    `import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format } from './helper.mjs';
export async function getValue() {
  'use macro';
  const path = resolve(globalThis.__dirname, 'message.json');
  trackFile(path);
  const value = JSON.parse(readFileSync(path, 'utf8')).value;
  return { value: format(value), env: process.env.USE_MACRO_NODE_SMOKE ?? 'empty' };
}`,
  );

  const result = await transformer.transform(
    `import { getValue } from './macros.mjs'; export const value = await getValue();`,
    join(directory, 'app.mjs'),
  );
  assert.match(result.code, /value: "NODE"/);
  assert.match(result.code, /env: "empty"/);
  assert.ok(result.watchFiles.includes(trackedFile));
  process.stdout.write('Node macro execution, ESM dependencies, file tracking, and environment isolation passed.\n');
} finally {
  await transformer.dispose();
  if (previous === undefined) delete process.env.USE_MACRO_NODE_SMOKE;
  else process.env.USE_MACRO_NODE_SMOKE = previous;
  await rm(directory, { recursive: true, force: true });
}
