import { EventEmitter } from "node:events";
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { app } from "electron";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import type * as Scope from "effect/Scope";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { normalizeAppSettings, type AppSettings } from "@lucent/core/settings";
import { listen } from "../electron/NativeListener";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../shared/logRecord";
import type { MessageBoxReturnValue } from "electron";
import { UpdateReleaseInfo, type UpdateCheckState } from "../../shared/updates";
import {
  ElectronApp,
  type ElectronWillQuitEvent,
} from "../electron/ElectronApp";
import {
  ElectronDialog,
  ElectronDialogMessageBoxError,
} from "../electron/ElectronDialog";
import { ElectronShell } from "../electron/ElectronShell";
import { ElectronTheme, ElectronThemeError } from "../electron/ElectronTheme";
import { GitHubCredentials } from "../scripting/GitHubCredentials";
import * as AccountSessions from "../game/accounts/AccountSessions";
import { AccountSettingsRepository } from "../game/account-settings/AccountSettingsRepository";
import { Accounts } from "../game/accounts/Accounts";
import { ArmyConfigRepository } from "../game/army/ArmyConfigRepository";
import { ArmyCoordinator } from "../game/army/ArmyCoordinator";
import { ArmyLoopTauntOrchestrator } from "../game/army/ArmyLoopTauntOrchestrator";
import { CombatProfiles } from "../game/combat-profiles/CombatProfiles";
import { GameEnvironments } from "../game/environment/GameEnvironments";
import { GameFollowers } from "../game/follower/GameFollowers";
import { GamePackets } from "../game/packets/GamePackets";
import { GameRendererRpc } from "../game/rpc/GameRendererRpc";
import { DesktopIpc, makeDesktopIpc } from "../ipc/DesktopIpc";
import { DesktopIpcSenders } from "../ipc/DesktopIpcSenders";
import { DesktopScriptLibrary } from "../scripting/DesktopScriptLibrary";
import { ScriptFileSystem } from "../scripting/ScriptFileSystem";
import { ScriptHttp } from "../scripting/ScriptHttp";
import { ScriptInputRepository } from "../scripting/ScriptInputRepository";
import { ScriptPackageCatalog } from "../scripting/ScriptPackageCatalog";
import { ScriptPackageManager } from "../scripting/ScriptPackageManager";
import { ScriptPackageState } from "../scripting/ScriptPackageState";
import { ScriptWorkspace } from "../scripting/ScriptWorkspace";
import { DesktopSettings } from "../settings/DesktopSettings";
import { DesktopUpdates } from "../updates/DesktopUpdates";
import { DesktopApplicationMenu } from "../window/DesktopApplicationMenu";
import { DesktopWindows } from "../window/DesktopWindows";
import { DesktopEnvironment } from "./DesktopEnvironment";
import { DesktopGameRendererRecovery } from "./DesktopGameRendererRecovery";
import {
  installDesktopNativeAppearanceSync,
  makeDesktopRuntime,
} from "./DesktopRuntime";
import { makeListenerRegistry } from "./ListenerRegistry";
import {
  DesktopObservability,
  layer as desktopObservabilityLayer,
} from "./observability/DesktopObservability";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter(), ipcMain: new EventEmitter() };
});

describe("desktop native appearance sync", () => {
  it.effect.each(["typed", "defect"] as const)(
    "isolates %s appearance failures without adding listener errors",
    (kind) =>
      Effect.gen(function* () {
        const changes = makeListenerRegistry<AppSettings>();
        const received: string[] = [];
        const records: unknown[] = [];
        const initial = normalizeAppSettings({
          appearance: { themeMode: "light" },
        });
        const changed = normalizeAppSettings({
          appearance: { themeMode: "dark" },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installDesktopNativeAppearanceSync(initial);
            yield* changes.subscribe((settings) => {
              received.push(settings.appearance.themeMode);
            });
            yield* changes.publish(changed);
            yield* Effect.promise(() => yieldToEventLoop());
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(DesktopSettings, { onChanged: changes.subscribe }),
                Layer.mock(ElectronTheme, {
                  setThemeMode: (mode) =>
                    mode === "light"
                      ? Effect.void
                      : kind === "typed"
                        ? Effect.fail(
                            new ElectronThemeError({
                              cause: new Error("Native appearance failed"),
                              themeMode: mode,
                            }),
                          )
                        : Effect.die(new Error("Native appearance defect")),
                  shouldUseDarkColors: Effect.succeed(false),
                }),
                Layer.mock(DesktopWindows, {
                  setBackgroundColor: () => Effect.void,
                }),
                Logger.layer([
                  Logger.make((options) => {
                    records.push({
                      level: options.logLevel,
                      message: options.message,
                    });
                  }),
                ]),
              ),
            ),
          ),
        );
        expect(received).toEqual(["dark"]);
        expect(records).toEqual(
          kind === "typed"
            ? [
                {
                  level: "Warn",
                  message: ["Failed to update Electron native appearance"],
                },
              ]
            : [],
        );
      }),
  );

  it.effect("awaits native appearance through listener publication", () =>
    Effect.gen(function* () {
      const changes = makeListenerRegistry<AppSettings>();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events: string[] = [];
      const initial = normalizeAppSettings({
        appearance: { themeMode: "light" },
      });
      const changed = normalizeAppSettings({
        appearance: { themeMode: "dark" },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installDesktopNativeAppearanceSync(initial);
          yield* changes.subscribe(() => {
            events.push("listener");
          });
          const publication = yield* changes
            .publish(changed)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
          expect(events).toEqual(["appearance started"]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(publication);
          expect(events).toEqual([
            "appearance started",
            "appearance finished",
            "listener",
          ]);
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(DesktopSettings, { onChanged: changes.subscribe }),
              Layer.mock(ElectronTheme, {
                setThemeMode: (mode) =>
                  mode === "light"
                    ? Effect.void
                    : Effect.gen(function* () {
                        events.push("appearance started");
                        yield* Deferred.succeed(started, undefined);
                        yield* Deferred.await(release);
                        events.push("appearance finished");
                      }),
                shouldUseDarkColors: Effect.succeed(false),
              }),
              Layer.mock(DesktopWindows, {
                setBackgroundColor: () => Effect.void,
              }),
            ),
          ),
        ),
      );
    }),
  );
});

