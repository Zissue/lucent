import "../shared/immediate";

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  applyAppearanceSnapshotToDocument,
  readDesktopViewArgument,
  readAppearanceSnapshotArgument,
  readSettingsSnapshotArgument,
} from "../shared/appearance";
import {
  readDebugModeArgument,
  readGameConsoleObservabilityArgument,
  readGameViewLayoutArgument,
} from "../shared/rendererBootstrapArguments";
import type {
  AppPlatform,
  DesktopAccountsBridge,
  DesktopAccountSettingsBridge,
  DesktopBridgeByView,
  DesktopCombatProfilesBridge,
  DesktopEnvironmentBridge,
  DesktopFileSystemBridge,
  DesktopFollowerBridge,
  DesktopGameAccountsBridge,
  DesktopGameConsoleObservabilityBridge,
  DesktopGameFollowerBridge,
  DesktopGamePacketsBridge,
  DesktopGameViewBridge,
  DesktopGameViewHostBridge,
  DesktopLoaderGrabberWindowBridge,
  DesktopLogBridge,
  DesktopPacketsWindowBridge,
  DesktopScriptingBridge,
  DesktopSettingsBridge,
  DesktopSettingsManagementBridge,
  DesktopUpdatesBridge,
  DesktopWindowsBridge,
} from "../shared/desktopBridge";
import {
  AboutIpc,
  AccountSettingsIpc,
  AccountsIpc,
  ArmyIpc,
  CombatProfilesIpc,
  RendererLogIpc,
  EnvironmentIpc,
  FollowerIpc,
  FileSystemIpc,
  GAME_RENDERER_RPC_PORT_CHANNEL,
  GAME_RENDERER_RPC_PORT_MESSAGE,
  HttpIpc,
  GameRendererIpc,
  GameViewsIpc,
  ScriptingIpc,
  SettingsIpc,
  UpdatesIpc,
  WindowsIpc,
  LoaderGrabberIpc,
  PacketsIpc,
  type RendererLogRecord,
} from "../shared/ipc";
import { desktopLogJsonSafe, type DesktopLogError } from "../shared/logRecord";
import { createInvoke, createSubscribe } from "./preloadIpcClient";

// Cancel cross-document navigations before Chromium emits the loading events
// that reset renderer state; reopening routes the URL through the main
// process window-open policy.
navigation.addEventListener("navigate", (event) => {
  const { sameDocument, url } = event.destination;
  if (
    !event.cancelable ||
    sameDocument ||
    event.downloadRequest !== null ||
    url === location.href
  ) {
    return;
  }

  event.preventDefault();
  window.open(url, "_blank");
});

const applyBootstrapAppearance = (): void => {
  try {
    const snapshot = readAppearanceSnapshotArgument(process.argv);
    if (snapshot !== null) {
      applyAppearanceSnapshotToDocument(document.documentElement, snapshot);
    }
  } catch {}
};

applyBootstrapAppearance();

const initialSettings = readSettingsSnapshotArgument(process.argv);
const initialGameViewLayout = readGameViewLayoutArgument(process.argv);
const applyBootstrapGameViewLayout = (): void => {
  try {
    // Grid game views should fill their renderer before app code mounts.
    if (initialGameViewLayout === "grid") {
      document.documentElement.setAttribute("data-topnav-hidden", "");
    }
  } catch {}
};

applyBootstrapGameViewLayout();

const bridgeView = readDesktopViewArgument(process.argv);
if (bridgeView === null) {
  throw new Error("Missing or invalid desktop bridge view.");
}
const debug = readDebugModeArgument(process.argv);
const gameConsoleObservabilityEnabled = readGameConsoleObservabilityArgument(
  process.argv,
);

const platform: AppPlatform =
  process.platform === "darwin"
    ? "mac"
    : process.platform === "win32"
      ? "windows"
      : "linux";

