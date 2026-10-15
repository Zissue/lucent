import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { loggingLayer } from "./runtime";

afterEach(() => vi.unstubAllGlobals());

describe("renderer Effect logger", () => {
  it.effect(
    "sends warnings and Cause errors at their real level without console output",
    () =>
      Effect.gen(function* () {
        const write = vi.fn();
        vi.stubGlobal("window", { desktop: { debug: false, log: { write } } });
        const consoleLog = vi.spyOn(console, "log");
        try {
          yield* Effect.logWarning(
            "Loop failed",
            Cause.fail(new Error("x")),
          ).pipe(Effect.provide(loggingLayer));
          expect(write.mock.calls).toEqual([
            [
              {
                level: "warn",
                message: "Loop failed",
                component: "effect",
                error: [
                  { name: "Error", message: "x", stack: expect.any(String) },
                ],
              },
            ],
          ]);
          expect(consoleLog).not.toHaveBeenCalled();
        } finally {
          consoleLog.mockRestore();
        }
      }),
  );

  for (const debug of [false, true]) {
    it.effect(`filters debug records with debug=${debug}`, () =>
      Effect.gen(function* () {
        const write = vi.fn();
        vi.stubGlobal("window", { desktop: { debug, log: { write } } });
        yield* Effect.gen(function* () {
          yield* Effect.logDebug("Debug detail");
          yield* Effect.logInfo("Ready").pipe(
            Effect.annotateLogs({ component: "game", data: { count: 42n } }),
          );
          yield* Effect.logFatal("Fatal error");
        }).pipe(Effect.provide(loggingLayer));
        expect(write.mock.calls).toEqual([
          ...(debug
            ? [
                [
                  {
                    level: "debug",
                    message: "Debug detail",
                    component: "effect",
                  },
                ],
              ]
            : []),
          [
            {
              level: "info",
              message: "Ready",
              component: "game",
              data: { count: 42n },
            },
          ],
          [{ level: "error", message: "Fatal error", component: "effect" }],
        ]);
      }),
    );
  }

  it.effect("drops bridge failures without failing the effect", () =>
    Effect.gen(function* () {
      const write = vi.fn().mockImplementationOnce(() => {
        throw new Error("closed");
      });
      vi.stubGlobal("window", { desktop: { debug: false, log: { write } } });
      const result = yield* Effect.gen(function* () {
        yield* Effect.logInfo("Closed bridge");
        yield* Effect.logInfo("Ready");
        return "completed";
      }).pipe(Effect.provide(loggingLayer));
      expect(result).toBe("completed");
      expect(write.mock.calls).toEqual([
        [{ level: "info", message: "Closed bridge", component: "effect" }],
        [{ level: "info", message: "Ready", component: "effect" }],
      ]);
    }),
  );

  it.effect("forwards repeat keys with renderer records", () =>
    Effect.gen(function* () {
      const write = vi.fn();
      vi.stubGlobal("window", { desktop: { debug: false, log: { write } } });
      yield* Effect.logWarning("Environment automation failed").pipe(
        Effect.annotateLogs({
          component: "environment",
          repeatKey: "environment/quests/load",
        }),
        Effect.provide(loggingLayer),
      );
      expect(write.mock.calls).toEqual([
        [
          {
            level: "warn",
            message: "Environment automation failed",
            component: "environment",
            repeatKey: "environment/quests/load",
          },
        ],
      ]);
    }),
  );
});
