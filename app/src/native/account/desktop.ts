import type {
  DesktopBridgeByView,
  DesktopLogBridge,
} from "../../shared/desktopBridge";
import {
  AccountSettingsIpc,
  AccountsIpc,
  ArmyIpc,
  CombatProfilesIpc,
  EnvironmentIpc,
  FileSystemIpc,
  GameViewsIpc,
  HttpIpc,
  ScriptingIpc,
  SettingsIpc,
  WindowsIpc,
  type IpcEventDescriptor,
  type IpcInvokeDescriptor,
  type IpcInvokeEnvelope,
} from "../../shared/ipc";
import type { RendererLogRecord } from "../../shared/ipc/rendererLog";
import { host, onInbound } from "../runtime/host";

class DesktopBridgeError extends Error {
  override name = "DesktopBridgeError";
}

const pending = new Map<
  number,
  { resolve: (envelope: IpcInvokeEnvelope<unknown>) => void }
>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();

onInbound<{
  readonly id: number;
  readonly envelope: IpcInvokeEnvelope<unknown>;
}>("reply", ({ id, envelope }) => {
  const call = pending.get(id);
  if (call === undefined) return;
  pending.delete(id);
  call.resolve(envelope);
});

onInbound<{ readonly channel: string; readonly payload: unknown }>(
  "event",
  ({ channel, payload }) => {
    for (const listener of [...(listeners.get(channel) ?? [])]) {
      try {
        listener(payload);
      } catch (cause) {
        host().log(
          3,
          `IPC event listener for ${channel} failed: ${String(cause)}`,
        );
      }
    }
  },
);

const invoke = async <Payload, Result>(
  descriptor: IpcInvokeDescriptor<Payload, Result>,
  payload: Payload,
): Promise<Result> => {
  const encoded = descriptor.encodePayload(payload);
  const envelope = await new Promise<IpcInvokeEnvelope<unknown>>((resolve) => {
    const id = host().call(
      "invoke",
      descriptor.channel,
      encoded === undefined ? undefined : JSON.stringify(encoded),
    ) as number;
    pending.set(id, { resolve });
  });
  if (!envelope.ok) throw new DesktopBridgeError(envelope.message);
  return envelope.value as Result;
};

