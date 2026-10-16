import * as Effect from "effect/Effect";

import { AccountsIpc } from "../../../shared/ipc";
import { Accounts } from "../../internal/accounts/Accounts";
import { DesktopWindows } from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpcMethod } from "../DesktopIpc";

const accountManagerSenders = ["account-manager"] as const;
const gameSenders = ["game"] as const;
const GAME_LOAD_RECOVERY_SCRIPT_MESSAGE =
  "Launch script skipped after the game took too long to load";

export const getState = makeDesktopIpcMethod({
  descriptor: AccountsIpc.getState,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.getState")(function* () {
    const accounts = yield* Accounts;
    return yield* accounts.getState;
  }),
});

export const getServers = makeDesktopIpcMethod({
  descriptor: AccountsIpc.getServers,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.getServers")(function* () {
    const accounts = yield* Accounts;
    return yield* accounts.getServers;
  }),
});

export const getServerPings = makeDesktopIpcMethod({
  descriptor: AccountsIpc.getServerPings,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.getServerPings")(function* () {
    const accounts = yield* Accounts;
    return yield* accounts.getServerPings;
  }),
});

export const refreshServers = makeDesktopIpcMethod({
  descriptor: AccountsIpc.refreshServers,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.refreshServers")(function* () {
    const accounts = yield* Accounts;
    return yield* accounts.refreshServers;
  }),
});

export const getGameLaunch = makeDesktopIpcMethod({
  descriptor: AccountsIpc.getGameLaunch,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.accounts.getGameLaunch")(
    function* (_payload, sender) {
      const accounts = yield* Accounts;
      return yield* accounts.getGameLaunch(sender.rendererId);
    },
  ),
});

export const prepareGameLoadRecovery = makeDesktopIpcMethod({
  descriptor: AccountsIpc.prepareGameLoadRecovery,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.accounts.prepareGameLoadRecovery")(
    function* (_payload, sender) {
      const accounts = yield* Accounts;
      const launch = yield* accounts.getGameLaunch(sender.rendererId);
      if (launch?.script === undefined) return;

      yield* accounts.suppressGameWindowLaunchScript(
        sender.rendererId,
        GAME_LOAD_RECOVERY_SCRIPT_MESSAGE,
      );
    },
  ),
});

export const createAccount = makeDesktopIpcMethod({
  descriptor: AccountsIpc.createAccount,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.createAccount")(function* (draft) {
    const accounts = yield* Accounts;
    return yield* accounts.createAccount(draft);
  }),
});

export const updateAccount = makeDesktopIpcMethod({
  descriptor: AccountsIpc.updateAccount,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.updateAccount")(function* (payload) {
    const accounts = yield* Accounts;
    return yield* accounts.updateAccount(payload.username, payload.patch);
  }),
});

export const deleteAccount = makeDesktopIpcMethod({
  descriptor: AccountsIpc.deleteAccount,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.deleteAccount")(function* (payload) {
    const accounts = yield* Accounts;
    return yield* accounts.deleteAccount(payload.username);
  }),
});

export const deleteAccounts = makeDesktopIpcMethod({
  descriptor: AccountsIpc.deleteAccounts,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.deleteAccounts")(
    function* (payload) {
      const accounts = yield* Accounts;
      return yield* accounts.deleteAccounts(payload.usernames);
    },
  ),
});

export const createGroup = makeDesktopIpcMethod({
  descriptor: AccountsIpc.createGroup,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.createGroup")(function* (draft) {
    const accounts = yield* Accounts;
    return yield* accounts.createGroup(draft);
  }),
});

export const updateGroup = makeDesktopIpcMethod({
  descriptor: AccountsIpc.updateGroup,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.updateGroup")(function* (payload) {
    const accounts = yield* Accounts;
    return yield* accounts.updateGroup(payload.name, payload.patch);
  }),
});

export const deleteGroup = makeDesktopIpcMethod({
  descriptor: AccountsIpc.deleteGroup,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.deleteGroup")(function* (payload) {
    const accounts = yield* Accounts;
    return yield* accounts.deleteGroup(payload.name);
  }),
});

export const launch = makeDesktopIpcMethod({
  descriptor: AccountsIpc.launch,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.launch")(function* (request) {
    const accounts = yield* Accounts;
    return yield* accounts.launch(request);
  }),
});

export const focusGameWindow = makeDesktopIpcMethod({
  descriptor: AccountsIpc.focusGameWindow,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.focusGameWindow")(
    function* (request) {
      const accounts = yield* Accounts;
      return yield* accounts.focusGameWindow(request.gameWindowId);
    },
  ),
});

export const closeGameWindow = makeDesktopIpcMethod({
  descriptor: AccountsIpc.closeGameWindow,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.closeGameWindow")(
    function* (request) {
      const accounts = yield* Accounts;
      return yield* accounts.closeGameWindow(request.gameWindowId);
    },
  ),
});

export const closeGameWindows = makeDesktopIpcMethod({
  descriptor: AccountsIpc.closeGameWindows,
  allowedSenders: accountManagerSenders,
  handler: Effect.fn("desktop.ipc.accounts.closeGameWindows")(
    function* (request) {
      const accounts = yield* Accounts;
      return yield* accounts.closeGameWindows(request.gameWindowIds);
    },
  ),
});

export const reportSession = makeDesktopIpcMethod({
  descriptor: AccountsIpc.reportSession,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.accounts.reportSession")(
    function* (report, sender) {
      const accounts = yield* Accounts;
      return yield* accounts.reportSession(sender.rendererId, report);
    },
  ),
});

export const methods = [
  getState,
  getServers,
  getServerPings,
  refreshServers,
  getGameLaunch,
  prepareGameLoadRecovery,
  createAccount,
  updateAccount,
  deleteAccount,
  deleteAccounts,
  createGroup,
  updateGroup,
  deleteGroup,
  launch,
  focusGameWindow,
  closeGameWindow,
  closeGameWindows,
  reportSession,
] as const;

export const installEventForwarding = Effect.fn(
  "desktop.ipc.accounts.installEventForwarding",
)(function* () {
  const accounts = yield* Accounts;
  const ipc = yield* DesktopIpc;
  const windows = yield* DesktopWindows;

  yield* Effect.acquireRelease(
    accounts.onChanged((state) =>
      Effect.gen(function* () {
        const rendererIds = yield* windows.getRendererIds("account-manager");
        yield* ipc.sendToRendererIds(rendererIds, AccountsIpc.changed, state);
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
});
