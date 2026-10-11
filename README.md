# use-macro

`use-macro` executes JavaScript and TypeScript functions during compilation and replaces their calls with serialized return values. A macro is an ordinary function marked with the `"use macro"` directive.

```ts
import { readFileSync } from "node:fs";

function getVersion() {
  "use macro";

  return JSON.parse(readFileSync("./package.json", "utf8")).version;
}

export const version = getVersion();
```

For a package with version `1.2.3`, the emitted JavaScript is:

```js
export const version = "1.2.3";
```

Macros execute build-time code. Configure `execution.mode: 'trusted'` only for macros and dependencies you trust.

## Installation

```sh
bun add use-macro
# or
npm install use-macro
```

The core transformer uses Babel's parser and generator. The default macro compiler is loaded only when a macro is compiled, and requires `esbuild`:

```sh
bun add -d esbuild
# or
npm install --save-dev esbuild
```

You can provide another implementation through the `MacroCompiler` interface.

## Build tool integrations

### esbuild

```ts
import { build } from "esbuild";
import { esbuildPluginUseMacro } from "use-macro/esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  plugins: [esbuildPluginUseMacro({ execution: { mode: "trusted" } })],
});
```

### Next.js

`withMacro` adds the loader to both Next.js Webpack and Turbopack configurations. It skips `node_modules` by default. The Turbopack loader uses esbuild to remove TypeScript syntax before returning JavaScript to Turbopack.

```ts
import { withMacro } from "use-macro/next";

const nextConfig = {
  reactStrictMode: true,
};

export default withMacro(nextConfig, {
  execution: { mode: "trusted" },
});
```

Install `esbuild` as a development dependency when using the default macro compiler or the Turbopack integration. Next.js 16 uses Turbopack by default; the wrapper also adds a Webpack loader for builds started with `--webpack`.

### Babel

Babel visitors are synchronous, so an ordinary Babel plugin cannot await asynchronous macro execution. Use the async preprocessor before Babel generates code. It mutates and reuses the supplied AST; Babel can generate the result once afterward.

```ts
import { parseSync, transformFromAstAsync } from "@babel/core";
import { createBabelMacroPreprocessor } from "use-macro/babel";

const source = await Bun.file("src/index.ts").text();
const ast = parseSync(source, {
  filename: "src/index.ts",
  parserOpts: { sourceType: "module" },
});
if (!ast) throw new Error("Babel did not produce an AST.");

await using macros = createBabelMacroPreprocessor({ execution: { mode: "trusted" } });
const result = await macros.transform(ast, {
  filename: "src/index.ts",
  source,
});
const output = await transformFromAstAsync(result.ast, source, {
  filename: "src/index.ts",
  configFile: false,
  babelrc: false,
});
process.stdout.write(output?.code ?? "");
```

`createBabelMacroPreprocessor` is an async preprocessing API, not a Babel visitor plugin. `transformBabelAst` is available for one-shot transforms.

Install `@babel/core` when using this integration example. The adapter accepts Babel ASTs and does not import Babel core itself.

### Rollup and Vite

```ts
import { rollupPluginUseMacro } from "use-macro/rollup";

export default {
  plugins: [rollupPluginUseMacro({ execution: { mode: "trusted" } })],
};
```

The same adapter can be passed to Vite's plugin list. It uses Rollup's async `transform` hook and registers module and explicitly tracked file dependencies for watch mode.

## Macro behavior

### Arguments and return values

Call arguments must be statically serializable. Supported expressions include primitive literals, nested arrays and plain objects, immutable `const` values, templates with primitive substitutions, and selected literal operators and constructors. Function calls, mutable variables, spreads, getters, and other dynamic expressions produce a source-located error.

```ts
function multiply(a: number, b: number) {
  "use macro";
  return a * b;
}

export const answer = multiply(6, 7);
```

This emits `export const answer = 42;`. Arguments are evaluated from the call expression, not from the function's parameter declarations. Nested macro calls are evaluated inside out. Top-level calls are processed in source order to preserve deterministic behavior when macros have side effects.

