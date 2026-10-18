import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { logFailure } from "../../shared/logFailure";

export type Listener<Value> = (
  value: Value,
) => void | Effect.Effect<void, unknown>;

export interface ListenerRegistry<Value> {
  readonly publish: (
    value: Value,
    concurrency?: 1 | "unbounded",
  ) => Effect.Effect<void>;
  readonly subscribe: (
    listener: Listener<Value>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export const makeListenerRegistry = <Value>(): ListenerRegistry<Value> => {
  const listeners = new Set<Listener<Value>>();

  const publish = (value: Value, concurrency?: 1 | "unbounded") =>
    Effect.forEach(
      [...listeners],
      (listener) =>
        Effect.suspend(() => {
          const result = listener(value);
          return Effect.isEffect(result) ? result : Effect.void;
        }).pipe(
          Effect.catchCause((cause) =>
            logFailure("Event listener failed", cause, { failure: "error" }),
          ),
        ),
      { concurrency, discard: true },
    );

  const subscribe: ListenerRegistry<Value>["subscribe"] = (listener) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        listeners.add(listener);
      }),
      () =>
        Effect.sync(() => {
          listeners.delete(listener);
        }),
    );

  return {
    publish,
    subscribe,
  };
};
