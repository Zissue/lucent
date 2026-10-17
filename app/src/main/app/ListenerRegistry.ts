import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

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
  readonly subscribe: (
    listener: Listener<Value>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export const makeListenerRegistry = <Value>(
  options: { readonly concurrency?: 1 | "unbounded" } = {},
): ListenerRegistry<Value> => {
  const listeners = new Set<Listener<Value>>();
  let lastDeliveredRevision = -Infinity;

  const publish = (
    value: Value,
    concurrency: 1 | "unbounded" | undefined = options.concurrency,
    revision?: number,
  ) =>
    Effect.forEach(
      [...listeners],
      (listener) =>
        Effect.suspend(() => {
          if (revision !== undefined && revision < lastDeliveredRevision) {
            return Effect.void;
          }
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
    publishLatest: (revision, value) =>
      Effect.suspend(() => {
        if (revision <= lastDeliveredRevision) return Effect.void;
        lastDeliveredRevision = revision;
        return publish(value, options.concurrency, revision);
      }),
    publish,
    subscribe,
  };
};
