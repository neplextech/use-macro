# `"use macro"`

This is a plugin for [esbuild](https://esbuild.github.io/) that allows you to use macros in your code. Macros are a way to define a function that will be executed at compile time, and will replace the macro call with the result of the function.

> Note: This package is esm only.

## Features

- [x] Macros are defined as regular functions that are marked with the `use macro` directive.
- [x] Macro functions can be async.
- [x] Macro functions are automatically awaited.
- [x] Supports serialization of various types like primitive types, Map, Set, Date, RegExp, and Request, Response, FormData, URL, URLSearchParams, and more.
- [x] Macro functions are self contained, they cannot access the scope of the calling code.

## Installation

```bash
npm install use-macro
```

## Usage

### Lets create a simple macro that will extract the version from the package.json file

<!-- prettier-ignore -->
```typescript
function $version(): string {
  'use macro';
  const { version } = require('../package.json');
  console.log(`Version: ${version}`);

  return version;
}

function $compiledAt(): Date {
  'use macro';
  return new Date();
}

async function $message(): Promise<string> {
  'use macro';

  const fs = require('fs').promises;
  const path = require('path');
  const messageText = path.resolve(__dirname, 'message.txt');
  const res = await fs.readFile(messageText, 'utf8');

  return res;
}

const $url = () => {
  'use macro';
  const url = new URL('https://example.com?foo=bar&baz=qux');

  return [url, url.searchParams];
};

const $formData = function () {
  'use macro';
  const formData = new FormData();
  formData.append('foo', 'bar');
  formData.append('baz', 'qux');

  return formData;
};

export const version = $version();
export const compiledAt = $compiledAt();
export const message = $message() as unknown as Awaited<ReturnType<typeof $message>>;
export const url = $url();
export const formData = $formData();
```

### Now lets register the macro in the esbuild plugin

```typescript
import { build } from "esbuild";
import { esbuildPluginUseMacro } from "use-macro";

build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  outfile: "dist/index.js",
  plugins: [esbuildPluginUseMacro()],
}).catch(() => process.exit(1));
```

> Note: You can also use this plugin with [tsup](https://tsup.egoist.sh/) by passing the `esbuildOptions` object to the `tsup` function.

### Now lets run the build. The output will be:

<!-- prettier-ignore -->
```javascript
// src/index.ts
var version = (
  /* @__MACRO__ $version */
  "1.0.0"
);
var compiledAt = (
  /* @__MACRO__ $compiledAt */
  /* @__PURE__ */ new Date(1736839318808)
);
var message = (
  /* @__MACRO__ $message */
  "Hello World!"
);
var url = (
  /* @__MACRO__ $url */
  [new URL("https://example.com/?foo=bar&baz=qux"), new URLSearchParams([["foo", "bar"], ["baz", "qux"]])]
);
var formData = (
  /* @__MACRO__ $formData */
  new FormData([["foo", "bar"], ["baz", "qux"]])
);
export {
  compiledAt,
  formData,
  message,
  url,
  version
};
```

Notice how entire function was removed and the function call was replaced with the result of the function.

## Transformer API (Usage without esbuild)

`use-macro` can be used without esbuild as a standalone transformer. This can be useful if you want to use macros in other tools programmatically.

```typescript
import { MacroTransformer } from "use-macro";

const transformer = new MacroTransformer();

const code = `
function $random(): number {
  'use macro';
  return Math.random();
}
`;

/**
 * The first argument is the code to transform.
 * The second argument is the file name, this is used to resolve relative imports.
 */
const result = transformer.transform(code, "file.ts");

/*
{
  content: '...',
  loader: 'ts'
}
*/
```