const writeRendererLog = (record: RendererLogRecord): void => {
  try {
    ipcRenderer.send(RendererLogIpc.record.channel, desktopLogJsonSafe(record));
  } catch {}
};

const rendererErrorRepeatKey = (error: DesktopLogError): string => {
  const firstFrame = error.stack
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  const identity = (firstFrame ?? error.message).replace(
    /[a-z][a-z\d+.-]*:\/\/[^\s)]+/gi,
    (source) => {
      const coordinates = /:\d+:\d+$/.exec(source)?.[0] ?? "";
      const url = URL.parse(
        source.slice(0, source.length - coordinates.length),
      );
      return url === null
        ? "[invalid URL]"
        : `${url.host}${url.pathname}${coordinates}`;
    },
  );
  return `${error.name}:${identity}`;
};

const logRenderer = (
  level: RendererLogRecord["level"],
  message: string,
  data: Record<string, unknown>,
  error?: DesktopLogError,
  repeatKey?: string,
): void =>
  writeRendererLog({
    level,
    message,
    component: "renderer",
    data,
    ...(error === undefined
      ? {}
      : { error: [error], repeatKey: rendererErrorRepeatKey(error) }),
    ...(repeatKey === undefined ? {} : { repeatKey }),
  });

const invoke = createInvoke((channel, payload) =>
  ipcRenderer.invoke(channel, payload),
);

interface RendererFailure {
  readonly message: "Renderer error" | "Renderer unhandled rejection";
  readonly error: DesktopLogError;
  readonly location?: {
    readonly columnNumber?: number;
    readonly lineNumber?: number;
    readonly source?: string;
  };
}

// Error events reach only listeners in the world that threw, and bridged Errors
// lose their original names, stack frames, and causes. Electron sends this
// function to the page as source text, so its whole body must be self-contained.
const installRendererLogging = (
  reportFailure: (failure: RendererFailure) => void,
  reportLog: (
    level: RendererLogRecord["level"],
    message: string,
    error?: DesktopLogError,
  ) => void,
  write: DesktopLogBridge["write"],
): DesktopLogBridge => {
  const errorDetails = (value: unknown, depth = 0): DesktopLogError => {
    if (value instanceof Error) {
      return {
        name: String(value.name),
        message: String(value.message),
        ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
        ...(value.cause === undefined || depth >= 5
          ? {}
          : { cause: errorDetails(value.cause, depth + 1) }),
      };
    }

    let message: string;
    try {
      message =
        typeof value === "string"
          ? value
          : (JSON.stringify(value) ?? String(value));
    } catch {
      try {
        message = String(value);
      } catch {
        message = "[Unserializable]";
      }
    }
    return { name: "NonError", message: message.slice(0, 1_024) };
  };

  window.addEventListener("error", (event) => {
    try {
      reportFailure({
        message: "Renderer error",
        error: errorDetails(event.error ?? event.message),
        location: {
          ...(event.colno === 0 ? {} : { columnNumber: event.colno }),
          ...(event.lineno === 0 ? {} : { lineNumber: event.lineno }),
          ...(event.filename === "" ? {} : { source: event.filename }),
        },
      });
    } catch {}
  });
  window.addEventListener("unhandledrejection", (event) => {
    try {
      reportFailure({
        message: "Renderer unhandled rejection",
        error: errorDetails(event.reason),
      });
    } catch {}
  });

  const logAtLevel =
    (level: RendererLogRecord["level"]) =>
    (message: string, error?: unknown): void => {
      try {
        reportLog(
          level,
          message,
          error === undefined ? undefined : errorDetails(error),
        );
      } catch {}
    };

  return {
    error: logAtLevel("error"),
    warn: logAtLevel("warn"),
    info: logAtLevel("info"),
    debug: logAtLevel("debug"),
    write,
  };
};

const reportRendererFailure = (failure: RendererFailure): void =>
  logRenderer(
    "error",
    failure.message,
    {
      ...failure.location,
      observedAt: new Date().toISOString(),
      view: bridgeView,
    },
    failure.error,
  );

