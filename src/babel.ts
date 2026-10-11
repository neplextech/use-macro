import type { File, Program } from '@babel/types';
import { MacroTransformer, type AstTransformResult, type MacroTransformerOptions } from './transformer.js';

export interface BabelMacroPreprocessorOptions extends MacroTransformerOptions {
  /** Supply a long-lived transformer to share parse and compilation caches across files. */
  transformer?: MacroTransformer;
}

export interface BabelAstTransformOptions {
  filename: string;
  source?: string;
  signal?: AbortSignal;
}

export interface BabelMacroPreprocessor extends AsyncDisposable {
  transform(ast: File | Program, transformOptions: BabelAstTransformOptions): Promise<AstTransformResult>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Create an async preprocessor that mutates the Babel AST supplied by the caller. */
export function createBabelMacroPreprocessor(options: BabelMacroPreprocessorOptions = {}) {
  const transformer = options.transformer ?? new MacroTransformer(options);
  const preprocessor: BabelMacroPreprocessor = {
    transform(ast: File | Program, transformOptions: BabelAstTransformOptions): Promise<AstTransformResult> {
      return transformer.transformAstInPlace(ast, transformOptions);
    },
    dispose(): Promise<void> {
      return transformer.dispose();
    },
    [Symbol.asyncDispose](): Promise<void> {
      return transformer[Symbol.asyncDispose]();
    },
  };
  return preprocessor;
}

/** Convenience one-shot API for tools that already have a Babel AST. */
export async function transformBabelAst(
  ast: File | Program,
  options: BabelAstTransformOptions & BabelMacroPreprocessorOptions,
): Promise<AstTransformResult> {
  if (options.transformer) return options.transformer.transformAstInPlace(ast, options);
  await using transformer = new MacroTransformer(options);
  return transformer.transformAstInPlace(ast, options);
}
