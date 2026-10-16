import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ScriptFileReferenceSchema } from "./scriptInputs";

export const ManagedAccountSchema = Schema.Struct({
  label: Schema.String,
  username: Schema.String,
  password: Schema.String,
});

export type ManagedAccount = typeof ManagedAccountSchema.Type;

export const ManagedAccountDraftSchema = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  username: Schema.String,
  password: Schema.String,
});

export type ManagedAccountDraft = typeof ManagedAccountDraftSchema.Type;

export const ManagedAccountPatchSchema = Schema.Struct({
  label: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
});

export type ManagedAccountPatch = typeof ManagedAccountPatchSchema.Type;

export const ManagedAccountGroupsSchema = Schema.Record(
  Schema.String,
  Schema.Array(Schema.String),
);

export type ManagedAccountGroups = typeof ManagedAccountGroupsSchema.Type;

export const ManagedAccountGroupDraftSchema = Schema.Struct({
  name: Schema.String,
  usernames: Schema.Array(Schema.String),
});

export type ManagedAccountGroupDraft =
  typeof ManagedAccountGroupDraftSchema.Type;

export const ManagedAccountGroupPatchSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  usernames: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type ManagedAccountGroupPatch =
  typeof ManagedAccountGroupPatchSchema.Type;

export const AccountScriptReferenceSchema = ScriptFileReferenceSchema;

export type AccountScriptReference = typeof AccountScriptReferenceSchema.Type;

export const AccountSessionConnectionSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("offline"),
    lastUsername: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("connecting"),
    lastUsername: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("online"),
    username: Schema.String,
  }),
]);

export type AccountSessionConnection =
  typeof AccountSessionConnectionSchema.Type;

const AccountSessionActiveLoginSchema = <State extends string>(state: State) =>
  Schema.Struct({
    state: Schema.Literal(state),
    attemptsRemaining: Schema.optionalKey(Schema.Number),
    message: Schema.optionalKey(Schema.String),
  });

export const AccountSessionLoginSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({ state: Schema.Literal("waiting-for-game") }),
  AccountSessionActiveLoginSchema("authenticating"),
  AccountSessionActiveLoginSchema("waiting-for-server"),
  Schema.Struct({
    state: Schema.Literal("selecting-server"),
    attemptsRemaining: Schema.optionalKey(Schema.Number),
    message: Schema.optionalKey(Schema.String),
    server: Schema.optionalKey(Schema.String),
  }),
  AccountSessionActiveLoginSchema("waiting-for-player"),
  Schema.Struct({
    state: Schema.Literal("failed"),
    message: Schema.String,
  }),
]);

export type AccountSessionLogin = typeof AccountSessionLoginSchema.Type;

export const AccountSessionScriptSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("idle"),
    name: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("starting"),
    name: Schema.String,
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("running"),
    name: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("stopped"),
    name: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    name: Schema.optionalKey(Schema.String),
    message: Schema.String,
  }),
]);

export type AccountSessionScript = typeof AccountSessionScriptSchema.Type;

/** Separate runtime facts reconciled by the renderer's session reducer. */
export const AccountSessionRuntimeSchema = Schema.Struct({
  connection: AccountSessionConnectionSchema,
  login: AccountSessionLoginSchema,
  script: AccountSessionScriptSchema,
});

export type AccountSessionRuntime = typeof AccountSessionRuntimeSchema.Type;

export const AccountGameServerSchema = Schema.Struct({
  name: Schema.String,
  language: Schema.String,
  online: Schema.Boolean,
  upgrade: Schema.Boolean,
  playerCount: Schema.Number,
  maxPlayers: Schema.Number,
});

export type AccountGameServer = typeof AccountGameServerSchema.Type;

export const AccountGameServersResultSchema = Schema.Struct({
  servers: Schema.Array(AccountGameServerSchema),
  refreshAvailableAt: Schema.Number,
});

export type AccountGameServersResult =
  typeof AccountGameServersResultSchema.Type;

export const AccountGameServerPingSchema = Schema.Union([
  Schema.Struct({
    serverName: Schema.String,
    status: Schema.Literal("ok"),
    latencyMs: Schema.Number,
  }),
  Schema.Struct({
    serverName: Schema.String,
    status: Schema.Literals(["offline", "timeout", "unreachable"]),
  }),
]);

