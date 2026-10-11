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

/** Create an async preprocessor that mutates the Babel AST supplied by the caller. */
export function createBabelMacroPreprocessor(options: BabelMacroPreprocessorOptions = {}) {
  const transformer = options.transformer ?? new MacroTransformer(options);
  return {
    transform(ast: File | Program, transformOptions: BabelAstTransformOptions): Promise<AstTransformResult> {
      return transformer.transformAstInPlace(ast, transformOptions);
    },
    dispose(): Promise<void> {
      return transformer.dispose();
    },
  };
}

/** Convenience one-shot API for tools that already have a Babel AST. */
export async function transformBabelAst(
  ast: File | Program,
  options: BabelAstTransformOptions & BabelMacroPreprocessorOptions,
): Promise<AstTransformResult> {
  if (options.transformer) return options.transformer.transformAstInPlace(ast, options);
  const transformer = new MacroTransformer(options);
  try {
    return await transformer.transformAstInPlace(ast, options);
  } finally {
    await transformer.dispose();
  }
}
