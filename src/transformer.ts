import { runInNewContext } from "vm";
import * as ts from "typescript";
import { dirname } from "path";
import { createRequire } from "module";
import { ParserOptions } from "@babel/parser";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";
import _generate from "@babel/generator";
import { OnLoadResult } from "esbuild";
import { stringify } from "./stringify.js";

type SourceLoaderType = "js" | "jsx" | "ts" | "tsx";

interface MacroFunction {
  ast: t.FunctionDeclaration | t.FunctionExpression;
  path: string;
  args: t.Node[];
}

const traverse = _traverse.default;
const generate = _generate.default;

// Helper to get parser options based on file extension
const getParserOptions = (filepath: string) => {
  const isTS = /\.tsx?$/.test(filepath);
  const isJSX = /\.jsx$/.test(filepath) || /\.tsx$/.test(filepath);
  const isModule = /^m/.test(filepath);

  return {
    sourceType: isModule ? "module" : "unambiguous",
    plugins: [
      ...(isTS ? ["typescript"] : []),
      ...(isJSX ? ["jsx"] : []),
      "decorators-legacy",
      "classProperties",
      "optionalChaining",
      "nullishCoalescingOperator",
    ] as ParserOptions["plugins"],
  } satisfies ParserOptions;
};

// Helper to transpile TypeScript to JavaScript
const transpileTypeScript = (code: string, filePath: string) => {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ESNext,
    },
    fileName: filePath,
  });
  return result.outputText;
};

// Helper to execute macro at compile time
const executeMacro = (macroFunction: MacroFunction) => {
  const macroCode = generate(macroFunction.ast).code;
  const transpiledCode = /\.(m|c|d)?tsx?$/.test(macroFunction.path)
    ? transpileTypeScript(macroCode, macroFunction.path)
    : macroCode;

  const macroModule = `
        ${transpiledCode}
        // do not export this as it is evaluated in vm which directly returns the result
        ${macroFunction.ast.id?.name}(${macroFunction.args.join(", ")})`;

  const result = runInNewContext(`${macroModule}`, {
    ...Object.fromEntries(Object.entries(globalThis)),
    process,
    Buffer,
    URL,
    URLSearchParams,
    fetch,
    Response,
    Headers,
    Request,
    FormData,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    AbortController,
    AbortSignal,
    __dirname: dirname(macroFunction.path),
    __filename: macroFunction.path,
    require: createRequire(macroFunction.path),
    import: (modulePath: string) => import(modulePath),
    isMacroContext: true,
  });

  return result?.default ?? result;
};

export class MacroTransformer {
  public cache = new Map<string, string>();
  public functions = new Map<string, MacroFunction>();

  public async transform(
    contents: string,
    filePath: string,
  ): Promise<OnLoadResult> {
    const macroFunctions = this.functions;
    const macroCache = this.cache;
    const ast = parse(contents, getParserOptions(filePath));

    const state = {
      modifications: [] as (() => void | Promise<void>)[],
      macrosToRemove: new Set<_traverse.NodePath>(),
      macrosToExecute: [] as Array<() => Promise<string>>,
    };

    const runMacro = async (
      name: string,
      fn: MacroFunction,
    ): Promise<string> => {
      if (macroCache.has(name)) {
        return macroCache.get(name) as string;
      }

      const result = await executeMacro(fn);
      const stringifiedResult = await stringify(result);
      macroCache.set(name as string, stringifiedResult);

      return stringifiedResult;
    };

    traverse(ast, {
      "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression"(path) {
        const node = path.node;

        if (!t.isFunction(node)) return;

        const body = node.body;
        if (!t.isBlockStatement(body)) return;

        if (body.directives) {
          const directive = body.directives.find(
            (d) => d.value.value === "use macro",
          );

          if (directive) {
            let functionName: string | undefined;

            if (t.isFunctionDeclaration(node) && node.id) {
              functionName = node.id.name;
            } else if (
              path.parent &&
              t.isVariableDeclarator(path.parent) &&
              t.isIdentifier(path.parent.id)
            ) {
              functionName = path.parent.id.name;
            }

            if (!functionName) {
              const err = new Error(
                `Macro function at at ${filePath}:${node.loc?.start.line}:${node.loc?.start.column} must have a name. If you are using an IIFE, it is not supported.`,
              );

              throw err;
            }

            const macroFunction = {
              ast: t.isFunctionDeclaration(node)
                ? node
                : t.functionDeclaration(
                    t.identifier(functionName),
                    // @ts-ignore
                    node.params,
                    body,
                  ),
              path: filePath,
              args: node.params,
            };

            macroFunctions.set(functionName, macroFunction);

            // Add to removal queue
            const nodeToRemove = t.isFunctionDeclaration(node)
              ? path
              : path.parentPath;
            if (nodeToRemove) {
              state.macrosToRemove.add(nodeToRemove);
            }
          }
        }
      },

      CallExpression(path) {
        if (t.isIdentifier(path.node.callee)) {
          const functionName = path.node.callee.name;
          const fn = macroFunctions.get(functionName);

          if (!fn) return;

          state.modifications.push(async () => {
            const value = await runMacro(functionName, fn);
            const newNode = t.identifier(value);
            t.addComment(newNode, "leading", ` @__MACRO__ ${functionName} `);
            path.replaceWith(newNode);
          });
        }
      },
    });

    // Apply all modifications in a single pass
    for (const modify of state.modifications) {
      await modify();
    }

    // Remove all macro definitions
    state.macrosToRemove.forEach((path) => path.remove());

    const { code } = generate(ast, {
      retainLines: true,
      compact: false,
      sourceMaps: true,
      sourceFileName: filePath,
    });

    return {
      contents: code,
      loader: filePath.split(".").pop() as SourceLoaderType,
    };
  }
}
