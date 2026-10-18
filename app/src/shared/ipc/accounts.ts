import * as Schema from "effect/Schema";

import {
  AccountGameLaunchPayloadSchema,
  AccountGameServerPingsResultSchema,
  AccountGameServersResultSchema,
  AccountGameWindowTargetRequestSchema,
  AccountLaunchRequestSchema,
  AccountLaunchResultSchema,
  AccountManagerStateSchema,
  AccountSessionReportSchema,
  ManagedAccountDraftSchema,
  ManagedAccountGroupDraftSchema,
  ManagedAccountGroupPatchSchema,
  ManagedAccountPatchSchema,
} from "@lucent/core/accounts";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:accounts";

export const AccountsIpc = {
  getState: defineInvoke({
    channel: `${namespace}:get-state`,
    name: "accounts.getState",
    payload: Schema.Void,
    result: AccountManagerStateSchema,
  }),
  getServers: defineInvoke({
    channel: `${namespace}:get-servers`,
    name: "accounts.getServers",
    payload: Schema.Void,
    result: AccountGameServersResultSchema,
  }),
  getServerPings: defineInvoke({
    channel: `${namespace}:get-server-pings`,
    name: "accounts.getServerPings",
    payload: Schema.Void,
    result: AccountGameServerPingsResultSchema,
  }),
  refreshServers: defineInvoke({
    channel: `${namespace}:refresh-servers`,
    name: "accounts.refreshServers",
    payload: Schema.Void,
    result: AccountGameServersResultSchema,
  }),
  getGameLaunch: defineInvoke({
    channel: `${namespace}:get-game-launch`,
    name: "accounts.getGameLaunch",
    payload: Schema.Void,
    result: Schema.NullOr(AccountGameLaunchPayloadSchema),
  }),
  prepareGameLoadRecovery: defineInvoke({
    channel: `${namespace}:prepare-game-load-recovery`,
    name: "accounts.prepareGameLoadRecovery",
    payload: Schema.Void,
    result: Schema.Void,
  }),
  createAccount: defineInvoke({
    channel: `${namespace}:create-account`,
    name: "accounts.createAccount",
    payload: ManagedAccountDraftSchema,
    result: AccountManagerStateSchema,
  }),
  updateAccount: defineInvoke({
    channel: `${namespace}:update-account`,
    name: "accounts.updateAccount",
    payload: Schema.Struct({
      username: Schema.String,
      patch: ManagedAccountPatchSchema,
    }),
    result: AccountManagerStateSchema,
  }),
  deleteAccounts: defineInvoke({
    channel: `${namespace}:delete-accounts`,
    name: "accounts.deleteAccounts",
    payload: Schema.Struct({
      usernames: Schema.Array(Schema.String),
    }),
    result: AccountManagerStateSchema,
  }),
  createGroup: defineInvoke({
    channel: `${namespace}:create-group`,
    name: "accounts.createGroup",
    payload: ManagedAccountGroupDraftSchema,
    result: AccountManagerStateSchema,
  }),
  updateGroup: defineInvoke({
    channel: `${namespace}:update-group`,
    name: "accounts.updateGroup",
    payload: Schema.Struct({
      name: Schema.String,
      patch: ManagedAccountGroupPatchSchema,
    }),
    result: AccountManagerStateSchema,
  }),
  deleteGroup: defineInvoke({
    channel: `${namespace}:delete-group`,
    name: "accounts.deleteGroup",
    payload: Schema.Struct({
      name: Schema.String,
    }),
    result: AccountManagerStateSchema,
  }),
  launch: defineInvoke({
    channel: `${namespace}:launch`,
    name: "accounts.launch",
    payload: AccountLaunchRequestSchema,
    result: AccountLaunchResultSchema,
  }),
  focusGameWindow: defineInvoke({
    channel: `${namespace}:focus-game-window`,
    name: "accounts.focusGameWindow",
    payload: AccountGameWindowTargetRequestSchema,
    result: AccountManagerStateSchema,
  }),
  closeGameWindows: defineInvoke({
    channel: `${namespace}:close-game-windows`,
    name: "accounts.closeGameWindows",
    payload: Schema.Struct({
      gameWindowIds: Schema.Array(Schema.Number),
    }),
    result: AccountManagerStateSchema,
  }),
  reportSession: defineInvoke({
    channel: `${namespace}:report-session`,
    name: "accounts.reportSession",
    payload: AccountSessionReportSchema,
    result: Schema.Void,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    name: "accounts.changed",
    payload: AccountManagerStateSchema,
  }),
} as const;