const reportRendererLog = (
  level: RendererLogRecord["level"],
  message: string,
  error?: DesktopLogError,
): void => logRenderer(level, message, { view: bridgeView }, error);

installRendererLogging(
  reportRendererFailure,
  reportRendererLog,
  writeRendererLog,
);
const logBridge: DesktopLogBridge = contextBridge.executeInMainWorld({
  func: installRendererLogging,
  args: [reportRendererFailure, reportRendererLog, writeRendererLog],
});

const eventWrappers = new WeakMap<
  (rawPayload: unknown) => void,
  (event: IpcRendererEvent, rawPayload: unknown) => void
>();
const subscribe = createSubscribe({
  on: (channel, listener) => {
    const wrapper = (_event: IpcRendererEvent, rawPayload: unknown) =>
      listener(rawPayload);
    eventWrappers.set(listener, wrapper);
    ipcRenderer.on(channel, wrapper);
  },
  removeListener: (channel, listener) => {
    const wrapper = eventWrappers.get(listener);
    if (wrapper !== undefined) {
      ipcRenderer.removeListener(channel, wrapper);
      eventWrappers.delete(listener);
    }
  },
});

const settingsBridge: DesktopSettingsBridge = {
  initial: initialSettings,
  get: () => invoke(SettingsIpc.get, undefined),
  onChanged: (listener) => subscribe(SettingsIpc.changed, listener),
};

const settingsManagementBridge: DesktopSettingsManagementBridge = {
  ...settingsBridge,
  resetAppearance: () => invoke(SettingsIpc.resetAppearance, undefined),
  resetHotkeys: () => invoke(SettingsIpc.resetHotkeys, undefined),
  updateAppearance: (patch) => invoke(SettingsIpc.updateAppearance, patch),
  updateHotkeys: (patch) => invoke(SettingsIpc.updateHotkeys, patch),
  updatePreferences: (patch) => invoke(SettingsIpc.updatePreferences, patch),
};

const combatProfilesBridge: DesktopCombatProfilesBridge = {
  deleteProfile: (profileId) =>
    invoke(CombatProfilesIpc.deleteProfile, { profileId }),
  getState: () => invoke(CombatProfilesIpc.getState, undefined),
  onChanged: (listener) => subscribe(CombatProfilesIpc.changed, listener),
  saveProfile: (profile) => invoke(CombatProfilesIpc.saveProfile, profile),
};

const accountsBridge: DesktopAccountsBridge = {
  closeGameWindow: (request) => invoke(AccountsIpc.closeGameWindow, request),
  closeGameWindows: (gameWindowIds) =>
    invoke(AccountsIpc.closeGameWindows, { gameWindowIds }),
  createAccount: (draft) => invoke(AccountsIpc.createAccount, draft),
  createGroup: (draft) => invoke(AccountsIpc.createGroup, draft),
  deleteAccount: (username) => invoke(AccountsIpc.deleteAccount, { username }),
  deleteAccounts: (usernames) =>
    invoke(AccountsIpc.deleteAccounts, { usernames }),
  deleteGroup: (name) => invoke(AccountsIpc.deleteGroup, { name }),
  focusGameWindow: (request) => invoke(AccountsIpc.focusGameWindow, request),
  getServerPings: () => invoke(AccountsIpc.getServerPings, undefined),
  getServers: () => invoke(AccountsIpc.getServers, undefined),
  getState: () => invoke(AccountsIpc.getState, undefined),
  launch: (request) => invoke(AccountsIpc.launch, request),
  onChanged: (listener) => subscribe(AccountsIpc.changed, listener),
  refreshServers: () => invoke(AccountsIpc.refreshServers, undefined),
  updateAccount: (username, patch) =>
    invoke(AccountsIpc.updateAccount, { username, patch }),
  updateGroup: (name, patch) =>
    invoke(AccountsIpc.updateGroup, { name, patch }),
};