export type AccountGameServerPing = typeof AccountGameServerPingSchema.Type;

export const AccountGameServerPingsResultSchema = Schema.Struct({
  pings: Schema.Array(AccountGameServerPingSchema),
  measuredAt: Schema.Number,
  expiresAt: Schema.Number,
});

export type AccountGameServerPingsResult =
  typeof AccountGameServerPingsResultSchema.Type;

export const AccountSessionLaunchSchema = Schema.Struct({
  requestedAt: Schema.Number,
  scriptName: Schema.optionalKey(Schema.String),
  server: Schema.optionalKey(Schema.String),
  username: Schema.String,
});

export type AccountSessionLaunch = typeof AccountSessionLaunchSchema.Type;

export const AccountGameSessionSchema = Schema.Struct({
  gameWindowId: Schema.Number,
  gameWindowGroupId: Schema.optionalKey(Schema.Number),
  rendererGeneration: Schema.Int,
  revision: Schema.Int,
  launch: Schema.optionalKey(AccountSessionLaunchSchema),
  connection: AccountSessionConnectionSchema,
  login: AccountSessionLoginSchema,
  script: AccountSessionScriptSchema,
  updatedAt: Schema.Number,
});

export type AccountGameSession = typeof AccountGameSessionSchema.Type;

export const RecentlyClosedGameSessionSchema = Schema.Struct({
  id: Schema.Int,
  closedAt: Schema.Number,
  username: Schema.String,
  server: Schema.optionalKey(Schema.String),
});

export type RecentlyClosedGameSession =
  typeof RecentlyClosedGameSessionSchema.Type;

export const AccountManagerStateSchema = Schema.Struct({
  accounts: Schema.Array(ManagedAccountSchema),
  groups: ManagedAccountGroupsSchema,
  sessions: Schema.Array(AccountGameSessionSchema),
  storagePath: Schema.String,
});

export type AccountManagerState = typeof AccountManagerStateSchema.Type;

export const AccountLaunchWindowTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new") }),
  Schema.Struct({
    kind: Schema.Literal("same-as-game"),
    gameWindowId: Schema.Number,
  }),
]);

export type AccountLaunchWindowTarget =
  typeof AccountLaunchWindowTargetSchema.Type;

export const AccountLaunchRequestSchema = Schema.Struct({
  username: Schema.String,
  script: Schema.optionalKey(Schema.NullOr(AccountScriptReferenceSchema)),
  server: Schema.optionalKey(Schema.String),
  gameViewLayout: Schema.optionalKey(Schema.Literal("grid")),
  windowTarget: Schema.optionalKey(AccountLaunchWindowTargetSchema),
});

export type AccountLaunchRequest = typeof AccountLaunchRequestSchema.Type;

export const AccountLaunchResultSchema = Schema.Struct({
  gameWindowId: Schema.Number,
});

export type AccountLaunchResult = typeof AccountLaunchResultSchema.Type;

export const AccountGameWindowTargetRequestSchema = Schema.Struct({
  gameWindowId: Schema.Number,
});

export type AccountGameWindowTargetRequest =
  typeof AccountGameWindowTargetRequestSchema.Type;

export const AccountGameLaunchPayloadSchema = Schema.Struct({
  account: ManagedAccountSchema,
  script: Schema.optionalKey(AccountScriptReferenceSchema),
  server: Schema.optionalKey(Schema.String),
  gameWindowId: Schema.Number,
  requestedAt: Schema.Number,
});

export type AccountGameLaunchPayload =
  typeof AccountGameLaunchPayloadSchema.Type;

/** A full renderer snapshot ordered within one renderer document generation. */
export const AccountSessionReportSchema = Schema.Struct({
  rendererGeneration: Schema.Int,
  revision: Schema.Int,
  runtime: AccountSessionRuntimeSchema,
});

export type AccountSessionReport = typeof AccountSessionReportSchema.Type;

export interface AccountManagerStorage {
  readonly accounts: readonly ManagedAccount[];
  readonly groups: ManagedAccountGroups;
}

const emptyStorage: AccountManagerStorage = {
  accounts: [],
  groups: {},
};

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const UnknownArraySchema = Schema.Array(Schema.Unknown);
const decodeUnknownArray = Schema.decodeUnknownOption(UnknownArraySchema);
const decodeUnknownRecord = Schema.decodeUnknownOption(UnknownRecordSchema);
const isManagedAccount = Schema.is(ManagedAccountSchema);

