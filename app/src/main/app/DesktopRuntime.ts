import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
    yield* settingsService.onChanged((settings) =>
      applyNativeAppearance(settings).pipe(Effect.ignoreCause),
    );
  });

const checkForUpdatesAtStartup = Effect.fn("checkForUpdatesAtStartup")(
  function* () {
    const dialog = yield* ElectronDialog;
    const lifecycle = yield* DesktopLifecycle;
    const updates = yield* DesktopUpdates;
    const windows = yield* DesktopWindows;
    const updateState = yield* updates.checkNow();
    yield* Effect.logDebug("Startup update check completed").pipe(
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

export const makeDesktopRuntime = <ROut, E, RIn, OOut, OE, OIn>(
  cliOptions: CliOptions,
  layer: Layer.Layer<ROut, E, RIn>,
  observabilityLayer: Layer.Layer<OOut, OE, OIn>,
) =>
  Effect.gen(function* () {
    const lifecycle = yield* DesktopLifecycle;
    yield* lifecycle.register;
    return yield* Effect.gen(function* () {
      yield* lifecycle.attachObservability;
      const observability = yield* DesktopObservability;
      yield* observability.installProcessHooks;
      let applicationFailure: Cause.Cause<unknown> | undefined;
      const app = yield* ElectronApp;
      const pendingLaunches = yield* Effect.acquireRelease(
        Queue.unbounded<CliOptions>(),
        Queue.shutdown,
      );
      yield* app.on(
        "second-instance",
        (_, argv, _workingDirectory, additionalData) => {
          const originalArgv = Schema.is(secondInstanceDataSchema)(
            additionalData,
          )
            ? additionalData.argv
            : argv;
          Queue.offerUnsafe(pendingLaunches, parseCliOptions(originalArgv));
        },
      );

      const source = yield* Effect.raceFirst(
        lifecycle.awaitQuit,
        Effect.gen(function* () {
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

          yield* installDesktopRendererObservability;
          const settings = yield* settingsService.load;
          const requestedLaunchMode =
            cliOptions.launchMode ?? settings.preferences.launchMode;
          const version = yield* app.getVersion;
          yield* Effect.logInfo("Lucent desktop runtime starting").pipe(
            Effect.annotateLogs({
              component: "startup",
              data: {
                version,
                platform: env.platform,
                arch: process.arch,
                isDev: env.isDev,
                launchMode: requestedLaunchMode,
                debug: env.debug === true,
                pid: process.pid,
                appDataDir: env.appDataDir,
                logFilePath: observability.logFilePath,
                workspaceDir: env.workspaceDir,
              },
            }),
          );

          yield* app.whenReady;
          yield* gameRendererRecovery.install;
          yield* scriptWorkspace.initialize;
          yield* initializeBundledScriptPackages;
          yield* installDesktopNativeAppearanceSync(settings);
          yield* installDesktopIpcHandlers();
          yield* applicationMenu.install;

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
          Effect.scoped,
          Effect.provide(layer),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (
                Exit.isFailure(exit) &&
                !Cause.hasInterruptsOnly(exit.cause)
              ) {
                applicationFailure = exit.cause;
              }
            }),
          ),
        ),
      );
      if (applicationFailure !== undefined) {
        return yield* Effect.failCause(applicationFailure);
      }
      return { source, observability };
    }).pipe(
      Effect.scoped,
      Effect.flatMap(({ source, observability }) =>
        Effect.gen(function* () {
          if (yield* lifecycle.isForcedExit) return 0;
          yield* observability.setSessionStop(source);
          return 0;
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) {
            return yield* Effect.failCause(cause);
          }
          if (yield* lifecycle.isQuitting) {
            yield* Effect.logError("Lucent shutdown failed", cause).pipe(
              Effect.annotateLogs({ component: "lifecycle" }),
            );
            return 0;
          }
          yield* Effect.logError("Lucent desktop runtime failed", cause).pipe(
            Effect.annotateLogs({ component: "startup" }),
          );
          return 1;
        }),
      ),
      Effect.provide(observabilityLayer),
    );
  }).pipe(Effect.scoped, Effect.provide(desktopLifecycleLayer));
