import type { DesktopGameConsoleObservabilityBridge } from "../../../shared/desktopBridge";

const consoleMethods = ["debug", "error", "info", "log", "warn"] as const;
const maxForwardedMessageLength = 1024 * 1024;
const defaultMaxArrayItems = 100;
const defaultMaxDepth = 6;
const defaultMaxObjectKeys = 100;
const truncatedMarker = "...[Truncated]";
let installed = false;

type ConsoleMethod = (typeof consoleMethods)[number];
type ConsoleMethodFn = (...args: readonly unknown[]) => void;

export interface FormatConsoleArgumentsOptions {
  readonly maxArrayItems?: number;
  readonly maxChars?: number;
  readonly maxDepth?: number;
  readonly maxObjectKeys?: number;
}

interface FormatOptions {
  readonly maxArrayItems: number;
  readonly maxChars: number;
  readonly maxDepth: number;
  readonly maxObjectKeys: number;
}

interface FormatState {
  readonly options: FormatOptions;
  readonly parts: string[];
  readonly seen: WeakSet<object>;
  remaining: number;
  truncated: boolean;
  truncationNoted: boolean;
}

interface OwnKeysResult {
  readonly hasMore: boolean;
  readonly keys: readonly string[];
}

const errorStack = (error: Error): string =>
  error.stack ?? `${error.name}: ${error.message}`;

const stringifyErrorCause = (cause: unknown): string => {
  if (typeof cause === "string") {
    return cause;
  }

  try {
    return String(cause);
  } catch {
    return "[Unprintable error cause]";
  }
};

const readErrorCause = (error: Error): unknown => {
  try {
    return (error as Error & { readonly cause?: unknown }).cause;
  } catch (cause) {
    return `[Thrown while reading error cause: ${stringifyErrorCause(cause)}]`;
  }
};

const errorMessage = (error: Error, maxDepth: number): string => {
  const parts: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = error;
  let depth = 0;

  while (current instanceof Error) {
    if (seen.has(current)) {
      parts.push("Caused by: [Circular error cause]");
      return parts.join("\n");
    }

    seen.add(current);
    parts.push(
      depth === 0 ? errorStack(current) : `Caused by: ${errorStack(current)}`,
    );
    const cause = readErrorCause(current);
    if (cause === undefined) {
      return parts.join("\n");
    }

    depth += 1;
    if (depth >= maxDepth) {
      parts.push("Caused by: [MaxDepth]");
      return parts.join("\n");
    }
    current = cause;
  }

  parts.push(`Caused by: ${stringifyErrorCause(current)}`);
  return parts.join("\n");
};

const clampPositiveInteger = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isSafeInteger(value) || value <= 0
    ? fallback
    : value;

const normalizeOptions = (
  options: FormatConsoleArgumentsOptions,
): FormatOptions => ({
  maxArrayItems: clampPositiveInteger(
    options.maxArrayItems,
    defaultMaxArrayItems,
  ),
  maxChars: clampPositiveInteger(options.maxChars, maxForwardedMessageLength),
  maxDepth: clampPositiveInteger(options.maxDepth, defaultMaxDepth),
  maxObjectKeys: clampPositiveInteger(
    options.maxObjectKeys,
    defaultMaxObjectKeys,
  ),
});

const makeFormatState = (
  options: FormatConsoleArgumentsOptions,
): FormatState => {
  const normalized = normalizeOptions(options);
  return {
    options: normalized,
    parts: [],
    remaining: normalized.maxChars,
    seen: new WeakSet(),
    truncated: false,
    truncationNoted: false,
  };
};

const append = (state: FormatState, value: string): boolean => {
  if (state.remaining <= 0) {
    state.truncated = true;
    return false;
  }

  if (value.length <= state.remaining) {
    state.parts.push(value);
    state.remaining -= value.length;
    return true;
  }

  state.parts.push(value.slice(0, state.remaining));
  state.remaining = 0;
  state.truncated = true;
  return false;
};

const appendTruncated = (state: FormatState): boolean => {
  state.truncated = true;
  state.truncationNoted = true;
  return append(state, truncatedMarker);
};

const appendJsonString = (state: FormatState, value: string): void => {
  const sourceLimit = Math.max(0, state.remaining - 2);
  const source =
    value.length > sourceLimit
      ? value.slice(0, Math.max(0, sourceLimit - truncatedMarker.length)) +
        truncatedMarker
      : value;
  append(state, JSON.stringify(source));
  if (source.length < value.length) {
    state.truncated = true;
    state.truncationNoted = true;
  }
};

const appendIndent = (state: FormatState, depth: number): boolean =>
  append(state, "  ".repeat(depth));

const appendObjectKey = (state: FormatState, key: string): boolean => {
  const source =
    key.length > 200 ? `${key.slice(0, 200)}${truncatedMarker}` : key;
  return append(state, JSON.stringify(source));
};

const readOwnEnumerableKeys = (value: object, limit: number): OwnKeysResult => {
  const keys: string[] = [];
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      keys.push(key);
      if (keys.length > limit) {
        return { hasMore: true, keys: keys.slice(0, limit) };
      }
    }
  }

  return { hasMore: false, keys };
};

const readProperty = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key];
  } catch (cause) {
    return `[Thrown ${cause instanceof Error ? cause.message : String(cause)}]`;
  }
};

