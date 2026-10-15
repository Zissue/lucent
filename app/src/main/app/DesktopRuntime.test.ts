import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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
import * as AccountSessions from "../internal/accounts/AccountSessions";
import { AccountSettingsRepository } from "../internal/account-settings/AccountSettingsRepository";
import { Accounts } from "../internal/accounts/Accounts";
import { ArmyConfigRepository } from "../internal/army/ArmyConfigRepository";
import { ArmyCoordinator } from "../internal/army/ArmyCoordinator";
import { ArmyLoopTauntOrchestrator } from "../internal/army/ArmyLoopTauntOrchestrator";
import { CombatProfiles } from "../internal/combat-profiles/CombatProfiles";
import { GameEnvironments } from "../internal/environment/GameEnvironments";
import { GameFollowers } from "../internal/follower/GameFollowers";
import { GamePackets } from "../internal/packets/GamePackets";
import { GameRendererRpc } from "../internal/game-renderer/GameRendererRpc";
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
import { layer as desktopLifecycleLayer } from "./DesktopLifecycle";
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
  const willQuitListeners = new Set<(event: ElectronWillQuitEvent) => void>();

  const emitWillQuit = (): void => {
    let defaultPrevented = false;
    const event: ElectronWillQuitEvent = {
      preventDefault: () => {
        defaultPrevented = true;
      },
    };
    for (const listener of willQuitListeners) {
      listener(event);
    }
    if (!defaultPrevented) {
      events.push("electron-terminated");
    }
  };

  const layer = Layer.mergeAll(
    desktopLifecycleLayer,
    servicesStartupNeverCalls,
    NodeFileSystem.layer,
    Logger.layer([
      Logger.make((log) => {
        if (String(log.message) === "Failed to show startup update dialog") {
          events.push("dialog-failed");
          Deferred.doneUnsafe(dialogFailed, Exit.void);
        }
        if (log.logLevel === "Error") {
          events.push(`error:${String(log.message)}`);
        }
      }),
    ]),
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("cleanup");
        }),
      ),
    ),
    Layer.mock(ElectronApp, {
      exit: (code) =>
        Effect.sync(() => {
          events.push(`exit:${code}`);
        }),
      on: (eventName, listener) =>
        Effect.sync(() => {
          if (eventName !== "will-quit") {
            return () => undefined;
          }
          willQuitListeners.add(listener);
          return () => {
            willQuitListeners.delete(listener);
          };
        }),
      whenReady: Effect.void,
    }),
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
        { handle: () => undefined, removeHandler: () => undefined },
        { getAllWebContents: () => [], fromId: () => undefined },
      ),
    ),
    Layer.mock(DesktopSettings, {
      load: Effect.succeed(
        normalizeAppSettings({ preferences: { checkForUpdates: true } }),
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
      open: () => Effect.succeed(1),
      describe: () =>
        Effect.succeed({
          rendererId: 1,
          windowId: 42,
          kind: "game",
          ownerId: undefined,
          generation: 0,
          ready: true,
        }),
      getVisibleParentWindowId: options.parentWindowId ?? Effect.succeed(42),
      setBackgroundColor: () => Effect.void,
    }),
    Layer.mock(DesktopApplicationMenu, { install: Effect.void }),
    Layer.mock(DesktopGameRendererRecovery, { install: Effect.void }),
    Layer.mock(ScriptWorkspace, { initialize: Effect.void }),
    Layer.mock(ScriptPackageCatalog, {
      onChanged: () => unsubscribe,
      refresh: Effect.succeed({ packages: [], revision: "r0", scriptCount: 0 }),
    }),
    Layer.mock(Accounts, { onChanged: () => unsubscribe }),
    Layer.mock(CombatProfiles, { onChanged: () => unsubscribe }),
    Layer.mock(ArmyCoordinator, { onSessionEnded: () => unsubscribe }),
    Layer.mock(ArmyLoopTauntOrchestrator, { onCommand: () => unsubscribe }),
  );

  const quitDuringStartup = (waitingOn: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      const runtime = yield* Effect.forkDetach(
        makeDesktopRuntime({}, layer).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              events.push("runtime-settled");
            }),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        yield* Deferred.await(waitingOn);
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setImmediate(resolve)),
        );
        emitWillQuit();
        yield* Effect.promise(() =>
          vi
            .waitUntil(() => events.includes("runtime-settled"), {
              interval: 5,
              timeout: 1_000,
            })
            .catch(() => undefined),
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_500));
        return [...events];
      }).pipe(Effect.ensuring(Fiber.interrupt(runtime)));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(directory, { recursive: true, force: true });
        }),
      ),
    );

  return { quitDuringStartup, dialogParents, dialogFailed };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("makeDesktopRuntime", () => {
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
