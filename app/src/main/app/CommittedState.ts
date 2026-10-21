import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { makeListenerRegistry } from "./ListenerRegistry";

interface LoadOptions {
  readonly diagnostics: boolean;
}

export const makeCommittedState = Effect.fnUntraced(function* <
  Value,
  E,
>(options: {
  readonly load: (options: LoadOptions) => Effect.Effect<Value, E>;
  readonly write?: (value: Value) => Effect.Effect<Value, E>;
  readonly equivalent?: (previous: Value, next: Value) => boolean;
}) {
  let current: Value | null = null;
  const lock = yield* Semaphore.make(1);
  const listeners = makeListenerRegistry<Value>();
  const equivalent = options.equivalent ?? Object.is;
  const locked = <A, E2, R>(effect: Effect.Effect<A, E2, R>) =>
    effect.pipe(Effect.uninterruptible, Semaphore.withPermit(lock));

  const get = Effect.suspend(() =>
    current !== null
      ? Effect.succeed(current)
      : locked(
          Effect.gen(function* () {
            if (current === null)
              current = yield* options.load({ diagnostics: true });
            return current;
          }),
        ),
  );

  const reload = locked(
    Effect.gen(function* () {
      const next = yield* options.load({ diagnostics: true });
      current = next;
      yield* listeners.publish(next);
      return next;
    }),
  );

  const update = <E2, R>(
    modify: (value: Value) => Effect.Effect<Value, E2, R>,
  ) =>
    locked(
      Effect.gen(function* () {
        const previous =
          current ?? (yield* options.load({ diagnostics: false }));
        const next = yield* modify(previous);
        if (equivalent(previous, next)) {
          current = previous;
          return previous;
        }
        const value =
          options.write === undefined ? next : yield* options.write(next);
        current = value;
        yield* listeners.publish(value);
        return value;
      }),
    );

  return {
    get,
    current: () => current,
    reload,
    update,
    subscribe: listeners.subscribe,
  };
});