const gameAccountsBridge: DesktopGameAccountsBridge = {
  getGameLaunch: () => invoke(AccountsIpc.getGameLaunch, undefined),
  prepareGameLoadRecovery: () =>
    invoke(AccountsIpc.prepareGameLoadRecovery, undefined),
  reportSession: (report) => invoke(AccountsIpc.reportSession, report),
};

const accountSettingsBridge: DesktopAccountSettingsBridge = {
  get: (username) => invoke(AccountSettingsIpc.get, { username }),
  update: (username, patch) =>
    invoke(AccountSettingsIpc.update, { patch, username }),
};

const scriptingBridge: DesktopScriptingBridge = {
  checkPackageUpdate: (packageName) =>
    invoke(ScriptingIpc.checkPackageUpdate, { packageName }),
  deleteCredential: (id) => invoke(ScriptingIpc.deleteCredential, { id }),
  getCatalog: () => invoke(ScriptingIpc.getCatalog, undefined),
  getCatalogPage: (request) => invoke(ScriptingIpc.getCatalogPage, request),
  getInputValues: (definition) =>
    invoke(ScriptingIpc.getInputValues, definition),
  installPackage: (input) => invoke(ScriptingIpc.installPackage, input),
  listCredentials: () => invoke(ScriptingIpc.listCredentials, undefined),
  loadReference: (reference) => invoke(ScriptingIpc.loadReference, reference),
  onCatalogChanged: (listener) =>
    subscribe(ScriptingIpc.catalogChanged, listener),
  openFile: () => invoke(ScriptingIpc.openFile, undefined),
  openPath: (path) => invoke(ScriptingIpc.openPath, { path }),
  openRepository: (repositoryUrl) =>
    invoke(ScriptingIpc.openRepository, { repositoryUrl }),
  readFile: (path) => invoke(ScriptingIpc.readFile, { path }),
  readReference: (reference) => invoke(ScriptingIpc.readReference, reference),
  refreshCatalog: () => invoke(ScriptingIpc.refreshCatalog, undefined),
  restorePackage: (input) => invoke(ScriptingIpc.restorePackage, input),
  removePackage: (input) => invoke(ScriptingIpc.removePackage, input),
  resolveFile: (path) => invoke(ScriptingIpc.resolveFile, { path }),
  resolveReference: (reference) =>
    invoke(ScriptingIpc.resolveReference, reference),
  saveInputValues: (definition, values) =>
    invoke(ScriptingIpc.saveInputValues, { definition, values }),
  saveCredential: (input) => invoke(ScriptingIpc.saveCredential, input),
  selectFile: () => invoke(ScriptingIpc.selectFile, undefined),
  updatePackage: (input) => invoke(ScriptingIpc.updatePackage, input),
};

const gameConsoleObservabilityBridge: DesktopGameConsoleObservabilityBridge = {
  message: (method, message) =>
    logRenderer(
      "debug",
      "Renderer console message",
      { method, message },
      undefined,
      message,
    ),
};

const fileSystemBridge: DesktopFileSystemBridge = {
  exists: (path) => invoke(FileSystemIpc.exists, { path }),
  list: (path) =>
    invoke(FileSystemIpc.list, path === undefined ? {} : { path }),
  readJson: (path) => invoke(FileSystemIpc.readJson, { path }),
  readText: (path) => invoke(FileSystemIpc.readText, { path }),
  remove: (path) => invoke(FileSystemIpc.remove, { path }),
  writeJson: (path, value) => invoke(FileSystemIpc.writeJson, { path, value }),
  writeText: (path, contents) =>
    invoke(FileSystemIpc.writeText, { contents, path }),
};

const windowsBridge: DesktopWindowsBridge = {
  open: (kind) => invoke(WindowsIpc.open, { kind }),
};

const loaderGrabberWindowBridge: DesktopLoaderGrabberWindowBridge = {
  grab: (payload) => invoke(LoaderGrabberIpc.grab, payload),
  load: (payload) => invoke(LoaderGrabberIpc.load, payload),
};

