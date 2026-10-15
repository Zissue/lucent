import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { makeFailureTransitions } from "./failureTransitions";

describe("failure transitions", () => {
  it.effect("logs one failure for three failed cycles and one recovery", () => {
    const logs: {
      readonly cause: Cause.Cause<unknown>;
      readonly level: string;
      readonly message: unknown;
      readonly annotations: Readonly<Record<string, unknown>>;
    }[] = [];
    const logger = Logger.make((options) => {
      logs.push({
        cause: options.cause,
        level: options.logLevel,
        message: options.message,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const automationLogs = yield* makeFailureTransitions({
        component: "environment",
        failed: "Environment automation failed",
        recovered: "Environment automation recovered",
      });
      const outcomes: boolean[] = [];
      for (const succeeds of [false, false, false, true, true]) {
        const cycle: Effect.Effect<boolean, string> = succeeds
          ? Effect.succeed(true)
          : Effect.fail("quest load failed");
        const result = yield* cycle.pipe(
          Effect.tap(() =>
            automationLogs.recovered("environment/quests/load", {
              questId: 123,
            }),
          ),
          Effect.catchCause((cause) =>
            automationLogs
              .failed("environment/quests/load", cause, { questId: 123 })
              .pipe(Effect.as(false)),
          ),
        );
        outcomes.push(result);
      }

      expect(outcomes).toEqual([false, false, false, true, true]);
      expect(
        logs.map(({ level, message, annotations }) => ({
          level,
          message,
          annotations,
        })),
      ).toEqual([
        {
          level: "Warn",
          message: ["Environment automation failed"],
          annotations: {
            component: "environment",
            data: { key: "environment/quests/load", questId: 123 },
          },
        },
        {
          level: "Info",
          message: ["Environment automation recovered"],
          annotations: {
            component: "environment",
            data: { key: "environment/quests/load", questId: 123 },
          },
        },
      ]);
      expect(logs[0]?.cause).toEqual(Cause.fail("quest load failed"));
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
  });

  it.effect(
    "keeps keys independent and logs a new failure after recovery",
    () => {
      const logs: { readonly level: string; readonly data: unknown }[] = [];
      const logger = Logger.make((options) => {
        logs.push({
          level: options.logLevel,
          data: options.fiber.getRef(References.CurrentLogAnnotations)["data"],
        });
      });

      return Effect.gen(function* () {
        const automationLogs = yield* makeFailureTransitions({
          component: "army",
          failed: "Loop Taunt report failed",
          recovered: "Loop Taunt report recovered",
        });
        yield* automationLogs.recovered("healthy");
        yield* automationLogs.failed("canceled", Cause.interrupt());
        yield* Effect.all(
          [
            automationLogs.failed("quest/1", Cause.fail("load failed")),
            automationLogs.failed("quest/1", Cause.fail("load failed again")),
            automationLogs.failed("quest/2", Cause.die("defect")),
          ],
          { concurrency: "unbounded" },
        );
        yield* automationLogs.recovered("quest/1");
        yield* automationLogs.failed("quest/1", Cause.fail("retry failed"));
        yield* automationLogs.recovered("quest/2");

        expect(logs).toEqual([
          { level: "Warn", data: { key: "quest/1" } },
          { level: "Error", data: { key: "quest/2" } },
          { level: "Info", data: { key: "quest/1" } },
          { level: "Warn", data: { key: "quest/1" } },
          { level: "Info", data: { key: "quest/2" } },
        ]);
      }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
    },
  );
});
