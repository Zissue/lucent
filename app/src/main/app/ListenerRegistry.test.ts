import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";

import { makeListenerRegistry } from "./ListenerRegistry";

describe("ListenerRegistry", () => {
  it.effect(
    "delivers concurrent events without waiting for the first listener",
    () =>
      Effect.gen(function* () {
        const registry = makeListenerRegistry<number>();
        const released = yield* Deferred.make<void>();
        const received: string[] = [];
        yield* registry.subscribe((value) =>
          Effect.gen(function* () {
            yield* Deferred.await(released);
            received.push(`first:${value}`);
          }),
        );
        yield* registry.subscribe((value) =>
          Effect.gen(function* () {
            received.push(`second:${value}`);
            yield* Deferred.succeed(released, undefined);
          }),
        );

        yield* registry.publish(7, "unbounded");
        expect(received).toEqual(["second:7", "first:7"]);
      }),
  );

  it.effect("isolates listener failures and continues publishing", () =>
    Effect.gen(function* () {
      const registry = makeListenerRegistry<number>();
      const received: number[] = [];
      const failures: unknown[] = [];
      const failure = new Error("listener failed");

      yield* registry.subscribe(() => {
        throw failure;
      });
      yield* registry.subscribe((value) => {
        received.push(value);
      });

      yield* registry.publish(42).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              if (options.logLevel === "Error") {
                failures.push(Cause.squash(options.cause));
              }
            }),
          ]),
        ),
      );

      expect(received).toEqual([42]);
      expect(failures).toEqual([failure]);
    }),
  );

  it.effect("stops publishing to unsubscribed listeners", () =>
    Effect.gen(function* () {
      const registry = makeListenerRegistry<number>();
      const received: number[] = [];
      const scope = yield* Scope.make();
      yield* registry
        .subscribe((value) => {
          received.push(value);
        })
        .pipe(Effect.provideService(Scope.Scope, scope));

      yield* registry.publish(1);
      yield* Scope.close(scope, Exit.void);
      yield* registry.publish(2);

      expect(received).toEqual([1]);
    }),
  );

  it.effect("awaits effect listeners and isolates their failures", () =>
    Effect.gen(function* () {
      const registry = makeListenerRegistry<number>();
      const received: number[] = [];
      const failures: unknown[] = [];
      yield* registry.subscribe(() => Effect.fail("subscriber failed"));
      yield* registry.subscribe((value) =>
        Effect.sync(() => {
          received.push(value);
        }),
      );
      yield* registry.publish(7).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              if (options.logLevel === "Error") {
                failures.push(Cause.squash(options.cause));
              }
            }),
          ]),
        ),
      );
      expect(received).toEqual([7]);
      expect(failures).toEqual(["subscriber failed"]);
    }),
  );
});
