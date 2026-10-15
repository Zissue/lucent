import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";

import { makeListenerRegistry } from "./ListenerRegistry";

describe("ListenerRegistry", () => {
  it.effect(
    "delivers concurrent events without waiting for the first listener",
    () =>
      Effect.gen(function* () {
        const registry = makeListenerRegistry<number>({
          concurrency: "unbounded",
        });
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

        yield* registry.publish(7);
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
      const unsubscribe = yield* registry.subscribe((value) => {
        received.push(value);
      });

      yield* registry.publish(1);
      unsubscribe();
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

it.effect(
  "drops stale and repeated revisions when the publication executes",
  () =>
    Effect.gen(function* () {
      const registry = makeListenerRegistry<string>();
      const received: string[] = [];
      yield* registry.subscribe((value) => {
        received.push(value);
      });
      const stale = registry.publishLatest(1, "old");
      yield* registry.publishLatest(2, "new");
      yield* stale;
      yield* registry.publishLatest(2, "repeated");
      expect(received).toEqual(["new"]);
    }),
);

it.effect(
  "skips remaining stale listeners after a newer publication overtakes it",
  () =>
    Effect.gen(function* () {
      const registry = makeListenerRegistry<string>();
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      yield* registry.subscribe((value) =>
        value === "old"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
            )
          : Effect.void,
      );
      const received: string[] = [];
      yield* registry.subscribe((value) => {
        received.push(value);
      });
      const old = yield* registry
        .publishLatest(1, "old")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* registry.publishLatest(2, "new");
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(old);
      expect(received).toEqual(["new"]);
    }),
);

it.effect("allows a listener to publish a newer revision", () =>
  Effect.gen(function* () {
    const registry = makeListenerRegistry<string>();
    yield* registry.subscribe((value) =>
      value === "old" ? registry.publishLatest(2, "new") : Effect.void,
    );
    const received: string[] = [];
    yield* registry.subscribe((value) => {
      received.push(value);
    });
    yield* registry.publishLatest(1, "old");
    expect(received).toEqual(["new"]);
  }),
);
