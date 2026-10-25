import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeCommittedState } from "./CommittedState";

describe("CommittedState", () => {
  it.effect("writes, remembers, and notifies an update once", () =>
    Effect.gen(function* () {
      let file = 1;
      const writes: number[] = [];
      const received: number[] = [];
      const state = yield* makeCommittedState({
        load: () => Effect.sync(() => file),
        write: (value: number) =>
          Effect.sync(() => {
            writes.push(value);
            file = value;
            return value;
          }),
      });
      yield* state.subscribe((value) => {
        received.push(value);
      });
      expect(yield* state.update(() => Effect.succeed(2))).toBe(2);
      expect(file).toBe(2);
      expect(yield* state.get).toBe(2);
      expect(writes).toEqual([2]);
      expect(received).toEqual([2]);
    }),
  );

  it.effect("finishes an interrupted update before releasing its caller", () =>
    Effect.gen(function* () {
      let file = 1;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const received: number[] = [];
      const state = yield* makeCommittedState({
        load: () => Effect.sync(() => file),
        write: (value: number) =>
          Effect.sync(() => {
            file = value;
            return value;
          }),
      });
      yield* state.subscribe((value) => {
        received.push(value);
      });
      const updating = yield* state
        .update(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(2),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const interrupting = yield* Fiber.interrupt(updating).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const beforeRelease = interrupting.pollUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      expect(beforeRelease).toBeUndefined();
      expect(yield* Fiber.await(updating)).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ _tag: "Interrupt" }] },
      });
      expect(file).toBe(2);
      expect(yield* state.get).toBe(2);
      expect(received).toEqual([2]);
    }),
  );

  it.effect("notifies overlapping updates in commit order", () =>
    Effect.gen(function* () {
      let file = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first: number[] = [];
      const second: number[] = [];
      const state = yield* makeCommittedState({
        load: () => Effect.sync(() => file),
        write: (value: number) =>
          Effect.sync(() => {
            file = value;
            return value;
          }),
      });
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
        .update((value) => Effect.succeed(value + 1))
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const overlapping = yield* state
        .update((value) => Effect.succeed(value + 1))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(updating);
      yield* Fiber.join(overlapping);
      expect(first).toEqual([1, 2]);
      expect(second).toEqual([1, 2]);
      expect(file).toBe(2);
      expect(yield* state.get).toBe(2);
    }),
  );

  it.effect(
    "leaves file, memory, and listeners unchanged after a failed write",
    () =>
      Effect.gen(function* () {
        let file = 1;
        const received: number[] = [];
        const state = yield* makeCommittedState({
          load: () => Effect.sync(() => file),
          write: (value: number) =>
            value === 2
              ? Effect.fail("write failed")
              : Effect.sync(() => {
                  file = value;
                  return value;
                }),
        });
        yield* state.get;
        yield* state.subscribe((value) => {
          received.push(value);
        });
        expect(yield* Effect.flip(state.update(() => Effect.succeed(2)))).toBe(
          "write failed",
        );
        expect(file).toBe(1);
        expect(yield* state.get).toBe(1);
        expect(received).toEqual([]);
      }),
  );

  it.effect(
    "loads once for overlapping first reads and diagnoses reloads",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const diagnostics: boolean[] = [];
        let file = 1;
        const state = yield* makeCommittedState({
          load: (options) =>
            Effect.gen(function* () {
              diagnostics.push(options.diagnostics);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return file;
            }),
        });
        const received: number[] = [];
        yield* state.subscribe((value) => {
          received.push(value);
        });
        const first = yield* state.get.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* state.get.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toBe(1);
        expect(yield* Fiber.join(second)).toBe(1);
        file = 2;
        expect(yield* state.get).toBe(1);
        expect(diagnostics).toEqual([true]);
        expect(received).toEqual([]);
        expect(yield* state.reload).toBe(2);
        expect(yield* state.reload).toBe(2);
        expect(received).toEqual([2, 2]);
        expect(diagnostics).toEqual([true, true, true]);
      }),
  );

  it.effect("skips writes and notifications for equivalent updates", () =>
    Effect.gen(function* () {
      const diagnostics: boolean[] = [];
      const writes: number[] = [];
      const received: number[] = [];
      const state = yield* makeCommittedState({
        load: (options) =>
          Effect.sync(() => {
            diagnostics.push(options.diagnostics);
            return { count: 1 };
          }),
        write: (value: { count: number }) =>
          Effect.sync(() => {
            writes.push(value.count);
            return value;
          }),
        equivalent: (previous, next) => previous.count === next.count,
      });
      yield* state.subscribe((value) => {
        received.push(value.count);
      });
      expect(yield* state.update(() => Effect.succeed({ count: 1 }))).toEqual({
        count: 1,
      });
      expect(yield* state.get).toEqual({ count: 1 });
      expect(diagnostics).toEqual([false]);
      expect(writes).toEqual([]);
      expect(received).toEqual([]);
    }),
  );
});

it.effect("lets a listener get its store's committed value", () =>
  Effect.gen(function* () {
    const received: number[] = [];
    const read: number[] = [];
    const state = yield* makeCommittedState({
      load: () => Effect.succeed(1),
    });
    yield* state.subscribe((value) =>
      Effect.gen(function* () {
        received.push(value);
        read.push(yield* state.get);
      }),
    );
    expect(yield* state.update(() => Effect.succeed(2))).toBe(2);
    expect(received).toEqual([2]);
    expect(read).toEqual([2]);
  }),
);

it.effect(
  "finishes a cold load and its update before releasing an interrupted caller",
  () =>
    Effect.gen(function* () {
      let file = 1;
      let loaded = false;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writes: number[] = [];
      const received: number[] = [];
      const state = yield* makeCommittedState({
        load: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            loaded = true;
            return file;
          }),
        write: (value: number) =>
          Effect.sync(() => {
            writes.push(value);
            file = value;
            return value;
          }),
      });
      yield* state.subscribe((value) => {
        received.push(value);
      });
      const updating = yield* state
        .update(() => Effect.succeed(2))
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const interrupting = yield* Fiber.interrupt(updating).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const beforeRelease = interrupting.pollUnsafe();
      const loadedBeforeRelease = loaded;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      expect(beforeRelease).toBeUndefined();
      expect(loadedBeforeRelease).toBe(false);
      expect(loaded).toBe(true);
      expect(file).toBe(2);
      expect(writes).toEqual([2]);
      expect(received).toEqual([2]);
      expect(yield* state.get).toBe(2);
      expect(yield* state.update(() => Effect.succeed(3))).toBe(3);
      expect(file).toBe(3);
      expect(yield* state.get).toBe(3);
      expect(writes).toEqual([2, 3]);
      expect(received).toEqual([2, 3]);
    }),
);

it.effect("keeps a cold store unloaded after modify fails", () =>
  Effect.gen(function* () {
    let file = 1;
    const diagnostics: boolean[] = [];
    const state = yield* makeCommittedState({
      load: (options) =>
        Effect.sync(() => {
          diagnostics.push(options.diagnostics);
          return file;
        }),
    });
    expect(
      yield* Effect.flip(state.update(() => Effect.fail("modify failed"))),
    ).toBe("modify failed");
    expect(state.current()).toBeNull();
    expect(diagnostics).toEqual([false]);
    file = 2;
    expect(yield* state.get).toBe(2);
    expect(diagnostics).toEqual([false, true]);
  }),
);
