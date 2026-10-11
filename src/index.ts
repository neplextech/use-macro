export * from './macro.js';
export * from './transformer.js';
export * from './stringify.js';
export * from './compiler.js';

/** Preserve a macro's awaited return type in TypeScript before it is transformed. */
export function unwrap<T extends (...args: any[]) => unknown>(value: ReturnType<T>): Awaited<ReturnType<T>> {
  return value as Awaited<ReturnType<T>>;
}