Results support primitives, arrays, plain objects, `Date`, `RegExp`, `Map`, `Set`, `URL`, `URLSearchParams`, `Headers`, `Request`, `Response`, `FormData`, `Blob`, `File`, `ArrayBuffer`, typed arrays, and Node `Buffer`. Promises are awaited. Cyclic arrays, maps, sets, and plain objects are preserved. Accessors, unsupported custom classes, and values that cannot be reconstructed produce errors.

### Async macros

Async macro results are awaited by the transformer. The source call does not need to be awaited:

```ts
async function loadData() {
  "use macro";
  return await Promise.resolve({ ok: true });
}

export const data = loadData();
```

The output contains the resolved object. To have TypeScript treat the call as its awaited return type before transformation, wrap it with `unwrap`:

```ts
import { unwrap } from "use-macro";

async function loadData() {
  "use macro";
  return await Promise.resolve({ ok: true });
}

export const data = unwrap<typeof loadData>(loadData());
```

`unwrap` returns its argument unchanged at runtime; the transformer replaces the macro call with its resolved value. Rejections include the macro call's source location. A configured timeout terminates the worker running the macro.

### Imports and cross-file macros

Macros can use static ESM imports, Node built-ins, local JavaScript or TypeScript modules, re-exports, aliases, and transitive dependencies. The default compiler bundles the macro's reachable lexical dependencies into an execution module. It does not execute unrelated top-level declarations from the source module.

```ts
// helpers.ts
export function format(value: string) {
  return value.toUpperCase();
}

// macros.ts
import { format as normalize } from "./helpers";

export function greeting() {
  "use macro";
  return normalize("hello");
}

// app.ts
import { greeting } from "./macros";

export const message = greeting();
```

The output contains `export const message = "HELLO";`. Macro-only imports and definitions are removed from runtime output. A macro imported but referenced as a runtime function is an error. Module identity and lexical bindings distinguish aliases, shadowed names, and same-named exports from different files.

Static imports in macro code work without converting them to `require()` or dynamic imports. The default compiler bundles Node built-ins and dependencies esbuild can bundle, including CommonJS dependencies. Dynamic import patterns, runtime-only modules, custom package resolution rules, and unusual bundler-specific resolution are not guaranteed. ESM cycles are handled by the module compiler when the dependency graph is supported; unresolved or unsupported dependencies report a compile-time error.

### TypeScript

The standalone transformer chooses Babel parser syntax from the file extension (`.ts`, `.tsx`, `.mts`, `.cts`, JavaScript, and JSX variants). Types are removed from compiled macro modules by the default compiler. This package does not type-check macro arguments or macro source.

## Configuration

The same `MacroTransformerOptions` are accepted by the standalone transformer and adapters unless an adapter adds a documented option.

| Option                     | Default               | Meaning                                                                                                    |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `transformDependencies`    | `false`               | Permit transforming files under `node_modules`. This is independent of imports used by trusted macros.     |
| `include(filePath)`        | all supported files   | Optional source inclusion predicate.                                                                       |
| `exclude(filePath)`        | none                  | Optional source exclusion predicate.                                                                       |
| `execution.mode`           | `restricted`          | `restricted` fails closed because no enforceable isolation backend is available. `trusted` runs the macro. |
| `execution.timeoutMs`      | `30000`               | Maximum time per macro call before its worker is terminated.                                               |
| `execution.maxOutputBytes` | `1048576`             | Maximum serialized argument and result size.                                                               |
| `execution.signal`         | none                  | Abort signal for active macro execution.                                                                   |
| `execution.env`            | empty object          | Environment variables passed to the macro worker. The parent process environment is not inherited.         |
| `compiler`                 | lazy esbuild compiler | A `MacroCompiler` implementation for generating executable macro modules.                                  |

The esbuild adapter also accepts `filter`, a regular expression for source paths. The Rollup/Vite adapter accepts `includeExtensions`.

The transformer returns `{ code, map?, changed, watchFiles }`. Standalone transforms generate a source map only when code changes. The esbuild and Rollup/Vite adapters pass generated maps through their native transform results.

## Execution and security

Macros execute during the build and can perform actions available to Node.js code. `execution.mode: 'trusted'` runs code in a reusable Node worker with filesystem, network, process, and subprocess capabilities. The worker receives only environment variables supplied through `execution.env`, which defaults to empty. The worker timeout and output limit control build resource usage, but do not sandbox side effects. Node's `vm` is not used as a security boundary. Do not run untrusted macro code.

