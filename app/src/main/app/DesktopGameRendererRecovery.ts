import * as Cause from "effect/Cause";
import {
  app,
  webContents,
  type Event as ElectronEvent,
  type RenderProcessGoneDetails,
  type WebContents,
} from "electron";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { Accounts } from "../internal/accounts/Accounts";
import { ElectronDialog } from "../electron/ElectronDialog";
import { DesktopWindows } from "../window/DesktopWindows";
import { logFailure } from "../../shared/logFailure";

const RECOVERY_MESSAGE =
  "The client was reloaded because the script stopped responding.";
const RENDERER_RECOVERY_MESSAGE = "The client was reloaded after it crashed.";
const CLIENT_RELOAD_DETAIL =
  "Only that client will reload. Any running script will stop and won't run automatically.";

interface RecoverableGameCrash {
  readonly generation: number;
  readonly reason: RenderProcessGoneDetails["reason"];
  readonly scriptWasRunning: boolean;
}

interface RecoveryAttempt {
  readonly target: RecoverableGameWebContents;
  readonly generation: number;
  readonly parentWindowId: number;
}

const isRecoverableRendererCrash = (
  reason: RenderProcessGoneDetails["reason"],
): boolean =>
  reason === "abnormal-exit" ||
  reason === "crashed" ||
  reason === "killed" ||
  reason === "oom";

export type RecoverableGameWebContents = Pick<
  WebContents,
  | "forcefullyCrashRenderer"
  | "getOSProcessId"
  | "id"
  | "isDestroyed"
  | "on"
  | "once"
  | "reload"
  | "removeListener"
>;

export interface DesktopGameRendererRecoveryDependencies {
  readonly allWebContents: () => readonly RecoverableGameWebContents[];
  readonly describe: DesktopWindows["Service"]["describe"];
  readonly onWebContentsCreated: (
    listener: (contents: RecoverableGameWebContents) => void,
  ) => () => void;
  readonly onBeforeQuit: (listener: () => void) => () => void;
  readonly showRecoveryPrompt: (
    parentWindowId: number | undefined,
  ) => Effect.Effect<number, unknown>;
  readonly showRendererRecoveryPrompt: (
    parentWindowId: number | undefined,
  ) => Effect.Effect<number, unknown>;
  readonly suppressLaunchScript: (
    rendererId: number,
    message: string,
  ) => Effect.Effect<void, unknown>;
  readonly warn: (message: string, data?: unknown) => Effect.Effect<void>;
  readonly error: (
    message: string,
    cause: Cause.Cause<unknown>,
    data?: unknown,
  ) => Effect.Effect<void>;
  readonly info: (message: string, data?: unknown) => Effect.Effect<void>;
}

export interface DesktopGameRendererRecoveryShape {
  readonly beginScriptExecution: (rendererId: number) => Effect.Effect<number>;
  readonly finishScriptExecution: (
    rendererId: number,
    token: number,
  ) => Effect.Effect<void>;
  readonly install: Effect.Effect<void, never, Scope.Scope>;
}

export class DesktopGameRendererRecovery extends Context.Service<
  DesktopGameRendererRecovery,
  DesktopGameRendererRecoveryShape
>()("lucent/desktop/app/DesktopGameRendererRecovery") {}

const isExclusiveRendererProcess = (
  target: RecoverableGameWebContents,
  allWebContents: () => readonly RecoverableGameWebContents[],
): boolean => {
  try {
    if (target.isDestroyed()) return false;
    const processId = target.getOSProcessId();
    if (processId <= 0) return false;

    return allWebContents().every((contents) => {
      if (contents.id === target.id || contents.isDestroyed()) return true;
      return contents.getOSProcessId() !== processId;
    });
  } catch {
    return false;
  }
};

