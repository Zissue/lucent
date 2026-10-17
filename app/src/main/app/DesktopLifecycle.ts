import type { EventEmitter } from "events";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { DesktopObservability } from "./observability/DesktopObservability";
import { ElectronApp } from "../electron/ElectronApp";

const QUIT_DEADLINE_MS = 1_500;
const FORCED_EXIT_FLUSH_TIMEOUT_MS = 250;
const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

export type QuitSource = "will-quit" | (typeof TERMINATION_SIGNALS)[number];

export interface DesktopLifecycleShape {
  readonly awaitQuit: Effect.Effect<QuitSource>;
  readonly isForcedExit: Effect.Effect<boolean>;
  readonly isQuitting: Effect.Effect<boolean>;
  readonly attachObservability: Effect.Effect<
    void,
    never,
    DesktopObservability
  >;
  readonly register: Effect.Effect<void, never, Scope.Scope | ElectronApp>;
}

export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  DesktopLifecycleShape
>()("lucent/desktop/app/DesktopLifecycle") {}

// Use `on` so a repeated signal cannot reach Node's default handler during cleanup.
const addProcessSignalListener = (
  signal: NodeJS.Signals,
  listener: () => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      (process as EventEmitter).on(signal, listener);
    }),
    () =>
      Effect.sync(() => {
        (process as EventEmitter).removeListener(signal, listener);
      }),
  ).pipe(Effect.asVoid);

export const layer = Layer.effect(
  DesktopLifecycle,
  Effect.gen(function* () {
    const quitRequested = yield* Deferred.make<QuitSource>();
    let isQuitting = false;
    let isForcedExit = false;
    let diagnosticContext = Context.empty();
    let flush = Effect.void;

    const attachObservability = Effect.gen(function* () {
      const observability = yield* DesktopObservability;
      diagnosticContext = yield* Effect.context();
      flush = observability
        .setSessionStop(undefined)
        .pipe(Effect.andThen(observability.flush));
    });

    const register = Effect.gen(function* () {
      const app = yield* ElectronApp;
      const context = yield* Effect.context<Scope.Scope | ElectronApp>();
      diagnosticContext = context;
      const runFork = Effect.runForkWith(context);
      let deadline: NodeJS.Timeout | undefined;

      const forcedExit = (source: QuitSource): Effect.Effect<void> =>
        Effect.logError("Lucent quit timed out; forcing exit").pipe(
          Effect.annotateLogs({
            component: "lifecycle",
            data: { source, timeoutMs: QUIT_DEADLINE_MS },
          }),
          Effect.andThen(flush),
          Effect.provideContext(diagnosticContext),
          Effect.timeoutOption(FORCED_EXIT_FLUSH_TIMEOUT_MS),
          Effect.asVoid,
          Effect.ensuring(app.exit(0)),
        );

      const beginShutdown = (source: QuitSource): boolean => {
        isQuitting = true;
        if (deadline !== undefined) {
          return false;
        }
        deadline = setTimeout(() => {
          isForcedExit = true;
          runFork(forcedExit(source));
        }, QUIT_DEADLINE_MS);
        deadline.unref?.();
        return true;
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearTimeout(deadline);
        }),
      );

      const disposeBeforeQuit = yield* app.on("before-quit", () => {
        isQuitting = true;
      });
      yield* Effect.addFinalizer(() => Effect.sync(disposeBeforeQuit));

      const disposeWillQuit = yield* app.on("will-quit", (event) => {
        event.preventDefault();
        beginShutdown("will-quit");
        Deferred.doneUnsafe(quitRequested, Effect.succeed("will-quit"));
      });
      yield* Effect.addFinalizer(() => Effect.sync(disposeWillQuit));

      const disposeWindowAllClosed = yield* app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
          runFork(app.quit);
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(disposeWindowAllClosed));

      const signalListeners = TERMINATION_SIGNALS.map((signal) => ({
        signal,
        listener: () => {
          if (!beginShutdown(signal)) {
            return;
          }
          Deferred.doneUnsafe(quitRequested, Effect.succeed(signal));
          runFork(app.quit);
        },
      }));
      for (const { signal, listener } of signalListeners) {
        yield* addProcessSignalListener(signal, listener);
      }
      yield* app.whenReady.pipe(
        Effect.andThen(
          Effect.sync(() => {
            for (const { signal, listener } of signalListeners) {
              (process as EventEmitter).removeListener(signal, listener);
              (process as EventEmitter).on(signal, listener);
            }
          }),
        ),
        Effect.forkScoped,
      );
    });

    const awaitQuit: DesktopLifecycleShape["awaitQuit"] =
      Deferred.await(quitRequested);

    return DesktopLifecycle.of({
      awaitQuit,
      isForcedExit: Effect.sync(() => isForcedExit),
      isQuitting: Effect.sync(() => isQuitting),
      attachObservability,
      register,
    });
  }),
);
