import { readFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import type { Plugin } from 'esbuild';
import { MacroTransformer, type MacroTransformerOptions } from './transformer.js';

export interface EsbuildMacroOptions extends MacroTransformerOptions {
  /** Filter source paths in addition to the built-in JavaScript/TypeScript extension filter. */
  filter?: RegExp;
}

const defaultFilter = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Create an esbuild adapter. The core transformer does not import esbuild until a macro is compiled. */
export function esbuildPluginUseMacro(options: EsbuildMacroOptions = {}): Plugin {
  const transformer = new MacroTransformer(options);
  const filter = options.filter ?? defaultFilter;

  return {
    name: 'use-macro',
    setup(build) {
      build.onDispose(() => {
        void transformer.dispose();
      });
      build.onLoad({ filter }, async (args) => {
        if (args.path.split(/[\\/]/).includes('node_modules') && !options.transformDependencies) return undefined;
        const source = await readFile(args.path, 'utf8');
        const result = await transformer.transformSource(source, args.path);
        if (!result.changed) return undefined;
        const contents = result.map
          ? `${result.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(result.map)).toString('base64')}`
          : result.code;
        return {
          contents,
          loader: loaderFromPath(args.path),
          resolveDir: dirname(args.path),
          watchFiles: result.watchFiles,
        };
      });
    },
  };
}

function loaderFromPath(filename: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  const extension = extname(filename).toLowerCase();
  if (extension === '.tsx' || extension === '.jsx') return extension.slice(1) as 'jsx' | 'tsx';
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') return 'ts';
  return 'js';
}

export const createEsbuildMacroPlugin = esbuildPluginUseMacro;
