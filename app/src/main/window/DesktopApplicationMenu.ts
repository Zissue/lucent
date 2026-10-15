import * as Cause from "effect/Cause";
import {
  BaseWindow,
  Menu,
  app,
  nativeImage,
  webContents,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { ThemeMode } from "@lucent/core/settings";
import {
  DesktopChromiumPerformanceRecording,
  type DesktopChromiumPerformanceRecordingState,
} from "../app/observability/DesktopChromiumPerformanceRecording";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { logFailure } from "../../shared/logFailure";
import { ElectronSession } from "../electron/ElectronSession";
import { ElectronApp } from "../electron/ElectronApp";
import { ElectronDialog } from "../electron/ElectronDialog";
import { ElectronShell } from "../electron/ElectronShell";
import { DesktopSettings } from "../settings/DesktopSettings";
import { DesktopUpdates } from "../updates/DesktopUpdates";
import { DesktopWindows } from "./DesktopWindows";
import { showUpdateCheckDialog } from "./UpdateCheckDialog";
import { DesktopLifecycle } from "../app/DesktopLifecycle";

export interface DesktopApplicationMenuShape {
  readonly install: Effect.Effect<void, never, Scope.Scope>;
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  DesktopApplicationMenuShape
>()("lucent/desktop/window/DesktopApplicationMenu") {}

const themeModes: readonly {
  readonly label: string;
  readonly mode: ThemeMode;
}[] = [
  { label: "Light", mode: "light" },
  { label: "Dark", mode: "dark" },
  { label: "System", mode: "system" },
];

class DesktopAppDataClearError extends Schema.TaggedError<DesktopAppDataClearError>()(
  "DesktopAppDataClearError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to clear app data.";
  }
}

const reloadContents = (target: WebContents, bypassCache: boolean): void => {
  if (target.isDestroyed()) {
    return;
  }

  if (bypassCache) {
    target.reloadIgnoringCache();
  } else {
    target.reload();
  }
};

const makeDesktopApplicationMenu = Effect.gen(function* () {
  const electronApp = yield* ElectronApp;
  const lifecycle = yield* DesktopLifecycle;
  const electronSession = yield* ElectronSession;
  const chromiumPerformanceRecording =
    yield* DesktopChromiumPerformanceRecording;
  const dialog = yield* ElectronDialog;
  const env = yield* DesktopEnvironment;
  const settings = yield* DesktopSettings;
  const shell = yield* ElectronShell;
  const updates = yield* DesktopUpdates;
  const windows = yield* DesktopWindows;
  const run = yield* FiberSet.makeRuntime<never, void>();
  const isDarwin = env.platform === "darwin";
  const usesMenuSymbols =
    isDarwin && Number.parseInt(process.getSystemVersion(), 10) >= 26;
  const menuSymbol = (name: string): Pick<MenuItemConstructorOptions, "icon"> =>
    usesMenuSymbols ? { icon: nativeImage.createMenuSymbol(name) } : {};
  const removeRendererWindowMenu = (rendererId: number) =>
    windows.describe(rendererId).pipe(
      Effect.map((info) => {
        if (info !== undefined) BaseWindow.fromId(info.windowId)?.setMenu(null);
      }),
    );

  const logMenuFailure = (operation: string, cause: Cause.Cause<unknown>) =>
    logFailure("Application menu action failed", cause).pipe(
      Effect.annotateLogs({
        component: "menu",
        data: {
          operation,
        },
      }),
    );
  const catchMenuFailure = (operation: string) =>
    Effect.catchCause((cause) => logMenuFailure(operation, cause));

  const toggleDevTools = (): void => {
    const target = webContents.getFocusedWebContents();
    if (target === null || target.isDestroyed()) {
      return;
    }

    try {
      if (target.isDevToolsOpened()) {
        target.closeDevTools();
      } else {
        // Keep DevTools separate from the game host's native child views.
        target.openDevTools({ mode: "detach" });
      }
    } catch (cause) {
      run(logMenuFailure("toggle-dev-tools", Cause.die(cause)));
    }
  };

  const reload =
    (bypassCache: boolean): NonNullable<MenuItemConstructorOptions["click"]> =>
    (_menuItem, browserWindow) => {
      const target = webContents.getFocusedWebContents();
      if (target === null || target.isDestroyed()) {
        return;
      }

      const reloadTarget = (): void => {
        try {
          reloadContents(target, bypassCache);
        } catch (cause) {
          run(
            logMenuFailure(
              bypassCache ? "force-reload-renderer" : "reload-renderer",
              Cause.die(cause),
            ),
          );
        }
      };

      if (browserWindow === undefined) {
        reloadTarget();
        return;
      }

      run(
        windows
          .reloadFocusedGameContents(browserWindow.id, target.id, bypassCache)
          .pipe(
            Effect.map((handled) => {
              if (!handled) reloadTarget();
            }),
            catchMenuFailure(
              bypassCache ? "force-reload-game-view" : "reload-game-view",
            ),
          ),
      );
    };

  const openWindow = (
    kind: "about" | "account-manager" | "game" | "settings",
  ): void => {
    run(
      windows.open(kind).pipe(Effect.asVoid, catchMenuFailure(`open-${kind}`)),
    );
  };

  const checkForUpdates = (): void => {
    run(
      updates.checkNow({ force: true }).pipe(
        Effect.flatMap((state) =>
          showUpdateCheckDialog(state, {
            mode: "manual",
            isQuitting: lifecycle.isQuitting,
            dialog,
            updates,
          }),
        ),
        catchMenuFailure("check-for-updates"),
      ),
    );
  };

  const showChromiumPerformanceRecordingFailure = (
    operation: "save" | "snapshot" | "start",
    cause: unknown,
  ) =>
    Effect.gen(function* () {
      const copy = {
        save: {
          title: "Chromium Recording Not Saved",
          message:
            "Unable to finish saving the Chromium performance recording.",
        },
        snapshot: {
          title: "Heap Snapshot Not Saved",
          message: "Unable to save the heap snapshot.",
        },
        start: {
          title: "Chromium Recording Not Started",
          message: "Unable to start the Chromium performance recording.",
        },
      } as const;
      yield* Effect.logError(
        "Chromium performance recording action failed",
        Cause.fail(cause),
      ).pipe(
        Effect.annotateLogs({
          component: "chromium-performance-recording",
          data: { operation, message: copy[operation].message },
        }),
      );
      yield* dialog.showMessageBox({
        type: "warning",
        title: copy[operation].title,
        message: copy[operation].message,
        detail:
          operation === "snapshot"
            ? "The performance recording is still running. Check the logs and try again."
            : "Check the logs and try again.",
        buttons: ["Close"],
        defaultId: 0,
        cancelId: 0,
      });
    }).pipe(Effect.asVoid);

  const startChromiumPerformanceRecording = (): void => {
    run(
      chromiumPerformanceRecording.start.pipe(
        Effect.catch((cause) =>
          showChromiumPerformanceRecordingFailure("start", cause),
        ),
        catchMenuFailure("start-chromium-performance-recording"),
      ),
    );
  };

  const captureChromiumHeapSnapshot = (): void => {
    run(
      chromiumPerformanceRecording.captureHeapSnapshot.pipe(
        Effect.flatMap((result) => {
          if (result.failedSnapshotCount === 0) {
            return Effect.void;
          }

          const savedSnapshotCount =
            result.snapshotCount - result.failedSnapshotCount;
          return dialog
            .showMessageBox({
              type: "warning",
              title: "Heap Snapshot Incomplete",
              message: `Saved ${savedSnapshotCount} of ${result.snapshotCount} heap snapshots.`,
              detail:
                "The Chromium performance recording is still running. Check the logs for details.",
              buttons: ["Close"],
              defaultId: 0,
              cancelId: 0,
            })
            .pipe(Effect.asVoid);
        }),
        Effect.catch((cause) =>
          showChromiumPerformanceRecordingFailure("snapshot", cause),
        ),
        catchMenuFailure("capture-chromium-heap-snapshot"),
      ),
    );
  };

  const stopChromiumPerformanceRecording = (): void => {
    run(
      chromiumPerformanceRecording.stop.pipe(
        Effect.flatMap((result) =>
          result === undefined
            ? Effect.void
            : shell.showItemInFolder(result.manifestPath),
        ),
        Effect.catch((cause) =>
          showChromiumPerformanceRecordingFailure("save", cause),
        ),
        catchMenuFailure("stop-chromium-performance-recording"),
      ),
    );
  };

  const clearAppData = electronSession.clearAppData.pipe(
    Effect.mapError((cause) => new DesktopAppDataClearError({ cause })),
  );

  const showDataClearResult = (result: "succeeded" | "failed") =>
    Effect.gen(function* () {
      if (result === "succeeded") {
        const response = yield* dialog.showMessageBox({
          type: "info",
          title: "App Data Cleared",
          message: "App data was cleared.",
          buttons: ["Relaunch Now", "Later"],
          defaultId: 0,
          cancelId: 1,
        });

        if (response.response === 0) {
          yield* electronApp.relaunch;
          yield* electronApp.quit;
        }

        return;
      }

      yield* dialog.showMessageBox({
        type: "warning",
        title: "App Data Clear Failed",
        message: "Lucent could not clear the app data.",
        detail: "Check the logs for details.",
      });
    }).pipe(Effect.asVoid);

  const clearData = (): void => {
    run(
      clearAppData.pipe(
        Effect.flatMap(() => showDataClearResult("succeeded")),
        Effect.catch((cause) =>
          Effect.logError("Failed to clear app data", Cause.fail(cause))
            .pipe(Effect.annotateLogs({ component: "menu" }))
            .pipe(Effect.flatMap(() => showDataClearResult("failed"))),
        ),
        catchMenuFailure("clear-app-data"),
      ),
    );
  };

  const updateTheme = (themeMode: ThemeMode): void => {
    run(
      settings
        .updateAppearance({ themeMode })
        .pipe(catchMenuFailure("update-theme")),
    );
  };

  const buildAppearanceMenu = (
    currentThemeMode: ThemeMode,
  ): MenuItemConstructorOptions => ({
    label: "Appearance",
    submenu: themeModes.map(({ label, mode }) => ({
      checked: currentThemeMode === mode,
      click: () => updateTheme(mode),
      label,
      type: "radio",
    })),
  });

  const buildChromiumPerformanceRecordingMenuItems = (
    state: DesktopChromiumPerformanceRecordingState,
  ): MenuItemConstructorOptions[] => {
    switch (state.status) {
      case "idle":
        return [
          {
            label: "Start Chromium Performance Recording",
            click: startChromiumPerformanceRecording,
          },
        ];
      case "recording":
        return [
          {
            label: "Capture Heap Snapshot",
            click: captureChromiumHeapSnapshot,
          },
          {
            label: "Stop and Save Chromium Recording",
            click: stopChromiumPerformanceRecording,
          },
        ];
      case "snapshotting":
        return [
          {
            label: "Capturing Heap Snapshot…",
            enabled: false,
          },
          {
            label: "Stop and Save Chromium Recording",
            enabled: false,
          },
        ];
      case "saving":
        return [
          {
            label: "Saving Chromium Recording…",
            enabled: false,
          },
        ];
    }
  };

  const buildTemplate = (
    currentThemeMode: ThemeMode,
    chromiumPerformanceRecordingState: DesktopChromiumPerformanceRecordingState,
  ): MenuItemConstructorOptions[] => {
    const settingsMenuItem: MenuItemConstructorOptions = {
      label: "Settings",
      accelerator: isDarwin ? "Command+," : "Control+,",
      ...menuSymbol("gearshape"),
      click: () => openWindow("settings"),
    };
    const aboutMenuItem: MenuItemConstructorOptions = {
      label: `About ${app.name}`,
      ...menuSymbol("info.circle"),
      click: () => openWindow("about"),
    };
    const checkForUpdatesMenuItem: MenuItemConstructorOptions = {
      label: "Check for Updates...",
      click: checkForUpdates,
    };
    const dataClearMenuItems: MenuItemConstructorOptions[] = [
      {
        label: "Clear App Data",
        click: clearData,
      },
    ];
    const launchMenuItems: MenuItemConstructorOptions[] = [
      {
        label: "New Game Window",
        accelerator: "CmdOrCtrl+N",
        click: () => openWindow("game"),
      },
      {
        label: "Open Account Manager",
        click: () => openWindow("account-manager"),
      },
      { type: "separator" },
    ];
    const fileSubmenu: MenuItemConstructorOptions[] = isDarwin
      ? [...launchMenuItems, { role: "close" }]
      : [
          ...launchMenuItems,
          settingsMenuItem,
          { type: "separator" },
          { role: "quit" },
        ];
    const helpUpdateItems: MenuItemConstructorOptions[] = isDarwin
      ? []
      : [checkForUpdatesMenuItem, { type: "separator" }];
    const helpAboutItems: MenuItemConstructorOptions[] = isDarwin
      ? []
      : [{ type: "separator" }, aboutMenuItem];
    const helpSubmenu: MenuItemConstructorOptions[] = [
      ...helpUpdateItems,
      ...buildChromiumPerformanceRecordingMenuItems(
        chromiumPerformanceRecordingState,
      ),
      { type: "separator" },
      ...dataClearMenuItems,
      ...helpAboutItems,
    ];
    const viewSubmenu: MenuItemConstructorOptions[] = [
      {
        accelerator: "CmdOrCtrl+R",
        click: reload(false),
        label: "Reload",
      },
      {
        accelerator: "CmdOrCtrl+Shift+R",
        click: reload(true),
        label: "Force Reload",
      },
      {
        accelerator: isDarwin ? "Alt+Command+I" : "Control+Shift+I",
        click: toggleDevTools,
        label: "Toggle Developer Tools",
      },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      buildAppearanceMenu(currentThemeMode),
      { type: "separator" },
      { role: "togglefullscreen" },
    ];

    return [
      ...(isDarwin
        ? [
            {
              label: app.name,
              submenu: [
                aboutMenuItem,
                { type: "separator" },
                settingsMenuItem,
                checkForUpdatesMenuItem,
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      { label: "File", submenu: fileSubmenu },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      { label: "View", submenu: viewSubmenu },
      { role: "windowMenu" },
      { label: "Help", submenu: helpSubmenu },
    ];
  };

  const rebuild = Effect.gen(function* () {
    const current = yield* settings.get;
    const chromiumPerformanceRecordingState =
      yield* chromiumPerformanceRecording.getState;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildTemplate(
          current.appearance.themeMode,
          chromiumPerformanceRecordingState,
        ),
      ),
    );
    if (!isDarwin) {
      for (const rendererId of yield* windows.getRendererIds("about")) {
        yield* removeRendererWindowMenu(rendererId);
      }
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "Failed to rebuild application menu",
        Cause.fail(cause),
      ).pipe(
        Effect.annotateLogs({
          component: "menu",
        }),
      ),
    ),
  );

  const install: DesktopApplicationMenuShape["install"] = Effect.gen(
    function* () {
      if (!isDarwin) {
        yield* windows.observe({ kind: "about" }, (event) =>
          event.type === "created"
            ? removeRendererWindowMenu(event.rendererId).pipe(
                Effect.catch(() => Effect.void),
              )
            : Effect.void,
        );
      }
      yield* rebuild;
      const unsubscribe = yield* settings.onChanged(() => {
        run(rebuild.pipe(catchMenuFailure("rebuild")));
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const unsubscribeChromiumPerformanceRecording =
        yield* chromiumPerformanceRecording.onChanged(() => {
          run(
            rebuild.pipe(
              catchMenuFailure("rebuild-chromium-performance-recording"),
            ),
          );
        });
      yield* Effect.addFinalizer(() =>
        Effect.sync(unsubscribeChromiumPerformanceRecording),
      );
    },
  );

  return DesktopApplicationMenu.of({
    install,
  });
});

export const layer = Layer.effect(
  DesktopApplicationMenu,
  makeDesktopApplicationMenu,
);