`execution.mode: 'restricted'` is the default and currently fails closed as soon as a macro would execute. There is no fallback to trusted execution. Use trusted mode only when the build configuration and macro dependencies are intentionally trusted.

`transformDependencies` controls whether source files inside `node_modules` are transformed or scanned for macros. It does not prevent a trusted macro from importing a dependency. Such imported code runs with the same Node capabilities as the macro.

Values from explicitly passed environment variables with names that look sensitive are redacted from error messages. Direct serialized results containing those values are rejected when the value is at least eight characters long. This check does not detect transformed, encoded, or otherwise derived data and is not an information-flow boundary.

## File tracking and caching

Imported JavaScript and TypeScript modules are registered in `watchFiles` automatically. Arbitrary file reads are not inferred. Call the build-time global `trackFile(path)` from a macro to register a non-module file for invalidation. Paths are resolved relative to the macro module. In watch integrations, changes to watched files cause the host build tool to rerun the transform.

The macro worker exposes `globalThis.__dirname` and `globalThis.__filename` for the macro's source module. The transformer keeps a bounded in-memory parsed-module cache and a dependency-content-aware compiled-module cache. Compilation requests for the same macro are deduplicated. Macro results are not cached because macros can be nondeterministic or have side effects. `dispose()` terminates workers and clears caches.

## API

```ts
import { MacroTransformer } from "use-macro";

await using transformer = new MacroTransformer({ execution: { mode: "trusted" } });
const result = await transformer.transform(
  source,
  "/absolute/path/to/file.ts",
);
console.log(result.code, result.map, result.watchFiles);
```

`MacroTransformer` and the Babel preprocessor implement `Symbol.asyncDispose`, so TypeScript 5.2+ can manage them with `await using`. Webpack builds reuse one transformer per compiler and dispose it at shutdown. Turbopack loader calls create and dispose a transformer per source file because its loader context does not expose a compiler shutdown hook. The transformer also accepts Babel `File` or `Program` ASTs through `transformAst` and `transformAstInPlace`. `MacroCompiler` and the default `esbuildMacroCompiler` are exported for custom integrations.

## Compatibility and limitations

- Node.js 22 or newer is required. The package is ESM.
- The default execution mode refuses to run macros until an enforceable isolation backend exists.
- Call arguments must be static and supported by the serializer.
- Macro definitions must be declared at module scope and close over module-level bindings.
- Runtime references to macro functions are rejected.
- Macro execution is serial within each compiled macro module. This preserves ordering for side-effectful trusted code.
- Module discovery follows static imports and exports. Dynamic loading and nonstandard resolution require a compatible custom compiler and are not generally supported.
- Babel integration is asynchronous preprocessing, not a normal Babel plugin, due to Babel's synchronous visitor lifecycle.

Version 2 changes the standalone `transform()` result from the former esbuild `OnLoadResult` shape to `{ code, map?, changed, watchFiles }`. Use `use-macro/esbuild` for esbuild's plugin API.

## Development and releases

Install with `bun install --frozen-lockfile`. Run `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --coverage`, `bun run build`, and `bun run check:package`. `bun run bench` runs non-gating performance measurements.

CI runs on pushes and pull requests targeting `main`. Publishing is limited to the official repository's `main` branch. A `workflow_dispatch` release accepts a stable version such as `1.2.3`, an explicit prerelease such as `1.2.4-dev.1`, or a lowercase prerelease channel such as `dev`. Channel inputs get a timestamped version based on the stable package version. Push-triggered releases inspect only the HEAD commit subject and publish only when it exactly matches a supported stable or prerelease version. Version-like strings in commit bodies and earlier commits do not trigger publishing.

The npm workflow uses [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers/) and does not use a long-lived npm token. It runs Node 24 with npm 11.21 or newer for OIDC dist-tag publishing. npm automatically generates provenance for this public GitHub release. One-time npm configuration is required:

- npm package: `use-macro`
- GitHub organization: `neplextech`
- Repository: `use-macro`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`
- GitHub environment: none; do not configure an environment name for this workflow

## License

MIT
