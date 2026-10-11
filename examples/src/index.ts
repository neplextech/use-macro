import type {} from '../../src/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function getVersion(): string {
  'use macro';

  const filePath = resolve(globalThis.__dirname, '../../package.json');
  trackFile(filePath);
  return JSON.parse(readFileSync(filePath, 'utf8')).version;
}

async function getMessage(): Promise<string> {
  'use macro';

  const filePath = resolve(globalThis.__dirname, 'message.txt');
  trackFile(filePath);
  return await readFileSync(filePath, 'utf8');
}

function describe(prefix: string, value: string): string {
  'use macro';
  return `${prefix}: ${value}`;
}

export const version = getVersion();
export const message = describe('Message', await getMessage());
