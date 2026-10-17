import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { makeCommittedState } from "../../app/CommittedState";
import type { Listener } from "../../app/ListenerRegistry";
import type * as Scope from "effect/Scope";

import {
  emptyAccountManagerStorage,
  normalizeAccountManagerStorage,
  serializeAccountManagerStorage,
  type AccountManagerStorage,
} from "@lucent/core/accounts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { FileSystem } from "effect/FileSystem";
import { type JsonFileError, makeJsonFile } from "../../filesystem/JsonFile";
import { makeSavedDocument } from "../../filesystem/SavedDocument";
import { AccountsError } from "./AccountsError";

const ACCOUNT_MANAGER_STORAGE_FILE = "accounts.json";
const isStoredDocument = Schema.is(
  Schema.Record(Schema.String, Schema.Unknown),
);
const isStoredArray = Schema.is(Schema.Array(Schema.Unknown));

const wrapJsonError = (error: JsonFileError): AccountsError =>
  new AccountsError({
    operation: error.operation,
    detail: error.message,
    cause: error,
  });

export interface AccountRepositoryShape {
  readonly current: () => AccountManagerStorage | null;
  readonly get: Effect.Effect<AccountManagerStorage, AccountsError>;
  readonly load: Effect.Effect<AccountManagerStorage, AccountsError>;
  readonly path: string;
  readonly subscribe: (
    listener: Listener<AccountManagerStorage>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly update: (
    modify: (
      storage: AccountManagerStorage,
    ) => Effect.Effect<AccountManagerStorage, AccountsError>,
  ) => Effect.Effect<AccountManagerStorage, AccountsError>;
}

export class AccountRepository extends Context.Service<
  AccountRepository,
  AccountRepositoryShape
>()("lucent/desktop/game/accounts/AccountRepository") {}

const decodeAccountStorage = (raw: Readonly<Record<string, unknown>>) => {
  const storage = normalizeAccountManagerStorage(raw);
  const reset: string[] = [];
  const accounts = isStoredArray(raw["accounts"]) ? raw["accounts"] : [];
  const groups = isStoredDocument(raw["groups"]) ? raw["groups"] : {};
  if (raw["accounts"] !== undefined && !isStoredArray(raw["accounts"]))
    reset.push("accounts");
  if (
    (raw["groups"] !== undefined && !isStoredDocument(raw["groups"])) ||
    Object.values(groups).some((members) => !isStoredArray(members))
  )
    reset.push("groups");
  const ignored = {
    accounts: accounts.length - storage.accounts.length,
    groups: Object.keys(groups).length - Object.keys(storage.groups).length,
    groupMembers:
      Object.values(groups).reduce(
        (count: number, members) =>
          count + (isStoredArray(members) ? members.length : 0),
        0,
      ) -
      Object.values(storage.groups).reduce(
        (count, members) => count + members.length,
        0,
      ),
  };
  return {
    value: storage,
    issues: {
      ...(Object.values(ignored).some((count) => count > 0) ? { ignored } : {}),
      ...(reset.length > 0 ? { reset } : {}),
    },
  };
};

export const layer = Layer.effect(
  AccountRepository,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const jsonFile = makeJsonFile(yield* FileSystem);
    const path = join(env.appDataDir, ACCOUNT_MANAGER_STORAGE_FILE);
    const document = yield* makeSavedDocument(jsonFile, {
      kind: "accounts",
      path,
      defaults: emptyAccountManagerStorage,
      decode: decodeAccountStorage,
      encode: serializeAccountManagerStorage,
      mapError: wrapJsonError,
    });
    const state = yield* makeCommittedState({
      load: document.load,
      write: document.save,
      equivalent: isDeepStrictEqual,
      shouldPublishReload: (previous, next) =>
        previous !== null && !isDeepStrictEqual(previous, next),
    });
    const update: AccountRepositoryShape["update"] = (modify) =>
      state.update((storage) =>
        modify(storage).pipe(Effect.map(serializeAccountManagerStorage)),
      );

    return AccountRepository.of({
      get: state.get,
      current: state.current,
      load: state.reload,
      path,
      subscribe: state.subscribe,
      update,
    });
  }),
);
