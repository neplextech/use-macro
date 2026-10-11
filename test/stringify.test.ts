import { expect, test, describe } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { stringify } from '../src/stringify.js';

function evaluateExpression<T>(source: string): T {
  return new Function(`return (${source});`)() as T;
}

describe('macro result serialization', () => {
  test('serializes primitives and nested plain objects', async () => {
    const value = { text: 'hello', count: 4, enabled: true, values: [null, undefined, -2] };
    const result = evaluateExpression<typeof value>(await stringify(value));
    expect(result).toEqual(value);
  });

  test('serializes Date, RegExp, Map, Set, and cyclic objects', async () => {
    const cyclic: { name: string; self?: unknown } = { name: 'cycle' };
    cyclic.self = cyclic;
    const value = {
      date: new Date('2025-01-02T03:04:05.000Z'),
      pattern: /use-macro/gi,
      map: new Map([
        ['one', 1],
        ['two', 2],
      ]),
      set: new Set(['a', 'b']),
      cyclic,
    };
    const result = evaluateExpression<typeof value>(await stringify(value));
    expect(result.date.toISOString()).toBe(value.date.toISOString());
    expect(result.pattern.source).toBe('use-macro');
    expect(result.pattern.flags).toBe('gi');
    expect([...result.map]).toEqual([...value.map]);
    expect([...result.set]).toEqual([...value.set]);
    expect(result.cyclic.self).toBe(result.cyclic);
  });

  test('serializes URL, URLSearchParams, and Headers', async () => {
    const value = {
      url: new URL('https://example.com/path?q=1'),
      search: new URLSearchParams([
        ['q', 'one'],
        ['q', 'two'],
      ]),
      headers: new Headers([['x-test', 'yes']]),
    };
    const result = evaluateExpression<typeof value>(await stringify(value));
    expect(result.url.href).toBe(value.url.href);
    expect([...result.search]).toEqual([...value.search]);
    expect(result.headers.get('x-test')).toBe('yes');
  });

  test('serializes ArrayBuffer, typed arrays, and Buffer', async () => {
    const value = {
      buffer: new Uint8Array([1, 2, 255]).buffer,
      typed: new Uint16Array([2, 1024]),
      nodeBuffer: Buffer.from([3, 4, 5]),
    };
    const result = evaluateExpression<typeof value>(await stringify(value));
    expect([...new Uint8Array(result.buffer)]).toEqual([1, 2, 255]);
    expect([...result.typed]).toEqual([2, 1024]);
    expect(Buffer.isBuffer(result.nodeBuffer)).toBe(true);
    expect([...result.nodeBuffer]).toEqual([3, 4, 5]);
  });

  test('serializes nested Blob and FormData values', async () => {
    const form = new FormData();
    form.append('title', 'hello');
    form.append('file', new Blob(['payload'], { type: 'text/plain' }), 'message.txt');
    const result = evaluateExpression<{ form: FormData }>(await stringify({ form })).form;
    expect(result.get('title')).toBe('hello');
    const file = result.get('file') as File;
    expect(file.name).toBe('message.txt');
    expect(await file.text()).toBe('payload');
  });

  test('serializes Request and Response bodies', async () => {
    const request = new Request('https://example.com/api', { method: 'POST', body: 'request body' });
    const response = new Response('response body', { status: 201, headers: { 'x-test': 'yes' } });
    const result = evaluateExpression<{ request: Request; response: Response }>(await stringify({ request, response }));
    expect(await result.request.text()).toBe('request body');
    expect(result.request.method).toBe('POST');
    expect(await result.response.text()).toBe('response body');
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get('x-test')).toBe('yes');
  });

  test('rejects consumed Request and Response bodies instead of dropping data', async () => {
    const request = new Request('https://example.com/api', { method: 'POST', body: 'request body' });
    const response = new Response('response body');
    await request.text();
    await response.text();
    await expect(stringify(request)).rejects.toThrow('Request with a consumed body cannot be serialized');
    await expect(stringify(response)).rejects.toThrow('Response with a consumed body cannot be serialized');
  });

  test('awaits promises returned by a macro', async () => {
    const source = await stringify(Promise.resolve({ resolved: true }));
    expect(evaluateExpression<{ resolved: boolean }>(source)).toEqual({ resolved: true });
  });

  test('supports plain objects and dates created in another realm', async () => {
    const value = runInNewContext(`({ nested: { value: 1 }, date: new Date('2024-01-01T00:00:00.000Z') })`);
    const result = evaluateExpression<{ nested: { value: number }; date: Date }>(await stringify(value));
    expect(result.nested.value).toBe(1);
    expect(result.date.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  test('rejects accessors and unsupported class instances clearly', async () => {
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'value' });
    await expect(stringify(accessor)).rejects.toThrow('Cannot serialize accessor property');
    class CustomValue {
      value = 1;
    }
    await expect(stringify(new CustomValue())).rejects.toThrow('Macro result cannot be serialized');
  });
});
