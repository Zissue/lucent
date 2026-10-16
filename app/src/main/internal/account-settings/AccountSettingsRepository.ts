import { join } from "path";

import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  DEFAULT_ACCOUNT_SETTINGS,
  applyAccountSettingsPatch,
  normalizeAccountSettings,
  serializeAccountSettings,
  type AccountSettings,
  type AccountSettingsPatch,
} from "@lucent/core/accountSettings";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { FileSystem } from "effect/FileSystem";
import { type JsonFileError, makeJsonFile } from "../../filesystem/JsonFile";

const ACCOUNT_SETTINGS_DIRECTORY = "account-settings";

const accountSettingsOperationSchema = Schema.Literals([
  "mkdir",
  "read",
  "rename",
  "unlink",
  "validate-username",
  "write",
]);

export class AccountSettingsError extends Schema.TaggedError<AccountSettingsError>()(
  "AccountSettingsError",
  {
    operation: accountSettingsOperationSchema,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AccountSettingsRepositoryShape {
  readonly get: (
    username: string,
  ) => Effect.Effect<AccountSettings, AccountSettingsError>;
  readonly pathFor: (
    username: string,
  ) => Effect.Effect<string, AccountSettingsError>;
  readonly update: (
    username: string,
    patch: AccountSettingsPatch,
  ) => Effect.Effect<AccountSettings, AccountSettingsError>;
}

export class AccountSettingsRepository extends Context.Service<
  AccountSettingsRepository,
  AccountSettingsRepositoryShape
>()("lucent/internal/account-settings/AccountSettingsRepository") {}

const wrapJsonError = (error: JsonFileError): AccountSettingsError =>
  new AccountSettingsError({
    operation: error.operation === "parse" ? "read" : error.operation,
    detail: error.message,
    cause: error,
  });

const normalizeUsername = (
  username: string,
): Effect.Effect<string, AccountSettingsError> => {
  const normalized = username.trim().toLowerCase();
  return normalized !== "" &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.includes("/") &&
    !normalized.includes("\\") &&
    !normalized.includes("\0")
    ? Effect.succeed(normalized)
    : Effect.fail(
        new AccountSettingsError({
          operation: "validate-username",
          detail: "Invalid account username.",
        }),
      );
};

export const layer = Layer.effect(
  AccountSettingsRepository,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const jsonFile = makeJsonFile(yield* FileSystem);
    const writes = yield* Semaphore.make(1);

    const pathFor = Effect.fn("AccountSettingsRepository.pathFor")(function* (
      username: string,
    ) {
      const normalized = yield* normalizeUsername(username);
      return join(
        env.appDataDir,
        ACCOUNT_SETTINGS_DIRECTORY,
        `${normalized}.json`,
      );
    });

    const readPath = Effect.fn("AccountSettingsRepository.readPath")(function* (
      path: string,
    ) {
      const result = yield* jsonFile.read(path).pipe(
        Effect.catch((error: JsonFileError) =>
          error.operation === "parse"
            ? Effect.logWarning(
                "Account settings JSON is malformed; using defaults until the next edit.",
                Cause.fail(error),
              ).pipe(
                Effect.annotateLogs({
                  component: "account-settings",
                  data: { path },
                }),
                Effect.as({ status: "malformed" as const }),
              )
            : Effect.fail(wrapJsonError(error)),
        ),
      );

      return result.status === "ok"
        ? normalizeAccountSettings(result.value)
        : DEFAULT_ACCOUNT_SETTINGS;
    });

    const get = Effect.fn("AccountSettingsRepository.get")(function* (
      username: string,
    ) {
      return yield* readPath(yield* pathFor(username));
    });

    const update = Effect.fn("AccountSettingsRepository.update")(function* (
      username: string,
      patch: AccountSettingsPatch,
    ) {
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const path = yield* pathFor(username);
          const current = yield* readPath(path);
          const next = applyAccountSettingsPatch(current, patch);
          yield* jsonFile
            .write(path, serializeAccountSettings(next))
            .pipe(Effect.mapError(wrapJsonError));
          return next;
        }),
      );
    });

    return AccountSettingsRepository.of({ get, pathFor, update });
  }),
);