const gameViewHostBridge: DesktopGameViewHostBridge = {
  getRecentlyClosed: () => invoke(GameViewsIpc.getRecentlyClosed, undefined),
  reopen: (id) => invoke(GameViewsIpc.reopen, { id }),
  add: () => invoke(GameViewsIpc.add, undefined),
  close: (id) => invoke(GameViewsIpc.close, { id }),
  dispatchGroupCommand: (request) =>
    invoke(GameViewsIpc.dispatchGroupCommand, request),
  getState: () => invoke(GameViewsIpc.getState, undefined),
  onChanged: (listener) => subscribe(GameViewsIpc.changed, listener),
  onShortcutModifierChanged: (listener) =>
    subscribe(GameViewsIpc.shortcutModifierChanged, listener),
  onTabMenuOpenChanged: (listener) =>
    subscribe(GameViewsIpc.tabMenuOpenChanged, listener),
  reorder: (ids) => invoke(GameViewsIpc.reorder, { ids }),
  select: (id, focus) => invoke(GameViewsIpc.select, { focus, id }),
  setGroupControlsOpen: (open) =>
    invoke(GameViewsIpc.setGroupControlsOpen, { open }),
  setGroupTargets: (ids) => invoke(GameViewsIpc.setGroupTargets, { ids }),
  setLayout: (layout) => invoke(GameViewsIpc.setLayout, { layout }),
  setTabMenuOpen: (open) => invoke(GameViewsIpc.setTabMenuOpen, { open }),
  syncTabBarLayout: () => invoke(GameViewsIpc.syncTabBarLayout, undefined),
};

const gameViewBridge: DesktopGameViewBridge = {
  close: () => {
    void invoke(GameViewsIpc.closeCurrent, undefined).catch(() => undefined);
  },
  dispatchGroupOptionHotkey: (commandId) =>
    invoke(GameViewsIpc.dispatchGroupOptionHotkey, { commandId }),
  getPresentation: () => invoke(GameViewsIpc.getPresentation, undefined),
  initialLayout: initialGameViewLayout,
  onGroupCommand: (listener) => subscribe(GameViewsIpc.groupCommand, listener),
  onPresentationChanged: (listener) =>
    subscribe(GameViewsIpc.presentationChanged, listener),
};

const packetsWindowBridge: DesktopPacketsWindowBridge = {
  getStatus: () => invoke(PacketsIpc.getStatus, undefined),
  onCaptured: (listener) => subscribe(PacketsIpc.captured, listener),
  onStatus: (listener) => subscribe(PacketsIpc.status, listener),
  send: (payload) => invoke(PacketsIpc.send, payload),
  startCapture: () => invoke(PacketsIpc.startCapture, undefined),
  startQueue: (payload) => invoke(PacketsIpc.startQueue, payload),
  stopCapture: () => invoke(PacketsIpc.stopCapture, undefined),
  stopQueue: () => invoke(PacketsIpc.stopQueue, undefined),
};

const gamePacketsBridge: DesktopGamePacketsBridge = {
  publishCaptured: (payload) => invoke(PacketsIpc.publishCaptured, payload),
  publishStatus: (payload) => invoke(PacketsIpc.publishStatus, payload),
};

const followerBridge: DesktopFollowerBridge = {
  configure: (payload) => invoke(FollowerIpc.configure, payload),
  getConfig: () => invoke(FollowerIpc.getConfig, undefined),
  getPlayers: () => invoke(FollowerIpc.getPlayers, undefined),
  getState: () => invoke(FollowerIpc.getState, undefined),
  me: () => invoke(FollowerIpc.me, undefined),
  onChanged: (listener) => subscribe(FollowerIpc.changed, listener),
  onPlayersChanged: (listener) =>
    subscribe(FollowerIpc.playersChanged, listener),
  start: (payload) => invoke(FollowerIpc.start, payload),
  stop: () => invoke(FollowerIpc.stop, undefined),
};

