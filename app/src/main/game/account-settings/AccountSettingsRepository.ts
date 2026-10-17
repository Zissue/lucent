import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

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
import { type JsonFileError, makeJsonFile } from "../../filesystem/JsonFile";
import { makeSavedDocument } from "../../filesystem/SavedDocument";

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

const decodeAccountSettings = (document: Readonly<Record<string, unknown>>) => {
  const settings = normalizeAccountSettings(document);
  const reset: string[] = [];
  const scripts = document["scripts"];
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
  return { value: settings, issues: { reset } };
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

    const documentAt = (path: string) =>
      makeSavedDocument(jsonFile, {
        kind: "account-settings",
        path,
        logPath: join(
          env.appDataDir,
          ACCOUNT_SETTINGS_DIRECTORY,
          "[account].json",
        ),
        versions: {
          current: DEFAULT_ACCOUNT_SETTINGS.version,
          migrations: {},
        },
        defaults: () => DEFAULT_ACCOUNT_SETTINGS,
        decode: decodeAccountSettings,
        encode: serializeAccountSettings,
        mapError: wrapJsonError,
      });

    const get = Effect.fn("AccountSettingsRepository.get")(function* (
      username: string,
    ) {
      const document = yield* documentAt(yield* pathFor(username));
      return yield* document.load({ diagnostics: true });
    });

    const update = Effect.fn("AccountSettingsRepository.update")(function* (
      username: string,
      patch: AccountSettingsPatch,
    ) {
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const path = yield* pathFor(username);
          const document = yield* documentAt(path);
          const current = yield* document.load({ diagnostics: false });
          const next = applyAccountSettingsPatch(current, patch);
          return yield* document.save(next);
        }),
      );
    });

    return AccountSettingsRepository.of({ get, pathFor, update });
  }),
);
