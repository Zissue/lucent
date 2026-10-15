import * as Cause from "effect/Cause";
import type * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Predicate from "effect/Predicate";

export interface DesktopLogError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: DesktopLogError;
}

export interface DesktopLogRecord {
  readonly at: string;
  readonly level: string;
  readonly component: unknown;
  readonly message: string;
  readonly repeatKey?: string;
  readonly data?: unknown;
  readonly annotations?: Record<string, unknown>;
  readonly error?: readonly DesktopLogError[];
  readonly traceId?: string;
  readonly spanId?: string;
}

export const desktopLogErrorDetails = (
  value: unknown,
  depth = 0,
): DesktopLogError => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
      ...(value.cause === undefined || depth >= 5
        ? {}
        : { cause: desktopLogErrorDetails(value.cause, depth + 1) }),
    };
  }

  let message: string;
  try {
    message =
      typeof value === "string"
        ? value
        : (JSON.stringify(value) ?? String(value));
  } catch {
    try {
      message = String(value);
    } catch {
      message = "[Unserializable]";
    }
  }
  return { name: "NonError", message: message.slice(0, 1_024) };
};

const boundReason = (reason: Cause.Reason<unknown>): Cause.Reason<unknown> => {
  if (Cause.isFailReason(reason) && reason.error instanceof Error) {
    return Cause.makeFailReason(desktopLogErrorDetails(reason.error)).annotate(
      Cause.reasonAnnotations(reason),
    );
  }
  if (Cause.isDieReason(reason) && reason.defect instanceof Error) {
    return Cause.makeDieReason(desktopLogErrorDetails(reason.defect)).annotate(
      Cause.reasonAnnotations(reason),
    );
  }
  return reason;
};

export const desktopLogRecord = (
  options: Logger.Options<unknown>,
): DesktopLogRecord => {
  const {
    component = "effect",
    data,
    repeatKey,
    ...annotations
  } = options.fiber.getRef(References.CurrentLogAnnotations);
  const span = options.fiber.cache.span;
  const messages = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const labeled = typeof messages[0] === "string";
  const message = labeled ? messages[0] : "Unlabeled log message";
  const errors = (
    labeled
      ? messages.slice(1)
      : messages.filter((part) => typeof part !== "string")
  ).map((value) => desktopLogErrorDetails(value));
  if (options.cause.reasons.length > 0) {
    errors.push(
      ...Cause.prettyErrors(
        Cause.fromReasons(options.cause.reasons.map(boundReason)),
      ).map((error) => desktopLogErrorDetails(error)),
    );
  }
  return {
    at: options.date.toISOString(),
    level: options.logLevel.toLowerCase(),
    component,
    message,
    ...(typeof repeatKey === "string" ? { repeatKey } : {}),
    ...(data === undefined ? {} : { data }),
    ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
    ...(errors.length === 0 ? {} : { error: errors }),
    ...(span === undefined
      ? {}
      : { traceId: span.traceId, spanId: span.spanId }),
  };
};

const MAX_DATA_BYTES = 16 * 1024;
const utf8 = new TextEncoder();

export const desktopLogJsonSafe = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  const source = JSON.stringify(value, (_key, part: unknown) => {
    if (typeof part === "bigint") return part.toString();
    if (part instanceof Error) return desktopLogErrorDetails(part);
    if (typeof part === "function" || typeof part === "symbol")
      return undefined;
    if (typeof part === "object" && part !== null) {
      if (seen.has(part)) return "[Circular]";
      seen.add(part);
    }
    return part;
  });
  if (source === undefined) return undefined;
  const safe: unknown = JSON.parse(source);
  if (
    Predicate.isObject(safe) &&
    "data" in safe &&
    safe["data"] !== undefined
  ) {
    const bytes = utf8.encode(JSON.stringify(safe["data"])).byteLength;
    if (bytes > MAX_DATA_BYTES) safe["data"] = { truncated: bytes };
  }
  return safe;
};