export const makeDesktopGameRendererRecovery = (
  dependencies: DesktopGameRendererRecoveryDependencies,
): DesktopGameRendererRecovery["Service"] => {
  const attempts = new Map<number, RecoveryAttempt>();
  const executions = new Map<number, Set<number>>();
  const intentionalRendererCrashes = new Set<number>();
  const observedContents = new Map<number, () => void>();
  const recoverableCrashes = new Map<number, RecoverableGameCrash>();
  const unresponsiveRenderers = new Set<number>();
  let appIsQuitting = false;
  let nextToken = 0;

  const hasActiveExecution = (rendererId: number): boolean =>
    (executions.get(rendererId)?.size ?? 0) > 0;

  const clearRenderer = (rendererId: number): void => {
    attempts.delete(rendererId);
    executions.delete(rendererId);
    recoverableCrashes.delete(rendererId);
    unresponsiveRenderers.delete(rendererId);
  };

  const isCurrent = (attempt: RecoveryAttempt): Effect.Effect<boolean> =>
    Effect.map(
      dependencies.describe(attempt.target.id),
      (info) =>
        !appIsQuitting &&
        !attempt.target.isDestroyed() &&
        attempts.get(attempt.target.id) === attempt &&
        info?.generation === attempt.generation,
    );

  const canRecoverUnresponsive = (
    attempt: RecoveryAttempt,
  ): Effect.Effect<boolean> =>
    Effect.map(
      isCurrent(attempt),
      (current) =>
        current &&
        unresponsiveRenderers.has(attempt.target.id) &&
        hasActiveExecution(attempt.target.id) &&
        isExclusiveRendererProcess(attempt.target, dependencies.allWebContents),
    );

  const beginScriptExecution: DesktopGameRendererRecoveryShape["beginScriptExecution"] =
    (rendererId) =>
      Effect.sync(() => {
        nextToken += 1;
        const active = executions.get(rendererId) ?? new Set<number>();
        active.add(nextToken);
        executions.set(rendererId, active);
        return nextToken;
      });

  const finishScriptExecution: DesktopGameRendererRecoveryShape["finishScriptExecution"] =
    (rendererId, token) =>
      Effect.sync(() => {
        const active = executions.get(rendererId);
        active?.delete(token);
        if (active?.size === 0) executions.delete(rendererId);
      });

  const offerUnresponsiveRecovery = (attempt: RecoveryAttempt) =>
    Effect.gen(function* () {
      const { target } = attempt;
      const rendererId = target.id;

      if (!isExclusiveRendererProcess(target, dependencies.allWebContents)) {
        yield* dependencies.warn(
          "Refused to recover an unresponsive game renderer because its process is shared",
          { rendererId },
        );
        return;
      }

      const response = yield* dependencies.showRecoveryPrompt(
        attempt.parentWindowId,
      );
      if (response !== 0 || !(yield* canRecoverUnresponsive(attempt))) return;

      yield* dependencies
        .suppressLaunchScript(rendererId, RECOVERY_MESSAGE)
        .pipe(
          Effect.catch((cause) =>
            dependencies.error(
              "Failed to suppress a script before renderer recovery",
              Cause.fail(cause),
              { rendererId },
            ),
          ),
        );
      if (!(yield* canRecoverUnresponsive(attempt))) return;
      clearRenderer(rendererId);
      intentionalRendererCrashes.add(rendererId);
      target.forcefullyCrashRenderer();
      // Electron documents this immediate reload sequence for recovering an
      // unresponsive renderer after the process has been forcefully ended.
      target.reload();
      yield* dependencies.info("Recovered an unresponsive game renderer", {
        rendererId,
      });
    });

  const offerCrashRecovery = (
    attempt: RecoveryAttempt,
    crash: RecoverableGameCrash,
  ) =>
    Effect.gen(function* () {
      const { target } = attempt;
      const rendererId = target.id;

      yield* dependencies.warn("Game renderer crashed", {
        reason: crash.reason,
        rendererId,
      });

      const response = yield* dependencies.showRendererRecoveryPrompt(
        attempt.parentWindowId,
      );
      if (response !== 0 || !(yield* isCurrent(attempt))) return;

      if (crash.scriptWasRunning) {
        yield* dependencies
          .suppressLaunchScript(rendererId, RENDERER_RECOVERY_MESSAGE)
          .pipe(
            Effect.catch((cause) =>
              dependencies.error(
                "Failed to suppress a script before renderer crash recovery",
                Cause.fail(cause),
                { rendererId },
              ),
            ),
          );
        if (!(yield* isCurrent(attempt))) return;
      }
      clearRenderer(rendererId);
      target.reload();
      yield* dependencies.info("Recovered a crashed game renderer", {
        reason: crash.reason,
        rendererId,
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (recoverableCrashes.get(attempt.target.id) === crash) {
            recoverableCrashes.delete(attempt.target.id);
          }
        }),
      ),
    );

  const install = Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const unsubscribeBeforeQuit = dependencies.onBeforeQuit(() => {
      appIsQuitting = true;
    });

    const observe = (contents: RecoverableGameWebContents): void => {
      if (observedContents.has(contents.id)) return;

      const startAttempt = (
        failure: string,
        offer: (
          attempt: RecoveryAttempt,
        ) => Effect.Effect<void, unknown> | undefined,
      ): void => {
        void runPromise(
          Effect.gen(function* () {
            const info = yield* dependencies.describe(contents.id);
            if (
              appIsQuitting ||
              contents.isDestroyed() ||
              info?.kind !== "game" ||
              attempts.get(contents.id)?.generation === info.generation
            ) {
              return;
            }
            const attempt: RecoveryAttempt = {
              target: contents,
              generation: info.generation,
              parentWindowId: info.windowId,
            };
            const recovery = offer(attempt);
            if (recovery === undefined) return;
            attempts.set(contents.id, attempt);
            yield* recovery.pipe(
              Effect.catchCause((cause) =>
                dependencies.error(failure, cause, { rendererId: contents.id }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (attempts.get(contents.id) === attempt) {
                    attempts.delete(contents.id);
                  }
                }),
              ),
            );
            startCrashRecovery();
          }),
        ).catch(() => undefined);
      };
      const startCrashRecovery = (): void => {
        if (!recoverableCrashes.has(contents.id)) return;
        startAttempt("Failed to offer renderer crash recovery", (attempt) => {
          const crash = recoverableCrashes.get(contents.id);
          return crash?.generation === attempt.generation
            ? offerCrashRecovery(attempt, crash)
            : undefined;
        });
      };
      const handleResponsive = (): void => {
        unresponsiveRenderers.delete(contents.id);
      };
      const handleUnresponsive = (): void => {
        if (appIsQuitting) return;
        unresponsiveRenderers.add(contents.id);
        if (!hasActiveExecution(contents.id)) return;
        startAttempt(
          "Failed to offer game renderer recovery",
          offerUnresponsiveRecovery,
        );
      };
      const handleRenderProcessGone = (
        _event: ElectronEvent,
        details: RenderProcessGoneDetails,
      ): void => {
        // Unresponsive recovery deliberately kills the renderer before
        // reloading it, so that event must not open another recovery prompt.
        if (intentionalRendererCrashes.delete(contents.id)) return;
        if (appIsQuitting || !isRecoverableRendererCrash(details.reason)) {
          return;
        }

        const scriptWasRunning = hasActiveExecution(contents.id);
        void runPromise(
          Effect.map(dependencies.describe(contents.id), (info) => {
            if (info?.kind !== "game") return;
            if (
              recoverableCrashes.get(contents.id)?.generation !==
              info.generation
            ) {
              recoverableCrashes.set(contents.id, {
                generation: info.generation,
                reason: details.reason,
                scriptWasRunning,
              });
            }
            startCrashRecovery();
          }),
        ).catch(() => undefined);
      };
      const handleDidStartLoading = (): void => {
        clearRenderer(contents.id);
      };
      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearRenderer(contents.id);
        intentionalRendererCrashes.delete(contents.id);
        contents.removeListener("responsive", handleResponsive);
        contents.removeListener("unresponsive", handleUnresponsive);
        contents.removeListener("render-process-gone", handleRenderProcessGone);
        contents.removeListener("did-start-loading", handleDidStartLoading);
        contents.removeListener("destroyed", cleanup);
        observedContents.delete(contents.id);
      };

      contents.on("responsive", handleResponsive);
      contents.on("unresponsive", handleUnresponsive);
      contents.on("render-process-gone", handleRenderProcessGone);
      contents.on("did-start-loading", handleDidStartLoading);
      contents.once("destroyed", cleanup);
      observedContents.set(contents.id, cleanup);
    };

    for (const contents of dependencies.allWebContents()) observe(contents);
    const unsubscribeCreated = dependencies.onWebContentsCreated(observe);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeBeforeQuit();
        unsubscribeCreated();
        for (const cleanup of observedContents.values()) cleanup();
      }),
    );
  });

  return DesktopGameRendererRecovery.of({
    beginScriptExecution,
    finishScriptExecution,
    install,
  });
};

