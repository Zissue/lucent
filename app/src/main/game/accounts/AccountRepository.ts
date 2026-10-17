import { isDeepStrictEqual } from "node:util";
import { join } from "path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
>()("lucent/internal/accounts/AccountRepository") {}

export const layer = Layer.effect(
  AccountRepository,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const jsonFile = makeJsonFile(yield* FileSystem);
    const path = join(env.appDataDir, ACCOUNT_MANAGER_STORAGE_FILE);
    const storageRef = yield* SynchronizedRef.make<VersionedStorage | null>(
      null,
    );

    const readStorageFromFile = Effect.gen(function* () {
      const result = yield* jsonFile
        .read(path)
        .pipe(Effect.mapError(wrapJsonError));
      const storage =
        result.status === "missing"
          ? emptyAccountManagerStorage()
          : normalizeAccountManagerStorage(result.value);
      yield* jsonFile
        .write(path, serializeAccountManagerStorage(storage))
        .pipe(Effect.mapError(wrapJsonError));
      return storage;
    });

    const getWithRevision = SynchronizedRef.get(storageRef);
    const get = SynchronizedRef.modifyEffect(storageRef, (current) =>
      Effect.gen(function* () {
        const next = current ?? {
          storage: yield* readStorageFromFile,
          revision: 0,
        };
        return [next.storage, next] as const;
      }),
    );
    const load = SynchronizedRef.modifyEffect(storageRef, (current) =>
      Effect.gen(function* () {
        const storage = yield* readStorageFromFile;
        const next =
          current !== null && isDeepStrictEqual(current.storage, storage)
            ? current
            : {
                storage,
                revision: current === null ? 0 : current.revision + 1,
              };
        return [next.storage, next] as const;
      }),
    );
    const update: AccountRepositoryShape["update"] = (modify) =>
      SynchronizedRef.modifyEffect(storageRef, (current) =>
        Effect.gen(function* () {
          const previous = current ?? {
            storage: yield* readStorageFromFile,
            revision: 0,
          };
          const storage = serializeAccountManagerStorage(
            yield* modify(previous.storage),
          );
          if (isDeepStrictEqual(previous.storage, storage))
            return [previous.storage, previous] as const;
          yield* jsonFile
            .write(path, storage)
            .pipe(Effect.mapError(wrapJsonError));
          const next = { storage, revision: previous.revision + 1 };
          return [storage, next] as const;
        }),
      );

    return AccountRepository.of({
      get,
      getWithRevision,
      load,
      path,
      update,
    });
  }),
);
