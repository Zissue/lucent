import { dirname } from "path";

import * as Effect from "effect/Effect";

import {
  AboutIpc,
  type AboutFolder,
  type AboutLink,
} from "../../../shared/ipc";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { DesktopObservability } from "../../app/observability/DesktopObservability";
import { ElectronApp } from "../../electron/ElectronApp";
import { ElectronShell } from "../../electron/ElectronShell";
import { resolveScriptWorkspacePaths } from "../../scripting/ScriptWorkspacePaths";
import { makeDesktopIpcMethod } from "../DesktopIpc";

interface DesktopBuildInfo {
  readonly builtAt: string | null;
  readonly commit: string | null;
  readonly dirty: boolean;
}

declare const __LUCENT_BUILD_INFO__: DesktopBuildInfo | undefined;

const desktopBuildInfo: DesktopBuildInfo =
  typeof __LUCENT_BUILD_INFO__ === "undefined"
    ? { builtAt: null, commit: null, dirty: false }
    : __LUCENT_BUILD_INFO__;

const aboutSenders = ["about"] as const;

const WEBSITE_URL = "https://uselucent.vercel.app";
const REPOSITORY_URL = "https://github.com/toommyliu/lucent";

const platformLabel = (platform: NodeJS.Platform): string => {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
};

const resolveFolderPath = Effect.fn("desktop.about.resolveFolderPath")(
  function* (folder: AboutFolder) {
    const env = yield* DesktopEnvironment;
    switch (folder) {
      case "appData":
        return env.appDataDir;
      case "logs":
        return dirname((yield* DesktopObservability).logFilePath);
      case "scripts":
        return resolveScriptWorkspacePaths(env.workspaceDir).scriptsDir;
    }
  },
);

const resolveLinkUrl = Effect.fn("desktop.about.resolveLinkUrl")(function* (
  link: AboutLink,
) {
  switch (link) {
    case "commit":
      return desktopBuildInfo.commit === null
        ? null
        : `${REPOSITORY_URL}/commit/${desktopBuildInfo.commit}`;
    case "documentation":
      return `${WEBSITE_URL}/docs`;
    case "issues":
      return `${REPOSITORY_URL}/issues/new`;
    case "releaseNotes": {
      const version = yield* (yield* ElectronApp).getVersion;
      return `${REPOSITORY_URL}/releases/tag/v${version}`;
    }
    case "repository":
      return REPOSITORY_URL;
  }
});

export const getInfo = makeDesktopIpcMethod({
  descriptor: AboutIpc.getInfo,
  allowedSenders: aboutSenders,
  handler: Effect.fn("desktop.ipc.about.getInfo")(function* () {
    const app = yield* ElectronApp;
    const env = yield* DesktopEnvironment;

    return {
      build: desktopBuildInfo,
      channel: env.isDev ? "development" : "release",
      paths: {
        appData: yield* resolveFolderPath("appData"),
        logs: yield* resolveFolderPath("logs"),
        scripts: yield* resolveFolderPath("scripts"),
      },
      system: {
        arch: process.arch,
        osVersion: process.getSystemVersion(),
        platform: platformLabel(env.platform),
      },
      version: yield* app.getVersion,
    } as const;
  }),
});

export const openFolder = makeDesktopIpcMethod({
  descriptor: AboutIpc.openFolder,
  allowedSenders: aboutSenders,
  handler: Effect.fn("desktop.ipc.about.openFolder")(function* (payload) {
    const shell = yield* ElectronShell;
    return yield* shell.openPath(yield* resolveFolderPath(payload.folder));
  }),
});

export const openLink = makeDesktopIpcMethod({
  descriptor: AboutIpc.openLink,
  allowedSenders: aboutSenders,
  handler: Effect.fn("desktop.ipc.about.openLink")(function* (payload) {
    const url = yield* resolveLinkUrl(payload.link);
    if (url === null) {
      return false;
    }

    const shell = yield* ElectronShell;
    return yield* shell.openExternal(new URL(url));
  }),
});

export const methods = [getInfo, openFolder, openLink] as const;
