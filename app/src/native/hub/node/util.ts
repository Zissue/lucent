const deepEqual = (
  a: unknown,
  b: unknown,
  seen: Map<object, object>,
): boolean => {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return String(a) === String(b);
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>;
    if (a.size !== other.size) return false;
    for (const [key, value] of a) {
      if (!other.has(key) || !deepEqual(value, other.get(key), seen))
        return false;
    }
    return true;
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>;
    if (a.size !== other.size) return false;
    for (const value of a) if (!other.has(value)) return false;
    return true;
  }
  if (ArrayBuffer.isView(a)) {
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(
      (b as ArrayBufferView).buffer,
      (b as ArrayBufferView).byteOffset,
      (b as ArrayBufferView).byteLength,
    );
    return (
      left.length === right.length &&
      left.every((byte, index) => byte === right[index])
    );
  }
  const leftKeys = Reflect.ownKeys(a).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(a, key),
  );
  const rightKeys = Reflect.ownKeys(b).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(b, key),
  );
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
    if (
      !deepEqual(
        (a as Record<PropertyKey, unknown>)[key],
        (b as Record<PropertyKey, unknown>)[key],
        seen,
      )
    ) {
      return false;
    }
  }
  return true;
};

export const isDeepStrictEqual = (a: unknown, b: unknown): boolean =>
  deepEqual(a, b, new Map());

export const inspect = (value: unknown): string => {
  if (typeof value === "string") return `'${value}'`;
  if (value instanceof Error) return value.stack ?? String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const format = (template: unknown, ...args: unknown[]): string => {
  if (typeof template !== "string")
    return [template, ...args].map(inspect).join(" ");
  let index = 0;
  const text = template.replace(/%[sdifjoO%]/g, (token) => {
    if (token === "%%") return "%";
    if (index >= args.length) return token;
    const arg = args[index++];
    switch (token) {
      case "%s":
        return typeof arg === "string" ? arg : inspect(arg);
      case "%d":
      case "%i":
        return String(Math.trunc(Number(arg)));
      case "%f":
        return String(Number(arg));
      default:
        return inspect(arg);
    }
  });
  return [text, ...args.slice(index).map(inspect)].join(" ");
};

export const promisify =
  <A extends unknown[], R>(
    fn: (...args: [...A, (error: unknown, value: R) => void]) => void,
  ) =>
  (...args: A): Promise<R> =>
    new Promise((resolve, reject) =>
      fn(...args, (error, value) => (error ? reject(error) : resolve(value))),
    );

export const types = {
  isDate: (value: unknown): value is Date => value instanceof Date,
  isRegExp: (value: unknown): value is RegExp => value instanceof RegExp,
  isPromise: (value: unknown): value is Promise<unknown> =>
    value instanceof Promise,
};

export default { isDeepStrictEqual, inspect, format, promisify, types };
