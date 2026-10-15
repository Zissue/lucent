import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ScriptFile } from "../../../../shared/ipc/scripting";
import { selectDesktopBridge } from "../../../../shared/desktopBridge";
import {
  type AccountScriptSettingsPatch,
  type AccountSettings,
  type RoomPolicy,
} from "@lucent/core/accountSettings";
import type { ScriptInputValues } from "@lucent/core/scriptInputs";
import { ArmyApi } from "../army/Army";
import { Automation } from "../automation/Automation";
import { Environment } from "../environment/Environment";
import { Api } from "../flash/api/Api";
import { ProjectionReadiness } from "../flash/api/ProjectionReadiness";
import { Bridge } from "../flash/bridge/Bridge";
import type { Event as FlashEvent } from "../flash/contract/Event";
import type { ScriptMain, ScriptRuntimeOptions } from "./ScriptApi";
import {
  makeScriptAsyncScope,
  type ScriptAsyncScope,
} from "./scriptAsyncScope";
import { loadScriptModule } from "./scriptLoader";
import {
  attributedScriptErrorDetails,
  attributedScriptErrorMessage,
} from "./scriptSourceAttribution";
import {
  DEFAULT_SCRIPT_RUNTIME_OPTIONS,
  makeScriptRuntimeApi,
  runScriptExitActions,
  snapshotRoomPolicy,
  snapshotScriptRuntimeOptions,
  type ScriptRuntimeOptionsUpdate,
} from "./ScriptRuntime";
import { makeScriptBuiltinModules } from "./ScriptBuiltinModules";
import { makeScriptFileSystemApi } from "./ScriptFileSystem";
import { makeScriptHttpApi } from "./ScriptHttp";
import { ScriptDialogs } from "./ScriptDialogs";
import { makeScriptRuntimeServices } from "./api/Services";
import {
  makeMoveToSafeDestination,
  runWithSafeStartStop as withSafeStartStop,
} from "./safeStartStop";
import {
  getScriptExitRequest,
  type ScriptExecutionError,
  ScriptNotReadyError,
  ScriptStopSignal,
  type ScriptExitRequest,
} from "./ScriptRunnerErrors";
import { makeScriptStartReadiness } from "./ScriptStartReadiness";
import { protectScriptExecutionUntil } from "./ScriptExecutionProtection";

export type ScriptRunnerStatus =
  | { readonly state: "idle" }
  | {
      readonly name: string;
      readonly path?: string;
      readonly startedAt: string;
      readonly state: "starting";
    }
  | {
      readonly name: string;
      readonly path?: string;
      readonly startedAt: string;
      readonly state: "running";
    }
  | {
      readonly completedAt: string;
      readonly name: string;
      readonly path?: string;
      readonly state: "completed";
    }
  | {
      readonly detailsText?: string;
      readonly failedAt: string;
      readonly message: string;
      readonly name: string;
      readonly path?: string;
      readonly state: "failed";
    }
  | {
      readonly reason?: string;
      readonly state: "stopped";
      readonly stoppedAt: string;
    }
  | {
      readonly name: string;
      readonly path?: string;
      readonly state: "stopping";
    }
  | {
      readonly disconnectedAt: string;
      readonly name: string;
      readonly path?: string;
      readonly state: "waiting-to-restart";
    };

export type StateDisposer = () => void;

export type ScriptRunTerminalOutcome =
  | {
      readonly kind: "completed";
      readonly status: Extract<
        ScriptRunnerStatus,
        { readonly state: "completed" }
      >;
    }
  | {
      readonly kind: "failed";
      readonly status: Extract<
        ScriptRunnerStatus,
        { readonly state: "failed" }
      >;
    }
  | {
      readonly kind: "script-stopped";
      readonly status: Extract<
        ScriptRunnerStatus,
        { readonly state: "stopped" }
      >;
    }
  | {
      readonly kind: "script-exited";
      readonly status: Extract<
        ScriptRunnerStatus,
        { readonly state: "stopped" }
      >;
    }
  | {
      readonly kind: "externally-stopped";
      readonly status: Extract<
        ScriptRunnerStatus,
        { readonly state: "stopped" }
      >;
    };

export interface ScriptRunHandle {
  readonly initialStatus: ScriptRunnerStatus;
  /** Completes after every resource owned by this run has been released. */
  readonly terminal: Effect.Effect<ScriptRunTerminalOutcome>;
}

export interface ScriptOptionsUpdateResult {
  readonly options: ScriptRuntimeOptions;
  readonly persisted: boolean;
}

interface ScriptFinalization {
  readonly outcome?: ScriptRunTerminalOutcome;
  readonly status: ScriptRunnerStatus;
}

const terminalFinalization = (
  outcome: ScriptRunTerminalOutcome,
): ScriptFinalization => ({ outcome, status: outcome.status });

const runtimeOptionsFrom = (settings: AccountSettings): ScriptRuntimeOptions =>
  snapshotScriptRuntimeOptions(settings.scripts);

const roomPoliciesEqual = (left: RoomPolicy, right: RoomPolicy): boolean =>
  left.kind === right.kind &&
  (left.kind !== "specific" ||
    (right.kind === "specific" && left.roomNumber === right.roomNumber));

const accountSettingsPatch = (
  current: ScriptRuntimeOptions,
  next: ScriptRuntimeOptions,
): AccountScriptSettingsPatch => ({
  ...(current.restartAfterReconnect === next.restartAfterReconnect
    ? {}
    : { restartAfterReconnect: next.restartAfterReconnect }),
  ...(roomPoliciesEqual(current.roomPolicy, next.roomPolicy)
    ? {}
    : { roomPolicy: snapshotRoomPolicy(next.roomPolicy) }),
  ...(current.safeStartStop === next.safeStartStop
    ? {}
    : { safeStartStop: next.safeStartStop }),
});

export const planScriptOptionsUpdate = (
  persisted: ScriptRuntimeOptions,
  current: ScriptRuntimeOptions,
  update: ScriptRuntimeOptionsUpdate,
) => {
  const next = snapshotScriptRuntimeOptions(update(current));
  return { next, patch: accountSettingsPatch(persisted, next) };
};

class ScriptAccountSettingsBridgeError extends Data.TaggedError(
  "ScriptAccountSettingsBridgeError",
)<{ readonly cause: unknown }> {}