const appendArray = (
  state: FormatState,
  value: readonly unknown[],
  depth: number,
): void => {
  if (state.seen.has(value)) {
    appendJsonString(state, "[Circular]");
    return;
  }

  if (depth >= state.options.maxDepth) {
    appendJsonString(state, "[MaxDepth]");
    return;
  }

  state.seen.add(value);
  if (!append(state, "[")) {
    state.seen.delete(value);
    return;
  }

  const itemCount = Math.min(value.length, state.options.maxArrayItems);
  for (let index = 0; index < itemCount; index += 1) {
    if (
      !append(state, index === 0 ? "\n" : ",\n") ||
      !appendIndent(state, depth + 1)
    ) {
      break;
    }

    appendValue(state, value[index], depth + 1);
  }

  if (itemCount < value.length && state.remaining > 0) {
    append(state, itemCount === 0 ? "\n" : ",\n");
    appendIndent(state, depth + 1);
    appendJsonString(state, `... ${value.length - itemCount} more items`);
  }

  if (itemCount > 0 || itemCount < value.length) {
    append(state, "\n");
    appendIndent(state, depth);
  }

  append(state, "]");
  state.seen.delete(value);
};

const appendObject = (
  state: FormatState,
  value: object,
  depth: number,
): void => {
  if (state.seen.has(value)) {
    appendJsonString(state, "[Circular]");
    return;
  }

  if (depth >= state.options.maxDepth) {
    appendJsonString(state, "[MaxDepth]");
    return;
  }

  state.seen.add(value);
  const { hasMore, keys } = readOwnEnumerableKeys(
    value,
    state.options.maxObjectKeys,
  );
  if (!append(state, "{")) {
    state.seen.delete(value);
    return;
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (
      key === undefined ||
      !append(state, index === 0 ? "\n" : ",\n") ||
      !appendIndent(state, depth + 1) ||
      !appendObjectKey(state, key) ||
      !append(state, ": ")
    ) {
      break;
    }

    appendValue(state, readProperty(value, key), depth + 1);
  }

  if (hasMore && state.remaining > 0) {
    append(state, keys.length === 0 ? "\n" : ",\n");
    appendIndent(state, depth + 1);
    appendJsonString(state, "... more properties");
  }

  if (keys.length > 0 || hasMore) {
    append(state, "\n");
    appendIndent(state, depth);
  }

  append(state, "}");
  state.seen.delete(value);
};

const appendValue = (
  state: FormatState,
  value: unknown,
  depth: number,
): void => {
  if (state.remaining <= 0) {
    state.truncated = true;
    return;
  }

  if (typeof value === "string") {
    appendJsonString(state, value);
    return;
  }

  if (value instanceof Error) {
    appendJsonString(state, errorMessage(value, state.options.maxDepth));
    return;
  }

  if (value === undefined) {
    appendJsonString(state, "undefined");
    return;
  }

  if (typeof value === "bigint") {
    appendJsonString(state, `${value.toString()}n`);
    return;
  }

  if (typeof value === "function") {
    appendJsonString(state, `[Function ${value.name || "anonymous"}]`);
    return;
  }

  if (typeof value === "symbol") {
    appendJsonString(state, value.toString());
    return;
  }

  if (typeof value !== "object" || value === null) {
    append(state, String(value));
    return;
  }

  if (value instanceof Date) {
    appendJsonString(state, value.toISOString());
    return;
  }

  if (value instanceof RegExp) {
    appendJsonString(state, value.toString());
    return;
  }

  if (Array.isArray(value)) {
    appendArray(state, value, depth);
    return;
  }

  const toJSON = Reflect.get(value, "toJSON");
  if (typeof toJSON === "function") {
    try {
      const serialized = Reflect.apply(toJSON, value, []) as unknown;
      if (serialized !== value) {
        appendValue(state, serialized, depth);
        return;
      }
    } catch {
      // Fall through to safe property inspection.
    }
  }

  appendObject(state, value, depth);
};

const appendArgument = (
  state: FormatState,
  value: unknown,
  depth: number,
): void => {
  if (typeof value === "string") {
    append(state, value);
    return;
  }

  if (value instanceof Error) {
    append(state, errorMessage(value, state.options.maxDepth));
    return;
  }

  appendValue(state, value, depth);
};

export const formatConsoleArguments = (
  args: readonly unknown[],
  options: FormatConsoleArgumentsOptions = {},
): string => {
  const state = makeFormatState(options);

  for (let index = 0; index < args.length; index += 1) {
    if (index > 0 && !append(state, " ")) {
      break;
    }

    appendArgument(state, args[index], 0);
    if (state.remaining <= 0) {
      break;
    }
  }

  if (state.truncated && !state.truncationNoted && state.remaining > 0) {
    appendTruncated(state);
  }

  return state.parts.join("");
};

export const installConsoleForwarder = (
  bridge: DesktopGameConsoleObservabilityBridge | undefined,
): void => {
  if (bridge === undefined || installed) {
    return;
  }

  installed = true;
  for (const method of consoleMethods) {
    const original = console[method].bind(console) as ConsoleMethodFn;
    console[method] = ((...args: readonly unknown[]) => {
      try {
        bridge.message(method, formatConsoleArguments(args));
      } catch {}

      original(...args);
    }) as Console[ConsoleMethod];
  }
};
