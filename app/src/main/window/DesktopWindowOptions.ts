import { join } from "node:path";

import type {
  BrowserWindowConstructorOptions,
  WebContentsViewConstructorOptions,
} from "electron";

import type { AppSettings } from "@lucent/core/settings";

import appBranding from "../../../appBranding.json";
import {
  type AppearanceSnapshot,
  serializeDesktopViewArgument,
  serializeAppearanceSnapshotArgument,
  serializeSettingsSnapshotArgument,
} from "../../shared/appearance";
import type { DesktopBridgeView } from "../../shared/desktopBridge";
import type { GameViewLayout } from "../../shared/gameViews";
import {
  DEBUG_MODE_ARGUMENT,
  GAME_CONSOLE_OBSERVABILITY_ARGUMENT,
  serializeGameViewLayoutArgument,
} from "../../shared/rendererBootstrapArguments";
import type { DesktopEnvironment } from "../app/DesktopEnvironment";
import type {
  ElectronWindowCreateOptions,
  ElectronHostWindowCreateOptions,
} from "../electron/ElectronWindow";
import type { DesktopWindowDefinition } from "./DesktopWindowCatalog";
import type { DesktopWindowOpenOptions } from "./DesktopWindows";

const rendererRoot = join(__dirname, "../renderer");
const preloadPath = join(rendererRoot, "preload.js");

export const viewHtmlPath = (kind: DesktopBridgeView): string =>
  join(rendererRoot, kind, "index.html");

type DesktopRendererWebPreferences = NonNullable<
  BrowserWindowConstructorOptions["webPreferences"]
>;

export const createRendererWebPreferences = (
  env: DesktopEnvironment["Service"],
  bridgeView: DesktopBridgeView,
  settings: AppSettings,
  snapshot: AppearanceSnapshot,
  options: {
    readonly backgroundThrottling?: boolean;
    readonly gameViewLayout?: GameViewLayout;
  } = {},
): DesktopRendererWebPreferences => ({
  additionalArguments: [
    serializeDesktopViewArgument(bridgeView),
    serializeAppearanceSnapshotArgument(snapshot),
    serializeSettingsSnapshotArgument(settings),
    ...(options.gameViewLayout === undefined
      ? []
      : [serializeGameViewLayoutArgument(options.gameViewLayout)]),
    ...(env.debug === true ? [DEBUG_MODE_ARGUMENT] : []),
    ...(bridgeView === "game" && env.debug === true
      ? [GAME_CONSOLE_OBSERVABILITY_ARGUMENT]
      : []),
  ],
  ...(options.backgroundThrottling === undefined
    ? {}
    : { backgroundThrottling: options.backgroundThrottling }),
  contextIsolation: true,
  nodeIntegration: false,
  preload: preloadPath,
  sandbox: false,
});

export const createNativeWindowOptions = (
  env: DesktopEnvironment["Service"],
  definition: DesktopWindowDefinition,
  snapshot: AppearanceSnapshot,
): ElectronHostWindowCreateOptions => {
  const { height, width } = definition;
  const activeBranding = env.isDev ? appBranding.dev : appBranding.production;
  const appIconPath = join(env.assetsDir, activeBranding.iconPng);

  return {
    width,
    height,
    ...(definition.minWidth === undefined
      ? {}
      : { minWidth: Math.min(definition.minWidth, width) }),
    ...(definition.minHeight === undefined
      ? {}
      : { minHeight: Math.min(definition.minHeight, height) }),
    ...(definition.fixedSize === true
      ? {
          fullscreenable: false,
          maximizable: false,
          resizable: false,
          useContentSize: true,
        }
      : {}),
    ...(env.platform === "linux" ? { icon: appIconPath } : {}),
    ...(definition.kind === "game"
      ? { title: activeBranding.displayName }
      : {}),
    backgroundColor: snapshot.backgroundColor,
    show: false,
  };
};

export const createWindowOptions = (
  env: DesktopEnvironment["Service"],
  definition: DesktopWindowDefinition,
  settings: AppSettings,
  snapshot: AppearanceSnapshot,
  renderer?: {
    readonly partition?: string;
  },
): ElectronWindowCreateOptions => {
  return {
    ...createNativeWindowOptions(env, definition, snapshot),
    webPreferences: {
      ...createRendererWebPreferences(
        env,
        definition.kind,
        settings,
        snapshot,
        definition.kind === "game" ? { backgroundThrottling: false } : {},
      ),
      ...(renderer?.partition === undefined
        ? {}
        : { partition: renderer.partition }),
    },
  };
};

export const gamePartitionOwner = (
  options?: DesktopWindowOpenOptions,
):
  | { readonly kind: "default" }
  | { readonly kind: "managed-account"; readonly key: string } =>
  options?.managedGameProfileKey === undefined
    ? { kind: "default" }
    : { kind: "managed-account", key: options.managedGameProfileKey };

export const createGameViewOptions = (
  env: DesktopEnvironment["Service"],
  settings: AppSettings,
  snapshot: AppearanceSnapshot,
  partition: string,
  layout: GameViewLayout,
): WebContentsViewConstructorOptions => ({
  webPreferences: {
    ...createRendererWebPreferences(env, "game", settings, snapshot, {
      backgroundThrottling: false,
      gameViewLayout: layout,
    }),
    partition,
  },
});
