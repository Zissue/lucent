import { isDeepStrictEqual } from "node:util";
import { join } from "path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

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
    const storageRef = yield* SynchronizedRef.make<VersionedStorage | null>(
      null,
    );
    const commitLock = yield* Semaphore.make(1);

    const readStorageFromFile = Effect.fnUntraced(function* (
      diagnostics: boolean,
    ) {
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

    const getWithRevision = SynchronizedRef.get(storageRef);
    const get = SynchronizedRef.modifyEffect(storageRef, (current) =>
      Effect.gen(function* () {
        const next = current ?? {
          storage: yield* readStorageFromFile(true),
          revision: 0,
        };
        return [next.storage, next] as const;
      }),
    ).pipe(Effect.uninterruptible, Semaphore.withPermit(commitLock));
    const load = SynchronizedRef.modifyEffect(storageRef, (current) =>
      Effect.gen(function* () {
        const storage = yield* readStorageFromFile(true);
        const next =
          current !== null && isDeepStrictEqual(current.storage, storage)
            ? current
            : {
                storage,
                revision: current === null ? 0 : current.revision + 1,
              };
        return [next.storage, next] as const;
      }),
    ).pipe(Effect.uninterruptible, Semaphore.withPermit(commitLock));
    const update: AccountRepositoryShape["update"] = (modify) =>
      Effect.uninterruptibleMask((restore) =>
        SynchronizedRef.modifyEffect(storageRef, (current) =>
          Effect.gen(function* () {
            const previous = current ?? {
              storage: yield* readStorageFromFile(false),
              revision: 0,
            };
            const storage = serializeAccountManagerStorage(
              yield* restore(modify(previous.storage)),
            );
            if (isDeepStrictEqual(previous.storage, storage))
              return [previous.storage, previous] as const;
            yield* jsonFile
              .write(path, storage)
              .pipe(Effect.mapError(wrapJsonError));
            const next = { storage, revision: previous.revision + 1 };
            return [storage, next] as const;
          }),
        ),
      ).pipe(Semaphore.withPermit(commitLock));

    return AccountRepository.of({
      get,
      getWithRevision,
      load,
      path,
      update,
    });
  }),
);