const subscribe = <Payload>(
  descriptor: IpcEventDescriptor<Payload>,
  listener: (payload: Payload) => void,
): (() => void) => {
  const set = listeners.get(descriptor.channel) ?? new Set();
  const wrapped = (payload: unknown) => listener(payload as Payload);
  set.add(wrapped);
  listeners.set(descriptor.channel, set);
  return () => {
    set.delete(wrapped);
  };
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;

const errorText = (error: unknown): string =>
  error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : String(error);

const write = (record: RendererLogRecord): void => {
  const parts = [
    record.component
      ? `[${record.component}] ${record.message}`
      : record.message,
  ];
  if (record.data !== undefined) parts.push(JSON.stringify(record.data));
  if (record.error !== undefined) parts.push(JSON.stringify(record.error));
  host().log(levels[record.level] ?? 1, parts.join(" "));
};

const logAt =
  (level: keyof typeof levels) =>
  (message: string, error?: unknown): void =>
    host().log(
      levels[level],
      error === undefined ? message : `${message} ${errorText(error)}`,
    );

const log: DesktopLogBridge = {
  debug: logAt("debug"),
  info: logAt("info"),
  warn: logAt("warn"),
  error: logAt("error"),
  write,
};

export const makeDesktop = (options: {
  readonly debug: boolean;
  readonly os: "linux" | "mac" | "windows";
}): DesktopBridgeByView["game"] => ({
  debug: options.debug,
  log,
  platform: { os: options.os },
  settings: {
    initial: null,
    get: () => invoke(SettingsIpc.get, undefined),
    onChanged: (listener) => subscribe(SettingsIpc.changed, listener),
  },
  view: "game",
  accountSettings: {
    get: (username) => invoke(AccountSettingsIpc.get, { username }),
    update: (username, patch) =>
      invoke(AccountSettingsIpc.update, { patch, username }),
  },
  army: {
    fail: (payload) => invoke(ArmyIpc.fail, payload),
    leave: () => invoke(ArmyIpc.leave, undefined),
    loopTauntAwait: (payload) => invoke(ArmyIpc.loopTauntAwait, payload),
    loopTauntLeave: (payload) => invoke(ArmyIpc.loopTauntLeave, payload),
    loopTauntRegister: (payload) => invoke(ArmyIpc.loopTauntRegister, payload),
    loopTauntReport: (payload) => invoke(ArmyIpc.loopTauntReport, payload),
    loopTauntReady: (payload) => invoke(ArmyIpc.loopTauntReady, payload),
    onEnded: (listener) => subscribe(ArmyIpc.ended, listener),
    onLoopTauntCommand: (listener) =>
      subscribe(ArmyIpc.loopTauntCommand, listener),
    progress: (payload) => invoke(ArmyIpc.progress, payload),
    start: (payload) => invoke(ArmyIpc.start, payload),
    sync: (payload) => invoke(ArmyIpc.sync, payload),
  },
  combatProfiles: {
    getState: () => invoke(CombatProfilesIpc.getState, undefined),
    onChanged: (listener) => subscribe(CombatProfilesIpc.changed, listener),
  },
  environment: {
    addBoost: (name) => invoke(EnvironmentIpc.addBoost, { name }),
    addItem: (name) => invoke(EnvironmentIpc.addItem, { name }),
    addQuest: (questId, rewardItemId) =>
      invoke(EnvironmentIpc.addQuest, {
        questId,
        ...(rewardItemId === undefined ? {} : { rewardItemId }),
      }),
    clear: () => invoke(EnvironmentIpc.clear, undefined),
    clearBoosts: () => invoke(EnvironmentIpc.clearBoosts, undefined),
    clearItems: () => invoke(EnvironmentIpc.clearItems, undefined),
    clearQuestReward: (questId) =>
      invoke(EnvironmentIpc.clearQuestReward, { questId }),
    clearQuests: () => invoke(EnvironmentIpc.clearQuests, undefined),
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
    setQuestAutoRegister: (input) =>
      invoke(EnvironmentIpc.setQuestAutoRegister, input),
    setQuestReward: (questId, rewardItemId) =>
      invoke(EnvironmentIpc.setQuestReward, { questId, rewardItemId }),
    syncToAll: () => invoke(EnvironmentIpc.syncToAll, undefined),
  },
  fileSystem: {
    exists: (path) => invoke(FileSystemIpc.exists, { path }),
    list: (path) =>
      invoke(FileSystemIpc.list, path === undefined ? {} : { path }),
    readJson: (path) => invoke(FileSystemIpc.readJson, { path }),
    readText: (path) => invoke(FileSystemIpc.readText, { path }),
    remove: (path) => invoke(FileSystemIpc.remove, { path }),
    writeJson: (path, value) =>
      invoke(FileSystemIpc.writeJson, { path, value }),
    writeText: (path, contents) =>
      invoke(FileSystemIpc.writeText, { contents, path }),
  },
  http: {
    openSession: () => invoke(HttpIpc.openSession, undefined),
    closeSession: (sessionId) => invoke(HttpIpc.closeSession, { sessionId }),
    request: (payload) => invoke(HttpIpc.request, payload),
    cancel: (sessionId, requestId) =>
      invoke(HttpIpc.cancel, { sessionId, requestId }),
  },
  gameAccounts: {
    getGameLaunch: () => invoke(AccountsIpc.getGameLaunch, undefined),
    prepareGameLoadRecovery: () =>
      invoke(AccountsIpc.prepareGameLoadRecovery, undefined),
    reportSession: (report) => invoke(AccountsIpc.reportSession, report),
  },
  gameFollower: {
    publishPlayers: async () => undefined,
    publishState: async () => undefined,
  },
  gameRenderer: {
    beginScriptExecution: async () => {
      host().watch(true);
    },
    finishScriptExecution: async () => {
      host().watch(false);
    },
    getGeneration: async () => 1,
    ready: async () => undefined,
  },
  gameView: {
    close: () => {
      host().call("emit", "close-client", "null");
    },
    dispatchGroupOptionHotkey: (commandId) =>
      invoke(GameViewsIpc.dispatchGroupOptionHotkey, { commandId }),
    getPresentation: () => invoke(GameViewsIpc.getPresentation, undefined),
    initialLayout: null,
    onGroupCommand: (listener) =>
      subscribe(GameViewsIpc.groupCommand, listener),
    onPresentationChanged: (listener) =>
      subscribe(GameViewsIpc.presentationChanged, listener),
  },
  packets: {
    publishCaptured: async () => undefined,
    publishStatus: async () => undefined,
  },
  scripting: {
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
    updatePackage: (input) => invoke(ScriptingIpc.updatePackage, input),
  },
  windows: {
    open: (kind) => invoke(WindowsIpc.open, { kind }),
  },
});
