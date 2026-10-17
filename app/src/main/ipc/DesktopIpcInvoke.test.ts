import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import { DEFAULT_APP_SETTINGS } from "@lucent/core/settings";
import { defineInvoke, SettingsIpc } from "../../shared/ipc";
import { createDesktopIpcInvokeHandler } from "./DesktopIpcInvoke";
import { DesktopIpcSenderError } from "./DesktopIpcSenders";

const CountIpc = defineInvoke({
  channel: "test:count",
  name: "test.count",
  payload: Schema.Int,
  result: Schema.Int,
});

interface LogRecord {
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly cause: Cause.Cause<unknown>;
  readonly level: string;
  readonly message: unknown;
}

const invokeWithCapturedLogs = (
  payload: unknown,
  handler: () => Effect.Effect<number, unknown>,
) => {
  const records: LogRecord[] = [];
  const capture = Logger.make((options) => {
    records.push({
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      cause: options.cause,
      level: options.logLevel,
      message: options.message,
    });
  });

  return Effect.gen(function* () {
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    const invoke = createDesktopIpcInvokeHandler(CountIpc, handler, runPromise);
    const envelope = yield* Effect.promise(() => invoke(undefined, payload));
    return { envelope, records };
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([capture])));
};

const logLines = (records: readonly LogRecord[]) =>
  records.map(({ annotations, level, message }) => ({
    annotations,
    level,
    message,
  }));

const unexpectedFailureLog = {
  annotations: {
    component: "ipc",
    data: { channel: "test:count" },
    repeatKey: "test:count",
  },
  level: "Error",
  message: ["IPC handler failed unexpectedly"],
};

const typedFailureLog = {
  ...unexpectedFailureLog,
  level: "Warn",
  message: ["IPC handler failed"],
};

describe("createDesktopIpcInvokeHandler", () => {
  it.effect("logs a handler defect with its channel and original cause", () =>
    Effect.gen(function* () {
      const defect = new Error("counter store corrupted");
      const { envelope, records } = yield* invokeWithCapturedLogs(1, () =>
        Effect.die(defect),
      );

      expect(envelope).toEqual({
        ok: false,
        error: {
          channel: "test:count",
          code: "IPC_HANDLER_FAILED",
          message: "counter store corrupted",
        },
      });
      expect(logLines(records)).toEqual([unexpectedFailureLog]);
      expect(records.map(({ cause }) => Cause.squash(cause))).toEqual([defect]);
    }),
  );

  it.effect("does not log a handler interruption", () =>
    Effect.gen(function* () {
      const { records } = yield* invokeWithCapturedLogs(
        1,
        () => Effect.interrupt,
      );

      expect(records).toEqual([]);
    }),
  );

  it.effect("logs a result that fails its own result schema", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeWithCapturedLogs(1, () =>
        Effect.succeed(1.5),
      );

      expect(envelope).toEqual({
        ok: false,
        error: {
          channel: "test:count",
          code: "IPC_HANDLER_FAILED",
          message: "Expected an integer",
        },
      });
      expect(logLines(records)).toEqual([unexpectedFailureLog]);
      expect(records.map(({ cause }) => Cause.hasDies(cause))).toEqual([true]);
    }),
  );

  it.effect("logs a typed handler failure by its tag", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeWithCapturedLogs(1, () =>
        Effect.fail(
          new DesktopIpcSenderError({ detail: "Sender is not allowed." }),
        ),
      );

      expect(envelope).toEqual({
        ok: false,
        error: {
          channel: "test:count",
          code: "IPC_HANDLER_FAILED",
          message: "Sender is not allowed.",
        },
      });
      expect(logLines(records)).toEqual([typedFailureLog]);
      expect(records.map(({ cause }) => Cause.squash(cause))).toEqual([
        "DesktopIpcSenderError",
      ]);
    }),
  );

  it.effect("rejects an invalid payload and logs it once", () =>
    Effect.gen(function* () {
      let handled = 0;
      const { envelope, records } = yield* invokeWithCapturedLogs("one", () =>
        Effect.sync(() => {
          handled += 1;
          return handled;
        }),
      );

      expect(envelope.ok).toBe(false);
      expect(handled).toBe(0);
      expect(logLines(records)).toEqual([typedFailureLog]);
    }),
  );

  it.effect(
    "rejects invalid mutation payloads before running the handler",
    () =>
      Effect.gen(function* () {
        let saveCount = 0;
        const invoke = createDesktopIpcInvokeHandler(
          SettingsIpc.updatePreferences,
          () =>
            Effect.sync(() => {
              saveCount += 1;
              return DEFAULT_APP_SETTINGS;
            }),
          Effect.runPromise,
        );

        const envelope = yield* Effect.promise(() =>
          invoke(undefined, { checkForUpdates: "yes" }),
        );

        expect(envelope.ok).toBe(false);
        if (!envelope.ok) {
          expect(envelope.error.channel).toBe(
            SettingsIpc.updatePreferences.channel,
          );
        }
        expect(saveCount).toBe(0);
      }),
  );

  it.effect("rejects unknown appearance token payloads before saving", () =>
    Effect.gen(function* () {
      let saveCount = 0;
      const invoke = createDesktopIpcInvokeHandler(
        SettingsIpc.updateAppearance,
        () =>
          Effect.sync(() => {
            saveCount += 1;
            return DEFAULT_APP_SETTINGS;
          }),
        Effect.runPromise,
      );

      const envelope = yield* Effect.promise(() =>
        invoke(undefined, {
          themes: {
            dark: {
              tokens: {
                bogus: [1, 2, 3],
              },
            },
          },
        }),
      );

      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error.channel).toBe(
          SettingsIpc.updateAppearance.channel,
        );
      }
      expect(saveCount).toBe(0);
    }),
  );

  it.effect("accepts a single-token appearance patch", () =>
    Effect.gen(function* () {
      const savedPatches: unknown[] = [];
      const invoke = createDesktopIpcInvokeHandler(
        SettingsIpc.updateAppearance,
        (patch) =>
          Effect.sync(() => {
            savedPatches.push(patch);
            return DEFAULT_APP_SETTINGS;
          }),
        Effect.runPromise,
      );

      const envelope = yield* Effect.promise(() =>
        invoke(undefined, {
          themes: {
            dark: {
              tokens: {
                background: [1, 2, 3],
              },
            },
          },
        }),
      );

      expect(envelope.ok).toBe(true);
      expect(savedPatches).toEqual([
        { themes: { dark: { tokens: { background: [1, 2, 3] } } } },
      ]);
    }),
  );
});