export interface ScriptRunnerShape {
  readonly bindAccount: (
    username: string,
  ) => Effect.Effect<ScriptRuntimeOptions>;
  readonly getOptions: () => Effect.Effect<ScriptRuntimeOptions>;
  readonly getStatus: () => Effect.Effect<ScriptRunnerStatus>;
  readonly isRunning: () => Effect.Effect<boolean>;
  readonly onStatus: (
    listener: (status: ScriptRunnerStatus) => void,
  ) => Effect.Effect<StateDisposer>;
  readonly onOptions: (
    listener: (options: ScriptRuntimeOptions) => void,
  ) => Effect.Effect<StateDisposer>;
  readonly persistOptions: () => Effect.Effect<ScriptOptionsUpdateResult>;
  readonly resetOptions: () => Effect.Effect<ScriptRuntimeOptions>;
  readonly setOptions: (
    update: ScriptRuntimeOptionsUpdate,
  ) => Effect.Effect<ScriptOptionsUpdateResult>;
  readonly setRestartAfterReconnect: (
    enabled: boolean,
  ) => Effect.Effect<ScriptOptionsUpdateResult>;
  readonly setRoomPolicy: (
    policy: RoomPolicy,
  ) => Effect.Effect<ScriptOptionsUpdateResult>;
  readonly setSafeStartStop: (
    enabled: boolean,
  ) => Effect.Effect<ScriptOptionsUpdateResult>;
  readonly start: (
    file: ScriptFile,
    inputs: ScriptInputValues,
  ) => Effect.Effect<ScriptRunHandle, ScriptExecutionError>;
  readonly stop: (reason?: string) => Effect.Effect<ScriptRunnerStatus>;
}

export class ScriptRunner extends Context.Service<
  ScriptRunner,
  ScriptRunnerShape
>()("lucent/game/scripting/ScriptRunner") {}

interface ActiveScript {
  readonly commandId: number;
  readonly fiber: Fiber.Fiber<void, unknown>;
  readonly file: ScriptFile;
  readonly id: number;
  readonly inputs: ScriptInputValues;
  readonly name: string;
  readonly path?: string;
  readonly scope: ScriptAsyncScope;
  readonly terminal: Deferred.Deferred<ScriptRunTerminalOutcome>;
  readonly username: string;
}

interface PendingFinalization {
  readonly done: Deferred.Deferred<ScriptRunnerStatus>;
  readonly id: number;
}

interface PendingRestart {
  readonly cancel: Deferred.Deferred<StartingCancellation>;
  readonly commandId: number;
  readonly disconnectedAt: string;
  readonly done: Deferred.Deferred<ScriptRunnerStatus>;
  readonly file: ScriptFile;
  readonly id: number;
  readonly inputs: ScriptInputValues;
  readonly name: string;
  readonly path?: string;
  readonly terminal: Deferred.Deferred<ScriptRunTerminalOutcome>;
  readonly username: string;
}

interface StartingCancellation {
  readonly reason?: string;
  readonly retryAfterReconnect?: boolean;
}

interface StartingScript {
  readonly cancel: Deferred.Deferred<StartingCancellation>;
  readonly commandId: number;
  readonly done: Deferred.Deferred<ScriptRunnerStatus>;
  readonly id: number;
  readonly name: string;
  readonly path?: string;
  readonly restart?: PendingRestart;
  readonly terminal: Deferred.Deferred<ScriptRunTerminalOutcome>;
}

interface ScriptRunIdentity {
  readonly id: number;
  readonly terminal: Deferred.Deferred<ScriptRunTerminalOutcome>;
}

type RestartReadiness =
  | { readonly kind: "account-changed" }
  | { readonly kind: "disabled" }
  | { readonly kind: "ready" };

const nowIso = (): string => new Date().toISOString();

const snapshotStatus = (status: ScriptRunnerStatus): ScriptRunnerStatus => ({
  ...status,
});

const makeRunHandle = (
  initialStatus: ScriptRunnerStatus,
  terminal: Deferred.Deferred<ScriptRunTerminalOutcome>,
): ScriptRunHandle => ({
  initialStatus: snapshotStatus(initialStatus),
  terminal: Deferred.await(terminal),
});

const externalStopOutcome = (
  status: Extract<ScriptRunnerStatus, { readonly state: "stopped" }>,
): ScriptRunTerminalOutcome => ({ kind: "externally-stopped", status });

const statusName = (file: Pick<ScriptFile, "name" | "path">) =>
  file.name.trim() === "" ? (file.path ?? "script") : file.name;

const activeStatusFields = (
  active: Pick<ActiveScript | PendingRestart | StartingScript, "name" | "path">,
) => ({
  name: active.name,
  ...(active.path === undefined ? {} : { path: active.path }),
});

const normalizeUsername = (username: string): string =>
  username.trim().toLowerCase();

export const statusFromStartingCancellation = (
  starting: {
    readonly restart?: Pick<PendingRestart, "disconnectedAt" | "name" | "path">;
  },
  cancellation: StartingCancellation,
): ScriptRunnerStatus =>
  cancellation.retryAfterReconnect === true && starting.restart !== undefined
    ? {
        ...activeStatusFields(starting.restart),
        disconnectedAt: starting.restart.disconnectedAt,
        state: "waiting-to-restart",
      }
    : {
        ...(cancellation.reason === undefined
          ? {}
          : { reason: cancellation.reason }),
        state: "stopped",
        stoppedAt: nowIso(),
      };

export type ScriptTermination =
  | { readonly kind: "failed" }
  | {
      readonly exitRequest: ScriptExitRequest;
      readonly kind: "script-exited";
      readonly reason?: string;
    }
  | { readonly kind: "script-interrupted" }
  | { readonly kind: "script-stopped"; readonly reason?: string };

export const classifyScriptTermination = (
  cause: Cause.Cause<unknown>,
): ScriptTermination => {
  let closeClient = false;
  let logout = false;
  let stopReason: string | undefined;
  let sawExitRequest = false;
  let sawStopSignal = false;

  for (const reason of cause.reasons) {
    if (Cause.isInterruptReason(reason)) {
      continue;
    }

    if (
      Cause.isFailReason(reason) &&
      reason.error instanceof ScriptStopSignal
    ) {
      sawStopSignal = true;
      stopReason ??= reason.error.reason;
      const exitRequest = getScriptExitRequest(reason.error);
      sawExitRequest ||= exitRequest !== undefined;
      closeClient ||= exitRequest?.closeClient === true;
      logout ||= exitRequest?.logout === true;
      continue;
    }

    return { kind: "failed" };
  }

  if (sawStopSignal) {
    return sawExitRequest
      ? {
          exitRequest: { closeClient, logout },
          kind: "script-exited",
          ...(stopReason === undefined ? {} : { reason: stopReason }),
        }
      : {
          kind: "script-stopped",
          ...(stopReason === undefined ? {} : { reason: stopReason }),
        };
  }
  return Cause.hasInterruptsOnly(cause)
    ? { kind: "script-interrupted" }
    : { kind: "failed" };
};

