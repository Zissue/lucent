import * as Cause from "effect/Cause";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layer as desktopEnvironmentLayer } from "../DesktopEnvironment";
import {
  DesktopObservability,
  layer as desktopObservabilityLayer,
} from "./DesktopObservability";

const fixtureDirectories = new Set<string>();

const makeFixture = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "lucent-observability-"));
  fixtureDirectories.add(path);
  return path;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw cause;
  }
};

const readRecords = async (path: string): Promise<unknown[]> =>
  (await fs.readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const makeLayer = (appDataDir: string, debug: boolean) =>
  desktopObservabilityLayer.pipe(
    Layer.provide(
      desktopEnvironmentLayer({
        appDataDir,
        assetsDir: join(appDataDir, "assets"),
        debug,
        isDev: false,
        platform: process.platform,
        workspaceDir: join(appDataDir, "workspace"),
      }),
    ),
  );

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    [...fixtureDirectories].map((path) =>
      fs.rm(path, { recursive: true, force: true }),
    ),
  );
  fixtureDirectories.clear();
});

describe("DesktopObservability", () => {
  it.effect("collapses 100 warnings until the window expires", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const logFilePath = join(root, "logs", "lucent.log");
      yield* Effect.gen(function* () {
        const observability = yield* DesktopObservability;
        yield* Effect.logWarning("Loop failed", new Error("offline")).pipe(
          Effect.annotateLogs({
            component: "relay",
            data: { attempt: 1 },
            requestId: "first",
          }),
          Effect.withSpan("retry"),
        );
        yield* TestClock.adjust("10 seconds");
        for (let i = 0; i < 99; i++) {
          yield* Effect.logWarning(
            "Loop failed",
            new Error("still offline"),
          ).pipe(
            Effect.annotateLogs({
              component: "relay",
              data: { attempt: i + 2 },
              requestId: "repeat",
            }),
            Effect.withSpan("retry"),
          );
        }
        yield* observability.flush;
        expect(yield* Effect.promise(() => readRecords(logFilePath))).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "warn",
            component: "relay",
            message: "Loop failed",
            data: { attempt: 1 },
            annotations: { requestId: "first" },
            error: [
              { name: "Error", message: "offline", stack: expect.any(String) },
            ],
            traceId: expect.any(String),
            spanId: expect.any(String),
          },
        ]);
        yield* TestClock.adjust("50 seconds");
        yield* observability.flush;
        expect(yield* Effect.promise(() => readRecords(logFilePath))).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "warn",
            component: "relay",
            message: "Loop failed",
            data: { attempt: 1 },
            annotations: { requestId: "first" },
            error: [
              { name: "Error", message: "offline", stack: expect.any(String) },
            ],
            traceId: expect.any(String),
            spanId: expect.any(String),
          },
          {
            at: "1970-01-01T00:01:00.000Z",
            level: "warn",
            component: "relay",
            message: "Loop failed",
            suppressed: 99,
            lastAt: "1970-01-01T00:00:10.000Z",
          },
        ]);
      }).pipe(Effect.provide(makeLayer(root, false)));
      expect(
        yield* Effect.promise(() => readRecords(logFilePath)),
      ).toHaveLength(2);
    }),
  );

  it.effect("keeps message, component, and level windows separate", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      yield* Effect.gen(function* () {
        for (let i = 0; i < 2; i++) {
          yield* Effect.logWarning("Retrying").pipe(
            Effect.annotateLogs({ component: "relay" }),
          );
          yield* Effect.logWarning("Disconnected").pipe(
            Effect.annotateLogs({ component: "relay" }),
          );
          yield* Effect.logWarning("Retrying").pipe(
            Effect.annotateLogs({ component: "loader" }),
          );
          yield* Effect.logError("Retrying").pipe(
            Effect.annotateLogs({ component: "relay" }),
          );
        }
      }).pipe(Effect.provide(makeLayer(root, false)));
      expect(
        yield* Effect.promise(() =>
          readRecords(join(root, "logs", "lucent.log")),
        ),
      ).toEqual([
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "relay",
          message: "Retrying",
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "relay",
          message: "Disconnected",
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "loader",
          message: "Retrying",
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "error",
          component: "relay",
          message: "Retrying",
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "relay",
          message: "Retrying",
          suppressed: 1,
          lastAt: "1970-01-01T00:00:00.000Z",
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "relay",
          message: "Disconnected",
          suppressed: 1,
          lastAt: "1970-01-01T00:00:00.000Z",
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "loader",
          message: "Retrying",
          suppressed: 1,
          lastAt: "1970-01-01T00:00:00.000Z",
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "error",
          component: "relay",
          message: "Retrying",
          suppressed: 1,
          lastAt: "1970-01-01T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("writes an expired tail before the next full occurrence", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("30 seconds");
        yield* Effect.logWarning("Retrying");
        yield* TestClock.adjust("10 seconds");
        yield* Effect.logWarning("Retrying");
        yield* TestClock.adjust("50 seconds");
        yield* Effect.logWarning("Retrying");
        yield* TestClock.adjust("90 seconds");
      }).pipe(Effect.provide(makeLayer(root, false)));
      expect(
        yield* Effect.promise(() =>
          readRecords(join(root, "logs", "lucent.log")),
        ),
      ).toEqual([
        {
          at: "1970-01-01T00:00:30.000Z",
          level: "warn",
          component: "effect",
          message: "Retrying",
        },
        {
          at: "1970-01-01T00:01:30.000Z",
          level: "warn",
          component: "effect",
          message: "Retrying",
          suppressed: 1,
          lastAt: "1970-01-01T00:00:40.000Z",
        },
        {
          at: "1970-01-01T00:01:30.000Z",
          level: "warn",
          component: "effect",
          message: "Retrying",
        },
      ]);
    }),
  );

  it.effect(
    "drains pending repeats at shutdown using the last repeat time",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeFixture);
        yield* Effect.gen(function* () {
          yield* Effect.logWarning("Retrying");
          yield* TestClock.adjust("5 seconds");
          yield* Effect.logWarning("Retrying");
          yield* TestClock.adjust("5 seconds");
          yield* Effect.logWarning("Retrying");
          yield* TestClock.adjust("5 seconds");
        }).pipe(Effect.provide(makeLayer(root, false)));
        expect(
          yield* Effect.promise(() =>
            readRecords(join(root, "logs", "lucent.log")),
          ),
        ).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "warn",
            component: "effect",
            message: "Retrying",
          },
          {
            at: "1970-01-01T00:00:15.000Z",
            level: "warn",
            component: "effect",
            message: "Retrying",
            suppressed: 2,
            lastAt: "1970-01-01T00:00:10.000Z",
          },
        ]);
      }),
  );

  it.effect("never collapses non-string record messages", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      yield* Effect.gen(function* () {
        const message = { ready: true };
        for (let i = 0; i < 2; i++) {
          yield* Effect.logInfo(message);
          yield* Effect.logInfo(message, "detail");
        }
      }).pipe(Effect.provide(makeLayer(root, false)));
      expect(
        yield* Effect.promise(() =>
          readRecords(join(root, "logs", "lucent.log")),
        ),
      ).toEqual([
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "info",
          component: "effect",
          message: { ready: true },
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "info",
          component: "effect",
          message: [{ ready: true }, "detail"],
          error: [{ name: "NonError", message: "detail" }],
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "info",
          component: "effect",
          message: { ready: true },
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "info",
          component: "effect",
          message: [{ ready: true }, "detail"],
          error: [{ name: "NonError", message: "detail" }],
        },
      ]);
    }),
  );

  it.effect(
    "writes new keys untracked at capacity and reclaims windows without repeats",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeFixture);
        yield* Effect.gen(function* () {
          const observability = yield* DesktopObservability;
          for (let i = 0; i < 1_000; i++) {
            yield* Effect.logInfo(`message-${i}`);
            if (i % 100 === 99) yield* observability.flush;
          }
          yield* Effect.logWarning("overflow");
          yield* Effect.logWarning("overflow");
          yield* TestClock.adjust("60 seconds");
          yield* observability.flush;
          yield* Effect.logWarning("overflow");
          yield* Effect.logWarning("overflow");
        }).pipe(Effect.provide(makeLayer(root, false)));
        const records = yield* Effect.promise(() =>
          readRecords(join(root, "logs", "lucent.log")),
        );
        expect(records).toHaveLength(1_004);
        expect(records[0]).toEqual({
          at: "1970-01-01T00:00:00.000Z",
          level: "info",
          component: "effect",
          message: "message-0",
        });
        expect(records.slice(1_000)).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "warn",
            component: "effect",
            message: "overflow",
          },
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "warn",
            component: "effect",
            message: "overflow",
          },
          {
            at: "1970-01-01T00:01:00.000Z",
            level: "warn",
            component: "effect",
            message: "overflow",
          },
          {
            at: "1970-01-01T00:01:00.000Z",
            level: "warn",
            component: "effect",
            message: "overflow",
            suppressed: 1,
            lastAt: "1970-01-01T00:01:00.000Z",
          },
        ]);
      }),
  );

  for (const expire of [false, true]) {
    it.effect(
      `drains 1,000 pending tails without overflowing the writer with expire=${expire}`,
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(makeFixture);
          yield* Effect.gen(function* () {
            const observability = yield* DesktopObservability;
            for (let i = 0; i < 1_000; i++) {
              yield* Effect.logWarning(`message-${i}`);
              yield* Effect.logWarning(`message-${i}`);
              if (i % 100 === 99) yield* observability.flush;
            }
            if (expire) yield* TestClock.adjust("60 seconds");
          }).pipe(Effect.provide(makeLayer(root, false)));
          const records = yield* Effect.promise(() =>
            readRecords(join(root, "logs", "lucent.log")),
          );
          expect(records).toHaveLength(2_000);
          expect(records.slice(1_000)).toEqual(
            Array.from({ length: 1_000 }, (_, i) => ({
              at: expire
                ? "1970-01-01T00:01:00.000Z"
                : "1970-01-01T00:00:00.000Z",
              level: "warn",
              component: "effect",
              message: `message-${i}`,
              suppressed: 1,
              lastAt: "1970-01-01T00:00:00.000Z",
            })),
          );
        }),
    );
  }

  it.effect(
    "retains operation, cleanup, and interruption failures in the log file",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeFixture);
        const exit = yield* Effect.fail(new Error("Operation failed")).pipe(
          Effect.ensuring(Effect.die(new Error("Cleanup failed"))),
          Effect.exit,
        );
        if (!Exit.isFailure(exit))
          throw new Error("Expected operation failure");

        yield* Effect.logError("Runtime failed", exit.cause).pipe(
          Effect.andThen(
            Effect.logError("Runtime interrupted", Cause.interrupt(99)),
          ),
          Effect.provide(makeLayer(root, false)),
        );

        expect(
          yield* Effect.promise(() =>
            readRecords(join(root, "logs", "lucent.log")),
          ),
        ).toEqual([
          {
            at: expect.any(String),
            component: "effect",
            level: "error",
            message: "Runtime failed",
            error: [
              {
                name: "Error",
                message: "Operation failed",
                stack: expect.any(String),
              },
              {
                name: "Error",
                message: "Cleanup failed",
                stack: expect.any(String),
              },
            ],
          },
          {
            at: expect.any(String),
            component: "effect",
            level: "error",
            message: "Runtime interrupted",
            error: [
              {
                name: "InterruptError",
                message: "All fibers interrupted without error",
                stack: expect.any(String),
                cause: {
                  name: "InterruptCause",
                  message: "The fiber was interrupted by:",
                  stack:
                    "InterruptCause: The fiber was interrupted by:\n    at fiber (#99)",
                },
              },
            ],
          },
        ]);
      }),
  );

  it.effect(
    "queues enabled log levels and drains them in order on shutdown",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        const root = yield* Effect.promise(makeFixture);
        const logFilePath = join(root, "logs", "lucent.log");

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.logInfo("info").pipe(
              Effect.annotateLogs({ component: "test" }),
            );
            yield* Effect.logWarning("warn").pipe(
              Effect.annotateLogs({ component: "test", data: { attempt: 1 } }),
            );
            yield* Effect.logDebug("debug").pipe(
              Effect.annotateLogs({ component: "test" }),
            );
            yield* Effect.logError("error", Cause.fail(new Error("boom"))).pipe(
              Effect.annotateLogs({ component: "test" }),
            );

            expect(yield* Effect.promise(() => fileExists(logFilePath))).toBe(
              false,
            );
          }).pipe(Effect.provide(makeLayer(root, false))),
        );

        expect(
          yield* Effect.promise(() => readRecords(logFilePath)),
        ).toMatchObject([
          { component: "test", level: "info", message: "info" },
          {
            component: "test",
            data: { attempt: 1 },
            level: "warn",
            message: "warn",
          },
          {
            component: "test",
            error: [{ message: "boom", name: "Error" }],
            level: "error",
            message: "error",
          },
        ]);
      }),
  );

  it.effect(
    "captures service startup, native callbacks, spans, and shutdown",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeFixture);
        class Callback extends Context.Service<Callback, () => Promise<void>>()(
          "test/Callback",
        ) {}
        const callbackLayer = Layer.effect(
          Callback,
          Effect.gen(function* () {
            yield* Effect.logInfo("initialized");
            const context = yield* Effect.context<never>();
            yield* Effect.addFinalizer(() => Effect.logInfo("released"));
            return () =>
              Effect.runPromiseWith(context)(
                Effect.logWarning("callback").pipe(
                  Effect.annotateLogs({ requestId: "request-1" }),
                  Effect.withSpan("callback-span"),
                ),
              );
          }),
        ).pipe(Layer.provideMerge(makeLayer(root, false)));

        yield* Effect.gen(function* () {
          const callback = yield* Callback;
          yield* Effect.promise(callback);
        }).pipe(Effect.provide(callbackLayer));

        expect(
          yield* Effect.promise(() =>
            readRecords(join(root, "logs", "lucent.log")),
          ),
        ).toMatchObject([
          { level: "info", component: "effect", message: "initialized" },
          {
            level: "warn",
            message: "callback",
            annotations: { requestId: "request-1" },
            traceId: expect.any(String),
            spanId: expect.any(String),
          },
          { level: "info", message: "released" },
        ]);
      }),
  );

  for (const debug of [false, true]) {
    it.effect(`filters Debug records with debug=${debug}`, () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeFixture);
        yield* Effect.gen(function* () {
          yield* Effect.logDebug("Debug detail");
          yield* Effect.logInfo("Ready");
        }).pipe(Effect.provide(makeLayer(root, debug)));

        const info = {
          at: expect.any(String),
          component: "effect",
          level: "info",
          message: "Ready",
        };
        expect(
          yield* Effect.promise(() =>
            readRecords(join(root, "logs", "lucent.log")),
          ),
        ).toEqual(
          debug
            ? [
                {
                  at: expect.any(String),
                  component: "effect",
                  level: "debug",
                  message: "Debug detail",
                },
                info,
              ]
            : [info],
        );
      }),
    );
  }

  it.effect("keeps Cause and raw errors separate from their messages", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      yield* Effect.gen(function* () {
        yield* Effect.logError(
          "Relay failed",
          Cause.fail(
            new Error("socket closed", {
              cause: new Error("ECONNRESET"),
            }),
          ),
        );
        yield* Effect.logWarning("Fallback used", new Error("bad json"));
      }).pipe(Effect.provide(makeLayer(root, false)));

      expect(
        yield* Effect.promise(() =>
          readRecords(join(root, "logs", "lucent.log")),
        ),
      ).toEqual([
        {
          at: expect.any(String),
          component: "effect",
          level: "error",
          message: "Relay failed",
          error: [
            {
              name: "Error",
              message: "socket closed",
              stack: expect.any(String),
              cause: {
                name: "Error",
                message: "ECONNRESET",
                stack: expect.any(String),
              },
            },
          ],
        },
        {
          at: expect.any(String),
          component: "effect",
          level: "warn",
          message: "Fallback used",
          error: [
            { name: "Error", message: "bad json", stack: expect.any(String) },
          ],
        },
      ]);
    }),
  );
  it.effect("bounds raw and Cause error chains to five cause links", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const chain = new Error("0", {
        cause: new Error("1", {
          cause: new Error("2", {
            cause: new Error("3", {
              cause: new Error("4", {
                cause: new Error("5", {
                  cause: new Error("6"),
                }),
              }),
            }),
          }),
        }),
      });
      const cycle = new Error("cycle");
      cycle.cause = cycle;
      yield* Effect.gen(function* () {
        yield* Effect.logError("Deep errors", chain, Cause.fail(chain));
        yield* Effect.logError("Cyclic errors", cycle, Cause.die(cycle));
      }).pipe(Effect.provide(makeLayer(root, false)));

      const deep = {
        name: "Error",
        message: "0",
        stack: expect.any(String),
        cause: {
          name: "Error",
          message: "1",
          stack: expect.any(String),
          cause: {
            name: "Error",
            message: "2",
            stack: expect.any(String),
            cause: {
              name: "Error",
              message: "3",
              stack: expect.any(String),
              cause: {
                name: "Error",
                message: "4",
                stack: expect.any(String),
                cause: {
                  name: "Error",
                  message: "5",
                  stack: expect.any(String),
                },
              },
            },
          },
        },
      };
      const cyclic = {
        name: "Error",
        message: "cycle",
        stack: expect.any(String),
        cause: {
          name: "Error",
          message: "cycle",
          stack: expect.any(String),
          cause: {
            name: "Error",
            message: "cycle",
            stack: expect.any(String),
            cause: {
              name: "Error",
              message: "cycle",
              stack: expect.any(String),
              cause: {
                name: "Error",
                message: "cycle",
                stack: expect.any(String),
                cause: {
                  name: "Error",
                  message: "cycle",
                  stack: expect.any(String),
                },
              },
            },
          },
        },
      };
      expect(
        yield* Effect.promise(() =>
          readRecords(join(root, "logs", "lucent.log")),
        ),
      ).toEqual([
        {
          at: expect.any(String),
          component: "effect",
          level: "error",
          message: "Deep errors",
          error: [deep, deep],
        },
        {
          at: expect.any(String),
          component: "effect",
          level: "error",
          message: "Cyclic errors",
          error: [cyclic, cyclic],
        },
      ]);
    }),
  );

  it.effect(
    "formats non-error arguments and preserves non-string messages",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeFixture);
        const circular: { self?: unknown } = {};
        circular.self = circular;
        const unserializable = Object.create(null);
        unserializable.self = unserializable;
        yield* Effect.gen(function* () {
          yield* Effect.logError(
            "Unexpected values",
            { code: 42 },
            undefined,
            circular,
            unserializable,
            42n,
            "x".repeat(1_025),
          );
          yield* Effect.logInfo({ ready: true });
          yield* Effect.logInfo({ ready: false }, 42);
        }).pipe(Effect.provide(makeLayer(root, false)));

        expect(
          yield* Effect.promise(() =>
            readRecords(join(root, "logs", "lucent.log")),
          ),
        ).toEqual([
          {
            at: expect.any(String),
            component: "effect",
            level: "error",
            message: "Unexpected values",
            error: [
              { name: "NonError", message: '{"code":42}' },
              { name: "NonError", message: "undefined" },
              { name: "NonError", message: "[object Object]" },
              { name: "NonError", message: "[Unserializable]" },
              { name: "NonError", message: "42" },
              { name: "NonError", message: "x".repeat(1_024) },
            ],
          },
          {
            at: expect.any(String),
            component: "effect",
            level: "info",
            message: { ready: true },
          },
          {
            at: expect.any(String),
            component: "effect",
            level: "info",
            message: [{ ready: false }, 42],
            error: [{ name: "NonError", message: "42" }],
          },
        ]);
      }),
  );
});
