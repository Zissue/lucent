import { homedir } from "os";
import { join } from "path";

import { app } from "electron";

import appBranding from "../../../appBranding.json";
import { parseCliOptions, type CliOptions } from "../cli";
import { type DesktopEnvironmentConfig } from "./DesktopEnvironment";
import { registerRuffleAssetScheme } from "../ruffle/RuffleAssets";

export interface MainProcessBootstrap {
  readonly cliOptions: CliOptions;
  readonly envConfig: DesktopEnvironmentConfig;
}

export const resolveWorkspaceHome = (
  options: {
    readonly documentsPath?: string;
  } = {},
): string =>
  join(options.documentsPath ?? join(homedir(), "Documents"), "Lucent");

const resolveAppDataBasePath = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (platform === "win32") {
    return env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  }

  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }

  return env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
};

export const resolveUserDataPath = (options: {
  readonly isDev: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}): string => {
  const activeBranding = options.isDev
    ? appBranding.dev
    : appBranding.production;
  return join(
    resolveAppDataBasePath(options.platform, options.env),
    activeBranding.userDataDirName,
  );
};

const resolveEnvironmentConfig = (
  cliOptions: CliOptions,
): DesktopEnvironmentConfig => {
  const isDev = !app.isPackaged;
  const platform = process.platform;
  const activeBranding = isDev ? appBranding.dev : appBranding.production;
  const appDataDir = resolveUserDataPath({ isDev, platform });

  app.setPath("userData", appDataDir);
  app.setName(activeBranding.displayName);
  if (platform === "win32") {
    app.setAppUserModelId(activeBranding.bundleId);
  }

  return {
    appDataDir: app.getPath("userData"),
    assetsDir: join(app.getAppPath(), "..", "assets"),
    debug: cliOptions.debug === true,
    isDev,
    platform,
    workspaceDir: resolveWorkspaceHome({
      documentsPath: app.getPath("documents"),
    }),
  };
};

const keepBackgroundGamesRunning = (): void => {
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
};

export const prepareMainProcess = (): MainProcessBootstrap => {
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

  const cliOptions = parseCliOptions(process.argv);
  const envConfig = resolveEnvironmentConfig(cliOptions);
  registerRuffleAssetScheme();
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  keepBackgroundGamesRunning();
  return { cliOptions, envConfig };
};