const gameFollowerBridge: DesktopGameFollowerBridge = {
  publishPlayers: (players) => invoke(FollowerIpc.publishPlayers, players),
  publishState: (state) => invoke(FollowerIpc.publishState, state),
};

const environmentBridge: DesktopEnvironmentBridge = {
  addBoost: (name) => invoke(EnvironmentIpc.addBoost, { name }),
  addBoosts: (names) => invoke(EnvironmentIpc.addBoosts, { names }),
  addItem: (name) => invoke(EnvironmentIpc.addItem, { name }),
  addItems: (names) => invoke(EnvironmentIpc.addItems, { names }),
  addQuest: (questId, rewardItemId) =>
    invoke(EnvironmentIpc.addQuest, {
      questId,
      ...(rewardItemId === undefined ? {} : { rewardItemId }),
    }),
  addQuests: (quests) => invoke(EnvironmentIpc.addQuests, { quests }),
  clear: () => invoke(EnvironmentIpc.clear, undefined),
  clearBoosts: () => invoke(EnvironmentIpc.clearBoosts, undefined),
  clearItems: () => invoke(EnvironmentIpc.clearItems, undefined),
  clearQuestReward: (questId) =>
    invoke(EnvironmentIpc.clearQuestReward, { questId }),
  clearQuests: () => invoke(EnvironmentIpc.clearQuests, undefined),
  fetchBoosts: () => invoke(EnvironmentIpc.fetchBoosts, undefined),
  getState: () => invoke(EnvironmentIpc.getState, undefined),
  onChanged: (listener) => subscribe(EnvironmentIpc.changed, listener),
  removeBoost: (name) => invoke(EnvironmentIpc.removeBoost, { name }),
  removeItem: (name) => invoke(EnvironmentIpc.removeItem, { name }),
  removeQuest: (questId) => invoke(EnvironmentIpc.removeQuest, { questId }),
  setAutomationEnabled: (capability, enabled) =>
    invoke(EnvironmentIpc.setAutomationEnabled, { capability, enabled }),
  setItemNotification: (name, enabled) =>
    invoke(EnvironmentIpc.setItemNotification, { enabled, name }),
  setItemRules: (rules) => invoke(EnvironmentIpc.setItemRules, rules),
  setQuestAutoRegister: (options) =>
    invoke(EnvironmentIpc.setQuestAutoRegister, options),
  setQuestReward: (questId, rewardItemId) =>
    invoke(EnvironmentIpc.setQuestReward, { questId, rewardItemId }),
  syncToAll: () => invoke(EnvironmentIpc.syncToAll, undefined),
  withdrawBoosts: (itemIds) =>
    invoke(EnvironmentIpc.withdrawBoosts, { itemIds }),
};

const updatesBridge: DesktopUpdatesBridge = {
  checkNow: (options) => invoke(UpdatesIpc.checkNow, options ?? {}),
  getState: () => invoke(UpdatesIpc.getState, undefined),
  onChanged: (listener) => subscribe(UpdatesIpc.changed, listener),
  openReleasePage: () => invoke(UpdatesIpc.openReleasePage, undefined),
};

const commonBridge = {
  debug,
  log: logBridge,
  platform: {
    os: platform,
  },
  settings: settingsBridge,
};