const makeLiveDesktopGameRendererRecovery = Effect.gen(function* () {
  const accounts = yield* Accounts;
  const dialog = yield* ElectronDialog;
  const windows = yield* DesktopWindows;

  return makeDesktopGameRendererRecovery({
    allWebContents: () => webContents.getAllWebContents(),
    describe: windows.describe,
    onWebContentsCreated: (listener) => {
      const handleCreated = (
        _event: ElectronEvent,
        contents: WebContents,
      ): void => listener(contents);
      app.on("web-contents-created", handleCreated);
      return () => app.removeListener("web-contents-created", handleCreated);
    },
    onBeforeQuit: (listener) => {
      const handleBeforeQuit = (): void => listener();
      app.on("before-quit", handleBeforeQuit);
      return () => app.removeListener("before-quit", handleBeforeQuit);
    },
    showRecoveryPrompt: (parentWindowId) =>
      dialog
        .showMessageBox(
          {
            buttons: ["Reload", "Keep Waiting"],
            cancelId: 1,
            defaultId: 0,
            detail: CLIENT_RELOAD_DETAIL,
            message: "A client stopped responding while a script was running.",
            title: "Client Not Responding",
            type: "warning",
          },
          parentWindowId,
        )
        .pipe(Effect.map((result) => result.response)),
    showRendererRecoveryPrompt: (parentWindowId) =>
      dialog
        .showMessageBox(
          {
            buttons: ["Reload", "Not Now"],
            cancelId: 1,
            defaultId: 0,
            detail: CLIENT_RELOAD_DETAIL,
            message: "A client crashed.",
            title: "Client Crashed",
            type: "warning",
          },
          parentWindowId,
        )
        .pipe(Effect.map((result) => result.response)),
    suppressLaunchScript: accounts.suppressGameWindowLaunchScript,
    warn: (message, data) =>
      Effect.logWarning(message).pipe(
        Effect.annotateLogs({
          component: "game-renderer-recovery",
          data: data,
        }),
      ),
    error: (message, cause, data) =>
      logFailure(message, cause, { failure: "error" }).pipe(
        Effect.annotateLogs({
          component: "game-renderer-recovery",
          data: data,
        }),
      ),
    info: (message, data) =>
      Effect.logInfo(message).pipe(
        Effect.annotateLogs({
          component: "game-renderer-recovery",
          data: data,
        }),
      ),
  });
});

export const layer = Layer.effect(
  DesktopGameRendererRecovery,
  makeLiveDesktopGameRendererRecovery,
);
