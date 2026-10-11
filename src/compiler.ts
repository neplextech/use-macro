import { resolve } from 'node:path';

export interface CompileMacroRequest {
  /** A synthetic entry module containing one macro and its lexical dependencies. */
  source: string;
  /** Directory used to resolve the synthetic module's imports. */
  resolveDir: string;
  /** Extension of the original macro module. */
  extension: string;
  /** Stable identity used by custom compilers. */
  identity: string;
}

export interface CompileMacroResult {
  code: string;
  dependencies: string[];
}

export interface MacroCompiler {
  compile(request: CompileMacroRequest): Promise<CompileMacroResult>;
}

/** Lazily imports esbuild so importing the core package does not load a bundler. */
export const esbuildMacroCompiler: MacroCompiler = {
  async compile(request) {
    let esbuild: typeof import('esbuild');
    try {
      esbuild = await import('esbuild');
    } catch {
      throw new Error('Macro compilation requires esbuild. Install esbuild or provide a MacroCompiler.');
    }

    const extension = /^\.(?:[cm]?[jt]sx?)$/.test(request.extension) ? request.extension : '.ts';
    const result = await esbuild.build({
      absWorkingDir: request.resolveDir,
      bundle: true,
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
      platform: 'node',
      sourcemap: false,
      stdin: {
        contents: request.source,
        resolveDir: request.resolveDir,
        sourcefile: `__use_macro_entry${extension}`,
        loader: extension.endsWith('x')
          ? extension.startsWith('.t')
            ? 'tsx'
            : 'jsx'
          : extension.endsWith('ts')
            ? 'ts'
            : 'js',
      },
      target: 'node20',
      write: false,
    });

    const output = result.outputFiles.find((file) => file.path.endsWith('.js')) ?? result.outputFiles[0];
    if (!output) throw new Error('The macro compiler produced no JavaScript output.');

    const dependencies = Object.keys(result.metafile?.inputs ?? {})
      .map((input) => resolve(request.resolveDir, input))
      .filter((input) => !input.includes('__use_macro_entry'));
    return { code: output.text, dependencies };
  },
};
