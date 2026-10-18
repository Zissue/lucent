import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import {
  defineInvoke,
  FileSystemIpc,
  type IpcInvokeDescriptor,
  ScriptingIpc,
} from "../../shared/ipc";
import { createDesktopIpcInvokeHandler } from "./DesktopIpcInvoke";

interface LogRecord {
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly cause: Cause.Cause<unknown>;
  readonly level: string;
  readonly message: unknown;
}

const invokeDescriptorWithLogs = <Payload, Result>(
  descriptor: IpcInvokeDescriptor<Payload, Result>,
  payload: unknown,
  result: Effect.Effect<Result, unknown>,
) => {
  const records: LogRecord[] = [];
  const logger = Logger.make((options) => {
    records.push({
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      cause: options.cause,
      level: options.logLevel,
      message: options.message,
    });
  });
  return Effect.gen(function* () {
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    const invoke = createDesktopIpcInvokeHandler(
      descriptor,
      () => result,
      runPromise,
    );
    const envelope = yield* Effect.promise(() => invoke(undefined, payload));
    return { envelope, records };
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
};

const invokeWithLogs = (
  channel: string,
  result: Effect.Effect<number, unknown>,
) =>
  invokeDescriptorWithLogs(
    defineInvoke({
      channel,
      payload: Schema.Int,
      result: Schema.Int,
    }),
    1,
    result,
  );

const logLines = (records: readonly LogRecord[]) =>
  records.map(({ annotations, level, message }) => ({
    annotations,
    level,
    message,
  }));

describe("IPC failure logging", () => {
  it.effect("logs one warning for a typed failure and returns its error", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeWithLogs(
        "test:save",
        Effect.fail(new Error("Save failed")),
      );

      expect(envelope).toEqual({
        ok: false,
        message: "Save failed",
      });
      expect(logLines(records)).toEqual([
        {
          annotations: {
            component: "ipc",
            data: { channel: "test:save" },
            repeatKey: "test:save",
          },
          level: "Warn",
          message: ["IPC handler failed"],
        },
      ]);
      expect(records.map(({ cause }) => Cause.squash(cause))).toEqual([
        "UnknownError",
      ]);
    }),
  );

  it.effect("keeps failures from different channels distinct", () =>
    Effect.gen(function* () {
      const save = yield* invokeWithLogs("test:save", Effect.fail("Failed"));
      const launch = yield* invokeWithLogs(
        "test:launch",
        Effect.fail("Failed"),
      );

      expect(
        [...save.records, ...launch.records].map(({ annotations }) => ({
          channel: annotations["data"],
          repeatKey: annotations["repeatKey"],
        })),
      ).toEqual([
        { channel: { channel: "test:save" }, repeatKey: "test:save" },
        { channel: { channel: "test:launch" }, repeatKey: "test:launch" },
      ]);
      expect([save.envelope.ok, launch.envelope.ok]).toEqual([false, false]);
    }),
  );

  it.effect("logs one error for a defect", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeWithLogs(
        "test:launch",
        Effect.die(new Error("Launch defect")),
      );

      expect(envelope).toEqual({
        ok: false,
        message: "Launch defect",
      });
      expect(logLines(records)).toEqual([
        {
          annotations: {
            component: "ipc",
            data: { channel: "test:launch" },
            repeatKey: "test:launch",
          },
          level: "Error",
          message: ["IPC handler failed unexpectedly"],
        },
      ]);
    }),
  );

  it.effect(
    "keeps an interruption silent while returning a failure envelope",
    () =>
      Effect.gen(function* () {
        const { envelope, records } = yield* invokeWithLogs(
          "test:close",
          Effect.interrupt,
        );

        expect(envelope.ok).toBe(false);
        expect(records).toEqual([]);
      }),
  );

  it.effect(
    "does not suppress a typed failure combined with an interruption",
    () =>
      Effect.gen(function* () {
        const { envelope, records } = yield* invokeWithLogs(
          "test:install",
          Effect.failCause(
            Cause.combine(Cause.fail("Install failed"), Cause.interrupt()),
          ),
        );

        expect(envelope.ok).toBe(false);
        expect(logLines(records)).toEqual([
          {
            annotations: {
              component: "ipc",
              data: { channel: "test:install" },
              repeatKey: "test:install",
            },
            level: "Warn",
            message: ["IPC handler failed"],
          },
        ]);
      }),
  );

  it.effect("returns successful results without logging a failure", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeWithLogs(
        "test:save",
        Effect.succeed(2),
      );

      expect(envelope).toEqual({ ok: true, value: 2 });
      expect(records).toEqual([]);
    }),
  );

  it.effect("keeps cancelled script selection silent", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeDescriptorWithLogs(
        ScriptingIpc.selectFile,
        undefined,
        Effect.succeed({ canceled: true } as const),
      );

      expect(envelope).toEqual({ ok: true, value: { canceled: true } });
      expect(records).toEqual([]);
    }),
  );

  it.effect("keeps a filesystem not-found business result silent", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeDescriptorWithLogs(
        FileSystemIpc.list,
        { path: "missing" },
        Effect.succeed({
          ok: false,
          error: { operation: "list", path: "missing", reason: "not-found" },
        } as const),
      );

      expect(envelope).toEqual({
        ok: true,
        value: {
          ok: false,
          error: { operation: "list", path: "missing", reason: "not-found" },
        },
      });
      expect(records).toEqual([]);
    }),
  );

  it.effect("logs the failure tag but not its details", () =>
    Effect.gen(function* () {
      const { envelope, records } = yield* invokeWithLogs(
        "test:save",
        Effect.fail(new Error("Password secret for account PrivateName")),
      );

      expect(envelope).toEqual({
        ok: false,
        message: "Password secret for account PrivateName",
      });
      expect(records.map(({ cause }) => Cause.squash(cause))).toEqual([
        "UnknownError",
      ]);
    }),
  );
});
