import { extname } from 'node:path';
import { MacroTransformer, type MacroTransformerOptions } from './transformer.js';
import type { NextMacroOptions } from './next.js';

interface NextLoaderCompiler {
  hooks?: {
    shutdown?: {
      tapPromise?: (name: string, callback: () => Promise<void>) => void;
    };
  };
}

export interface NextLoaderContext {
  resourcePath: string;
  getOptions(): NextMacroOptions & { __useMacroTurbopack?: boolean };
  addDependency(filePath: string): void;
  _compiler?: NextLoaderCompiler;
}

export type NextLoaderCallback = (error: Error | null, code?: string, map?: object) => void;

const transformersByCompiler = new WeakMap<object, Map<string, MacroTransformer>>();

/** Entrypoint called by the CommonJS bridge used by Webpack and Turbopack. */
export function runNextMacroLoader(
  context: NextLoaderContext,
  source: string,
  inputSourceMap: object | undefined,
  callback: NextLoaderCallback,
): void {
  void transformSource(context, source, inputSourceMap)
    .then(({ code, map }) => callback(null, code, map))
    .catch((error: unknown) => callback(asError(error)));
}

async function transformSource(
  context: NextLoaderContext,
  source: string,
  inputSourceMap: object | undefined,
): Promise<{ code: string; map?: object }> {
  const options = context.getOptions();
  const compiler = context._compiler;
  const transformer = compiler
    ? getCompilerTransformer(compiler, options)
    : new MacroTransformer(options as MacroTransformerOptions);
  try {
    const result = await transformer.transformSource(source, context.resourcePath);
    for (const filePath of result.watchFiles) context.addDependency(filePath);
    const extension = extname(context.resourcePath).toLowerCase();
    if (!options.__useMacroTurbopack || !isTypeScript(extension)) {
      if (!result.changed) return { code: source, ...(inputSourceMap ? { map: inputSourceMap } : {}) };
      return { code: result.code, ...(result.map ? { map: result.map } : {}) };
    }

    const codeBeforeEsbuild = result.changed ? result.code : source;
    const upstreamMap = result.changed ? result.map : inputSourceMap;
    const code = upstreamMap ? appendInlineMap(codeBeforeEsbuild, upstreamMap) : codeBeforeEsbuild;
    const { transform } = await import('esbuild');
    const compiled = await transform(code, {
      loader: extension === '.tsx' ? 'tsx' : 'ts',
      sourcefile: context.resourcePath,
      target: 'esnext',
      jsx: 'preserve',
      sourcemap: 'external',
    });
    const map = compiled.map ? (JSON.parse(compiled.map) as object) : result.map;
    return { code: compiled.code, ...(map ? { map } : {}) };
  } finally {
    if (!compiler) await transformer.dispose();
  }
}

function getCompilerTransformer(compiler: NextLoaderCompiler, options: NextMacroOptions): MacroTransformer {
  let transformers = transformersByCompiler.get(compiler);
  if (!transformers) {
    transformers = new Map();
    transformersByCompiler.set(compiler, transformers);
    const compilerTransformers = transformers;
    compiler.hooks?.shutdown?.tapPromise?.('use-macro', async () => {
      await Promise.all([...compilerTransformers.values()].map((transformer) => transformer.dispose()));
      compilerTransformers.clear();
    });
  }

  const key = JSON.stringify(options);
  let transformer = transformers.get(key);
  if (!transformer) {
    transformer = new MacroTransformer(options as MacroTransformerOptions);
    transformers.set(key, transformer);
  }
  return transformer;
}

function isTypeScript(extension: string): boolean {
  return extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts';
}

function appendInlineMap(code: string, map: object): string {
  const encoded = Buffer.from(JSON.stringify(map)).toString('base64');
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${encoded}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
