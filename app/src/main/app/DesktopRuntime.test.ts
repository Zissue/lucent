import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Scope from "effect/Scope";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { normalizeAppSettings } from "@lucent/core/settings";
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
import { ElectronTheme } from "../electron/ElectronTheme";
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
import { DesktopLifecycle } from "./DesktopLifecycle";
import { makeDesktopRuntime } from "./DesktopRuntime";
import { DesktopObservability } from "./observability/DesktopObservability";

vi.mock("electron", () => ({ ipcMain: {} }));

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

const unsubscribe = Effect.succeed(() => undefined);
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
    on: (eventName, listener) =>
      Effect.sync(() => {
        appEvents.on(eventName, listener);
        return () => {
          appEvents.removeListener(eventName, listener);
        };
      }),
    whenReady: Effect.void,
    quit: Effect.void,
  });
  const diagnostics = Layer.effectDiscard(
    Effect.flatMap(
      DesktopLifecycle,
      (lifecycle) => lifecycle.attachObservability,
    ),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Logger.layer([
          Logger.make((log) => {
            if (
              String(log.message) === "Failed to show startup update dialog"
            ) {
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
            flush: Effect.sync(() => {
              events.push("flush");
            }),
            installProcessHooks: Effect.void,
            logFilePath: join(directory, "lucent.log"),
          }),
        ),
      ),
    ),
  );

  const layer = Layer.mergeAll(
    servicesStartupNeverCalls,
    NodeFileSystem.layer,
    diagnostics,
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("cleanup");
        }),
      ),
    ),
    appLayer,
    Layer.effectDiscard(options.build ?? Effect.void).pipe(
      Layer.provide(diagnostics),
    ),
    Layer.succeed(
      DesktopEnvironment,
      DesktopEnvironment.of({
        appDataDir: directory,
        assetsDir: join(directory, "assets"),
        isDev: false,
        platform: "darwin",
        workspaceDir: join(directory, "workspace"),
      }),
    ),
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
        normalizeAppSettings({ preferences: { checkForUpdates: true } }),
      ),
      get: Effect.sync(() =>
        normalizeAppSettings({
          preferences: {
            checkForUpdates: true,
            launchMode: options.launchMode ?? "game",
          },
        }),
      ),
      onChanged: () => unsubscribe,
    }),
    Layer.mock(DesktopUpdates, {
      checkNow: () => options.checkNow,
      onStateChanged: () => unsubscribe,
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
      onChanged: () => unsubscribe,
      refresh: Effect.succeed({ packages: [], revision: "r0", scriptCount: 0 }),
    }),
    Layer.mock(Accounts, { onChanged: () => unsubscribe }),
    Layer.mock(CombatProfiles, { onChanged: () => unsubscribe }),
    Layer.mock(ArmyCoordinator, { onSessionEnded: () => unsubscribe }),
    Layer.mock(ArmyLoopTauntOrchestrator, { onCommand: () => unsubscribe }),
  );

  const quitDuringStartup = (
    waitingOn: Deferred.Deferred<void>,
    onReady: Effect.Effect<void> = Effect.void,
    afterDeadline?: Effect.Effect<void>,
    requestQuit: () => void = emitWillQuit,
  ) =>
    Effect.gen(function* () {
      const runtime = yield* Effect.forkDetach(
        makeDesktopRuntime({}, layer).pipe(
          Effect.provide(appLayer),
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
          rmSync(directory, { recursive: true, force: true });
        }),
      ),
    );

  const secondInstance = (argv: readonly string[], additionalData?: unknown) =>
    appEvents.emit("second-instance", {}, argv, "/tmp", additionalData);
  return {
    quitDuringStartup,
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
  vi.useRealTimers();
});

describe("makeDesktopRuntime", () => {
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

        expect(events).toEqual([
          "termination-signal",
          "cleanup",
          "runtime-settled",
        ]);
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
