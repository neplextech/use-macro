import { uneval, type JavaScriptTag } from 'devalue';

const tag = (value: object): string => Object.prototype.toString.call(value);
const isTag = (value: unknown, name: string): boolean =>
  typeof value === 'object' && value !== null && tag(value) === `[object ${name}]`;

class RawExpression {
  constructor(readonly source: string) {}
}

function rawFragment(taggedJavaScript: JavaScriptTag, source: string) {
  const strings = [source] as unknown as TemplateStringsArray;
  Object.defineProperty(strings, 'raw', { value: [source] });
  return taggedJavaScript(strings);
}

async function blobExpression(blob: Blob): Promise<string> {
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  if (isTag(blob, 'File') || typeof (blob as File).name === 'string') {
    const file = blob as File;
    return `new File([Uint8Array.from(${uneval(bytes)})], ${uneval(file.name)}, { type: ${uneval(file.type)}, lastModified: ${uneval(file.lastModified)} })`;
  }
  return `new Blob([Uint8Array.from(${uneval(bytes)})], { type: ${uneval(blob.type)} })`;
}

async function requestExpression(request: Request): Promise<string> {
  if (request.bodyUsed && request.method !== 'GET' && request.method !== 'HEAD') {
    throw new TypeError('A Request with a consumed body cannot be serialized.');
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.clone().arrayBuffer();
  const bytes = body === null ? 'null' : `Uint8Array.from(${uneval(Array.from(new Uint8Array(body)))})`;
  const headers = Array.from(Headers.prototype.entries.call(request.headers));
  return `new Request(${uneval(request.url)}, { method: ${uneval(request.method)}, headers: ${uneval(headers)}, body: ${bytes} })`;
}

async function responseExpression(response: Response): Promise<string> {
  if (response.status === 0) throw new TypeError('Responses with status 0 cannot be reconstructed.');
  if (response.bodyUsed) throw new TypeError('A Response with a consumed body cannot be serialized.');
  const body = await response.clone().arrayBuffer();
  const bytes = body === null ? 'null' : `Uint8Array.from(${uneval(Array.from(new Uint8Array(body)))})`;
  const headers = Array.from(Headers.prototype.entries.call(response.headers));
  return `new Response(${bytes}, { status: ${uneval(response.status)}, statusText: ${uneval(response.statusText)}, headers: ${uneval(headers)} })`;
}

async function prepare(value: unknown, seen = new WeakMap<object, unknown>()): Promise<unknown> {
  if (value instanceof Promise || isTag(value, 'Promise')) return prepare(await value, seen);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return seen.get(value);

  if (Buffer.isBuffer(value)) return value;
  if (isTag(value, 'URL')) return new RawExpression(`new URL(${uneval((value as URL).href)})`);
  if (isTag(value, 'URLSearchParams')) {
    const entries = Array.from(URLSearchParams.prototype.entries.call(value));
    return new RawExpression(`new URLSearchParams(${uneval(entries)})`);
  }
  if (isTag(value, 'Headers')) {
    const entries = Array.from(Headers.prototype.entries.call(value));
    return new RawExpression(`new Headers(${uneval(entries)})`);
  }
  if (isTag(value, 'Request')) return new RawExpression(await requestExpression(value as Request));
  if (isTag(value, 'Response')) return new RawExpression(await responseExpression(value as Response));
  if (isTag(value, 'Blob')) return new RawExpression(await blobExpression(value as Blob));
  if (isTag(value, 'FormData')) {
    const entries = Array.from(FormData.prototype.entries.call(value)) as Array<[string, string | Blob]>;
    const statements: string[] = [];
    for (const [key, item] of entries) {
      const itemExpression = typeof item === 'string' ? uneval(item) : await blobExpression(item);
      statements.push(`form.append(${uneval(key)}, ${itemExpression});`);
    }
    return new RawExpression(`(() => { const form = new FormData(); ${statements.join(' ')} return form; })()`);
  }
  if (isTag(value, 'Date')) return new Date(Date.prototype.getTime.call(value));
  if (isTag(value, 'RegExp')) {
    const regexp = value as RegExp;
    return new RegExp(regexp.source, regexp.flags);
  }
  if (isTag(value, 'ArrayBuffer')) return Uint8Array.from(new Uint8Array(value as ArrayBuffer)).buffer;
  if (ArrayBuffer.isView(value)) {
    if (tag(value) === '[object DataView]') {
      const view = value as DataView;
      const bytes = Uint8Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      return new DataView(bytes.buffer);
    }
    const typedArrayConstructor = (globalThis as Record<string, unknown>)[tag(value).slice(8, -1)] as new (
      values: ArrayLike<number>,
    ) => ArrayBufferView;
    if (typeof typedArrayConstructor !== 'function') return value;
    return new typedArrayConstructor(Array.from(value as unknown as ArrayLike<number>));
  }
  if (isTag(value, 'Map')) {
    const output = new Map<unknown, unknown>();
    seen.set(value, output);
    for (const [key, item] of Map.prototype.entries.call(value)) {
      output.set(await prepare(key, seen), await prepare(item, seen));
    }
    return output;
  }
  if (isTag(value, 'Set')) {
    const output = new Set<unknown>();
    seen.set(value, output);
    for (const item of Set.prototype.values.call(value)) output.add(await prepare(item, seen));
    return output;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(await prepare(item, seen));
    return output;
  }
  if (tag(value) !== '[object Object]') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null) {
    const propertyNames = Object.getOwnPropertyNames(prototype).sort().join('\0');
    const objectPropertyNames = Object.getOwnPropertyNames(Object.prototype).sort().join('\0');
    if (propertyNames !== objectPropertyNames) return value;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>,
  )) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) {
      throw new TypeError(`Cannot serialize accessor property ${JSON.stringify(key)}.`);
    }
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: await prepare(descriptor.value, seen),
    });
  }
  return output;
}

/** Serialize a macro result as a JavaScript expression. Promises and body values are awaited. */
export async function stringify(value: unknown): Promise<string> {
  try {
    const prepared = await prepare(value);
    return uneval(prepared, (nested: any, taggedJavaScript: JavaScriptTag) => {
      if (nested instanceof RawExpression) return rawFragment(taggedJavaScript, nested.source);
      if (Buffer.isBuffer(nested)) return rawFragment(taggedJavaScript, `Buffer.from(${uneval(Array.from(nested))})`);
      return undefined;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unsupported value';
    throw new TypeError(`Macro result cannot be serialized: ${message}`);
  }
}