const availableUpdate: UpdateCheckState = {
  status: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  checkedAt: "2026-01-01T00:00:00.000Z",
  release: new UpdateReleaseInfo({
    version: "1.1.0",
    tagName: "v1.1.0",
    htmlUrl: "https://github.com/toommyliu/lucent/releases/tag/v1.1.0",
  }),
};

const originalSecondArgv = [
  "/Electron",
  "/Lucent",
  "--launch-mode",
  "account-manager",
];
const reorderedSecondArgv = [
  "/Electron",
  "--launch-mode",
  "--allow-file-access-from-files",
  "--no-sandbox",
  "/Lucent",
  "account-manager",
];

const servicesStartupNeverCalls = Layer.mergeAll(
  AccountSessions.layer,
  Layer.mock(AccountSettingsRepository, {}),
  Layer.mock(ArmyConfigRepository, {}),
  Layer.mock(DesktopIpcSenders, {}),
  Layer.mock(DesktopScriptLibrary, {}),
  Layer.mock(ElectronShell, {}),
  Layer.mock(GameEnvironments, {}),
  Layer.mock(GameFollowers, {}),
  Layer.mock(GamePackets, {}),
  Layer.mock(GameRendererRpc, {}),
  Layer.mock(GitHubCredentials, {}),
  Layer.mock(ScriptFileSystem, {}),
  Layer.mock(ScriptHttp, {}),
  Layer.mock(ScriptInputRepository, {}),
  Layer.mock(ScriptPackageManager, {}),
  Layer.mock(ScriptPackageState, {}),
);

