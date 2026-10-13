import type { EventEmitter } from "events";
import { join } from "path";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { DesktopEnvironment } from "../DesktopEnvironment";
import {
  desktopLogErrorDetails,
  makeBufferedDesktopLogWriter,
} from "./DesktopLogWriter";

export interface DesktopDiagnosticRecord {
  readonly component: string;
  readonly event: string;
  readonly data?: unknown;
  readonly cause?: unknown;
}

export interface DesktopObservabilityShape {
  readonly flush: Effect.Effect<void>;
  readonly installProcessHooks: Effect.Effect<void, never, Scope.Scope>;
  readonly logFilePath: string;
  readonly record: (record: DesktopDiagnosticRecord) => Effect.Effect<void>;
  readonly recordUnsafe: (record: DesktopDiagnosticRecord) => void;
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
  const diagnosticRecordingEnabled = env.debug === true;
  const recordingStartedAt = diagnosticRecordingEnabled
    ? new Date().toISOString()
    : null;

  const logger = Logger.make<unknown, void>((options) => {
    const {
      component = "effect",
      data,
      ...annotations
    } = options.fiber.getRef(References.CurrentLogAnnotations);
    const span = options.fiber.cache.span;
    bufferedWriter.write({
      at: options.date.toISOString(),
      level: options.logLevel.toLowerCase(),
      component,
      message:
        Array.isArray(options.message) && options.message.length === 1
          ? options.message[0]
          : options.message,
      ...(data === undefined ? {} : { data }),
      ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
      ...(options.cause.reasons.length === 0
        ? {}
        : { error: Cause.prettyErrors(options.cause) }),
      ...(span === undefined
        ? {}
        : { traceId: span.traceId, spanId: span.spanId }),
    });
  });

  const flush: DesktopObservabilityShape["flush"] = Effect.promise(() =>
    bufferedWriter.flush(),
  );

  const recordUnsafe: DesktopObservabilityShape["recordUnsafe"] =
    diagnosticRecordingEnabled === false
      ? () => undefined
      : (diagnostic) => {
          bufferedWriter.write({
            at: new Date().toISOString(),
            level: "debug",
            component: diagnostic.component,
            message: diagnostic.event,
            event: diagnostic.event,
            ...(diagnostic.data === undefined ? {} : { data: diagnostic.data }),
            ...(diagnostic.cause === undefined
              ? {}
              : { error: desktopLogErrorDetails(diagnostic.cause) }),
          });
        };

  const record: DesktopObservabilityShape["record"] =
    diagnosticRecordingEnabled === false
      ? () => Effect.void
      : (diagnostic) => Effect.sync(() => recordUnsafe(diagnostic));

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

  if (recordingStartedAt !== null) {
    bufferedWriter.write({
      at: recordingStartedAt,
      level: "debug",
      component: "startup",
      message: "Diagnostic recording started",
      event: "recording.started",
      data: {
        architecture: process.arch,
        pid: process.pid,
        platform: env.platform,
        runtimeVersions: {
          chrome: process.versions.chrome ?? "unknown",
          electron: process.versions.electron ?? "unknown",
          node: process.versions.node,
        },
      },
    });
  }

  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      bufferedWriter.close(
        diagnosticRecordingEnabled
          ? {
              at: new Date().toISOString(),
              level: "debug",
              component: "startup",
              message: "Diagnostic recording stopped",
              event: "recording.stopped",
              data: { pid: process.pid },
            }
          : undefined,
      ),
    ),
  );

  return Context.make(
    DesktopObservability,
    DesktopObservability.of({
      flush,
      installProcessHooks,
      logFilePath,
      record,
      recordUnsafe,
    }),
  ).pipe(
    Context.add(Logger.CurrentLoggers, new Set([logger])),
    Context.add(References.MinimumLogLevel, "Debug"),
  );
});

export const layer = Layer.effectContext(makeDesktopObservability);
