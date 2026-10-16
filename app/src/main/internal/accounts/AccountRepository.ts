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

export interface AccountRepositoryShape {
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
    const storageRef =
      yield* SynchronizedRef.make<AccountManagerStorage | null>(null);

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

    const write = (storage: AccountManagerStorage) => {
      const normalized = serializeAccountManagerStorage(storage);
      return jsonFile
        .write(path, normalized)
        .pipe(Effect.mapError(wrapJsonError), Effect.as(normalized));
    };

    const get = SynchronizedRef.modifyEffect(storageRef, (current) =>
      (current === null ? readStorageFromFile : Effect.succeed(current)).pipe(
        Effect.map((storage) => [storage, storage] as const),
      ),
    );
    const load = SynchronizedRef.modifyEffect(storageRef, () =>
      readStorageFromFile.pipe(
        Effect.map((storage) => [storage, storage] as const),
      ),
    );
    const update: AccountRepositoryShape["update"] = (modify) =>
      SynchronizedRef.modifyEffect(storageRef, (current) =>
        (current === null ? readStorageFromFile : Effect.succeed(current)).pipe(
          Effect.flatMap(modify),
          Effect.flatMap(write),
          Effect.map((saved) => [saved, saved] as const),
        ),
      );

    return AccountRepository.of({
      get,
      load,
      path,
      update,
    });
  }),
);
