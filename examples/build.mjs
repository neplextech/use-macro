import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { esbuildPluginUseMacro } from '../dist/esbuild.js';

const directory = dirname(fileURLToPath(import.meta.url));

await build({
  absWorkingDir: resolve(directory),
  bundle: true,
  entryPoints: ['./src/index.ts'],
  outfile: './dist/use-macro-example.js',
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  plugins: [esbuildPluginUseMacro({ execution: { mode: 'trusted' } })],
});