const makeStartup = (options: {
  readonly captureSignals?: boolean;
  readonly synchronousQuit?: boolean;
  readonly realLog?: boolean;
  readonly initialLaunchMode?: "game" | "account-manager";
  readonly cliLaunchMode?: "game" | "account-manager";
  readonly launchMode?: "game" | "account-manager";
  readonly initialize?: Effect.Effect<void>;
  readonly build?: Effect.Effect<void, never, Scope.Scope>;
  readonly checkNow: Effect.Effect<UpdateCheckState>;
  readonly parentWindowId?: Effect.Effect<number | undefined>;
  readonly showMessageBox: Effect.Effect<
    MessageBoxReturnValue,
    ElectronDialogMessageBoxError
  >;
}) => {
  const events: string[] = [];
  const records: DesktopLogRecord[] = [];
  const dialogParents: (number | undefined)[] = [];
  const dialogFailed = Deferred.makeUnsafe<void>();
  const directory = mkdtempSync(join(tmpdir(), "lucent-runtime-"));
  const parentWindowId = options.parentWindowId ?? Effect.succeed(42);
  const appEvents = new EventEmitter();
  const openedWindows: string[] = [];
  const ipcHandlers = new Set<string>();

  const emitWillQuit = (): void => {
    let defaultPrevented = false;
    const event: ElectronWillQuitEvent = {
      preventDefault: () => {
        defaultPrevented = true;
      },
    };
    appEvents.emit("will-quit", event);
    if (!defaultPrevented) {
      events.push("electron-terminated");
    }
  };

  const appLayer = Layer.mock(ElectronApp, {
    exit: (code) =>
      Effect.sync(() => {
        events.push(`exit:${code}`);
      }),
    on: (eventName, listener) => listen(appEvents, eventName, listener),
    getVersion: Effect.succeed("1.2.3"),
    whenReady: Effect.void,
    quit: options.synchronousQuit ? Effect.sync(emitWillQuit) : Effect.void,
  });
  const diagnostics = Layer.mergeAll(
    Layer.succeed(References.MinimumLogLevel, "Debug"),
    Logger.layer([
      Logger.make((log) => {
        records.push(desktopLogRecord(log));
        if (String(log.message) === "Failed to show startup update dialog") {
          events.push("dialog-failed");
          Deferred.doneUnsafe(dialogFailed, Exit.void);
        }
        if (
          options.captureSignals &&
          String(log.message) === "Received termination signal"
        ) {
          events.push("termination-signal");
        }
        if (log.logLevel === "Error") {
          events.push(`error:${String(log.message)}`);
        }
      }),
    ]),
    Layer.succeed(
      DesktopObservability,
      DesktopObservability.of({
        setSessionStop: () => Effect.void,
        flush: Effect.sync(() => {
          events.push("flush");
        }),
        installProcessHooks: Effect.void,
        logFilePath: join(directory, "lucent.log"),
      }),
    ),
  );

  const environment = Layer.succeed(
    DesktopEnvironment,
    DesktopEnvironment.of({
      appDataDir: directory,
      assetsDir: join(directory, "assets"),
      isDev: false,
      platform: "darwin",
      workspaceDir: join(directory, "workspace"),
    }),
  );
  const logging = options.realLog
    ? desktopObservabilityLayer.pipe(Layer.provide(environment))
    : diagnostics;
  const layer = Layer.mergeAll(
    servicesStartupNeverCalls,
    NodeFileSystem.layer,
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("cleanup");
        }),
      ),
    ),
    appLayer,
    Layer.effectDiscard(options.build ?? Effect.void),
    environment,
    Layer.succeed(
      DesktopIpc,
      makeDesktopIpc(
        {
          handle: (channel) => {
            ipcHandlers.add(channel);
          },
          removeHandler: (channel) => {
            ipcHandlers.delete(channel);
          },
        },
        { getAllWebContents: () => [], fromId: () => undefined },
      ),
    ),
    Layer.mock(DesktopSettings, {
      load: Effect.succeed(
        normalizeAppSettings({
          preferences: {
            checkForUpdates: true,
            launchMode: options.initialLaunchMode ?? "game",
          },
        }),
      ),
      get: Effect.sync(() =>
        normalizeAppSettings({
          preferences: {
            checkForUpdates: true,
            launchMode: options.launchMode ?? "game",
          },
        }),
      ),
      onChanged: () => Effect.void,
    }),
    Layer.mock(DesktopUpdates, {
      checkNow: () => options.checkNow,
      onStateChanged: () => Effect.void,
      shouldPromptForAvailableRelease: () => Effect.succeed(true),
      skipAvailableRelease: (version) =>
        Effect.sync(() => {
          events.push(`skip:${version}`);
          return true;
        }),
    }),
    Layer.mock(ElectronDialog, {
      showMessageBox: (_, parentWindowId) => {
        dialogParents.push(parentWindowId);
        return options.showMessageBox;
      },
    }),
    Layer.mock(ElectronTheme, {
      setThemeMode: () => Effect.void,
      shouldUseDarkColors: Effect.succeed(false),
    }),
    Layer.mock(DesktopWindows, {
      observe: () => Effect.void,
      open: (kind) =>
        Effect.sync(() => {
          openedWindows.push(kind);
          return 1;
        }),
      getVisibleParentWindowId: parentWindowId,
      isVisibleParentWindow: (windowId) =>
        parentWindowId.pipe(Effect.map((id) => id === windowId)),
      setBackgroundColor: () => Effect.void,
    }),
    Layer.mock(DesktopApplicationMenu, { install: Effect.void }),
    Layer.mock(DesktopGameRendererRecovery, { install: Effect.void }),
    Layer.mock(ScriptWorkspace, {
      initialize: options.initialize ?? Effect.void,
    }),
    Layer.mock(ScriptPackageCatalog, {
      onChanged: () => Effect.void,
      refresh: Effect.succeed({ packages: [], revision: "r0", scriptCount: 0 }),
    }),
    Layer.mock(Accounts, { onChanged: () => Effect.void }),
    Layer.mock(CombatProfiles, { onChanged: () => Effect.void }),
    Layer.mock(ArmyCoordinator, { onSessionEnded: () => Effect.void }),
    Layer.mock(ArmyLoopTauntOrchestrator, { onCommand: () => Effect.void }),
  );

  const run = makeDesktopRuntime(
    options.cliLaunchMode === undefined
      ? {}
      : { launchMode: options.cliLaunchMode },
    layer,
    logging,
  ).pipe(Effect.provide(appLayer));
  const readLog = () =>
    readFileSync(join(directory, "logs", "lucent.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DesktopLogRecord);
  const quitDuringStartup = (
    waitingOn: Deferred.Deferred<void>,
    onReady: Effect.Effect<void> = Effect.void,
    afterDeadline?: Effect.Effect<void>,
    requestQuit: () => void = emitWillQuit,
  ) =>
    Effect.gen(function* () {
      const runtime = yield* Effect.forkDetach(
        run.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              events.push("runtime-settled");
            }),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        yield* Deferred.await(waitingOn);
        yield* Effect.promise(() => yieldToEventLoop());
        yield* onReady;
        requestQuit();
        yield* Effect.promise(() =>
          vi
            .waitUntil(() => events.includes("runtime-settled"), {
              interval: 5,
              timeout: 1_000,
            })
            .catch(() => undefined),
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_500));
        if (afterDeadline !== undefined) {
          yield* afterDeadline;
          yield* Fiber.join(runtime);
        }
        return [...events];
      }).pipe(Effect.ensuring(Fiber.interrupt(runtime)));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (options.realLog) records.push(...readLog());
          rmSync(directory, { recursive: true, force: true });
        }),
      ),
    );

  const secondInstance = (argv: readonly string[], additionalData?: unknown) =>
    appEvents.emit("second-instance", {}, argv, "/tmp", additionalData);
  return {
    quitDuringStartup,
    events,
    run,
    readLog,
    directory,
    records,
    dialogParents,
    openedWindows,
    dialogFailed,
    secondInstance,
    appEvents,
    emitWillQuit,
    ipcHandlers,
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("makeDesktopRuntime", () => {
  it.live(
    "writes distinct renderer failures and clean exits without debug",
    () =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const startup = makeStartup({
          realLog: true,
          checkNow: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          showMessageBox: Effect.never,
        });
        yield* startup.quitDuringStartup(
          checking,
          Effect.sync(() => {
            const first = Object.assign(new EventEmitter(), { id: 42 });
            const second = Object.assign(new EventEmitter(), { id: 43 });
            app.emit("web-contents-created", {}, first);
            app.emit("web-contents-created", {}, second);
            app.emit("render-process-gone", {}, first, {
              reason: "crashed",
              exitCode: 1,
            });
            app.emit("render-process-gone", {}, second, {
              reason: "crashed",
              exitCode: 1,
            });
            app.emit("render-process-gone", {}, first, {
              reason: "oom",
              exitCode: 2,
            });
            app.emit("render-process-gone", {}, first, {
              reason: "clean-exit",
              exitCode: 0,
            });
            first.emit("did-fail-load", {}, -3, "ERR_ABORTED", "", true);
            first.emit(
              "did-fail-load",
              {},
              -7,
              "ERR_TIMED_OUT",
              "https://example.com/game?token=private",
              true,
            );
            first.emit(
              "did-fail-load",
              {},
              -105,
              "ERR_NAME_NOT_RESOLVED",
              "https://example.com/game?token=private",
              true,
            );
            second.emit(
              "did-fail-load",
              {},
              -7,
              "ERR_TIMED_OUT",
              "https://example.com/game?token=private",
              true,
            );
          }).pipe(Effect.andThen(Effect.yieldNow)),
        );
        expect(
          startup.records
            .filter((record) => record.component === "renderer")
            .map(({ level, message, data }) => ({ level, message, data })),
        ).toEqual([
          {
            level: "error",
            message: "Renderer process gone",
            data: { rendererId: 42, reason: "crashed", exitCode: 1 },
          },
          {
            level: "error",
            message: "Renderer process gone",
            data: { rendererId: 43, reason: "crashed", exitCode: 1 },
          },
          {
            level: "error",
            message: "Renderer process gone",
            data: { rendererId: 42, reason: "oom", exitCode: 2 },
          },
          {
            level: "info",
            message: "Renderer process gone",
            data: { rendererId: 42, reason: "clean-exit", exitCode: 0 },
          },
          {
            level: "warn",
            message: "Renderer load failed",
            data: {
              rendererId: 42,
              errorCode: -7,
              errorDescription: "ERR_TIMED_OUT",
              isMainFrame: true,
              host: "example.com",
            },
          },
          {
            level: "warn",
            message: "Renderer load failed",
            data: {
              rendererId: 42,
              errorCode: -105,
              errorDescription: "ERR_NAME_NOT_RESOLVED",
              isMainFrame: true,
              host: "example.com",
            },
          },
          {
            level: "warn",
            message: "Renderer load failed",
            data: {
              rendererId: 43,
              errorCode: -7,
              errorDescription: "ERR_TIMED_OUT",
              isMainFrame: true,
              host: "example.com",
            },
          },
        ]);
      }),
  );

  it.live.each([
    { initialLaunchMode: "account-manager" },
    { initialLaunchMode: "game", cliLaunchMode: "account-manager" },
  ] as const)(
    "writes resolved session metadata and a terminal clean stop on a fast disk %#",
    (modes) =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const startup = makeStartup({
          ...modes,
          realLog: true,
          build: Effect.addFinalizer(() =>
            Effect.logInfo("Cleanup completed").pipe(
              Effect.andThen(Effect.logInfo("Cleanup completed")),
            ),
          ),
          checkNow: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          showMessageBox: Effect.never,
        });
        expect(yield* startup.quitDuringStartup(checking)).toEqual([
          "cleanup",
          "runtime-settled",
        ]);
        const start = startup.records.filter(
          (record) => record.message === "Lucent desktop runtime starting",
        );
        expect(start).toEqual([
          {
            at: expect.any(String),
            level: "info",
            component: "startup",
            message: "Lucent desktop runtime starting",
            data: {
              version: "1.2.3",
              platform: "darwin",
              arch: process.arch,
              isDev: false,
              launchMode: "account-manager",
              debug: false,
              pid: process.pid,
              appDataDir: startup.directory,
              logFilePath: join(startup.directory, "logs", "lucent.log"),
              workspaceDir: join(startup.directory, "workspace"),
            },
          },
        ]);
        expect(startup.records.slice(-2)).toEqual([
          {
            at: expect.any(String),
            level: "info",
            component: "effect",
            message: "Cleanup completed",
            suppressed: 1,
            lastAt: expect.any(String),
          },
          {
            at: expect.any(String),
            level: "info",
            component: "lifecycle",
            message: "Lucent desktop runtime stopped",
            data: {
              source: "will-quit",
              uptimeMs: expect.any(Number),
              outcome: "clean",
            },
          },
        ]);
      }),
  );

  it.live.each(["layer", "startup"] as const)(
    "writes %s failure to lucent.log without a clean stop",
    (stage) =>
      Effect.gen(function* () {
        const failure = Effect.die(new Error("startup exploded"));
        const startup = makeStartup({
          realLog: true,
          build: stage === "layer" ? failure : Effect.void,
          initialize: stage === "startup" ? failure : Effect.void,
          checkNow: Effect.never,
          showMessageBox: Effect.never,
        });
        expect(yield* startup.run).toBe(1);
        const records = startup.readLog();
        expect(
          records.filter(
            (record) => record.message === "Lucent desktop runtime failed",
          ),
        ).toEqual([
          {
            at: expect.any(String),
            level: "error",
            component: "startup",
            message: "Lucent desktop runtime failed",
            error: [
              {
                name: "Error",
                message: "startup exploded",
                stack: expect.any(String),
              },
            ],
          },
        ]);
        expect(
          records.filter(
            (record) => record.message === "Lucent desktop runtime stopped",
          ),
        ).toEqual([]);
        rmSync(startup.directory, { recursive: true, force: true });
      }),
  );

  it.live(
    "keeps the initiating signal when app.quit synchronously emits will-quit",
    () =>
      Effect.gen(function* () {
        const previous = new Set(process.listeners("SIGTERM"));
        const checking = yield* Deferred.make<void>();
        const startup = makeStartup({
          realLog: true,
          synchronousQuit: true,
          checkNow: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          showMessageBox: Effect.never,
        });
        yield* startup.quitDuringStartup(
          checking,
          Effect.void,
          undefined,
          () => {
            const listener = process
              .listeners("SIGTERM")
              .find((entry) => !previous.has(entry));
            if (listener === undefined)
              throw new Error("SIGTERM listener is missing");
            listener("SIGTERM");
          },
        );
        expect(startup.records.at(-1)).toEqual({
          at: expect.any(String),
          level: "info",
          component: "lifecycle",
          message: "Lucent desktop runtime stopped",
          data: {
            source: "SIGTERM",
            uptimeMs: expect.any(Number),
            outcome: "clean",
          },
        });
        expect(
          startup.records.filter(
            (record) => record.message === "Received termination signal",
          ),
        ).toEqual([]);
      }),
  );

  it.live(
    "does not write a clean stop after cleanup reaches the forced exit deadline",
    () =>
      Effect.gen(function* () {
        const building = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const startup = makeStartup({
          realLog: true,
          build: Effect.addFinalizer(() => Deferred.await(releaseCleanup)).pipe(
            Effect.andThen(Deferred.succeed(building, undefined)),
            Effect.andThen(Effect.never),
          ),
          checkNow: Effect.never,
          showMessageBox: Effect.never,
        });
        const events = yield* startup.quitDuringStartup(
          building,
          Effect.void,
          Deferred.succeed(releaseCleanup, undefined).pipe(Effect.asVoid),
        );
        expect(events).toEqual(["exit:0", "cleanup", "runtime-settled"]);
        expect(startup.records).toEqual([
          {
            at: expect.any(String),
            level: "error",
            component: "lifecycle",
            message: "Lucent quit timed out; forcing exit",
            data: { source: "will-quit", timeoutMs: 1500 },
          },
        ]);
      }),
  );

  it.live(
    "logs a cleanup defect without writing a clean stop when quit wins the race",
    () =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const startup = makeStartup({
          realLog: true,
          build: Effect.addFinalizer(() =>
            Effect.die(new Error("cleanup exploded")),
          ),
          checkNow: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          showMessageBox: Effect.never,
        });
        const running = yield* Effect.forkDetach(startup.run);
        yield* Deferred.await(checking);
        startup.emitWillQuit();
        expect(yield* Fiber.join(running)).toBe(0);
        const records = startup.readLog();
        expect(records.at(-1)).toEqual({
          at: expect.any(String),
          level: "error",
          component: "lifecycle",
          message: "Lucent shutdown failed",
          error: [
            {
              name: "Error",
              message: "cleanup exploded",
              stack: expect.any(String),
            },
          ],
        });
        expect(
          records.filter(
            (record) => record.message === "Lucent desktop runtime stopped",
          ),
        ).toEqual([]);
        rmSync(startup.directory, { recursive: true, force: true });
      }),
  );

  it.live.each([
    "every append after quit",
    "periodic drain",
    "final stop append",
  ])("forces exit within 1750 ms when %s stalls", (stalledStep) =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const appendStarted = yield* Deferred.make<void>();
      const releaseAppend = Promise.withResolvers<void>();
      let quitting = false;
      const appendFile = fs.appendFile;
      vi.spyOn(fs, "appendFile").mockImplementation(
        async (path, data, options) => {
          if (
            quitting &&
            (stalledStep !== "final stop append" ||
              String(data).includes("Lucent desktop runtime stopped"))
          ) {
            Deferred.doneUnsafe(appendStarted, Exit.void);
            await releaseAppend.promise;
          }
          await appendFile(path, data, options);
        },
      );
      const startup = makeStartup({
        realLog: true,
        build: Effect.addFinalizer(() => Effect.logInfo("Cleanup completed")),
        checkNow: Deferred.succeed(checking, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
        showMessageBox: Effect.never,
      });
      const running = yield* Effect.forkDetach(startup.run);
      yield* Effect.gen(function* () {
        yield* Deferred.await(checking);
        quitting = true;
        if (stalledStep === "periodic drain") {
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
        }
        startup.emitWillQuit();
        yield* Deferred.await(appendStarted);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_499));
        expect(startup.events).toEqual(["cleanup"]);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(250));
        expect(startup.events).toEqual(["cleanup"]);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
        expect(startup.events).toEqual(["cleanup", "exit:0"]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => releaseAppend.resolve()).pipe(
            Effect.andThen(Fiber.await(running)),
            Effect.andThen(
              Effect.sync(() => {
                rmSync(startup.directory, { recursive: true, force: true });
              }),
            ),
          ),
        ),
      );
    }),
  );

  it.live(
    "does not write a clean stop when the drain recovers after the quit deadline",
    () =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const appendStarted = yield* Deferred.make<void>();
        const releaseAppend = Promise.withResolvers<void>();
        const appendFile = fs.appendFile;
        let quitting = false;
        vi.spyOn(fs, "appendFile").mockImplementation(
          async (path, data, options) => {
            if (quitting) {
              Deferred.doneUnsafe(appendStarted, Exit.void);
              await releaseAppend.promise;
            }
            await appendFile(path, data, options);
          },
        );
        const startup = makeStartup({
          realLog: true,
          build: Effect.addFinalizer(() => Effect.logInfo("Cleanup completed")),
          checkNow: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          showMessageBox: Effect.never,
        });
        const running = yield* Effect.forkDetach(startup.run);
        yield* Effect.gen(function* () {
          yield* Deferred.await(checking);
          quitting = true;
          startup.emitWillQuit();
          yield* Deferred.await(appendStarted);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_500));
          expect(startup.events).toEqual(["cleanup"]);
          releaseAppend.resolve();
          expect(yield* Fiber.join(running)).toBe(0);
          yield* Effect.promise(() =>
            vi.waitUntil(() => startup.events.includes("exit:0")),
          );
          expect(startup.events).toEqual(["cleanup", "exit:0"]);
          const records = startup.readLog();
          expect(records.at(-1)).toEqual({
            at: expect.any(String),
            level: "error",
            component: "lifecycle",
            message: "Lucent quit timed out; forcing exit",
            data: { source: "will-quit", timeoutMs: 1500 },
          });
          expect(
            records.filter(
              (record) => record.message === "Lucent desktop runtime stopped",
            ),
          ).toEqual([]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => releaseAppend.resolve()).pipe(
              Effect.andThen(Fiber.await(running)),
              Effect.andThen(
                Effect.sync(() =>
                  rmSync(startup.directory, { recursive: true, force: true }),
                ),
              ),
            ),
          ),
        );
      }),
  );

  it.live.each([
    { state: availableUpdate, level: "debug", data: { status: "available" } },
    {
      state: {
        status: "current",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
      level: "debug",
      data: { status: "current" },
    },
    {
      state: {
        status: "error",
        currentVersion: "1.0.0",
        checkedAt: "2026-01-01T00:00:00.000Z",
        message: "offline",
      },
      level: "debug",
      data: { status: "error" },
    },
  ] as const)(
    "logs startup update status $data.status at $level",
    ({ state, level, data }) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        const startup = makeStartup({
          checkNow: Effect.succeed(state),
          parentWindowId: Deferred.succeed(completed, undefined).pipe(
            Effect.as(84),
          ),
          showMessageBox: Effect.never,
        });
        yield* startup.quitDuringStartup(completed);
        expect(
          startup.records.filter(
            (record) => record.message === "Startup update check completed",
          ),
        ).toEqual([
          {
            at: expect.any(String),
            level,
            component: "updates",
            message: "Startup update check completed",
            data,
          },
        ]);
      }),
  );

  it.live(
    "releases startup handlers before layer cleanup and guards repeated quit during cleanup",
    () =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const handlersDuringCleanup: boolean[] = [];
        const startup = makeStartup({
          build: Effect.addFinalizer(() =>
            Effect.gen(function* () {
              handlersDuringCleanup.push(
                startup.ipcHandlers.has("desktop:settings:get"),
              );
              yield* Deferred.succeed(cleanupStarted, undefined);
              yield* Deferred.await(releaseCleanup);
            }),
          ),
          checkNow: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          showMessageBox: Effect.never,
        });
        const watchCleanup = Effect.gen(function* () {
          expect(startup.ipcHandlers.has("desktop:settings:get")).toBe(true);
          yield* Effect.gen(function* () {
            yield* Deferred.await(cleanupStarted);
            startup.emitWillQuit();
            yield* Deferred.succeed(releaseCleanup, undefined);
          }).pipe(Effect.forkChild);
        });
        const events = yield* startup.quitDuringStartup(checking, watchCleanup);
        expect(handlersDuringCleanup).toEqual([false]);
        expect(events).toEqual(["cleanup", "runtime-settled"]);
        expect(startup.ipcHandlers.size).toBe(0);
      }),
  );

  it.live(
    "cancels a layer build on a signal without waiting for will-quit",
    () =>
      Effect.gen(function* () {
        const previous = new Set(process.listeners("SIGTERM"));
        const building = yield* Deferred.make<void>();
        const startup = makeStartup({
          captureSignals: true,
          build: Deferred.succeed(building, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          checkNow: Effect.never,
          showMessageBox: Effect.never,
        });
        const signal = () => {
          const listener = process
            .listeners("SIGTERM")
            .find((entry) => !previous.has(entry));
          if (listener === undefined)
            throw new Error("SIGTERM listener is missing");
          listener("SIGTERM");
        };

        const events = yield* startup.quitDuringStartup(
          building,
          Effect.void,
          undefined,
          signal,
        );

        expect(events).toEqual(["cleanup", "runtime-settled"]);
        expect(
          startup.records.filter(
            (record) => record.message === "Received termination signal",
          ),
        ).toEqual([]);
        expect(startup.appEvents.listenerCount("will-quit")).toBe(0);
      }),
  );

  it.live("logs and flushes the deadline during unfinished layer cleanup", () =>
    Effect.gen(function* () {
      const building = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const startup = makeStartup({
        build: Effect.addFinalizer(() => Deferred.await(releaseCleanup)).pipe(
          Effect.andThen(Deferred.succeed(building, undefined)),
          Effect.andThen(Effect.never),
        ),
        checkNow: Effect.never,
        showMessageBox: Effect.never,
      });

      const events = yield* startup.quitDuringStartup(
        building,
        Effect.void,
        Deferred.succeed(releaseCleanup, undefined).pipe(Effect.asVoid),
      );

      expect(events).toEqual([
        "error:Lucent quit timed out; forcing exit",
        "flush",
        "exit:0",
        "cleanup",
        "runtime-settled",
      ]);
    }),
  );

  it.live("guards quit while the desktop layer is still building", () =>
    Effect.gen(function* () {
      const building = yield* Deferred.make<void>();
      let buildCleanedUp = false;
      const startup = makeStartup({
        build: Effect.addFinalizer(() =>
          Effect.sync(() => {
            buildCleanedUp = true;
          }),
        ).pipe(
          Effect.andThen(Deferred.succeed(building, undefined)),
          Effect.andThen(Effect.never),
        ),
        checkNow: Effect.never,
        showMessageBox: Effect.never,
      });

      const events = yield* startup.quitDuringStartup(building);

      expect(events).toEqual(["cleanup", "runtime-settled"]);
      expect(buildCleanedUp).toBe(true);
    }),
  );

  it.live("interrupts a pending workspace initialization on quit", () =>
    Effect.gen(function* () {
      const initializing = yield* Deferred.make<void>();
      let initializeCleanedUp = false;
      const startup = makeStartup({
        initialize: Deferred.succeed(initializing, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              initializeCleanedUp = true;
            }),
          ),
        ),
        checkNow: Effect.never,
        showMessageBox: Effect.never,
      });

      const events = yield* startup.quitDuringStartup(initializing);

      expect(events).toEqual(["cleanup", "runtime-settled"]);
      expect(initializeCleanedUp).toBe(true);
    }),
  );

  it.live("captures a second launch while the desktop layer builds", () =>
    Effect.gen(function* () {
      const building = yield* Deferred.make<void>();
      const built = yield* Deferred.make<void>();
      const startup = makeStartup({
        build: Deferred.succeed(building, undefined).pipe(
          Effect.andThen(Deferred.await(built)),
        ),
        checkNow: Effect.never,
        showMessageBox: Effect.never,
      });
      const launch = Effect.gen(function* () {
        startup.secondInstance(reorderedSecondArgv, {
          argv: originalSecondArgv,
        });
        yield* Deferred.succeed(built, undefined);
        yield* Effect.promise(() =>
          vi
            .waitUntil(() => startup.openedWindows.length === 2, {
              timeout: 100,
              interval: 5,
            })
            .catch(() => undefined),
        );
      });

      const events = yield* startup.quitDuringStartup(building, launch);

      expect(startup.openedWindows).toEqual(["game", "account-manager"]);
      expect(events).toEqual(["cleanup", "runtime-settled"]);
    }),
  );

  it.live("queues a second launch until startup can open windows", () =>
    Effect.gen(function* () {
      const initializing = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const startup = makeStartup({
        initialize: Deferred.succeed(initializing, undefined).pipe(
          Effect.andThen(Deferred.await(ready)),
        ),
        checkNow: Effect.never,
        showMessageBox: Effect.never,
      });
      const launch = Effect.gen(function* () {
        startup.secondInstance(reorderedSecondArgv, {
          argv: originalSecondArgv,
        });
        yield* Effect.yieldNow;
        expect(startup.openedWindows).toEqual([]);
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.promise(() =>
          vi
            .waitUntil(() => startup.openedWindows.length === 2, {
              timeout: 100,
              interval: 5,
            })
            .catch(() => undefined),
        );
      });

      const events = yield* startup.quitDuringStartup(initializing, launch);

      expect(startup.openedWindows).toEqual(["game", "account-manager"]);
      expect(events).toEqual(["cleanup", "runtime-settled"]);
    }),
  );

  for (const { name, argv, additionalData, launchMode } of [
    {
      name: "original arguments after Chromium reorders switches",
      argv: reorderedSecondArgv,
      additionalData: { argv: originalSecondArgv },
      launchMode: "game" as const,
    },
    {
      name: "saved preference with no launch flag",
      argv: ["/Electron", "/Lucent"],
      additionalData: undefined,
      launchMode: "account-manager" as const,
    },
    {
      name: "fallback argv when additional data is not a string array",
      argv: ["/Electron", "--launch-mode=account-manager", "/Lucent"],
      additionalData: { argv: [123] },
      launchMode: "game" as const,
    },
  ]) {
    it.live(`opens a second launch using ${name}`, () =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const startup = makeStartup({
          launchMode,
          checkNow: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          showMessageBox: Effect.never,
        });
        const launch = Effect.gen(function* () {
          startup.secondInstance(argv, additionalData);
          yield* Effect.promise(() =>
            vi
              .waitUntil(() => startup.openedWindows.length === 2, {
                timeout: 100,
                interval: 5,
              })
              .catch(() => undefined),
          );
        });

        const events = yield* startup.quitDuringStartup(checking, launch);

        expect(startup.openedWindows).toEqual(["game", "account-manager"]);
        expect(events).toEqual(["cleanup", "runtime-settled"]);
        expect(startup.appEvents.listenerCount("second-instance")).toBe(0);
      }),
    );
  }

  it.live("ignores second launches after before-quit", () =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const startup = makeStartup({
        checkNow: Deferred.succeed(checking, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
        showMessageBox: Effect.never,
      });
      const launch = Effect.gen(function* () {
        startup.appEvents.emit("before-quit");
        startup.secondInstance([
          "/Electron",
          "--launch-mode=account-manager",
          "/Lucent",
        ]);
        yield* Effect.promise(() => yieldToEventLoop());
      });
      const events = yield* startup.quitDuringStartup(checking, launch);
      expect(startup.openedWindows).toEqual(["game"]);
      expect(events).toEqual(["cleanup", "runtime-settled"]);
    }),
  );

  it.live(
    "skips the automatic prompt when its parent closed during the check",
    () =>
      Effect.gen(function* () {
        const resolved = yield* Deferred.make<void>();
        const startup = makeStartup({
          checkNow: Deferred.succeed(resolved, undefined).pipe(
            Effect.as(availableUpdate),
          ),
          parentWindowId: Effect.succeed(undefined),
          showMessageBox: Effect.never,
        });

        const events = yield* startup.quitDuringStartup(resolved);

        expect(events).toEqual(["cleanup", "runtime-settled"]);
        expect(startup.dialogParents).toEqual([]);
      }),
  );

  it.live("uses another visible window after the startup window closes", () =>
    Effect.gen(function* () {
      const dialogOpen = yield* Deferred.make<void>();
      const startup = makeStartup({
        checkNow: Effect.succeed(availableUpdate),
        parentWindowId: Effect.succeed(84),
        showMessageBox: Deferred.succeed(dialogOpen, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
      });
      const events = yield* startup.quitDuringStartup(dialogOpen);
      expect(startup.dialogParents).toEqual([84]);
      expect(events).toEqual(["cleanup", "runtime-settled"]);
    }),
  );

  it.live(
    "settles without a skip when the parent closes before the dialog shows",
    () =>
      Effect.gen(function* () {
        const startup = makeStartup({
          checkNow: Effect.succeed(availableUpdate),
          showMessageBox: Effect.fail(
            new ElectronDialogMessageBoxError({
              cause: new Error("Browser window is not open: 42"),
            }),
          ),
        });
        const events = yield* startup.quitDuringStartup(startup.dialogFailed);
        expect(startup.dialogParents).toEqual([42]);
        expect(events).toEqual(["dialog-failed", "cleanup", "runtime-settled"]);
      }),
  );

  it.live("does not skip an update when its sheet parent starts closing", () =>
    Effect.gen(function* () {
      const parent = new EventEmitter();
      let parentWindowId: number | undefined = 42;
      parent.on("close", () => {
        parentWindowId = undefined;
      });
      const answered = yield* Deferred.make<void>();
      const startup = makeStartup({
        checkNow: Effect.succeed(availableUpdate),
        parentWindowId: Effect.sync(() => parentWindowId),
        showMessageBox: Effect.sync(() => {
          parent.emit("close");
          return { response: 1, checkboxChecked: false };
        }).pipe(Effect.tap(() => Deferred.succeed(answered, undefined))),
      });

      const events = yield* startup.quitDuringStartup(answered);

      expect(startup.dialogParents).toEqual([42]);
      expect(events).toEqual(["cleanup", "runtime-settled"]);
    }),
  );

  it.live(
    "does not skip the update when its sheet parent closes and another window remains",
    () =>
      Effect.gen(function* () {
        const parent = new EventEmitter();
        let parentWindowId = 42;
        parent.on("close", () => {
          parentWindowId = 84;
        });
        const answered = yield* Deferred.make<void>();
        const startup = makeStartup({
          checkNow: Effect.succeed(availableUpdate),
          parentWindowId: Effect.sync(() => parentWindowId),
          showMessageBox: Effect.sync(() => {
            parent.emit("close");
            return { response: 1, checkboxChecked: false };
          }).pipe(Effect.tap(() => Deferred.succeed(answered, undefined))),
        });

        const events = yield* startup.quitDuringStartup(answered);

        expect(startup.dialogParents).toEqual([42]);
        expect(events).toEqual(["cleanup", "runtime-settled"]);
      }),
  );

  it.live(
    "skips the update when its visible sheet parent receives a cancel response",
    () =>
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>();
        const startup = makeStartup({
          checkNow: Effect.succeed(availableUpdate),
          showMessageBox: Deferred.succeed(answered, undefined).pipe(
            Effect.as({ response: 1, checkboxChecked: false }),
          ),
        });

        const events = yield* startup.quitDuringStartup(answered);

        expect(startup.dialogParents).toEqual([42]);
        expect(events).toEqual(["skip:1.1.0", "cleanup", "runtime-settled"]);
      }),
  );

  it.live("cleans up when quit arrives during the startup update check", () =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const startup = makeStartup({
        checkNow: Deferred.succeed(checking, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
        showMessageBox: Effect.never,
      });

      const events = yield* startup.quitDuringStartup(checking);

      expect(events).toEqual(["cleanup", "runtime-settled"]);
    }),
  );

  it.live("cleans up when quit arrives during the startup update dialog", () =>
    Effect.gen(function* () {
      const dialogOpen = yield* Deferred.make<void>();
      const startup = makeStartup({
        checkNow: Effect.succeed(availableUpdate),
        showMessageBox: Deferred.succeed(dialogOpen, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
      });

      const events = yield* startup.quitDuringStartup(dialogOpen);

      expect(events).toEqual(["cleanup", "runtime-settled"]);
      expect(startup.dialogParents).toEqual([42]);
    }),
  );
});