const isScriptNotReadyCause = (cause: Cause.Cause<unknown>): boolean => {
  let sawNotReady = false;
  for (const reason of cause.reasons) {
    if (Cause.isInterruptReason(reason)) continue;
    if (
      Cause.isFailReason(reason) &&
      reason.error instanceof ScriptNotReadyError
    ) {
      sawNotReady = true;
      continue;
    }
    return false;
  }
  return sawNotReady;
};

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.length > 0
    ? attributedScriptErrorMessage(squashed)
    : Cause.pretty(cause);
};

const causeDetailsText = (cause: Cause.Cause<unknown>): string | undefined => {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error) {
    const details = attributedScriptErrorDetails(squashed);
    if (details !== undefined) return details;
  }

  const pretty = Cause.pretty(cause);
  return pretty.trim() === "" ? undefined : pretty;
};

const logScriptFailureCause = (
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const squashed = Cause.squash(cause);
    console.error(
      "[script]",
      "error running script:",
      squashed instanceof Error ? squashed : causeMessage(cause),
    );
  });

const isConnectionLoss = (event: FlashEvent): boolean =>
  event.type === "connection" &&
  (event.status === "OnConnectionLost" ||
    event.status === "OnConnectionFailed");

export const layer = Layer.effect(
  ScriptRunner,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const api = yield* Api;
    const projectionReadiness = yield* ProjectionReadiness;
    const army = yield* ArmyApi;
    const automation = yield* Automation;
    const environment = yield* Environment;
    const bridge = yield* Bridge;
    const dialogs = yield* ScriptDialogs;
    const {
      accountSettings,
      fileSystem: fileSystemBridge,
      http: httpBridge,
      gameView,
    } = selectDesktopBridge(window.desktop, "game");
    const { auth, combat, events, house, map, packet, player, wait } = api;
    const { autoRelogin, autoZone } = automation;
    const scriptStartReadiness = makeScriptStartReadiness({
      auth,
      player,
      projectionReadiness,
      wait,
    });

    const services = makeScriptRuntimeServices(api, army, environment);

    const activeRef = yield* Ref.make<ActiveScript | null>(null);
    const lifecycleGate = yield* Semaphore.make(1);
    const latestCommandIdRef = yield* Ref.make(0);
    const nextIdRef = yield* Ref.make(0);
    const pendingFinalizationRef = yield* Ref.make<PendingFinalization | null>(
      null,
    );
    const pendingRestartRef = yield* Ref.make<PendingRestart | null>(null);
    const startingRef = yield* Ref.make<StartingScript | null>(null);
    const optionsRef = yield* SubscriptionRef.make<ScriptRuntimeOptions>(
      DEFAULT_SCRIPT_RUNTIME_OPTIONS,
    );
    const persistedOptionsRef = yield* Ref.make<ScriptRuntimeOptions>(
      DEFAULT_SCRIPT_RUNTIME_OPTIONS,
    );
    const accountUsernameRef = yield* Ref.make<string | null>(null);
    const accountSettingsGate = yield* Semaphore.make(1);
    const statusRef = yield* SubscriptionRef.make<ScriptRunnerStatus>({
      state: "idle",
    });

    const getStatus = () =>
      SubscriptionRef.get(statusRef).pipe(Effect.map(snapshotStatus));

    const setStatus = (status: ScriptRunnerStatus) =>
      SubscriptionRef.set(statusRef, snapshotStatus(status));

    const getOptions = () =>
      SubscriptionRef.get(optionsRef).pipe(
        Effect.map(snapshotScriptRuntimeOptions),
      );

    const loadPersistedOptions = Effect.fn("ScriptRunner.loadPersistedOptions")(
      function* (username: string) {
        return yield* Effect.tryPromise({
          try: () => accountSettings.get(username),
          catch: (cause) => new ScriptAccountSettingsBridgeError({ cause }),
        }).pipe(
          Effect.map(runtimeOptionsFrom),
          Effect.catch((cause) =>
            Effect.logWarning(
              "Failed to load account script settings; using defaults.",
              Cause.fail(cause),
            ).pipe(
              Effect.annotateLogs({
                component: "scripting",
                data: { username },
              }),
              Effect.as(DEFAULT_SCRIPT_RUNTIME_OPTIONS),
            ),
          ),
        );
      },
    );

    const bindAccount: ScriptRunnerShape["bindAccount"] = (username) =>
      accountSettingsGate.withPermits(1)(
        Effect.gen(function* () {
          const normalized = normalizeUsername(username);
          const boundUsername = yield* Ref.get(accountUsernameRef);
          if (normalized !== "" && boundUsername === normalized) {
            return yield* getOptions();
          }

          const options =
            normalized === ""
              ? DEFAULT_SCRIPT_RUNTIME_OPTIONS
              : yield* loadPersistedOptions(normalized);
          yield* Ref.set(
            accountUsernameRef,
            normalized === "" ? null : normalized,
          );
          yield* Ref.set(
            persistedOptionsRef,
            snapshotScriptRuntimeOptions(options),
          );
          return yield* SubscriptionRef.updateAndGet(optionsRef, () =>
            snapshotScriptRuntimeOptions(options),
          ).pipe(Effect.map(snapshotScriptRuntimeOptions));
        }),
      );

    const setOptions = (
      update: ScriptRuntimeOptionsUpdate,
    ): Effect.Effect<ScriptOptionsUpdateResult> =>
      accountSettingsGate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getOptions();
          const persistedOptions = yield* Ref.get(persistedOptionsRef);
          const { next, patch } = planScriptOptionsUpdate(
            persistedOptions,
            current,
            update,
          );
          const username = yield* Ref.get(accountUsernameRef);
          // Reverting a failed save still changes the session, even when disk already matches.
          if (username === null || Object.keys(patch).length === 0) {
            const options = yield* SubscriptionRef.updateAndGet(
              optionsRef,
              () => next,
            ).pipe(Effect.map(snapshotScriptRuntimeOptions));
            return { options, persisted: true };
          }

          const persisted = yield* Effect.tryPromise({
            try: () => accountSettings.update(username, { scripts: patch }),
            catch: (cause) => new ScriptAccountSettingsBridgeError({ cause }),
          }).pipe(
            Effect.map(runtimeOptionsFrom),
            Effect.catch((cause) =>
              Effect.logWarning(
                "Failed to persist account script settings; keeping the session value.",
                Cause.fail(cause),
              ).pipe(
                Effect.annotateLogs({
                  component: "scripting",
                  data: { username },
                }),
                Effect.as(null),
              ),
            ),
          );

          const options = yield* SubscriptionRef.updateAndGet(
            optionsRef,
            () => persisted ?? next,
          ).pipe(Effect.map(snapshotScriptRuntimeOptions));
          if (persisted === null) return { options, persisted: false };

          yield* Ref.set(
            persistedOptionsRef,
            snapshotScriptRuntimeOptions(persisted),
          );
          return { options, persisted: true };
        }),
      );

    const observe = <A>(
      changes: Stream.Stream<A>,
      snapshot: (value: A) => A,
      listener: (value: A) => void,
    ) =>
      changes.pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => listener(snapshot(value))),
        ),
        Effect.forkIn(scope),
        Effect.map((fiber) => () => {
          runFork(Fiber.interrupt(fiber));
        }),
      );

    const awaitStatus = (done: Deferred.Deferred<ScriptRunnerStatus>) =>
      Deferred.await(done).pipe(Effect.map(snapshotStatus));

    const requestInterrupt = Effect.fn("ScriptRunner.requestInterrupt")(
      function* (fiber: Fiber.Fiber<void, unknown>) {
        const interruptor = yield* Effect.fiberId;
        yield* Effect.sync(() => {
          // Request cancellation synchronously; the owning finalizer awaits
          // termination before releasing script resources.
          fiber.interruptUnsafe(interruptor);
        });
      },
    );

    interface FinalizationOptions {
      readonly active: ActiveScript;
      readonly awaitFiber: boolean;
      readonly beforeComplete?: Effect.Effect<void>;
      readonly cause?: Cause.Cause<unknown>;
      readonly done: PendingFinalization["done"];
      readonly result: () => ScriptFinalization;
    }

    const completeFinalization = Effect.fn("ScriptRunner.completeFinalization")(
      function* (
        id: number,
        done: PendingFinalization["done"],
        terminal: Deferred.Deferred<ScriptRunTerminalOutcome>,
        finalization: ScriptFinalization,
      ) {
        yield* lifecycleGate.withPermit(
          Effect.gen(function* () {
            const pending = yield* Ref.get(pendingFinalizationRef);
            if (pending?.id !== id || pending.done !== done) {
              yield* Deferred.succeed(done, yield* getStatus());
              return;
            }

            yield* Ref.set(pendingFinalizationRef, null);
            yield* setStatus(finalization.status);
            yield* Deferred.succeed(done, snapshotStatus(finalization.status));
            if (finalization.outcome !== undefined) {
              yield* Deferred.succeed(terminal, finalization.outcome);
            }
          }),
        );
      },
    );

    const finalize = Effect.fn("ScriptRunner.finalize")(function* (
      options: FinalizationOptions,
    ) {
      if (options.awaitFiber) {
        yield* Fiber.await(options.active.fiber);
      }
      yield* options.active.scope.close;
      if (options.cause !== undefined) {
        yield* logScriptFailureCause(options.cause);
      }
      if (options.beforeComplete !== undefined) {
        yield* options.beforeComplete;
      }
      const result = options.result();
      yield* completeFinalization(
        options.active.id,
        options.done,
        options.active.terminal,
        result,
      );
    });

    const beginFinalization = Effect.fn("ScriptRunner.beginFinalization")(
      function* (
        active: ActiveScript,
        options: {
          readonly awaitFiber: boolean;
          readonly beforeComplete?: Effect.Effect<void>;
          readonly cause?: Cause.Cause<unknown>;
          readonly intermediateStatus?: ScriptRunnerStatus;
          readonly interrupt: boolean;
          readonly result: () => ScriptFinalization;
        },
      ) {
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const done = yield* Deferred.make<ScriptRunnerStatus>();
            yield* Ref.set(activeRef, null);
            yield* Ref.set(pendingFinalizationRef, { done, id: active.id });
            if (options.intermediateStatus !== undefined) {
              yield* setStatus(options.intermediateStatus);
            }

            yield* active.scope.cancel;
            if (options.interrupt) {
              yield* requestInterrupt(active.fiber);
            }

            yield* finalize({
              active,
              awaitFiber: options.awaitFiber,
              ...(options.beforeComplete === undefined
                ? {}
                : { beforeComplete: options.beforeComplete }),
              ...(options.cause === undefined ? {} : { cause: options.cause }),
              done,
              result: options.result,
            }).pipe(Effect.forkDetach);
            return done;
          }),
        );
      },
    );

    const cancelPendingRestart = Effect.fn("ScriptRunner.cancelPendingRestart")(
      function* (reason?: string) {
        const pending = yield* Ref.get(pendingRestartRef);
        if (pending !== null) {
          yield* Deferred.succeed(
            pending.cancel,
            reason === undefined ? {} : { reason },
          );
        }
        return pending;
      },
    );

    const stopActive = Effect.fn("ScriptRunner.stopActive")(function* (
      reason?: string,
    ) {
      yield* Ref.update(latestCommandIdRef, (value) => value + 1);
      const result = yield* lifecycleGate.withPermit(
        Effect.gen(function* () {
          const restart = yield* cancelPendingRestart(reason);
          const starting = yield* Ref.get(startingRef);
          if (starting !== null) {
            yield* Deferred.succeed(
              starting.cancel,
              reason === undefined ? {} : { reason },
            );
            return {
              done: restart?.done ?? starting.done,
              kind: "waiting",
            } as const;
          }

          const pending = yield* Ref.get(pendingFinalizationRef);
          if (pending !== null) {
            return {
              done: restart?.done ?? pending.done,
              kind: "waiting",
            } as const;
          }

          const active = yield* Ref.get(activeRef);
          if (active === null) {
            if (restart !== null) {
              return { done: restart.done, kind: "waiting" } as const;
            }
            return { kind: "status", status: yield* getStatus() } as const;
          }

          const done = yield* beginFinalization(active, {
            awaitFiber: true,
            intermediateStatus: {
              ...activeStatusFields(active),
              state: "stopping",
            },
            interrupt: true,
            result: () => {
              const status = {
                ...(reason === undefined ? {} : { reason }),
                state: "stopped",
                stoppedAt: nowIso(),
              } as const;
              return terminalFinalization(externalStopOutcome(status));
            },
          });
          return { done, kind: "waiting" } as const;
        }),
      );

      return result.kind === "status"
        ? result.status
        : yield* awaitStatus(result.done);
    });

    const finishIfActive = Effect.fn("ScriptRunner.finishIfActive")(function* (
      id: number,
      options: {
        readonly beforeComplete?: Effect.Effect<void>;
        readonly result: () => ScriptFinalization;
      },
    ) {
      const done = yield* lifecycleGate.withPermit(
        Effect.gen(function* () {
          if ((yield* Ref.get(pendingFinalizationRef)) !== null) {
            return null;
          }
          const active = yield* Ref.get(activeRef);
          return active?.id === id
            ? yield* beginFinalization(active, {
                awaitFiber: false,
                ...(options.beforeComplete === undefined
                  ? {}
                  : { beforeComplete: options.beforeComplete }),
                interrupt: false,
                result: options.result,
              })
            : null;
        }),
      );
      if (done !== null) {
        yield* awaitStatus(done);
      } else if (options.beforeComplete !== undefined) {
        yield* options.beforeComplete;
      }
    });

    const failActiveCause = Effect.fn("ScriptRunner.failActiveCause")(
      function* (id: number, cause: Cause.Cause<unknown>) {
        const detailsText = causeDetailsText(cause);
        const done = yield* lifecycleGate.withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(pendingFinalizationRef)) !== null) {
              return null;
            }

            const active = yield* Ref.get(activeRef);
            if (active?.id !== id) return null;
            return yield* beginFinalization(active, {
              awaitFiber: true,
              cause,
              interrupt: true,
              result: () => {
                const status = {
                  ...activeStatusFields(active),
                  ...(detailsText === undefined ? {} : { detailsText }),
                  failedAt: nowIso(),
                  message: causeMessage(cause),
                  state: "failed",
                } as const;
                return terminalFinalization({ kind: "failed", status });
              },
            });
          }),
        );
        if (done !== null) {
          yield* awaitStatus(done);
        }
      },
    );

    const moveToSafeMap = makeMoveToSafeDestination({
      auth,
      bridge,
      combat,
      house,
      map,
      packet,
      player,
      roomPolicy: SubscriptionRef.get(optionsRef).pipe(
        Effect.map((options) => snapshotRoomPolicy(options.roomPolicy)),
      ),
      wait,
    });

    const runWithSafeStartStop = (main: ScriptMain) =>
      withSafeStartStop(
        Effect.gen(function* () {
          const iterator = main() as Generator<
            Effect.Effect<any, any, never>,
            unknown,
            any
          >;
          return yield* iterator;
        }).pipe(Effect.asVoid),
        SubscriptionRef.get(optionsRef).pipe(
          Effect.map((options) => options.safeStartStop),
        ),
        moveToSafeMap,
      );

    const runScript = (id: number, file: ScriptFile, main: ScriptMain) =>
      runWithSafeStartStop(main).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            const termination = classifyScriptTermination(cause);
            if (termination.kind !== "failed") {
              const reason =
                termination.kind === "script-interrupted"
                  ? undefined
                  : termination.reason;
              const exitRequest =
                termination.kind === "script-exited"
                  ? termination.exitRequest
                  : undefined;
              return finishIfActive(id, {
                beforeComplete: runScriptExitActions(exitRequest, {
                  closeClient: gameView.close,
                  logout: auth.logout,
                }),
                result: () => {
                  const status = {
                    ...(reason === undefined ? {} : { reason }),
                    state: "stopped",
                    stoppedAt: nowIso(),
                  } as const;
                  const outcome: ScriptRunTerminalOutcome =
                    termination.kind === "script-exited"
                      ? { kind: "script-exited", status }
                      : termination.kind === "script-stopped"
                        ? { kind: "script-stopped", status }
                        : { kind: "externally-stopped", status };
                  return terminalFinalization(outcome);
                },
              }).pipe(Effect.uninterruptible);
            }

            const detailsText = causeDetailsText(cause);
            return logScriptFailureCause(cause).pipe(
              Effect.andThen(
                finishIfActive(id, {
                  result: () => {
                    const status = {
                      ...(detailsText === undefined ? {} : { detailsText }),
                      failedAt: nowIso(),
                      message: causeMessage(cause),
                      name: statusName(file),
                      ...(file.path === undefined ? {} : { path: file.path }),
                      state: "failed",
                    } as const;
                    return terminalFinalization({ kind: "failed", status });
                  },
                }),
              ),
            );
          },
          onSuccess: () =>
            finishIfActive(id, {
              result: () => {
                const status = {
                  completedAt: nowIso(),
                  name: statusName(file),
                  ...(file.path === undefined ? {} : { path: file.path }),
                  state: "completed",
                } as const;
                return terminalFinalization({ kind: "completed", status });
              },
            }),
        }),
      );

    const completeStarting = Effect.fn("ScriptRunner.completeStarting")(
      function* (starting: StartingScript, status: ScriptRunnerStatus) {
        return yield* lifecycleGate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* Ref.get(startingRef);
              const authoritative =
                current?.id === starting.id && current.done === starting.done
                  ? status
                  : yield* getStatus();

              if (
                current?.id === starting.id &&
                current.done === starting.done
              ) {
                yield* Ref.set(startingRef, null);
                yield* setStatus(status);
              }
              yield* Deferred.succeed(starting.done, snapshotStatus(status));
              if (status.state === "failed") {
                yield* Deferred.succeed(starting.terminal, {
                  kind: "failed",
                  status: { ...status },
                });
              } else if (status.state === "stopped") {
                yield* Deferred.succeed(
                  starting.terminal,
                  externalStopOutcome({ ...status }),
                );
              } else if (status.state === "completed") {
                yield* Deferred.succeed(starting.terminal, {
                  kind: "completed",
                  status: { ...status },
                });
              }
              return authoritative;
            }),
          ),
        );
      },
    );

    const runStarting = Effect.fn("ScriptRunner.runStarting")(function* (
      starting: StartingScript,
      file: ScriptFile,
      inputs: ScriptInputValues,
    ): Effect.fn.Return<void> {
      const scriptScope = makeScriptAsyncScope();
      let activated = false;
      let scriptFiber: Fiber.Fiber<void, unknown> | undefined;

      const cleanup = Effect.suspend(() =>
        activated
          ? Effect.void
          : Effect.uninterruptible(
              Effect.gen(function* () {
                yield* scriptScope.cancel;
                if (scriptFiber !== undefined) {
                  yield* requestInterrupt(scriptFiber);
                  yield* Fiber.await(scriptFiber);
                }
                yield* scriptScope.close;
              }),
            ),
      );
      yield* installReadinessWatcher(starting.id, scriptScope);

      const setup = Effect.gen(function* () {
        const readiness = yield* scriptStartReadiness.awaitReady();
        const username = readiness.username;
        yield* bindAccount(username);

        yield* scriptScope.addCleanup(() =>
          army.leave().pipe(Effect.catchCause(() => Effect.void)),
        );
        const script = makeScriptRuntimeApi({
          dialogs,
          getOptions,
          inputValues: inputs,
          log: (...values) => console.log("[script]", ...values),
          scope: scriptScope,
          setOptions: (update) =>
            setOptions(update).pipe(Effect.map((result) => result.options)),
          source: { sourceName: statusName(file) },
        });
        const fileSystem = yield* makeScriptFileSystemApi(
          fileSystemBridge,
          scriptScope,
        );
        const http = yield* makeScriptHttpApi(httpBridge, scriptScope);
        const modules = makeScriptBuiltinModules({
          autoRelogin,
          autoZone,
          bridge,
          failCause: (cause) => failActiveCause(starting.id, cause),
          fileSystem,
          http,
          roomPolicy: SubscriptionRef.get(optionsRef).pipe(
            Effect.map((options) => snapshotRoomPolicy(options.roomPolicy)),
          ),
          scope: scriptScope,
          script,
          services,
        });
        const loaded = yield* loadScriptModule({
          modules,
          name: file.path ?? file.name,
          revision: file.revision,
          ...(file.snapshot === undefined ? {} : { snapshot: file.snapshot }),
          source: file.source,
        });
        const release = yield* Deferred.make<void>();
        const fiber = yield* Deferred.await(release).pipe(
          Effect.andThen(runScript(starting.id, file, loaded.main)),
          Effect.forkDetach,
        );
        scriptFiber = fiber;
        const active: ActiveScript = {
          commandId: starting.commandId,
          fiber,
          file: { ...file },
          id: starting.id,
          inputs: { ...inputs },
          name: starting.name,
          ...(starting.path === undefined ? {} : { path: starting.path }),
          scope: scriptScope,
          terminal: starting.terminal,
          username,
        };
        const status: ScriptRunnerStatus = {
          ...activeStatusFields(active),
          startedAt: nowIso(),
          state: "running",
        };

        const committed = yield* lifecycleGate.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* Ref.get(startingRef);
              const latestCommandId = yield* Ref.get(latestCommandIdRef);
              const cancelled = yield* Deferred.isDone(starting.cancel);
              const restartCancelled =
                starting.restart !== undefined &&
                (yield* Deferred.isDone(starting.restart.cancel));
              const currentRestart = yield* Ref.get(pendingRestartRef);
              if (
                current?.id !== starting.id ||
                current.done !== starting.done ||
                latestCommandId !== starting.commandId ||
                cancelled ||
                restartCancelled ||
                (starting.restart !== undefined &&
                  currentRestart !== starting.restart)
              ) {
                return false;
              }

              yield* Effect.sync(() => {
                activated = true;
              });
              yield* Ref.set(startingRef, null);
              yield* Ref.set(activeRef, active);
              yield* setStatus(status);
              yield* Deferred.succeed(release, undefined);
              if (starting.restart !== undefined) {
                yield* Ref.set(pendingRestartRef, null);
                yield* Deferred.succeed(
                  starting.restart.done,
                  snapshotStatus(status),
                );
              }
              return true;
            }),
          ),
        );
        if (!committed) {
          return yield* Effect.interrupt;
        }
        return status;
      }).pipe(Effect.ensuring(cleanup));

      const status = yield* Effect.raceFirst(
        setup.pipe(
          Effect.map((status) => ({ kind: "started", status }) as const),
        ),
        Deferred.await(starting.cancel).pipe(
          Effect.map(
            (cancellation) => ({ cancellation, kind: "cancelled" }) as const,
          ),
        ),
      ).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                const cancellation = (yield* Deferred.isDone(starting.cancel))
                  ? yield* Deferred.await(starting.cancel)
                  : { reason: "Start cancelled" };
                return statusFromStartingCancellation(starting, cancellation);
              }

              if (
                starting.restart !== undefined &&
                isScriptNotReadyCause(cause)
              ) {
                return {
                  ...activeStatusFields(starting.restart),
                  disconnectedAt: starting.restart.disconnectedAt,
                  state: "waiting-to-restart",
                } as ScriptRunnerStatus;
              }

              yield* logScriptFailureCause(cause);
              const detailsText = causeDetailsText(cause);
              return {
                ...(detailsText === undefined ? {} : { detailsText }),
                failedAt: nowIso(),
                message: causeMessage(cause),
                name: starting.name,
                ...(starting.path === undefined ? {} : { path: starting.path }),
                state: "failed",
              } as ScriptRunnerStatus;
            }),
          onSuccess: (outcome) =>
            outcome.kind === "started"
              ? Effect.succeed<ScriptRunnerStatus>(outcome.status)
              : Effect.succeed<ScriptRunnerStatus>(
                  statusFromStartingCancellation(
                    starting,
                    outcome.cancellation,
                  ),
                ),
        }),
      );

      yield* completeStarting(starting, status);
    });

    const beginStarting = Effect.fn("ScriptRunner.beginStarting")(function* (
      commandId: number,
      file: ScriptFile,
      inputs: ScriptInputValues,
      restart?: PendingRestart,
      identity?: ScriptRunIdentity,
    ): Effect.fn.Return<StartingScript> {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const id =
            restart?.id ??
            identity?.id ??
            (yield* Ref.updateAndGet(nextIdRef, (value) => value + 1));
          const cancel = yield* Deferred.make<StartingCancellation>();
          const done = yield* Deferred.make<ScriptRunnerStatus>();
          const terminal =
            restart?.terminal ??
            identity?.terminal ??
            (yield* Deferred.make<ScriptRunTerminalOutcome>());
          const starting: StartingScript = {
            cancel,
            commandId,
            done,
            id,
            name: statusName(file),
            ...(file.path === undefined ? {} : { path: file.path }),
            ...(restart === undefined ? {} : { restart }),
            terminal,
          };
          yield* Ref.set(startingRef, starting);
          yield* setStatus({
            ...activeStatusFields(starting),
            startedAt: nowIso(),
            state: "starting",
          });
          yield* runStarting(starting, file, inputs).pipe(Effect.forkDetach);
          return starting;
        }),
      );
    });

    const completePendingRestart = Effect.fn(
      "ScriptRunner.completePendingRestart",
    )(function* (pending: PendingRestart, status: ScriptRunnerStatus) {
      yield* lifecycleGate.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(pendingRestartRef);
          const authoritative =
            current === pending ? status : yield* getStatus();
          if (current === pending) {
            yield* Ref.set(pendingRestartRef, null);
            yield* setStatus(status);
          }
          yield* Deferred.succeed(pending.done, snapshotStatus(authoritative));
          if (status.state === "stopped") {
            yield* Deferred.succeed(
              pending.terminal,
              externalStopOutcome({ ...status }),
            );
          } else if (status.state === "failed") {
            yield* Deferred.succeed(pending.terminal, {
              kind: "failed",
              status: { ...status },
            });
          }
        }),
      );
    });

    const awaitRestartReadiness = Effect.fn(
      "ScriptRunner.awaitRestartReadiness",
    )(function* (pending: PendingRestart) {
      return (
        (yield* wait.untilSome(
          Effect.gen(function* () {
            const options = yield* SubscriptionRef.get(optionsRef);
            if (!options.restartAfterReconnect) {
              return Option.some<RestartReadiness>({ kind: "disabled" });
            }

            const readiness = yield* scriptStartReadiness.get();
            if (!readiness.ready) return Option.none<RestartReadiness>();

            return Option.some<RestartReadiness>({
              kind:
                readiness.username === pending.username
                  ? "ready"
                  : "account-changed",
            });
          }),
          { interval: "250 millis" },
        )) ?? { kind: "disabled" }
      );
    });

    const resumePendingRestart = Effect.fn("ScriptRunner.resumePendingRestart")(
      function* (pending: PendingRestart): Effect.fn.Return<boolean> {
        const result = yield* lifecycleGate.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(pendingRestartRef);
            const latestCommandId = yield* Ref.get(latestCommandIdRef);
            const options = yield* SubscriptionRef.get(optionsRef);
            if (
              current !== pending ||
              latestCommandId !== pending.commandId ||
              !options.restartAfterReconnect
            ) {
              const status = yield* getStatus();
              if (current === pending) {
                const stopped: ScriptRunnerStatus = {
                  state: "stopped",
                  stoppedAt: nowIso(),
                };
                yield* Ref.set(pendingRestartRef, null);
                yield* setStatus(stopped);
                return { kind: "settled", status: stopped } as const;
              }
              return { kind: "settled", status } as const;
            }

            const starting = yield* beginStarting(
              pending.commandId,
              pending.file,
              pending.inputs,
              pending,
            );
            return {
              done: starting.done,
              kind: "starting",
            } as const;
          }),
        );

        const status =
          result.kind === "starting"
            ? yield* awaitStatus(result.done)
            : result.status;
        if (status.state === "waiting-to-restart") {
          return true;
        }
        yield* completePendingRestart(pending, status);
        return false;
      },
    );

    const runPendingRestart = Effect.fn("ScriptRunner.runPendingRestart")(
      function* (
        pending: PendingRestart,
        finalized: Deferred.Deferred<ScriptRunnerStatus>,
      ): Effect.fn.Return<void> {
        yield* awaitStatus(finalized);
        while (true) {
          const outcome = yield* Effect.raceFirst(
            Deferred.await(pending.cancel).pipe(
              Effect.map(
                (cancellation) =>
                  ({ cancellation, kind: "cancelled" }) as const,
              ),
            ),
            awaitRestartReadiness(pending).pipe(
              Effect.map(
                (readiness) => ({ kind: "readiness", readiness }) as const,
              ),
            ),
          );

          if (
            outcome.kind === "readiness" &&
            outcome.readiness.kind === "ready"
          ) {
            if (yield* resumePendingRestart(pending)) continue;
            return;
          }

          const reason =
            outcome.kind === "cancelled"
              ? outcome.cancellation.reason
              : outcome.readiness.kind === "account-changed"
                ? "Account changed"
                : undefined;
          yield* completePendingRestart(pending, {
            ...(reason === undefined ? {} : { reason }),
            state: "stopped",
            stoppedAt: nowIso(),
          });
          return;
        }
      },
    );

    const handleConnectionLoss = Effect.fn("ScriptRunner.handleConnectionLoss")(
      function* (id: number): Effect.fn.Return<void> {
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const result = yield* lifecycleGate.withPermit(
              Effect.gen(function* () {
                const starting = yield* Ref.get(startingRef);
                if (starting?.id === id) {
                  yield* Deferred.succeed(starting.cancel, {
                    reason: "Connection lost",
                    retryAfterReconnect: starting.restart !== undefined,
                  });
                  return null;
                }
                if ((yield* Ref.get(pendingFinalizationRef)) !== null) {
                  return null;
                }

                const active = yield* Ref.get(activeRef);
                if (active?.id !== id) return null;

                const options = yield* SubscriptionRef.get(optionsRef);
                const shouldRestart =
                  options.restartAfterReconnect && active.username !== "";
                const disconnectedAt = nowIso();
                const restart = shouldRestart
                  ? {
                      cancel: yield* Deferred.make<StartingCancellation>(),
                      commandId: active.commandId,
                      disconnectedAt,
                      done: yield* Deferred.make<ScriptRunnerStatus>(),
                      file: { ...active.file },
                      id: active.id,
                      inputs: { ...active.inputs },
                      name: active.name,
                      ...(active.path === undefined
                        ? {}
                        : { path: active.path }),
                      terminal: active.terminal,
                      username: active.username,
                    }
                  : null;
                if (restart !== null) {
                  yield* Ref.set(pendingRestartRef, restart);
                }

                const finalized = yield* beginFinalization(active, {
                  awaitFiber: true,
                  intermediateStatus: {
                    ...activeStatusFields(active),
                    state: "stopping",
                  },
                  interrupt: true,
                  result: () => {
                    if (restart === null) {
                      const status = {
                        state: "stopped",
                        stoppedAt: nowIso(),
                      } as const;
                      return terminalFinalization(externalStopOutcome(status));
                    }
                    return {
                      status: {
                        ...activeStatusFields(restart),
                        disconnectedAt: restart.disconnectedAt,
                        state: "waiting-to-restart",
                      },
                    };
                  },
                });
                return restart === null ? null : { finalized, restart };
              }),
            );

            if (result !== null) {
              yield* runPendingRestart(result.restart, result.finalized).pipe(
                Effect.forkDetach,
              );
            }
          }),
        );
      },
    );

    const installReadinessWatcher = (
      id: number,
      scope: ScriptAsyncScope,
    ): Effect.Effect<StateDisposer> =>
      events
        .on({ type: "connection" }, (event) =>
          isConnectionLoss(event) ? handleConnectionLoss(id) : Effect.void,
        )
        .pipe(Effect.tap((dispose) => scope.addCleanup(dispose)));

    const start: ScriptRunnerShape["start"] = (file, inputs) => {
      const fileSnapshot = { ...file };
      const inputSnapshot = { ...inputs };
      return Effect.gen(function* () {
        const commandId = yield* Ref.updateAndGet(
          latestCommandIdRef,
          (value) => value + 1,
        );
        const identity: ScriptRunIdentity = {
          id: yield* Ref.updateAndGet(nextIdRef, (value) => value + 1),
          terminal: yield* Deferred.make<ScriptRunTerminalOutcome>(),
        };
        yield* protectScriptExecutionUntil(Deferred.await(identity.terminal));
        while (true) {
          const result = yield* lifecycleGate.withPermit(
            Effect.gen(function* () {
              if ((yield* Ref.get(latestCommandIdRef)) !== commandId) {
                const status: Extract<
                  ScriptRunnerStatus,
                  { readonly state: "stopped" }
                > = {
                  reason: "Replaced by another script",
                  state: "stopped",
                  stoppedAt: nowIso(),
                };
                yield* Deferred.succeed(
                  identity.terminal,
                  externalStopOutcome(status),
                );
                return {
                  handle: makeRunHandle(status, identity.terminal),
                  kind: "superseded",
                } as const;
              }

              const restart = yield* cancelPendingRestart(
                "Replaced by another script",
              );
              const starting = yield* Ref.get(startingRef);
              if (starting !== null) {
                yield* Deferred.succeed(starting.cancel, {
                  reason: "Replaced by another script",
                });
                return {
                  done: restart?.done ?? starting.done,
                  kind: "waiting",
                } as const;
              }

              const pending = yield* Ref.get(pendingFinalizationRef);
              if (pending !== null) {
                return {
                  done: restart?.done ?? pending.done,
                  kind: "waiting",
                } as const;
              }

              const active = yield* Ref.get(activeRef);
              if (active !== null) {
                const done = yield* beginFinalization(active, {
                  awaitFiber: true,
                  intermediateStatus: {
                    ...activeStatusFields(active),
                    state: "stopping",
                  },
                  interrupt: true,
                  result: () => {
                    const status = {
                      reason: "Replaced by another script",
                      state: "stopped",
                      stoppedAt: nowIso(),
                    } as const;
                    return terminalFinalization(externalStopOutcome(status));
                  },
                });
                return { done, kind: "waiting" } as const;
              }
              if (restart !== null) {
                return { done: restart.done, kind: "waiting" } as const;
              }

              const started = yield* beginStarting(
                commandId,
                fileSnapshot,
                inputSnapshot,
                undefined,
                identity,
              );
              return {
                started,
                kind: "starting",
              } as const;
            }),
          );

          if (result.kind === "superseded") {
            return result.handle;
          }
          const status = yield* awaitStatus(
            result.kind === "starting" ? result.started.done : result.done,
          );
          if (result.kind === "starting") {
            return makeRunHandle(status, result.started.terminal);
          }
        }
      });
    };

    const stop: ScriptRunnerShape["stop"] = (reason) => stopActive(reason);
    const setRestartAfterReconnect: ScriptRunnerShape["setRestartAfterReconnect"] =
      (enabled) =>
        lifecycleGate.withPermit(
          Effect.gen(function* () {
            const result = yield* setOptions((current) => ({
              ...current,
              restartAfterReconnect: enabled,
            }));
            if (!enabled) {
              yield* cancelPendingRestart();
            }
            return result;
          }),
        );
    const resetOptions = () =>
      lifecycleGate.withPermit(
        Effect.gen(function* () {
          const result = yield* setOptions(() =>
            snapshotScriptRuntimeOptions(DEFAULT_SCRIPT_RUNTIME_OPTIONS),
          );
          yield* cancelPendingRestart();
          return result.options;
        }),
      );

    yield* Effect.addFinalizer(() => stop("shutdown").pipe(Effect.asVoid));

    return ScriptRunner.of({
      bindAccount,
      getOptions,
      getStatus,
      isRunning: () =>
        getStatus().pipe(
          Effect.map(
            (status) =>
              status.state === "running" ||
              status.state === "starting" ||
              status.state === "stopping" ||
              status.state === "waiting-to-restart",
          ),
        ),
      onOptions: (listener) =>
        observe(
          SubscriptionRef.changes(optionsRef),
          snapshotScriptRuntimeOptions,
          listener,
        ),
      onStatus: (listener) =>
        observe(SubscriptionRef.changes(statusRef), snapshotStatus, listener),
      persistOptions: () => setOptions((options) => options),
      resetOptions,
      setOptions,
      setRoomPolicy: (roomPolicy) =>
        setOptions((options) => ({
          ...options,
          roomPolicy: snapshotRoomPolicy(roomPolicy),
        })),
      setRestartAfterReconnect,
      setSafeStartStop: (enabled) =>
        setOptions((options) => ({ ...options, safeStartStop: enabled })),
      start,
      stop,
    });
  }),
);
