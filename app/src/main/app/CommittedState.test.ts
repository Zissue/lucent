import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import { makeCommittedPublication, makeCommittedState } from "./CommittedState";

describe("CommittedState", () => {
  it.effect(
    "commits and publishes a write that interrupts its caller exactly once",
    () =>
      Effect.gen(function* () {
        let file = 1;
        const written = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const state = yield* makeCommittedState({
          loadMayWrite: false,
          load: () => Effect.sync(() => file),
          write: (value: number) =>
            Effect.gen(function* () {
              file = value;
              yield* Deferred.succeed(written, undefined);
              yield* Deferred.await(release);
              return value;
            }),
          publishValue: (value) => value,
        });
        const received: number[] = [];
        yield* state.subscribe((value) => {
          received.push(value);
        });
        yield* state.get;
        const updating = yield* state
          .update(() => Effect.succeed(2))
          .pipe(Effect.forkChild);
        yield* Deferred.await(written);
        updating.interruptUnsafe();
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.await(updating)).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ _tag: "Interrupt" }] },
        });
        expect(received).toEqual([2]);
        yield* state.update((value) => Effect.succeed(value));
        expect(received).toEqual([2]);
      }),
  );

  it.effect(
    "keeps the file and memory aligned after an interrupted write",
    () =>
      Effect.gen(function* () {
        let file = 1;
        const written = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const state = yield* makeCommittedState({
          load: () => Effect.sync(() => file),
          loadMayWrite: false,
          write: (value: number) =>
            Effect.gen(function* () {
              file = value;
              yield* Deferred.succeed(written, undefined);
              yield* Deferred.await(release);
              return value;
            }),
          publishValue: (value) => value,
        });
        yield* state.get;
        const updating = yield* state
          .update(() => Effect.succeed(2))
          .pipe(Effect.forkChild);
        yield* Deferred.await(written);
        updating.interruptUnsafe();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(updating);
        expect([file, yield* state.get]).toEqual([2, 2]);
        yield* state.update((value) => Effect.succeed(value + 1));
        expect([file, yield* state.get]).toEqual([3, 3]);
      }),
  );

  it.effect(
    "leaves the cache empty after a failed modify and diagnoses the next read",
    () =>
      Effect.gen(function* () {
        let file = 1;
        const diagnostics: boolean[] = [];
        const state = yield* makeCommittedState({
          load: (options) =>
            Effect.sync(() => {
              diagnostics.push(options.diagnostics);
              return file;
            }),
          loadMayWrite: false,
          publishValue: (value) => value,
        });
        expect(
          yield* Effect.flip(state.update(() => Effect.fail("invalid"))),
        ).toBe("invalid");
        expect(yield* state.current).toBe(null);
        file = 2;
        expect(yield* state.get).toBe(2);
        file = 3;
        expect(yield* state.reload).toBe(3);
        expect(diagnostics).toEqual([false, true, true]);
      }),
  );

  it.effect("interrupts modify without writing and releases the lock", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writes: number[] = [];
      const received: number[] = [];
      const state = yield* makeCommittedState({
        loadMayWrite: false,
        load: () => Effect.succeed(1),
        write: (value: number) =>
          Effect.sync(() => {
            writes.push(value);
            return value;
          }),
        publishValue: (value) => value,
      });
      yield* state.get;
      yield* state.subscribe((value) => {
        received.push(value);
      });
      const updating = yield* state
        .update(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(99),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      updating.interruptUnsafe();
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.await(updating))._tag).toBe("Failure");
      expect(yield* state.get).toBe(1);
      expect(yield* state.current).toEqual({ value: 1, revision: 0 });
      yield* state.update(() => Effect.succeed(2));
      expect(writes).toEqual([2]);
      expect(received).toEqual([2]);
      expect(yield* state.get).toBe(2);
    }),
  );

  it.effect(
    "publishes overlapping commits in order and skips stale listeners",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const state = yield* makeCommittedState({
          loadMayWrite: false,
          load: () => Effect.succeed(0),
          publishValue: (value) => value,
        });
        const first: number[] = [];
        const second: number[] = [];
        yield* state.subscribe((value) =>
          Effect.gen(function* () {
            first.push(value);
            if (value === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
          }),
        );
        yield* state.subscribe((value) => {
          second.push(value);
        });
        const updating = yield* state
          .update(() => Effect.succeed(1))
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* state.update(() => Effect.succeed(2));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(updating);
        expect(first).toEqual([1, 2]);
        expect(second).toEqual([2]);
        expect(yield* state.current).toEqual({ value: 2, revision: 2 });
      }),
  );

  it.effect(
    "lets listeners start another update before returning outside the lock",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const modifying = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const state = yield* makeCommittedState({
          loadMayWrite: false,
          load: () => Effect.succeed(0),
          publishValue: (value) => value,
        });
        const received: number[] = [];
        let entered = false;
        let nested: Fiber.Fiber<number> | undefined;
        yield* state.subscribe((value) =>
          Effect.gen(function* () {
            received.push(value);
            if (value !== 1) return;
            nested = yield* state
              .update(() =>
                Deferred.succeed(modifying, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(2),
                ),
              )
              .pipe(Effect.forkIn(scope, { startImmediately: true }));
            entered = yield* Deferred.isDone(modifying);
            yield* Deferred.succeed(release, undefined);
            if (entered) yield* Fiber.join(nested);
          }),
        );
        expect(yield* state.update(() => Effect.succeed(1))).toBe(1);
        if (nested !== undefined) yield* Fiber.join(nested);
        expect(entered).toBe(true);
        expect(received).toEqual([1, 2]);
        expect(yield* state.get).toBe(2);
      }),
  );

  it.effect.each(["get", "reload"] as const)(
    "serializes a normalizing %s with updates",
    (operation) =>
      Effect.gen(function* () {
        let file = 1;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const history: string[] = [];
        const state = yield* makeCommittedState({
          loadMayWrite: true,
          load: () =>
            Effect.gen(function* () {
              const value = file;
              history.push(`load ${value}`);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              file = value;
              history.push(`normalize ${value}`);
              return value;
            }),
          write: (value: number) =>
            Effect.sync(() => {
              file = value;
              history.push(`write ${value}`);
              return value;
            }),
          publishValue: (value) => value,
        });
        const loading = yield* state[operation].pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const updating = yield* state
          .update((value) =>
            Effect.sync(() => {
              history.push(`modify ${value}`);
              return value + 1;
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(loading);
        yield* Fiber.join(updating);
        expect(history).toEqual([
          "load 1",
          "normalize 1",
          "modify 1",
          "write 2",
        ]);
        expect(file).toBe(2);
        expect(yield* state.get).toBe(2);
      }),
  );

  it.effect.each(["get", "reload"] as const)(
    "commits a normalizing %s even if its file rewrite interrupts it",
    (operation) =>
      Effect.gen(function* () {
        let file = " raw ";
        const state = yield* makeCommittedState({
          loadMayWrite: true,
          load: () =>
            Effect.withFiber((fiber) => {
              file = file.trim();
              fiber.interruptUnsafe();
              return Effect.succeed(file);
            }),
          write: (value: string) => Effect.succeed(value),
          publishValue: (value) => value,
        });
        const loading = yield* state[operation].pipe(Effect.forkChild);
        expect((yield* Fiber.await(loading))._tag).toBe("Failure");
        expect(file).toBe("raw");
        expect(yield* state.get).toBe("raw");
      }),
  );

  it.effect(
    "leaves revision, memory and publication unchanged on failed and equal saves",
    () =>
      Effect.gen(function* () {
        let file = 0;
        const state = yield* makeCommittedState({
          loadMayWrite: false,
          load: () => Effect.sync(() => file),
          write: (value: number) =>
            value === 9
              ? Effect.fail("write failed")
              : Effect.sync(() => {
                  file = value;
                  return value;
                }),
          publishValue: (value) => `saved ${value}`,
        });
        const received: string[] = [];
        yield* state.subscribe((value) => {
          received.push(value);
        });
        yield* state.update(() => Effect.succeed(1));
        expect(yield* Effect.flip(state.update(() => Effect.succeed(9)))).toBe(
          "write failed",
        );
        yield* state.update(() => Effect.succeed(1));
        expect(file).toBe(1);
        expect(yield* state.current).toEqual({ value: 1, revision: 1 });
        expect(received).toEqual(["saved 1"]);
      }),
  );

  it.effect("removes scoped subscriptions", () =>
    Effect.gen(function* () {
      const state = yield* makeCommittedState({
        loadMayWrite: false,
        load: () => Effect.succeed(0),
        publishValue: (value) => value,
      });
      const received: number[] = [];
      const scope = yield* Scope.make();
      yield* state
        .subscribe((value) => {
          received.push(value);
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* state.update(() => Effect.succeed(1));
      yield* Scope.close(scope, Exit.void);
      yield* state.update(() => Effect.succeed(2));
      expect(received).toEqual([1]);
      expect(yield* state.get).toBe(2);
    }),
  );

  it.effect(
    "interrupts a read-only reload without committing or publishing",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let block = false;
        const state = yield* makeCommittedState({
          loadMayWrite: false,
          load: () =>
            block
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                )
              : Effect.succeed(1),
          write: (value: number) => Effect.succeed(value),
          publishValue: (value) => value,
        });
        yield* state.get;
        const received: number[] = [];
        yield* state.subscribe((value) => {
          received.push(value);
        });
        block = true;
        const loading = yield* state.reload.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(loading);
        expect(yield* state.current).toEqual({ value: 1, revision: 0 });
        yield* state.update(() => Effect.succeed(2));
        expect(received).toEqual([2]);
      }),
  );
});

describe("CommittedPublication", () => {
  it.effect(
    "publishes a derived committed snapshot after interruption and skips old revisions",
    () =>
      Effect.gen(function* () {
        let revision = 1;
        const publication = makeCommittedPublication(
          Effect.sync(() => ({
            revision,
            value: { saved: "account", session: revision },
          })),
          (value) => value,
        );
        const received: { saved: string; session: number }[] = [];
        yield* publication.subscribe((value) => {
          received.push(value);
        });
        const changing = yield* publication
          .withPublication(Effect.interrupt)
          .pipe(Effect.forkChild);
        yield* Fiber.await(changing);
        yield* publication.withPublication(Effect.void);
        revision = 2;
        yield* publication.withPublication(Effect.void);
        revision = 1;
        yield* publication.withPublication(Effect.void);
        expect(received).toEqual([
          { saved: "account", session: 1 },
          { saved: "account", session: 2 },
        ]);
      }),
  );
});
