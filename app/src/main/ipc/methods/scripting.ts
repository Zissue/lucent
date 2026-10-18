import * as Effect from "effect/Effect";

import { ScriptingIpc } from "../../../shared/ipc";
import { ScriptInputRepository } from "../../scripting/ScriptInputRepository";
import { GitHubCredentials } from "../../scripting/GitHubCredentials";
import { ScriptPackageManager } from "../../scripting/ScriptPackageManager";
import { ScriptPackageCatalog } from "../../scripting/ScriptPackageCatalog";
import { DesktopScriptLibrary } from "../../scripting/DesktopScriptLibrary";
import { DesktopWindows } from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpcMethod } from "../DesktopIpc";

const scriptingSenders = ["game"] as const;

export const listCredentials = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.listCredentials,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.listCredentials")(function* () {
    const credentials = yield* GitHubCredentials;
    return yield* credentials.list;
  }),
});

export const saveCredential = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.saveCredential,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.saveCredential")(function* (input) {
    const credentials = yield* GitHubCredentials;
    return yield* credentials.save(input);
  }),
});

export const deleteCredential = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.deleteCredential,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.deleteCredential")(
    function* (input) {
      const credentials = yield* GitHubCredentials;
      return yield* credentials.delete(input.id);
    },
  ),
});

export const installPackage = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.installPackage,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.installPackage")(function* (input) {
    const packages = yield* ScriptPackageManager;
    return yield* packages.install(input);
  }),
});

export const updatePackage = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.updatePackage,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.updatePackage")(function* (input) {
    const packages = yield* ScriptPackageManager;
    return yield* packages.update(input);
  }),
});

export const restorePackage = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.restorePackage,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.restorePackage")(function* (input) {
    const packages = yield* ScriptPackageManager;
    return yield* packages.restore(input);
  }),
});

export const removePackage = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.removePackage,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.removePackage")(function* (input) {
    const packages = yield* ScriptPackageManager;
    return yield* packages.remove(input);
  }),
});

export const checkPackageUpdate = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.checkPackageUpdate,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.checkPackageUpdate")(
    function* (input) {
      const packages = yield* ScriptPackageManager;
      return yield* packages.checkUpdate(input);
    },
  ),
});

export const openRepository = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.openRepository,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.openRepository")(function* (input) {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.openRepository(input.repositoryUrl);
  }),
});

export const getCatalog = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.getCatalog,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.getCatalog")(function* () {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.getCatalog;
  }),
});

export const getCatalogPage = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.getCatalogPage,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.getCatalogPage")(function* (input) {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.getCatalogPage(input);
  }),
});

export const refreshCatalog = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.refreshCatalog,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.refreshCatalog")(function* () {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.refreshCatalog;
  }),
});

export const openFile = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.openFile,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.openFile")(function* () {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.openFile();
  }),
});

export const loadReference = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.loadReference,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.loadReference")(
    function* (reference) {
      const scripts = yield* DesktopScriptLibrary;
      return yield* scripts.loadReference(reference);
    },
  ),
});

export const readFile = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.readFile,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.readFile")(function* (payload) {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.readFile(payload.path);
  }),
});

export const readReference = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.readReference,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.readReference")(
    function* (reference) {
      const scripts = yield* DesktopScriptLibrary;
      return yield* scripts.readReference(reference);
    },
  ),
});

export const resolveFile = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.resolveFile,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.resolveFile")(function* (payload) {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.resolveFile(payload.path);
  }),
});

export const resolveReference = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.resolveReference,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.resolveReference")(
    function* (reference) {
      const scripts = yield* DesktopScriptLibrary;
      return yield* scripts.resolveReference(reference);
    },
  ),
});

export const selectFile = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.selectFile,
  allowedSenders: ["account-manager"],
  handler: Effect.fn("desktop.ipc.scripting.selectFile")(function* () {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.selectFile;
  }),
});

export const openPath = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.openPath,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.openPath")(function* (payload) {
    const scripts = yield* DesktopScriptLibrary;
    return yield* scripts.openPath(payload.path);
  }),
});

export const getInputValues = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.getInputValues,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.getInputValues")(
    function* (definition) {
      const scriptInputs = yield* ScriptInputRepository;
      return yield* scriptInputs.getValues(definition);
    },
  ),
});

export const saveInputValues = makeDesktopIpcMethod({
  descriptor: ScriptingIpc.saveInputValues,
  allowedSenders: scriptingSenders,
  handler: Effect.fn("desktop.ipc.scripting.saveInputValues")(
    function* (payload) {
      const scriptInputs = yield* ScriptInputRepository;
      return yield* scriptInputs.saveValues(payload.definition, payload.values);
    },
  ),
});

export const libraryMethods = [
  getCatalog,
  getCatalogPage,
  refreshCatalog,
  loadReference,
  openFile,
  readFile,
  readReference,
  resolveFile,
  resolveReference,
  selectFile,
  openPath,
  openRepository,
] as const;

export const inputMethods = [getInputValues, saveInputValues] as const;

export const credentialMethods = [
  listCredentials,
  saveCredential,
  deleteCredential,
] as const;

export const packageMethods = [
  installPackage,
  updatePackage,
  restorePackage,
  removePackage,
  checkPackageUpdate,
] as const;

export const methods = [
  ...libraryMethods,
  ...inputMethods,
  ...credentialMethods,
  ...packageMethods,
] as const;

export const installEventForwarding = Effect.fn(
  "desktop.ipc.scripting.installEventForwarding",
)(function* () {
  const ipc = yield* DesktopIpc;
  const catalog = yield* ScriptPackageCatalog;
  const windows = yield* DesktopWindows;

  yield* catalog.onChanged((change) =>
    Effect.gen(function* () {
      const rendererIds = yield* windows.getRendererIds("game");
      yield* ipc.sendToRendererIds(
        rendererIds,
        ScriptingIpc.catalogChanged,
        change,
      );
    }),
  );
});
