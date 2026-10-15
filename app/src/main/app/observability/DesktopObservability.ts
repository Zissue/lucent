import type { EventEmitter } from "events";
import { join } from "path";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { DesktopEnvironment } from "../DesktopEnvironment";
import {
  desktopLogErrorDetails,
  makeBufferedDesktopLogWriter,
} from "./DesktopLogWriter";

const REPEAT_WINDOW_MS = 60_000;
const MAX_REPEAT_WINDOWS = 1_000;
const TAIL_BATCH_SIZE = 100;

interface RepeatWindow {
  readonly level: string;
  readonly component: unknown;
  readonly message: string;
  readonly startedAt: number;
  suppressed: number;
  lastAt: number;
}

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

export interface DesktopObservabilityShape {
  readonly flush: Effect.Effect<void>;
  readonly installProcessHooks: Effect.Effect<void, never, Scope.Scope>;
  readonly logFilePath: string;
}

export class DesktopObservability extends Context.Service<
  DesktopObservability,
  DesktopObservabilityShape
>()("lucent/desktop/app/observability/DesktopObservability") {}

const makeDesktopObservability = Effect.gen(function* () {
  const env = yield* DesktopEnvironment;
  const logsDir = join(env.appDataDir, "logs");
  const logFilePath = join(logsDir, "lucent.log");
  const bufferedWriter = makeBufferedDesktopLogWriter(logsDir, logFilePath);
  const windows = new Map<string, RepeatWindow>();

  const writeTail = (window: RepeatWindow, at: Date) => {
    bufferedWriter.write({
      at: at.toISOString(),
      level: window.level,
      component: window.component,
      message: window.message,
      suppressed: window.suppressed,
      lastAt: DateTime.formatIso(DateTime.makeUnsafe(window.lastAt)),
    });
  };

  const drainWindows = Effect.fnUntraced(function* (all: boolean) {
    yield* Effect.promise(() => bufferedWriter.flush());
    let now = yield* DateTime.nowAsDate;
    let emitted = 0;
    for (const [key, window] of windows) {
      if (!all && now.getTime() - window.startedAt < REPEAT_WINDOW_MS) {
        continue;
      }
      windows.delete(key);
      if (window.suppressed === 0) {
        continue;
      }
      writeTail(window, now);
      if (++emitted % TAIL_BATCH_SIZE === 0) {
        yield* Effect.promise(() => bufferedWriter.flush());
        now = yield* DateTime.nowAsDate;
      }
    }
  }, Effect.uninterruptible);

  const logger = Logger.make<unknown, void>((options) => {
    const {
      component = "effect",
      data,
      ...annotations
    } = options.fiber.getRef(References.CurrentLogAnnotations);
    const span = options.fiber.cache.span;
    const messages = Array.isArray(options.message)
      ? options.message
      : [options.message];
    const message =
      typeof messages[0] === "string" || messages.length === 1
        ? messages[0]
        : options.message;
    const level = options.logLevel.toLowerCase();
    const at = options.date.getTime();
    const key =
      typeof message === "string"
        ? `${level}\u0000${String(component)}\u0000${message}`
        : undefined;
    const window = key === undefined ? undefined : windows.get(key);
    if (key !== undefined && window !== undefined) {
      if (at - window.startedAt < REPEAT_WINDOW_MS) {
        window.suppressed++;
        window.lastAt = at;
        return;
      }
      if (window.suppressed > 0) {
        writeTail(window, options.date);
      }
      windows.delete(key);
    }
    const errors = messages
      .slice(1)
      .map((value) => desktopLogErrorDetails(value));
    if (options.cause.reasons.length > 0) {
      errors.push(
        ...Cause.prettyErrors(
          Cause.fromReasons(options.cause.reasons.map(boundReason)),
        ).map((error) => desktopLogErrorDetails(error)),
      );
    }
    const kept = bufferedWriter.write({
      at: options.date.toISOString(),
      level,
      component,
      message,
      ...(data === undefined ? {} : { data }),
      ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
      ...(errors.length === 0 ? {} : { error: errors }),
      ...(span === undefined
        ? {}
        : { traceId: span.traceId, spanId: span.spanId }),
    });
    if (
      kept &&
      typeof message === "string" &&
      key !== undefined &&
      windows.size < MAX_REPEAT_WINDOWS
    ) {
      windows.set(key, {
        level,
        component,
        message,
        startedAt: at,
        suppressed: 0,
        lastAt: at,
      });
    }
  });

  const flush: DesktopObservabilityShape["flush"] = Effect.promise(() =>
    bufferedWriter.flush(),
  );

  const installProcessHooks = Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const handleUncaughtException = (cause: unknown): void => {
      void runPromise(
        Effect.logError("Uncaught exception", Cause.fail(cause)).pipe(
          Effect.annotateLogs({ component: "process" }),
        ),
      ).catch(() => undefined);
    };
    const handleUnhandledRejection = (cause: unknown): void => {
      void runPromise(
        Effect.logError("Unhandled rejection", Cause.fail(cause)).pipe(
          Effect.annotateLogs({ component: "process" }),
        ),
      ).catch(() => undefined);
    };

    yield* Effect.sync(() => {
      process.on("uncaughtException", handleUncaughtException);
      process.on("unhandledRejection", handleUnhandledRejection);
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        (process as EventEmitter).removeListener(
          "uncaughtException",
          handleUncaughtException,
        );
        (process as EventEmitter).removeListener(
          "unhandledRejection",
          handleUnhandledRejection,
        );
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => bufferedWriter.close()),
  );
  yield* Effect.addFinalizer(() => drainWindows(true));
  yield* drainWindows(false).pipe(
    Effect.delay(REPEAT_WINDOW_MS),
    Effect.forever,
    Effect.forkScoped,
  );

  return Context.make(
    DesktopObservability,
    DesktopObservability.of({
      flush,
      installProcessHooks,
      logFilePath,
    }),
  ).pipe(
    Context.add(Logger.CurrentLoggers, new Set([logger])),
    Context.add(
      References.MinimumLogLevel,
      env.debug === true ? "Debug" : "Info",
    ),
  );
});

export const layer = Layer.effectContext(makeDesktopObservability);
