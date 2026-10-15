import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Layer from "effect/Layer";

import { createAppearanceSnapshot } from "@lucent/core/appearance";
import type { AppLaunchMode, AppSettings } from "@lucent/core/settings";
import { parseCliOptions, type CliOptions } from "../cli";
import { installDesktopDevRendererReload } from "./DesktopDevRendererReload";
import { DesktopGameRendererRecovery } from "./DesktopGameRendererRecovery";
import { DesktopEnvironment } from "./DesktopEnvironment";
import {
  DesktopLifecycle,
  layer as desktopLifecycleLayer,
} from "./DesktopLifecycle";
import { DesktopObservability } from "./observability/DesktopObservability";
import { installDesktopRendererObservability } from "./observability/DesktopRendererObservability";
import { ElectronApp } from "../electron/ElectronApp";
import { ElectronDialog } from "../electron/ElectronDialog";
import { ElectronTheme } from "../electron/ElectronTheme";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers";
import { DesktopSettings } from "../settings/DesktopSettings";
import { ScriptWorkspace } from "../scripting/ScriptWorkspace";
import { initializeBundledScriptPackages } from "../scripting/BundledScriptPackages";
import { DesktopUpdates } from "../updates/DesktopUpdates";
import { DesktopApplicationMenu } from "../window/DesktopApplicationMenu";
import { DesktopWindows } from "../window/DesktopWindows";
import { showUpdateCheckDialog } from "../window/UpdateCheckDialog";

const secondInstanceDataSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
});

export const installDesktopNativeAppearanceSync = (
  initialSettings: AppSettings,
) =>
  Effect.gen(function* () {
    const settingsService = yield* DesktopSettings;
    const theme = yield* ElectronTheme;
    const windows = yield* DesktopWindows;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);

    const applyNativeAppearance = (settings: AppSettings) =>
      Effect.gen(function* () {
        yield* theme.setThemeMode(settings.appearance.themeMode);
        const systemPrefersDark = yield* theme.shouldUseDarkColors;
        const snapshot = createAppearanceSnapshot(settings, systemPrefersDark);
        yield* windows.setBackgroundColor(snapshot.backgroundColor);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to update Electron native appearance").pipe(
            Effect.annotateLogs({ component: "appearance", data: { cause } }),
          ),
        ),
      );

    yield* applyNativeAppearance(initialSettings);
    const unsubscribe = yield* settingsService.onChanged((settings) => {
      void runPromise(applyNativeAppearance(settings)).catch(() => undefined);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  });

const checkForUpdatesAtStartup = Effect.fn("checkForUpdatesAtStartup")(
  function* () {
    const dialog = yield* ElectronDialog;
    const lifecycle = yield* DesktopLifecycle;
    const updates = yield* DesktopUpdates;
    const windows = yield* DesktopWindows;
    const updateState = yield* updates.checkNow();
    yield* Effect.logInfo("Startup update check completed").pipe(
      Effect.annotateLogs({
        component: "updates",
        data: {
          status: updateState.status,
        },
      }),
    );
    const parentWindowId = yield* windows.getVisibleParentWindowId;
    if (parentWindowId === undefined || (yield* lifecycle.isQuitting)) {
      return;
    }
    yield* showUpdateCheckDialog(updateState, {
      mode: "automatic",
      parentWindowId,
      dismissedWithoutAnswer: Effect.gen(function* () {
        return (
          (yield* lifecycle.isQuitting) ||
          !(yield* windows.isVisibleParentWindow(parentWindowId))
        );
      }),
      dialog,
      updates,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to show startup update dialog").pipe(
          Effect.annotateLogs({ component: "updates", data: { cause } }),
        ),
      ),
    );
  },
);

export const makeDesktopRuntime = <ROut, E>(
  cliOptions: CliOptions,
  layer: Layer.Layer<ROut, E, DesktopLifecycle>,
) =>
  Effect.gen(function* () {
    const lifecycle = yield* DesktopLifecycle;
    yield* lifecycle.register;
    const app = yield* ElectronApp;
    const pendingLaunches = yield* Effect.acquireRelease(
      Queue.unbounded<CliOptions>(),
      Queue.shutdown,
    );
    const disposeSecondInstance = yield* app.on(
      "second-instance",
      (_, argv, _workingDirectory, additionalData) => {
        const originalArgv = Schema.is(secondInstanceDataSchema)(additionalData)
          ? additionalData.argv
          : argv;
        Queue.offerUnsafe(pendingLaunches, parseCliOptions(originalArgv));
      },
    );
    yield* Effect.addFinalizer(() => Effect.sync(disposeSecondInstance));

    yield* Effect.raceFirst(
      lifecycle.awaitQuit,
      Effect.gen(function* () {
        const observability = yield* DesktopObservability;
        yield* observability.installProcessHooks;
        const applicationMenu = yield* DesktopApplicationMenu;
        const env = yield* DesktopEnvironment;
        const gameRendererRecovery = yield* DesktopGameRendererRecovery;
        const settingsService = yield* DesktopSettings;
        const scriptWorkspace = yield* ScriptWorkspace;
        const windows = yield* DesktopWindows;
        const openLaunchWindow = (launchMode: AppLaunchMode) =>
          windows.open(
            launchMode === "account-manager" ? "account-manager" : "game",
          );

        if (env.debug === true) {
          yield* installDesktopRendererObservability;
        }
        yield* Effect.logInfo("Lucent desktop runtime starting").pipe(
          Effect.annotateLogs({
            component: "startup",
            data: {
              appDataDir: env.appDataDir,
              logFilePath: observability.logFilePath,
              workspaceDir: env.workspaceDir,
            },
          }),
        );

        const settings = yield* settingsService.load;

        yield* app.whenReady;
        yield* gameRendererRecovery.install;
        yield* scriptWorkspace.initialize;
        yield* initializeBundledScriptPackages;
        yield* installDesktopNativeAppearanceSync(settings);
        yield* installDesktopIpcHandlers();
        yield* applicationMenu.install;

        const requestedLaunchMode =
          cliOptions.launchMode ?? settings.preferences.launchMode;
        yield* openLaunchWindow(requestedLaunchMode);
        yield* installDesktopDevRendererReload;
        yield* Effect.forever(
          Effect.gen(function* () {
            const options = yield* Queue.take(pendingLaunches);
            const launchMode =
              options.launchMode ??
              (yield* settingsService.get).preferences.launchMode;
            if (yield* lifecycle.isQuitting) {
              return;
            }
            yield* openLaunchWindow(launchMode);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Failed to open second-instance window",
                cause,
              ).pipe(Effect.annotateLogs({ component: "startup" })),
            ),
          ),
        ).pipe(Effect.forkScoped);

        if (settings.preferences.checkForUpdates) {
          yield* checkForUpdatesAtStartup();
        }

        return yield* Effect.never;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) {
              return yield* Effect.failCause(cause);
            }
            yield* Effect.logError("Lucent desktop runtime failed", cause).pipe(
              Effect.annotateLogs({ component: "startup" }),
            );
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.provide(layer),
        Effect.scoped,
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(desktopLifecycleLayer));
