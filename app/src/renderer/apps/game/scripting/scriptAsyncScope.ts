import * as Effect from "effect/Effect";

export type ScriptCleanup = () => void | Effect.Effect<void, unknown>;

export interface ScriptAsyncScope {
  readonly addCleanup: (cleanup: ScriptCleanup) => Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}

const runCleanup = (cleanup: ScriptCleanup): Effect.Effect<void> =>
  Effect.suspend(() => {
    const result = cleanup();
    return Effect.isEffect(result) ? result.pipe(Effect.asVoid) : Effect.void;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("script cleanup failed", cause).pipe(
        Effect.annotateLogs({ component: "scripting" }),
      ),
    ),
  );

export const makeScriptAsyncScope = (): ScriptAsyncScope => {
  const controller = new AbortController();
  const cleanups = new Set<ScriptCleanup>();

  const cancel = Effect.sync(() => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  });

  const close = Effect.gen(function* () {
    yield* cancel;
    const pending = Array.from(cleanups).reverse();
    cleanups.clear();
    yield* Effect.forEach(pending, runCleanup, { discard: true });
  });

  return {
    addCleanup: (cleanup) =>
      Effect.suspend(() => {
        if (controller.signal.aborted) {
          return runCleanup(cleanup);
        }

        cleanups.add(cleanup);
        return Effect.void;
      }),
    cancel,
    close,
    controller,
    signal: controller.signal,
  };
};
