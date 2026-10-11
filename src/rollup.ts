import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { MacroTransformer, type MacroTransformerOptions } from './transformer.js';

export interface RollupMacroOptions extends MacroTransformerOptions {
  includeExtensions?: string[];
}

const sourceExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];

/** A Rollup-compatible transform hook. It can also be used directly in Vite's plugin list. */
export function rollupPluginUseMacro(options: RollupMacroOptions = {}) {
  const transformer = new MacroTransformer(options);
  const extensions = new Set(
    (options.includeExtensions ?? sourceExtensions).map((extension) =>
      extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
    ),
  );

  return {
    name: 'use-macro',
    enforce: 'pre' as const,
    async transform(this: { addWatchFile(filePath: string): void }, source: string, id: string) {
      const filename = id.split('?')[0];
      if (!filename) return null;
      if (!extensions.has(extname(filename).toLowerCase())) return null;
      const currentSource = source || (await readFile(filename, 'utf8'));
      const result = await transformer.transformSource(currentSource, filename);
      for (const filePath of result.watchFiles) this.addWatchFile(filePath);
      if (!result.changed) return null;
      return { code: result.code, map: result.map ?? null };
    },
    async closeBundle() {
      await transformer.dispose();
    },
  };
}

export const vitePluginUseMacro = rollupPluginUseMacro;
