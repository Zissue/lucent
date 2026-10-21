import { DEFAULT_APP_SETTINGS } from "@lucent/core/settings";
import { describe, expect, it } from "@effect/vitest";
import type { MenuItemConstructorOptions } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { vi } from "vitest";

import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { DesktopLifecycle } from "../app/DesktopLifecycle";
import { DesktopChromiumPerformanceRecording } from "../app/observability/DesktopChromiumPerformanceRecording";
import { ElectronApp } from "../electron/ElectronApp";
import { ElectronDialog } from "../electron/ElectronDialog";
import { GameSessions } from "../game/session/GameSessions";
import { ElectronShell } from "../electron/ElectronShell";
import {
  DesktopSettings,
  DesktopSettingsError,
} from "../settings/DesktopSettings";
import { DesktopUpdates } from "../updates/DesktopUpdates";
import { DesktopWindows } from "./DesktopWindows";
import { DesktopApplicationMenu, layer } from "./DesktopApplicationMenu";

const electron = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
}));

vi.mock("electron", () => ({
  app: { name: "Lucent" },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      electron.template = template;
      return template;
    },
    setApplicationMenu: () => undefined,
  },
}));

describe("DesktopApplicationMenu logging", () => {
  it.effect("logs a failed theme save once at Warning", () =>
    Effect.gen(function* () {
      const logged = yield* Deferred.make<void>();
      const records: {
        level: string;
        message: unknown;
        annotations: Readonly<Record<string, unknown>>;
      }[] = [];
      const capture = Logger.make((options) => {
        records.push({
          level: options.logLevel,
          message: options.message,
          annotations: options.fiber.getRef(References.CurrentLogAnnotations),
        });
        Deferred.doneUnsafe(logged, Effect.void);
      });
      const unused = () => Effect.die("Unexpected menu dependency call");
      const dependencies = Layer.mergeAll(
        Layer.succeed(DesktopEnvironment, {
          appDataDir: "/tmp/lucent-app-data",
          assetsDir: "/tmp/lucent-assets",
          isDev: false,
          platform: "linux",
          workspaceDir: "/tmp/lucent-workspace",
        }),
        Layer.succeed(ElectronApp, {
          exit: unused,
          getAppMetrics: Effect.die("Unused"),
          getVersion: Effect.die("Unused"),
          on: unused,
          relaunch: Effect.void,
          quit: Effect.void,
          whenReady: Effect.void,
        }),
        Layer.succeed(DesktopLifecycle, {
          awaitQuit: Effect.succeed("will-quit" as const),
          isForcedExit: Effect.succeed(false),
          isQuitting: Effect.succeed(false),
          isQuittingSync: () => false,
          attachObservability: Effect.void,
          register: Effect.void,
        }),
        Layer.succeed(GameSessions, {
          acquireGamePartition: unused,
          clearAppData: Effect.void,
          prepareGameNetworking: Effect.void,
          retireManagedGameProfile: unused,
        }),
        Layer.succeed(DesktopChromiumPerformanceRecording, {
          captureHeapSnapshot: Effect.die("Unused"),
          getState: Effect.succeed({ status: "idle" as const }),
          onChanged: () => Effect.void,
          start: Effect.void,
          stop: Effect.succeed(undefined),
        }),
        Layer.succeed(ElectronDialog, {
          showMessageBox: unused,
          showOpenDialog: unused,
        }),
        Layer.succeed(DesktopSettings, {
          get: Effect.succeed(DEFAULT_APP_SETTINGS),
          onChanged: () => Effect.void,
          resetAppearance: Effect.succeed(DEFAULT_APP_SETTINGS),
          resetHotkeys: Effect.succeed(DEFAULT_APP_SETTINGS),
          updateAppearance: () =>
            Effect.fail(
              new DesktopSettingsError({
                detail: "Failed to save appearance",
                operation: "write",
              }),
            ),
          updateHotkeys: unused,
          updatePreferences: unused,
        }),
        Layer.succeed(ElectronShell, {
          openExternal: unused,
          openPath: unused,
          showItemInFolder: unused,
        }),
        Layer.succeed(DesktopUpdates, {
          checkNow: unused,
          getState: Effect.die("Unused"),
          onStateChanged: unused,
          openReleasePage: Effect.die("Unused"),
          shouldPromptForAvailableRelease: unused,
          skipAvailableRelease: unused,
        }),
        Layer.succeed(DesktopWindows, {
          updateGameViewHost: unused,
          closeRenderer: unused,
          getRendererIds: () => Effect.succeed([]),
          describe: unused,
          getVisibleParentWindowId: Effect.die("Unused"),
          isVisibleParentWindow: unused,
          getOwnedRendererIds: unused,
          markRendererReady: unused,
          addGameView: unused,
          closeGameView: unused,
          getGameViewHostState: unused,
          getGameViewPresentation: unused,
          observe: () => Effect.void,
          open: unused,
          revealRenderer: unused,
          reloadFocusedGameContents: unused,
          setBackgroundColor: unused,
          setGameViewName: unused,
          withGameViewGroupControlsNativeDialog: unused,
        }),
      );

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu;
        yield* menu.install;
        const view = electron.template.find((item) => item.label === "View");
        const appearance = Array.isArray(view?.submenu)
          ? view.submenu.find((item) => item.label === "Appearance")
          : undefined;
        const dark = Array.isArray(appearance?.submenu)
          ? appearance.submenu.find((item) => item.label === "Dark")
          : undefined;
        if (dark?.click === undefined)
          throw new Error("Missing Dark menu item");
        dark.click(
          {} as Electron.MenuItem,
          undefined,
          {} as Electron.KeyboardEvent,
        );
        yield* Deferred.await(logged);
      }).pipe(
        Effect.provide(layer.pipe(Layer.provide(dependencies))),
        Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.scoped,
      );

      expect(records).toEqual([
        {
          level: "Warn",
          message: ["Application menu action failed"],
          annotations: {
            component: "menu",
            data: { operation: "update-theme" },
          },
        },
      ]);
    }),
  );
});
