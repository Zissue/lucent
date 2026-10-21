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
    payload: Schema.Void,
    result: AccountManagerStateSchema,
  }),
  getServers: defineInvoke({
    channel: `${namespace}:get-servers`,
    payload: Schema.Void,
    result: AccountGameServersResultSchema,
  }),
  getServerPings: defineInvoke({
    channel: `${namespace}:get-server-pings`,
    payload: Schema.Void,
    result: AccountGameServerPingsResultSchema,
  }),
  refreshServers: defineInvoke({
    channel: `${namespace}:refresh-servers`,
    payload: Schema.Void,
    result: AccountGameServersResultSchema,
  }),
  getGameLaunch: defineInvoke({
    channel: `${namespace}:get-game-launch`,
    payload: Schema.Void,
    result: Schema.NullOr(AccountGameLaunchPayloadSchema),
  }),
  prepareGameLoadRecovery: defineInvoke({
    channel: `${namespace}:prepare-game-load-recovery`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  createAccount: defineInvoke({
    channel: `${namespace}:create-account`,
    payload: ManagedAccountDraftSchema,
    result: AccountManagerStateSchema,
  }),
  updateAccount: defineInvoke({
    channel: `${namespace}:update-account`,
    payload: Schema.Struct({
      username: Schema.String,
      patch: ManagedAccountPatchSchema,
    }),
    result: AccountManagerStateSchema,
  }),
  deleteAccounts: defineInvoke({
    channel: `${namespace}:delete-accounts`,
    payload: Schema.Struct({
      usernames: Schema.Array(Schema.String),
    }),
    result: AccountManagerStateSchema,
  }),
  createGroup: defineInvoke({
    channel: `${namespace}:create-group`,
    payload: ManagedAccountGroupDraftSchema,
    result: AccountManagerStateSchema,
  }),
  updateGroup: defineInvoke({
    channel: `${namespace}:update-group`,
    payload: Schema.Struct({
      name: Schema.String,
      patch: ManagedAccountGroupPatchSchema,
    }),
    result: AccountManagerStateSchema,
  }),
  deleteGroup: defineInvoke({
    channel: `${namespace}:delete-group`,
    payload: Schema.Struct({
      name: Schema.String,
    }),
    result: AccountManagerStateSchema,
  }),
  launch: defineInvoke({
    channel: `${namespace}:launch`,
    payload: AccountLaunchRequestSchema,
    result: AccountLaunchResultSchema,
  }),
  focusGameWindow: defineInvoke({
    channel: `${namespace}:focus-game-window`,
    payload: AccountGameWindowTargetRequestSchema,
    result: AccountManagerStateSchema,
  }),
  closeGameWindows: defineInvoke({
    channel: `${namespace}:close-game-windows`,
    payload: Schema.Struct({
      gameWindowIds: Schema.Array(Schema.Number),
    }),
    result: AccountManagerStateSchema,
  }),
  reportSession: defineInvoke({
    channel: `${namespace}:report-session`,
    payload: AccountSessionReportSchema,
    result: Schema.Void,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    payload: AccountManagerStateSchema,
  }),
} as const;
