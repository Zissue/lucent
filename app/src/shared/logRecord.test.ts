import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { desktopLogJsonSafe, desktopLogRecord } from "./logRecord";

const collect = (records: unknown[]) =>
  Logger.layer(
    [
      Logger.make((options) => {
        records.push(desktopLogRecord(options));
      }),
    ],
    { mergeWithExisting: false },
  );

describe("log records", () => {
  it.effect("preserves messages, errors, annotations, data, and spans", () =>
    Effect.gen(function* () {
      const records: unknown[] = [];
      yield* Effect.logWarning(
        "Loop failed",
        new Error("raw"),
        Cause.fail(new Error("x")),
      ).pipe(
        Effect.annotateLogs({
          component: "army",
          data: { attempt: 2 },
          requestId: "r1",
        }),
        Effect.withSpan("loop"),
        Effect.provide(collect(records)),
      );
      expect(records).toEqual([
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "army",
          message: "Loop failed",
          data: { attempt: 2 },
          annotations: { requestId: "r1" },
          error: [
            { name: "Error", message: "raw", stack: expect.any(String) },
            { name: "Error", message: "x", stack: expect.any(String) },
          ],
          traceId: expect.any(String),
          spanId: expect.any(String),
        },
      ]);
    }),
  );

  it.effect(
    "labels non-string messages and retains every non-string argument",
    () =>
      Effect.gen(function* () {
        const records: unknown[] = [];
        yield* Effect.logInfo({ ready: false }, "detail", 42).pipe(
          Effect.provide(collect(records)),
        );
        expect(records).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "info",
            component: "effect",
            message: "Unlabeled log message",
            error: [
              { name: "NonError", message: '{"ready":false}' },
              { name: "NonError", message: "42" },
            ],
          },
        ]);
      }),
  );

  it.effect("keeps repeat keys separate from saved annotations", () =>
    Effect.gen(function* () {
      const records: unknown[] = [];
      yield* Effect.logWarning("Environment automation failed").pipe(
        Effect.annotateLogs({
          component: "environment",
          repeatKey: "environment/quests/load",
          requestId: "r1",
        }),
        Effect.provide(collect(records)),
      );
      expect(records).toEqual([
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "environment",
          message: "Environment automation failed",
          repeatKey: "environment/quests/load",
          annotations: { requestId: "r1" },
        },
      ]);
    }),
  );

  it("makes bigint, cycles, errors, functions, and symbols safe for IPC", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const shared = { count: 1 };
    const cause = new Error("root");
    cause.stack = "root stack";
    const error = new Error("broken", { cause });
    error.stack = "broken stack";
    expect(
      desktopLogJsonSafe({
        data: {
          count: 42n,
          circular,
          error,
          fn: () => {},
          symbol: Symbol("x"),
          shared,
          again: shared,
        },
      }),
    ).toEqual({
      data: {
        count: "42",
        circular: { self: "[Circular]" },
        error: {
          name: "Error",
          message: "broken",
          stack: "broken stack",
          cause: { name: "Error", message: "root", stack: "root stack" },
        },
        shared: { count: 1 },
        again: "[Circular]",
      },
    });
    expect(desktopLogJsonSafe(undefined)).toBeUndefined();
  });

  it("retains back-references after serializing an error with a cause", () => {
    const error = new Error("x", { cause: "root" });
    error.stack = "error stack";
    const value: { err: Error; self?: unknown } = { err: error };
    value.self = value;
    expect(desktopLogJsonSafe(value)).toEqual({
      err: {
        name: "Error",
        message: "x",
        stack: "error stack",
        cause: { name: "NonError", message: "root" },
      },
      self: "[Circular]",
    });
  });

  it("retains back-references in objects returned by toJSON", () => {
    const error = new Error("x", { cause: "root" });
    error.stack = "error stack";
    const value: { err: Error; self?: unknown } = { err: error };
    value.self = value;
    expect(desktopLogJsonSafe({ toJSON: () => value })).toEqual({
      err: {
        name: "Error",
        message: "x",
        stack: "error stack",
        cause: { name: "NonError", message: "root" },
      },
      self: "[Circular]",
    });
  });

  it("limits only data using UTF-8 JSON bytes above 16 KiB", () => {
    expect(
      desktopLogJsonSafe({ message: "Large data", data: "x".repeat(16382) }),
    ).toEqual({ message: "Large data", data: "x".repeat(16382) });
    expect(
      desktopLogJsonSafe({ message: "Large data", data: "x".repeat(16383) }),
    ).toEqual({ message: "Large data", data: { truncated: 16385 } });
    expect(
      desktopLogJsonSafe({ message: "Unicode data", data: "é".repeat(8192) }),
    ).toEqual({ message: "Unicode data", data: { truncated: 16386 } });
  });
});
