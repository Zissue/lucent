import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { makeListenerRegistry } from "./ListenerRegistry";

export interface CommittedValue<Value> {
  readonly value: Value;
  readonly revision: number;
}

export const makeCommittedPublication = <Value, Published>(
  current: Effect.Effect<CommittedValue<Value> | null>,
  publishValue: (value: Value) => Published,
) => {
  const listeners = makeListenerRegistry<Published>();
  const publishCurrent = current.pipe(
    Effect.flatMap((snapshot) =>
      snapshot === null || snapshot.revision === 0
        ? Effect.void
        : listeners.publishLatest(
            snapshot.revision,
            publishValue(snapshot.value),
          ),
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
  Error,
  Published,
>(options: {
  readonly load: (options: LoadOptions) => Effect.Effect<Value, Error>;
  readonly loadMayWrite: boolean;
  readonly write?: (value: Value) => Effect.Effect<Value, Error>;
  readonly publishValue: (value: Value) => Published;
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
  const publication = makeCommittedPublication(current, options.publishValue);

  const read = (
    loadOptions: LoadOptions,
    restore: (
      effect: Effect.Effect<Value, Error>,
    ) => Effect.Effect<Value, Error>,
  ) =>
    options.loadMayWrite
      ? options.load(loadOptions)
      : restore(options.load(loadOptions));

  const readCurrent = Effect.fnUntraced(function* (
    loadOptions: LoadOptions,
    restore: (
      effect: Effect.Effect<Value, Error>,
    ) => Effect.Effect<Value, Error>,
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
  ).pipe(Semaphore.withPermit(commitLock), publication.withPublication);

  const update = <E, R>(modify: (value: Value) => Effect.Effect<Value, E, R>) =>
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
    ).pipe(Semaphore.withPermit(commitLock), publication.withPublication);

  return { get, current, reload, update, subscribe: publication.subscribe };
});
