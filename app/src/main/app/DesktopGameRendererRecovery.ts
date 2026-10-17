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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";

import { Accounts } from "../game/accounts/Accounts";
import { ElectronDialog } from "../electron/ElectronDialog";
import {
  DesktopWindows,
  type RendererLifetime,
} from "../window/DesktopWindows";
import { logFailure } from "../../shared/logFailure";

const RECOVERY_MESSAGE =
  "The client was reloaded because the script stopped responding.";
const RENDERER_RECOVERY_MESSAGE = "The client was reloaded after it crashed.";
const CLIENT_RELOAD_DETAIL =
  "Only that client will reload. Any running script will stop and won't run automatically.";

interface RecoverableGameCrash {
  readonly reason: RenderProcessGoneDetails["reason"];
  readonly scriptWasRunning: boolean;
}

interface RecoveryAttempt {
  readonly target: RecoverableGameWebContents;
  readonly lifetime: RendererLifetime;
  readonly parentWindowId: number;
  readonly scope: Scope.Closeable;
  readonly kind: "unresponsive" | "crashed";
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
  readonly lifetime: DesktopWindows["Service"]["lifetime"];
  readonly observe: DesktopWindows["Service"]["observe"];
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
  readonly beginScriptExecution: (
    lifetime: RendererLifetime,
  ) => Effect.Effect<number>;
  readonly finishScriptExecution: (
    lifetime: RendererLifetime,
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
  const executions = new WeakMap<RendererLifetime, Set<number>>();
  const intentionalRendererCrashes = new WeakSet<RendererLifetime>();
  const observedContents = new Map<number, () => void>();
  const unresponsiveLifetimes = new WeakSet<RendererLifetime>();
  let appIsQuitting = false;
  let nextToken = 0;

  const hasActiveExecution = (lifetime: RendererLifetime): boolean =>
    (executions.get(lifetime)?.size ?? 0) > 0;

  const isCurrent = (attempt: RecoveryAttempt): Effect.Effect<boolean> =>
    Effect.map(
      dependencies.lifetime(attempt.target.id),
      (lifetime) =>
        !appIsQuitting &&
        !attempt.target.isDestroyed() &&
        attempts.get(attempt.target.id) === attempt &&
        lifetime === attempt.lifetime,
    );

  const canRecoverUnresponsive = (
    attempt: RecoveryAttempt,
  ): Effect.Effect<boolean> =>
    Effect.map(
      isCurrent(attempt),
      (current) =>
        current &&
        attempt.lifetime.isCurrent() &&
        unresponsiveLifetimes.has(attempt.lifetime) &&
        hasActiveExecution(attempt.lifetime) &&
        isExclusiveRendererProcess(attempt.target, dependencies.allWebContents),
    );

  const beginScriptExecution: DesktopGameRendererRecoveryShape["beginScriptExecution"] =
    (lifetime) =>
      Effect.sync(() => {
        nextToken += 1;
        if (lifetime.isCurrent()) {
          const active = executions.get(lifetime) ?? new Set<number>();
          active.add(nextToken);
          executions.set(lifetime, active);
        }
        return nextToken;
      });

  const finishScriptExecution: DesktopGameRendererRecoveryShape["finishScriptExecution"] =
    (lifetime, token) =>
      Effect.sync(() => {
        const active = executions.get(lifetime);
        active?.delete(token);
        if (active?.size === 0) executions.delete(lifetime);
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
      executions.delete(attempt.lifetime);
      unresponsiveLifetimes.delete(attempt.lifetime);
      intentionalRendererCrashes.add(attempt.lifetime);
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
      executions.delete(attempt.lifetime);
      target.reload();
      yield* dependencies.info("Recovered a crashed game renderer", {
        reason: crash.reason,
        rendererId,
      });
    });

  const install = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const runFork = yield* FiberSet.makeRuntime<never, void>();
    const run = (effect: Effect.Effect<void>): void => {
      runFork(effect);
    };
    const stopAttempt = (rendererId: number, generation?: number) =>
      Effect.suspend(() => {
        const attempt = attempts.get(rendererId);
        return attempt === undefined ||
          (generation !== undefined && attempt.lifetime.generation > generation)
          ? Effect.void
          : Scope.close(attempt.scope, Exit.void);
      });

    const startAttempt = Effect.fnUntraced(function* (
      target: RecoverableGameWebContents,
      lifetime: RendererLifetime,
      crash?: RecoverableGameCrash,
    ) {
      const info = yield* dependencies.describe(target.id);
      if (
        appIsQuitting ||
        target.isDestroyed() ||
        info?.kind !== "game" ||
        (yield* dependencies.lifetime(target.id)) !== lifetime ||
        (crash === undefined && !lifetime.isCurrent())
      )
        return;
      const pending = attempts.get(target.id);
      if (
        pending?.lifetime === lifetime &&
        (crash === undefined || pending.kind === "crashed")
      )
        return;
      yield* stopAttempt(target.id);
      if (
        (yield* dependencies.lifetime(target.id)) !== lifetime ||
        appIsQuitting ||
        (crash === undefined && !lifetime.isCurrent()) ||
        (attempts.get(target.id) !== pending &&
          attempts.get(target.id)?.lifetime === lifetime)
      )
        return;
      const attempt: RecoveryAttempt = {
        target,
        lifetime,
        parentWindowId: info.windowId,
        scope: yield* Scope.fork(crash === undefined ? lifetime.scope : scope),
        kind: crash === undefined ? "unresponsive" : "crashed",
      };
      attempts.set(target.id, attempt);
      const recovery =
        crash === undefined
          ? offerUnresponsiveRecovery(attempt)
          : offerCrashRecovery(attempt, crash);
      const fiber = yield* recovery.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : dependencies.error("Failed to offer renderer recovery", cause, {
                rendererId: target.id,
              }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (attempts.get(target.id) === attempt) attempts.delete(target.id);
          }),
        ),
        Effect.forkIn(attempt.scope),
      );
      yield* Fiber.join(fiber).pipe(
        Effect.uninterruptible,
        Effect.ensuring(Scope.close(attempt.scope, Exit.void)),
      );
    });

    yield* dependencies.observe({ kind: "game" }, (event) =>
      Effect.gen(function* () {
        if (event.type === "reloaded") {
          yield* stopAttempt(event.rendererId, event.generation - 1);
        } else if (event.type === "closed") {
          yield* stopAttempt(event.rendererId, event.generation);
        } else if (event.type === "crashed") {
          const lifetime = yield* dependencies.lifetime(event.rendererId);
          if (
            lifetime === undefined ||
            lifetime.generation !== event.generation
          )
            return;
          // Unresponsive recovery deliberately kills the renderer before
          // reloading it, so that event must not open another recovery prompt.
          if (
            intentionalRendererCrashes.delete(lifetime) ||
            appIsQuitting ||
            !isRecoverableRendererCrash(event.reason)
          )
            return;
          const target = dependencies
            .allWebContents()
            .find((contents) => contents.id === event.rendererId);
          if (target === undefined) return;
          run(
            startAttempt(target, lifetime, {
              reason: event.reason,
              scriptWasRunning: hasActiveExecution(lifetime),
            }),
          );
        }
      }),
    );

    const unsubscribeBeforeQuit = dependencies.onBeforeQuit(() => {
      appIsQuitting = true;
      for (const rendererId of attempts.keys()) run(stopAttempt(rendererId));
    });
    const observe = (contents: RecoverableGameWebContents): void => {
      if (observedContents.has(contents.id)) return;
      const handleResponsive = (): void =>
        run(
          Effect.gen(function* () {
            const lifetime = yield* dependencies.lifetime(contents.id);
            if (lifetime !== undefined) unresponsiveLifetimes.delete(lifetime);
          }),
        );
      const handleUnresponsive = (): void =>
        run(
          Effect.gen(function* () {
            const lifetime = yield* dependencies.lifetime(contents.id);
            if (
              appIsQuitting ||
              lifetime === undefined ||
              !lifetime.isCurrent()
            )
              return;
            unresponsiveLifetimes.add(lifetime);
            if (hasActiveExecution(lifetime))
              run(startAttempt(contents, lifetime));
          }),
        );
      const cleanup = (): void => {
        contents.removeListener("responsive", handleResponsive);
        contents.removeListener("unresponsive", handleUnresponsive);
        contents.removeListener("destroyed", handleDestroyed);
        observedContents.delete(contents.id);
      };
      const handleDestroyed = (): void => {
        cleanup();
        run(stopAttempt(contents.id));
      };
      contents.on("responsive", handleResponsive);
      contents.on("unresponsive", handleUnresponsive);
      contents.once("destroyed", handleDestroyed);
      observedContents.set(contents.id, cleanup);
    };
    for (const contents of dependencies.allWebContents()) observe(contents);
    const unsubscribeCreated = dependencies.onWebContentsCreated(observe);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        appIsQuitting = true;
        unsubscribeBeforeQuit();
        unsubscribeCreated();
        for (const cleanup of observedContents.values()) cleanup();
        yield* Effect.forEach(
          [...attempts.values()],
          (attempt) => Scope.close(attempt.scope, Exit.void),
          { discard: true },
        );
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
    lifetime: windows.lifetime,
    observe: windows.observe,
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
