import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const loader = require(resolve(process.cwd(), 'dist/next-loader.cjs'));
assert.equal(typeof loader, 'function');

const result = await new Promise((resolveResult, rejectResult) => {
  const context = {
    resourcePath: resolve(process.cwd(), 'next-loader-smoke.ts'),
    getOptions: () => ({ __useMacroTurbopack: true }),
    addDependency() {},
    async() {
      return (error, code, map) => {
        if (error) rejectResult(error);
        else resolveResult({ code, map });
      };
    },
  };
  loader.call(context, 'export const value: number = 42;');
});

assert.match(result.code, /export const value = 42/);
assert.ok(result.map);
process.stdout.write('Next.js CommonJS loader bridge is valid.\n');
