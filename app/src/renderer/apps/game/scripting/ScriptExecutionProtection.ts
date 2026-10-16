import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { selectDesktopBridge } from "../../../../shared/desktopBridge";
import { ScriptExecutionError } from "./ScriptRunnerErrors";

const beginScriptExecution = (): Effect.Effect<number, ScriptExecutionError> =>
  Effect.tryPromise({
    try: () =>
      selectDesktopBridge(
        window.desktop,
        "game",
      ).gameRenderer.beginScriptExecution(),
    catch: (cause) =>
      new ScriptExecutionError({
        cause,
        detail: "Unable to arm recovery for this script.",
      }),
  });

const finishScriptExecution = (token: number): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () =>
      selectDesktopBridge(
        window.desktop,
        "game",
      ).gameRenderer.finishScriptExecution(token),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "Failed to disarm script renderer recovery.",
        Cause.fail(cause),
      ).pipe(Effect.annotateLogs({ component: "scripting" })),
    ),
  );

export const protectScriptExecution = <A, E, R>(
  execution: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ScriptExecutionError, R> =>
  Effect.acquireUseRelease(
    beginScriptExecution(),
    () => execution,
    finishScriptExecution,
  );

/** Keeps recovery armed for a run after its asynchronous start call returns. */
export const protectScriptExecutionUntil = (
  terminal: Effect.Effect<unknown, unknown>,
): Effect.Effect<void, ScriptExecutionError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const token = yield* beginScriptExecution();
      yield* terminal.pipe(
        Effect.ensuring(finishScriptExecution(token)),
        Effect.forkDetach,
      );
    }),
  );
