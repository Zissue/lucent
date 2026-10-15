import * as Effect from "effect/Effect";

import { logFailure } from "../../shared/logFailure";

export type Listener<Value> = (
  value: Value,
) => void | Effect.Effect<void, unknown>;

export interface ListenerRegistry<Value> {
  readonly publishLatest: (
    revision: number,
    value: Value,
  ) => Effect.Effect<void>;
  readonly publish: (
    value: Value,
    concurrency?: 1 | "unbounded",
  ) => Effect.Effect<void>;
  readonly subscribe: (listener: Listener<Value>) => Effect.Effect<() => void>;
}

export const makeListenerRegistry = <Value>(
  options: { readonly concurrency?: 1 | "unbounded" } = {},
): ListenerRegistry<Value> => {
  const listeners = new Set<Listener<Value>>();

  const publish: ListenerRegistry<Value>["publish"] = (
    value,
    concurrency = options.concurrency,
  ) =>
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
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });

  return {
    publishLatest: (_revision, value) => publish(value),
    publish,
    subscribe,
  };
};
