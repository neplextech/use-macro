import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackageJson {
  name: string;
  exports: Record<string, string | Record<string, string>>;
  files: string[];
}

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageJson;
const exportPaths = Object.values(packageJson.exports).flatMap((entry) =>
  typeof entry === 'string' ? [entry] : Object.values(entry),
);

for (const exportPath of exportPaths) {
  if (!exportPath.startsWith('./')) continue;
  const path = resolve(root, exportPath);
  if (!existsSync(path)) throw new Error(`Package export target does not exist: ${exportPath}`);
}

const packageEntries = ['.', './esbuild', './babel', './rollup', './next'];
for (const entry of packageEntries) {
  execFileSync(
    'node',
    ['--input-type=module', '-e', `await import(${JSON.stringify(packageJson.name + entry.slice(1))})`],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
}
execFileSync('node', ['scripts/node-smoke.mjs'], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['scripts/node-next-loader-smoke.mjs'], { cwd: root, stdio: 'inherit' });

const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
if (pack.status !== 0) throw new Error(`npm pack --dry-run failed:\n${pack.stderr || pack.stdout}`);

const packResult = JSON.parse(pack.stdout) as
  | Array<{ files: Array<{ path: string }> }>
  | Record<string, { files: Array<{ path: string }> }>;
const packed = Array.isArray(packResult) ? packResult[0] : packResult[packageJson.name];
const files = new Set(packed?.files.map((file) => file.path) ?? []);
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/esbuild.js',
  'dist/babel.js',
  'dist/rollup.js',
  'dist/next.js',
  'dist/next-loader.js',
  'dist/next-loader.cjs',
];
for (const file of required) {
  if (!files.has(file)) throw new Error(`npm pack is missing required file: ${file}`);
}
for (const file of files) {
  if (/^(?:src|test|scripts|benchmarks|examples)\//.test(file)) {
    throw new Error(`Unexpected development file included in npm package: ${file}`);
  }
}

process.stdout.write(`Package exports and npm pack contents are valid (${files.size} files).\n`);
