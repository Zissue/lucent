import { promises as fs } from "fs";
import { join } from "path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

import {
  assertValidArmyConfigName,
  normalizeArmyConfig,
  type ArmyConfigPayload,
} from "@lucent/core/army";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";

const armyConfigOperationSchema = Schema.Literals([
  "parse",
  "read",
  "validate",
]);

export class ArmyConfigRepositoryError extends Schema.TaggedError<ArmyConfigRepositoryError>()(
  "ArmyConfigRepositoryError",
  {
    operation: armyConfigOperationSchema,
    configName: Schema.String,
    path: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.path === undefined
      ? `Could not ${this.operation} army config ${this.configName}.`
      : `Could not ${this.operation} army config ${this.configName} at ${this.path}.`;
  }
}

export interface ArmyConfigRepositoryShape {
  readonly read: (
    configName: string,
  ) => Effect.Effect<ArmyConfigPayload, ArmyConfigRepositoryError>;
}

export class ArmyConfigRepository extends Context.Service<
  ArmyConfigRepository,
  ArmyConfigRepositoryShape
>()("lucent/internal/army/ArmyConfigRepository") {}

const error = (
  operation: typeof armyConfigOperationSchema.Type,
  configName: string,
  cause: unknown,
  path?: string,
) =>
  new ArmyConfigRepositoryError({
    operation,
    configName,
    cause,
    ...(path === undefined ? {} : { path }),
  });

const readText = (
  configName: string,
  path: string,
): Effect.Effect<string, ArmyConfigRepositoryError> =>
  Effect.tryPromise({
    try: () => fs.readFile(path, "utf8"),
    catch: (cause) => error("read", configName, cause, path),
  });

export const layer = Layer.effect(
  ArmyConfigRepository,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const armyDir = join(env.workspaceDir, "army");

    const read: ArmyConfigRepositoryShape["read"] = (configNameInput) =>
      Effect.gen(function* () {
        const configName = yield* Effect.try({
          try: () => assertValidArmyConfigName(configNameInput),
          catch: (cause) => error("validate", configNameInput, cause),
        });
        const path = join(armyDir, `${configName}.yaml`);
        const source = yield* readText(configName, path);
        const raw = yield* Effect.try({
          try: () => parse(source) as unknown,
          catch: (cause) => error("parse", configName, cause, path),
        });
        return yield* Effect.try({
          try: () => normalizeArmyConfig(configName, raw),
          catch: (cause) => error("parse", configName, cause, path),
        });
      });

    return ArmyConfigRepository.of({ read });
  }),
);
