import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { logFailure } from "../../../shared/logFailure";

describe("logFailure", () => {
  it.effect("chooses the level from the cause", () =>
    Effect.gen(function* () {
      const records: {
        cause: Cause.Cause<unknown>;
        level: string;
        message: unknown;
        annotations: Readonly<Record<string, unknown>>;
      }[] = [];
      const capture = Logger.make((options) => {
        records.push({
          cause: options.cause,
          level: options.logLevel,
          message: options.message,
          annotations: options.fiber.getRef(References.CurrentLogAnnotations),
        });
      });
      yield* Effect.gen(function* () {
        yield* logFailure("Defect occurred", Cause.die("broken invariant"));
        yield* logFailure("Action failed", Cause.fail("window closed"));
        yield* logFailure(
          "Interrupted action failed",
          Cause.combine(Cause.interrupt(4), Cause.fail("request rejected")),
        );
        yield* logFailure("Using fallback", Cause.fail("unavailable"), {
          failure: "warning",
        });
        yield* logFailure("Listener failed", Cause.fail("rejected"), {
          failure: "error",
        });
        yield* logFailure("Action cancelled", Cause.interrupt(1));
        yield* logFailure("Fallback cancelled", Cause.interrupt(2), {
          failure: "warning",
        });
        yield* logFailure(
          "Fallback defect",
          Cause.combine(Cause.interrupt(3), Cause.die("cleanup defect")),
          { failure: "warning" },
        );
      }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.annotateLogs({ component: "test", data: { operation: "open" } }),
      );

      expect(records).toEqual([
        {
          cause: Cause.die("broken invariant"),
          level: "Error",
          message: ["Defect occurred"],
          annotations: { component: "test", data: { operation: "open" } },
        },
        {
          cause: Cause.fail("window closed"),
          level: "Debug",
          message: ["Action failed"],
          annotations: { component: "test", data: { operation: "open" } },
        },
        {
          cause: Cause.combine(
            Cause.interrupt(4),
            Cause.fail("request rejected"),
          ),
          level: "Debug",
          message: ["Interrupted action failed"],
          annotations: { component: "test", data: { operation: "open" } },
        },
        {
          cause: Cause.fail("unavailable"),
          level: "Warn",
          message: ["Using fallback"],
          annotations: { component: "test", data: { operation: "open" } },
        },
        {
          cause: Cause.fail("rejected"),
          level: "Error",
          message: ["Listener failed"],
          annotations: { component: "test", data: { operation: "open" } },
        },
        {
          cause: Cause.combine(Cause.interrupt(3), Cause.die("cleanup defect")),
          level: "Error",
          message: ["Fallback defect"],
          annotations: { component: "test", data: { operation: "open" } },
        },
      ]);
    }),
  );
});
