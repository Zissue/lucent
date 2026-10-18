import * as Cause from "effect/Cause";
import {
  app,
  webContents,
  type Event as ElectronEvent,
  type RenderProcessGoneDetails,
  type WebContents,
} from "electron";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";

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
  ) => Effect.Effect<void>;
}

export interface DesktopGameRendererRecoveryShape {
  readonly beginScriptExecution: (
    lifetime: RendererLifetime,
  ) => Effect.Effect<void>;
  readonly finishScriptExecution: (
    lifetime: RendererLifetime,
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
  const pendingPrompts = new Map<
    number,
    {
      readonly crash: RecoverableGameCrash | undefined;
      readonly dismiss: Deferred.Deferred<void>;
    }
  >();
  const executions = new WeakMap<RendererLifetime, number>();
  const intentionalRendererCrashes = new WeakSet<RendererLifetime>();
  const observedContents = new Map<number, () => void>();
  let appIsQuitting = false;

  const hasActiveExecution = (lifetime: RendererLifetime): boolean =>
    (executions.get(lifetime) ?? 0) > 0;

  const dismissPrompt = Effect.fnUntraced(function* (rendererId: number) {
    const pending = pendingPrompts.get(rendererId);
    pendingPrompts.delete(rendererId);
    if (pending !== undefined)
      yield* Deferred.succeed(pending.dismiss, undefined);
  });

  const isCurrent = (
    target: RecoverableGameWebContents,
    lifetime: RendererLifetime,
  ): Effect.Effect<boolean> =>
    Effect.map(
      dependencies.lifetime(target.id),
      (current) =>
        current === lifetime && !target.isDestroyed() && !appIsQuitting,
    );

  const beginScriptExecution: DesktopGameRendererRecoveryShape["beginScriptExecution"] =
    (lifetime) =>
      Effect.sync(() => {
        if (lifetime.isCurrent()) {
          executions.set(lifetime, (executions.get(lifetime) ?? 0) + 1);
        }
      });

  const finishScriptExecution: DesktopGameRendererRecoveryShape["finishScriptExecution"] =
    (lifetime) =>
      Effect.sync(() => {
        const active = executions.get(lifetime) ?? 0;
        if (active <= 1) executions.delete(lifetime);
        else executions.set(lifetime, active - 1);
      });

  const recoverUnresponsive = Effect.fnUntraced(function* (
    target: RecoverableGameWebContents,
    lifetime: RendererLifetime,
  ) {
    const rendererId = target.id;
    if (!isExclusiveRendererProcess(target, dependencies.allWebContents))
      return;
    yield* dependencies.suppressLaunchScript(rendererId, RECOVERY_MESSAGE);
    if (
      !(yield* isCurrent(target, lifetime)) ||
      !lifetime.isCurrent() ||
      !isExclusiveRendererProcess(target, dependencies.allWebContents)
    )
      return;
    executions.delete(lifetime);
    intentionalRendererCrashes.add(lifetime);
    target.forcefullyCrashRenderer();
    if (!(yield* isCurrent(target, lifetime))) return;
    target.reload();
    yield* Effect.logInfo("Recovered an unresponsive game renderer").pipe(
      Effect.annotateLogs({
        component: "game-renderer-recovery",
        data: { rendererId },
      }),
    );
  });

  const recoverCrash = Effect.fnUntraced(function* (
    target: RecoverableGameWebContents,
    lifetime: RendererLifetime,
    crash: RecoverableGameCrash,
  ) {
    const rendererId = target.id;

    if (crash.scriptWasRunning) {
      yield* dependencies.suppressLaunchScript(
        rendererId,
        RENDERER_RECOVERY_MESSAGE,
      );
    }
    if (!(yield* isCurrent(target, lifetime))) return;
    executions.delete(lifetime);
    target.reload();
    yield* Effect.logInfo("Recovered a crashed game renderer").pipe(
      Effect.annotateLogs({
        component: "game-renderer-recovery",
        data: { reason: crash.reason, rendererId },
      }),
    );
  });

  const install = Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime<never, void>();
    const run = (effect: Effect.Effect<void>): void => {
      runFork(effect);
    };
    const startAttempt = Effect.fnUntraced(function* (
      target: RecoverableGameWebContents,
      lifetime: RendererLifetime,
      crash?: RecoverableGameCrash,
    ) {
      const info = yield* dependencies.describe(target.id);
      const pending = pendingPrompts.get(target.id);
      if (
        appIsQuitting ||
        target.isDestroyed() ||
        info?.kind !== "game" ||
        (pending !== undefined &&
          (crash === undefined || pending.crash !== undefined)) ||
        (crash === undefined && !lifetime.isCurrent())
      )
        return;
      if (
        crash === undefined &&
        !isExclusiveRendererProcess(target, dependencies.allWebContents)
      ) {
        yield* Effect.logWarning(
          "Refused to recover an unresponsive game renderer because its process is shared",
        ).pipe(
          Effect.annotateLogs({
            component: "game-renderer-recovery",
            data: { rendererId: target.id },
          }),
        );
        return;
      }
      const prompt = { crash, dismiss: yield* Deferred.make<void>() };
      pendingPrompts.set(target.id, prompt);
      if (pending !== undefined)
        yield* Deferred.succeed(pending.dismiss, undefined);
      yield* Effect.gen(function* () {
        const response = yield* Effect.exit(
          Effect.raceFirst(
            crash === undefined
              ? dependencies.showRecoveryPrompt(info.windowId)
              : dependencies.showRendererRecoveryPrompt(info.windowId),
            Deferred.await(prompt.dismiss).pipe(Effect.as(1)),
          ),
        );
        const current = yield* isCurrent(target, lifetime);
        if (pendingPrompts.get(target.id) !== prompt) return;
        pendingPrompts.delete(target.id);
        const answer = yield* response;
        if (!current || answer !== 0) return;
        yield* crash === undefined
          ? recoverUnresponsive(target, lifetime)
          : recoverCrash(target, lifetime, crash);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : logFailure("Failed to offer renderer recovery", cause, {
                failure: "error",
              }).pipe(
                Effect.annotateLogs({
                  component: "game-renderer-recovery",
                  data: { rendererId: target.id },
                }),
              ),
        ),
      );
    });

    yield* dependencies.observe({ kind: "game" }, (event) =>
      Effect.gen(function* () {
        if (event.type === "reloaded" || event.type === "closed") {
          yield* dismissPrompt(event.rendererId);
        } else if (event.type === "crashed") {
          const lifetime = yield* dependencies.lifetime(event.rendererId);
          if (
            lifetime === undefined ||
            lifetime.generation !== event.generation
          )
            return;
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
    });
    const observe = (contents: RecoverableGameWebContents): void => {
      if (observedContents.has(contents.id)) return;
      const handleUnresponsive = (): void =>
        run(
          Effect.gen(function* () {
            const lifetime = yield* dependencies.lifetime(contents.id);
            if (lifetime !== undefined && hasActiveExecution(lifetime))
              yield* startAttempt(contents, lifetime);
          }),
        );
      const cleanup = (): void => {
        contents.removeListener("unresponsive", handleUnresponsive);
        contents.removeListener("destroyed", handleDestroyed);
        observedContents.delete(contents.id);
      };
      const handleDestroyed = (): void => {
        cleanup();
        run(dismissPrompt(contents.id));
      };
      contents.on("unresponsive", handleUnresponsive);
      contents.once("destroyed", handleDestroyed);
      observedContents.set(contents.id, cleanup);
    };
    for (const contents of dependencies.allWebContents()) observe(contents);
    const unsubscribeCreated = dependencies.onWebContentsCreated(observe);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        appIsQuitting = true;
        unsubscribeBeforeQuit();
        unsubscribeCreated();
        for (const cleanup of observedContents.values()) cleanup();
        pendingPrompts.clear();
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
  });
});

export const layer = Layer.effect(
  DesktopGameRendererRecovery,
  makeLiveDesktopGameRendererRecovery,
);