const bridges = {
  about: {
    ...commonBridge,
    about: {
      getInfo: () => invoke(AboutIpc.getInfo, undefined),
      openFolder: (folder) => invoke(AboutIpc.openFolder, { folder }),
      openLink: (link) => invoke(AboutIpc.openLink, { link }),
    },
    updates: updatesBridge,
    view: "about",
  },
  "account-manager": {
    ...commonBridge,
    accounts: accountsBridge,
    scripting: scriptingBridge,
    view: "account-manager",
  },
  "combat-profiles": {
    ...commonBridge,
    combatProfiles: combatProfilesBridge,
    view: "combat-profiles",
  },
  environment: {
    ...commonBridge,
    environment: environmentBridge,
    view: "environment",
  },
  follower: {
    ...commonBridge,
    combatProfiles: combatProfilesBridge,
    follower: followerBridge,
    view: "follower",
    windows: windowsBridge,
  },
  game: {
    ...commonBridge,
    accountSettings: accountSettingsBridge,
    army: {
      fail: (payload) => invoke(ArmyIpc.fail, payload),
      leave: () => invoke(ArmyIpc.leave, undefined),
      loadConfig: (configName) => invoke(ArmyIpc.loadConfig, { configName }),
      loopTauntAwait: (payload) => invoke(ArmyIpc.loopTauntAwait, payload),
      loopTauntLeave: (payload) => invoke(ArmyIpc.loopTauntLeave, payload),
      loopTauntRegister: (payload) =>
        invoke(ArmyIpc.loopTauntRegister, payload),
      loopTauntReport: (payload) => invoke(ArmyIpc.loopTauntReport, payload),
      loopTauntReady: (payload) => invoke(ArmyIpc.loopTauntReady, payload),
      onEnded: (listener) => subscribe(ArmyIpc.ended, listener),
      onLoopTauntCommand: (listener) =>
        subscribe(ArmyIpc.loopTauntCommand, listener),
      progress: (payload) => invoke(ArmyIpc.progress, payload),
      start: (payload) => invoke(ArmyIpc.start, payload),
      sync: (payload) => invoke(ArmyIpc.sync, payload),
    },
    combatProfiles: combatProfilesBridge,
    environment: environmentBridge,
    fileSystem: fileSystemBridge,
    http: {
      openSession: () => invoke(HttpIpc.openSession, undefined),
      closeSession: (sessionId) => invoke(HttpIpc.closeSession, { sessionId }),
      request: (payload) => invoke(HttpIpc.request, payload),
      cancel: (sessionId, requestId) =>
        invoke(HttpIpc.cancel, { sessionId, requestId }),
    },
    gameAccounts: gameAccountsBridge,
    gameFollower: gameFollowerBridge,
    gameRenderer: {
      beginScriptExecution: () =>
        invoke(GameRendererIpc.beginScriptExecution, undefined),
      finishScriptExecution: () =>
        invoke(GameRendererIpc.finishScriptExecution, undefined),
      getGeneration: () => invoke(GameRendererIpc.getGeneration, undefined),
      ready: () => invoke(GameRendererIpc.ready, undefined),
    },
    gameView: gameViewBridge,
    packets: gamePacketsBridge,
    scripting: scriptingBridge,
    view: "game",
    windows: windowsBridge,
    ...(debug && gameConsoleObservabilityEnabled
      ? { gameConsoleObservability: gameConsoleObservabilityBridge }
      : {}),
  },
  "game-group-controls": {
    ...commonBridge,
    gameViewHost: gameViewHostBridge,
    view: "game-group-controls",
  },
  "game-host": {
    ...commonBridge,
    gameViewHost: gameViewHostBridge,
    view: "game-host",
  },
  "loader-grabber": {
    ...commonBridge,
    loaderGrabber: loaderGrabberWindowBridge,
    view: "loader-grabber",
  },
  packets: {
    ...commonBridge,
    packets: packetsWindowBridge,
    view: "packets",
  },
  settings: {
    ...commonBridge,
    settings: settingsManagementBridge,
    updates: updatesBridge,
    view: "settings",
  },
} satisfies DesktopBridgeByView;

const bridge = bridges[bridgeView];

if (bridgeView === "game") {
  ipcRenderer.on(GAME_RENDERER_RPC_PORT_CHANNEL, (event) => {
    window.postMessage(GAME_RENDERER_RPC_PORT_MESSAGE, "*", event.ports);
  });
}

contextBridge.exposeInMainWorld("desktop", bridge);
