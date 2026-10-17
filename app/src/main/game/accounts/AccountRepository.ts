import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { makeCommittedState } from "../../app/CommittedState";

import {
  emptyAccountManagerStorage,
  normalizeAccountManagerStorage,
  serializeAccountManagerStorage,
  type AccountManagerStorage,
} from "@lucent/core/accounts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { FileSystem } from "effect/FileSystem";
import { type JsonFileError, makeJsonFile } from "../../filesystem/JsonFile";
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

interface VersionedStorage {
  readonly storage: AccountManagerStorage;
  readonly revision: number;
}

export interface AccountRepositoryShape {
  readonly getWithRevision: Effect.Effect<VersionedStorage | null>;
  readonly get: Effect.Effect<AccountManagerStorage, AccountsError>;
  readonly load: Effect.Effect<AccountManagerStorage, AccountsError>;
  readonly path: string;
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

export const layer = Layer.effect(
  AccountRepository,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const jsonFile = makeJsonFile(yield* FileSystem);
    const path = join(env.appDataDir, ACCOUNT_MANAGER_STORAGE_FILE);
    const readStorageFromFile = Effect.fnUntraced(function* ({
      diagnostics,
    }: {
      readonly diagnostics: boolean;
    }) {
      const result = yield* jsonFile.read(path).pipe(
        Effect.catch((error) =>
          error.operation === "parse"
            ? Effect.succeed({ status: "unreadable" as const, error })
            : Effect.fail(error),
        ),
        Effect.mapError(wrapJsonError),
      );
      if (
        result.status === "unreadable" ||
        (result.status === "ok" && !isStoredDocument(result.value))
      ) {
        if (diagnostics) {
          yield* Effect.logWarning(
            "Saved accounts could not be read; using defaults until the next save",
            ...(result.status === "unreadable"
              ? [Cause.fail(result.error)]
              : []),
          ).pipe(
            Effect.annotateLogs({
              component: "accounts",
              data: { path, reset: ["accounts", "groups"] },
            }),
          );
        }
        return emptyAccountManagerStorage();
      }
      const storage =
        result.status === "missing"
          ? emptyAccountManagerStorage()
          : normalizeAccountManagerStorage(result.value);
      if (result.status === "ok" && isStoredDocument(result.value)) {
        const raw = result.value;
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
          groups:
            Object.keys(groups).length - Object.keys(storage.groups).length,
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
        if (
          reset.length > 0 ||
          Object.values(ignored).some((count) => count > 0)
        ) {
          if (diagnostics) {
            yield* Effect.logWarning(
              "Saved accounts had invalid entries; ignoring them until the next save",
            ).pipe(
              Effect.annotateLogs({
                component: "accounts",
                data: {
                  path,
                  ...(Object.values(ignored).some((count) => count > 0)
                    ? { ignored }
                    : {}),
                  ...(reset.length > 0 ? { reset } : {}),
                },
              }),
            );
          }
          return storage;
        }
      }
      yield* jsonFile
        .write(path, serializeAccountManagerStorage(storage))
        .pipe(Effect.mapError(wrapJsonError));
      return storage;
    });

    const state = yield* makeCommittedState({
      load: readStorageFromFile,
      loadMayWrite: true,
      write: (storage: AccountManagerStorage) =>
        jsonFile
          .write(path, storage)
          .pipe(Effect.mapError(wrapJsonError), Effect.as(storage)),
      publishValue: (value) => value,
      equivalent: isDeepStrictEqual,
      shouldPublishReload: (previous, next) =>
        previous !== null && !isDeepStrictEqual(previous, next),
    });
    const getWithRevision = state.current.pipe(
      Effect.map((current) =>
        current === null
          ? null
          : {
              storage: current.value,
              revision: current.revision,
            },
      ),
    );
    const update: AccountRepositoryShape["update"] = (modify) =>
      state.update((storage) =>
        modify(storage).pipe(Effect.map(serializeAccountManagerStorage)),
      );

    return AccountRepository.of({
      get: state.get,
      getWithRevision,
      load: state.reload,
      path,
      update,
    });
  }),
);
