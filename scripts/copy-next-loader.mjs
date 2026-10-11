import { copyFile } from 'node:fs/promises';

await copyFile(new URL('../src/next-loader.cjs', import.meta.url), new URL('../dist/next-loader.cjs', import.meta.url));
