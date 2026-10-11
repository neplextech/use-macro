import { readFile, writeFile } from 'node:fs/promises';
import { parseReleaseInput } from './release-version.mjs';

const input = process.env.RELEASE_VERSION;
const tag = process.env.NPM_TAG;
if (!input || !tag) throw new TypeError('RELEASE_VERSION and NPM_TAG must be provided by the validated release job.');

const packagePath = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const release = parseReleaseInput(input, packageJson.version, { trigger: 'push' });
if (release.version !== input || release.tag !== tag) {
  throw new TypeError('Release version or npm dist-tag does not match the validated release decision.');
}
packageJson.version = release.version;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
