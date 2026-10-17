import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { makeListenerRegistry } from "./ListenerRegistry";

export interface CommittedValue<Value> {
  readonly value: Value;
  readonly revision: number;
}

export const makeCommittedPublication = <Value>(
  current: Effect.Effect<CommittedValue<Value> | null>,
) => {
  const listeners = makeListenerRegistry<Value>();
  const publishCurrent = current.pipe(
    Effect.flatMap((snapshot) =>
      snapshot === null || snapshot.revision === 0
        ? Effect.void
        : listeners.publishLatest(snapshot.revision, snapshot.value),
    ),
  );

  return {
    subscribe: listeners.subscribe,
    withPublication: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.ensuring(publishCurrent)),
  };
};

interface LoadOptions {
  readonly diagnostics: boolean;
}

export const makeCommittedState = Effect.fnUntraced(function* <
  Value,
  E,
>(options: {
  readonly load: (options: LoadOptions) => Effect.Effect<Value, E>;
  readonly loadMayWrite: boolean;
  readonly write?: (value: Value) => Effect.Effect<Value, E>;
  readonly equivalent?: (previous: Value, next: Value) => boolean;
  readonly shouldPublishReload?: (
    previous: Value | null,
    next: Value,
  ) => boolean;
}) {
  const state = yield* Ref.make<CommittedValue<Value> | null>(null);
  const commitLock = yield* Semaphore.make(1);
  const equivalent = options.equivalent ?? Object.is;
  const current = Ref.get(state);

  const read = (
    loadOptions: LoadOptions,
    restore: (effect: Effect.Effect<Value, E>) => Effect.Effect<Value, E>,
  ) =>
    options.loadMayWrite
      ? options.load(loadOptions)
      : restore(options.load(loadOptions));

  const readCurrent = Effect.fnUntraced(function* (
    loadOptions: LoadOptions,
    restore: (effect: Effect.Effect<Value, E>) => Effect.Effect<Value, E>,
  ) {
    const loaded = yield* current;
    if (loaded !== null) return loaded;
    return { value: yield* read(loadOptions, restore), revision: 0 };
  });

  const get = current.pipe(
    Effect.flatMap((snapshot) =>
      snapshot !== null
        ? Effect.succeed(snapshot.value)
        : Effect.uninterruptibleMask((restore) =>
            readCurrent({ diagnostics: true }, restore).pipe(
              Effect.tap((loaded) => Ref.set(state, loaded)),
            ),
          ).pipe(
            Semaphore.withPermit(commitLock),
            Effect.map((loaded) => loaded.value),
          ),
    ),
  );

  const reload = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const previous = yield* current;
      const value = yield* read({ diagnostics: true }, restore);
      const changed =
        options.shouldPublishReload?.(previous?.value ?? null, value) ?? true;
      yield* Ref.set(state, {
        value,
        revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
      });
      return value;
    }),
  ).pipe(Semaphore.withPermit(commitLock));

  const update = <E2, R>(
    modify: (value: Value) => Effect.Effect<Value, E2, R>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const previous = yield* readCurrent({ diagnostics: false }, restore);
        const next = yield* restore(
          Effect.suspend(() => modify(previous.value)),
        );
        if (equivalent(previous.value, next)) {
          yield* Ref.set(state, previous);
          return previous.value;
        }
        const value =
          options.write === undefined ? next : yield* options.write(next);
        yield* Ref.set(state, { value, revision: previous.revision + 1 });
        return value;
      }),
    ).pipe(Semaphore.withPermit(commitLock));

  const publication = makeCommittedPublication(current);
  return {
    get,
    current,
    currentUnsafe: () => Ref.getUnsafe(state),
    reload: publication.withPublication(reload),
    update: <E2, R>(modify: (value: Value) => Effect.Effect<Value, E2, R>) =>
      publication.withPublication(update(modify)),
    subscribe: publication.subscribe,
  };
});