const decodeArrayOrEmpty = (value: unknown): readonly unknown[] => {
  const decoded = decodeUnknownArray(value);
  return Option.isSome(decoded) ? decoded.value : [];
};

const decodeRecordOrEmpty = (
  value: unknown,
): Readonly<Record<string, unknown>> => {
  const decoded = decodeUnknownRecord(value);
  return Option.isSome(decoded) ? decoded.value : {};
};

export const normalizeStoredAccount = (
  account: ManagedAccount,
): ManagedAccount => ({
  label: account.label,
  username: account.username,
  password: account.password,
});

export const dedupeAccountsByUsername = (
  accounts: readonly ManagedAccount[],
): readonly ManagedAccount[] => {
  const seen = new Set<string>();
  const nextAccounts: ManagedAccount[] = [];

  for (const account of accounts) {
    const key = account.username.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    nextAccounts.push(account);
  }

  return nextAccounts;
};

const normalizeAccounts = (value: unknown): readonly ManagedAccount[] => {
  return dedupeAccountsByUsername(
    decodeArrayOrEmpty(value)
      .filter(isManagedAccount)
      .map(normalizeStoredAccount),
  );
};

const normalizeStoredGroupMembers = (
  value: unknown,
  accounts: readonly ManagedAccount[],
): readonly string[] => {
  const accountUsernames = new Set(accounts.map((account) => account.username));
  const seen = new Set<string>();
  const usernames: string[] = [];

  for (const member of decodeArrayOrEmpty(value)) {
    if (typeof member !== "string" || !accountUsernames.has(member)) {
      continue;
    }

    const key = member.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    usernames.push(member);
  }

  return usernames;
};

const normalizeGroups = (
  value: unknown,
  accounts: readonly ManagedAccount[],
): ManagedAccountGroups => {
  const groups: Record<string, readonly string[]> = {};
  const seen = new Set<string>();

  for (const [rawName, rawMembers] of Object.entries(
    decodeRecordOrEmpty(value),
  )) {
    const name = rawName.trim();
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) {
      continue;
    }

    seen.add(key);
    groups[name] = normalizeStoredGroupMembers(rawMembers, accounts);
  }

  return groups;
};

export const normalizeAccountManagerStorage = (
  value: unknown,
): AccountManagerStorage => {
  const storage = decodeUnknownRecord(value);
  if (Option.isNone(storage)) {
    return emptyStorage;
  }
  const accounts = normalizeAccounts(storage.value["accounts"]);

  return {
    accounts,
    groups: normalizeGroups(storage.value["groups"], accounts),
  };
};

export const renameGroupMemberUsername = (
  groups: ManagedAccountGroups,
  currentUsername: string,
  nextUsername: string,
): ManagedAccountGroups => {
  if (currentUsername === nextUsername) {
    return groups;
  }

  const nextGroups: Record<string, readonly string[]> = {};
  for (const [name, usernames] of Object.entries(groups)) {
    const seen = new Set<string>();
    const nextUsernames: string[] = [];
    for (const username of usernames) {
      const next = username === currentUsername ? nextUsername : username;
      const key = next.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      nextUsernames.push(next);
    }
    nextGroups[name] = nextUsernames;
  }

  return nextGroups;
};

export const removeGroupMemberUsername = (
  groups: ManagedAccountGroups,
  accountUsername: string,
): ManagedAccountGroups => {
  const nextGroups: Record<string, readonly string[]> = {};
  for (const [name, usernames] of Object.entries(groups)) {
    nextGroups[name] = usernames.filter(
      (username) => username !== accountUsername,
    );
  }

  return nextGroups;
};

export const serializeAccountManagerStorage = (
  storage: AccountManagerStorage,
): AccountManagerStorage => {
  const accounts = dedupeAccountsByUsername(
    storage.accounts.map(normalizeStoredAccount),
  );
  return {
    accounts,
    groups: normalizeGroups(storage.groups, accounts),
  };
};

export const emptyAccountManagerStorage = (): AccountManagerStorage =>
  normalizeAccountManagerStorage(emptyStorage);
