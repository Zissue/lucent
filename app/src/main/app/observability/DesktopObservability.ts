import { ipcMain, type IpcMainEvent } from "electron";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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
import { makeBufferedDesktopLogWriter } from "./DesktopLogWriter";
import {
  desktopLogJsonSafe,
  desktopLogRecord,
  type DesktopLogError,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import { RendererLogIpc } from "../../../shared/ipc/rendererLog";

const REPEAT_WINDOW_MS = 60_000;
const MAX_REPEAT_WINDOWS = 1_000;
const MAX_RENDERER_REPEAT_WINDOWS = 200;
const TAIL_BATCH_SIZE = 100;

interface RepeatWindow {
  readonly level: string;
  readonly component: unknown;
  readonly message: string;
  readonly rendererId?: number;
  readonly repeatKey?: string;
  readonly startedAt: number;
  suppressed: number;
  lastAt: number;
}

const decodeRendererRecord = Option.liftThrowable(
  RendererLogIpc.record.decodePayload,
);

const boundRendererString = (value: string, length: number): string =>
  value.length <= length
    ? value
    : Buffer.from(value.slice(0, length), "utf16le").toString("utf16le");

const boundRendererError = (
  error: DesktopLogError,
  depth = 0,
): DesktopLogError => ({
  name: boundRendererString(error.name, 256),
  message: boundRendererString(error.message, 1_024),
  ...(error.stack === undefined
    ? {}
    : { stack: boundRendererString(error.stack, 8_192) }),
  ...(error.cause === undefined || depth >= 5
    ? {}
    : { cause: boundRendererError(error.cause, depth + 1) }),
});

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
  const clock = yield* Clock.Clock;
  const logsDir = join(env.appDataDir, "logs");
  const logFilePath = join(logsDir, "lucent.log");
  const bufferedWriter = makeBufferedDesktopLogWriter(logsDir, logFilePath);
  const mainWindows = new Map<string, RepeatWindow>();
  const rendererWindows = new Map<string, RepeatWindow>();

  const writeTail = (window: RepeatWindow, at: Date) => {
    bufferedWriter.write({
      at: at.toISOString(),
      level: window.level,
      component: window.component,
      message: window.message,
      ...(window.rendererId === undefined
        ? {}
        : { annotations: { rendererId: window.rendererId } }),
      ...(window.repeatKey === undefined
        ? {}
        : { repeatKey: window.repeatKey }),
      suppressed: window.suppressed,
      lastAt: DateTime.formatIso(DateTime.makeUnsafe(window.lastAt)),
    });
  };

  const drainWindows = Effect.fnUntraced(function* (all: boolean) {
    yield* Effect.promise(() => bufferedWriter.flush());
    let now = yield* DateTime.nowAsDate;
    let emitted = 0;
    for (const windows of [mainWindows, rendererWindows]) {
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
    }
  }, Effect.uninterruptible);

  const writeRecord = (
    record: DesktopLogRecord,
    at: number,
    rendererId?: number,
  ): void => {
    const { repeatKey, ...output } = record;
    const { level, component, message } = output;
    const origin = rendererId === undefined ? "main" : `renderer:${rendererId}`;
    const key = JSON.stringify([
      origin,
      level,
      String(component),
      message,
      repeatKey,
    ]);
    const [windows, maxWindows] =
      rendererId === undefined
        ? [mainWindows, MAX_REPEAT_WINDOWS]
        : [rendererWindows, MAX_RENDERER_REPEAT_WINDOWS];
    const window = windows.get(key);
    if (window !== undefined) {
      if (at - window.startedAt < REPEAT_WINDOW_MS) {
        window.suppressed++;
        window.lastAt = at;
        return;
      }
      if (window.suppressed > 0) writeTail(window, new Date(at));
      windows.delete(key);
    }
    const kept = bufferedWriter.write(output);
    if (kept && windows.size < maxWindows) {
      windows.set(key, {
        level,
        component,
        message,
        ...(rendererId === undefined ? {} : { rendererId }),
        ...(repeatKey === undefined ? {} : { repeatKey }),
        startedAt: at,
        suppressed: 0,
        lastAt: at,
      });
    }
  };

  const logger = Logger.make<unknown, void>((options) => {
    writeRecord(desktopLogRecord(options), options.date.getTime());
  });

  const handleRendererRecord = (
    event: IpcMainEvent,
    rawPayload: unknown,
  ): void => {
    const decoded = decodeRendererRecord(rawPayload);
    if (Option.isNone(decoded)) return;
    const {
      component = "renderer",
      data,
      error,
      repeatKey,
      ...record
    } = decoded.value;
    if (record.level === "debug" && !env.debug) return;
    const safeData = desktopLogJsonSafe({ data });
    const boundedData =
      Predicate.isObject(safeData) && "data" in safeData
        ? safeData["data"]
        : undefined;
    const at = clock.currentTimeMillisUnsafe();
    writeRecord(
      {
        ...record,
        at: new Date(at).toISOString(),
        message: boundRendererString(record.message, 1_024),
        component: boundRendererString(component, 64),
        ...(boundedData === undefined ? {} : { data: boundedData }),
        ...(error === undefined
          ? {}
          : {
              error: error
                .slice(0, 8)
                .map((entry) => boundRendererError(entry)),
            }),
        ...(repeatKey === undefined
          ? {}
          : { repeatKey: boundRendererString(repeatKey, 256) }),
        annotations: { rendererId: event.sender.id },
      },
      at,
      event.sender.id,
    );
  };

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

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      ipcMain.on(RendererLogIpc.record.channel, handleRendererRecord),
    ),
    () =>
      Effect.sync(() => {
        ipcMain.removeListener(
          RendererLogIpc.record.channel,
          handleRendererRecord,
        );
      }),
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
