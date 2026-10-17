import { isDeepStrictEqual } from "node:util";
import { join } from "path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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
import { JsonFileError, makeJsonFile } from "../../filesystem/JsonFile";

const ACCOUNT_SETTINGS_DIRECTORY = "account-settings";
const isStoredDocument = Schema.is(
  Schema.Record(Schema.String, Schema.Unknown),
);

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
>()("lucent/desktop/game/account-settings/AccountSettingsRepository") {}

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
      diagnostics: boolean,
    ) {
      const logPath = join(
        env.appDataDir,
        ACCOUNT_SETTINGS_DIRECTORY,
        "[account].json",
      );
      const result = yield* jsonFile.read(path).pipe(
        Effect.catch((error) =>
          error.operation === "parse"
            ? Effect.succeed({ status: "unreadable" as const, error })
            : Effect.fail(error),
        ),
        Effect.mapError(wrapJsonError),
      );
      if (result.status === "missing") return DEFAULT_ACCOUNT_SETTINGS;
      if (result.status === "unreadable" || !isStoredDocument(result.value)) {
        if (diagnostics) {
          yield* Effect.logWarning(
            "Saved account settings could not be read; using defaults until the next save",
            ...(result.status === "unreadable"
              ? [
                  Cause.fail(
                    new JsonFileError({
                      operation: result.error.operation,
                      path: logPath,
                      cause: result.error.cause,
                    }),
                  ),
                ]
              : []),
          ).pipe(
            Effect.annotateLogs({
              component: "account-settings",
              data: { path: logPath, reset: ["scripts"] },
            }),
          );
        }
        return DEFAULT_ACCOUNT_SETTINGS;
      }
      const settings = normalizeAccountSettings(result.value);
      const reset: string[] = [];
      if (
        result.value["version"] !== undefined &&
        result.value["version"] !== settings.version
      )
        reset.push("version");
      const scripts = result.value["scripts"];
      if (scripts !== undefined && !isStoredDocument(scripts)) {
        reset.push("scripts");
      } else if (isStoredDocument(scripts)) {
        for (const field of [
          "restartAfterReconnect",
          "roomPolicy",
          "safeStartStop",
        ] as const) {
          if (
            scripts[field] !== undefined &&
            !isDeepStrictEqual(scripts[field], settings.scripts[field])
          )
            reset.push(`scripts.${field}`);
        }
      }
      if (diagnostics && reset.length > 0) {
        yield* Effect.logWarning(
          "Saved account settings had invalid entries; ignoring them until the next save",
        ).pipe(
          Effect.annotateLogs({
            component: "account-settings",
            data: { path: logPath, reset },
          }),
        );
      }
      return settings;
    });

    const get = Effect.fn("AccountSettingsRepository.get")(function* (
      username: string,
    ) {
      return yield* readPath(yield* pathFor(username), true);
    });

    const update = Effect.fn("AccountSettingsRepository.update")(function* (
      username: string,
      patch: AccountSettingsPatch,
    ) {
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const path = yield* pathFor(username);
          const current = yield* readPath(path, false);
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
