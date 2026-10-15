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

type QuitSource = "will-quit" | (typeof TERMINATION_SIGNALS)[number];

export interface DesktopLifecycleShape {
  readonly awaitQuit: Effect.Effect<void>;
  readonly isQuitting: Effect.Effect<boolean>;
  readonly register: Effect.Effect<
    void,
    never,
    DesktopObservability | Scope.Scope | ElectronApp
  >;
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

export const provideInsideQuitGuard =
  <ROut, LayerError>(layer: Layer.Layer<ROut, LayerError>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(layer), Effect.scoped);

export const layer = Layer.effect(
  DesktopLifecycle,
  Effect.gen(function* () {
    const quitRequested = yield* Deferred.make<void>();
    let isQuitting = false;

    const register = Effect.gen(function* () {
      const app = yield* ElectronApp;
      const observability = yield* DesktopObservability;
      const context = yield* Effect.context<
        DesktopObservability | Scope.Scope | ElectronApp
      >();
      const runFork = Effect.runForkWith(context);
      let deadline: NodeJS.Timeout | undefined;

      const forcedExit = (source: QuitSource): Effect.Effect<void> =>
        Effect.logError("Lucent quit timed out; forcing exit").pipe(
          Effect.annotateLogs({
            component: "lifecycle",
            data: { source, timeoutMs: QUIT_DEADLINE_MS },
          }),
          Effect.andThen(observability.flush),
          Effect.timeoutOption(FORCED_EXIT_FLUSH_TIMEOUT_MS),
          Effect.asVoid,
          Effect.ensuring(app.exit(0)),
        );

      const beginShutdown = (source: QuitSource): boolean => {
        isQuitting = true;
        if (deadline !== undefined) {
          return false;
        }
        deadline = setTimeout(
          () => runFork(forcedExit(source)),
          QUIT_DEADLINE_MS,
        );
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
        Deferred.doneUnsafe(quitRequested, Effect.void);
      });
      yield* Effect.addFinalizer(() => Effect.sync(disposeWillQuit));

      const disposeWindowAllClosed = yield* app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
          runFork(app.quit);
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(disposeWindowAllClosed));

      for (const signal of TERMINATION_SIGNALS) {
        yield* addProcessSignalListener(signal, () => {
          if (!beginShutdown(signal)) {
            return;
          }
          runFork(
            Effect.logWarning("Received termination signal").pipe(
              Effect.annotateLogs({ component: "lifecycle", data: { signal } }),
            ),
          );
          runFork(app.quit);
        });
      }
    });

    const awaitQuit: DesktopLifecycleShape["awaitQuit"] =
      Deferred.await(quitRequested);

    return DesktopLifecycle.of({
      awaitQuit,
      isQuitting: Effect.sync(() => isQuitting),
      register,
    });
  }),
);
