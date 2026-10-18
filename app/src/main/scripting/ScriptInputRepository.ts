import { join } from "path";
import { isDeepStrictEqual } from "node:util";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  normalizeScriptInputValues,
  type ScriptInputsDefinition,
  type ScriptInputValues,
} from "@lucent/core/scriptInputs";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { FileSystem } from "effect/FileSystem";
import { type JsonFileError, makeJsonFile } from "../filesystem/JsonFile";

const inputRepositoryOperationSchema = Schema.Literals(["read", "write"]);

export class ScriptInputRepositoryError extends Schema.TaggedError<ScriptInputRepositoryError>()(
  "ScriptInputRepositoryError",
  {
    operation: inputRepositoryOperationSchema,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScriptInputRepositoryShape {
  readonly getValues: (
    definition: ScriptInputsDefinition,
  ) => Effect.Effect<ScriptInputValues, ScriptInputRepositoryError>;
  readonly saveValues: (
    definition: ScriptInputsDefinition,
    values: ScriptInputValues,
  ) => Effect.Effect<ScriptInputValues, ScriptInputRepositoryError>;
}

export class ScriptInputRepository extends Context.Service<
  ScriptInputRepository,
  ScriptInputRepositoryShape
>()("lucent/desktop/scripting/ScriptInputRepository") {}

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
type UnknownRecord = typeof UnknownRecordSchema.Type;
type Store = Record<string, UnknownRecord>;
const decodeUnknownRecord = Schema.decodeUnknownOption(UnknownRecordSchema);

const decodeStore = (
  value: unknown,
): { readonly store: Store; readonly ignoredScripts: number } | null => {
  const decodedStore = decodeUnknownRecord(value);
  if (Option.isNone(decodedStore)) {
    return null;
  }

  const store: Store = {};
  let ignoredScripts = 0;
  for (const [key, entry] of Object.entries(decodedStore.value)) {
    const decodedEntry = decodeUnknownRecord(entry);
    if (Option.isSome(decodedEntry)) {
      store[key] = decodedEntry.value;
    } else {
      ignoredScripts += 1;
    }
  }
  return { store, ignoredScripts };
};

const ignoredInputFields = (
  definition: ScriptInputsDefinition,
  raw: UnknownRecord,
): number => {
  const values = normalizeScriptInputValues(definition, raw);
  return Object.entries(raw).filter(([key, value]) => {
    const field = definition.fields.find((candidate) => candidate.key === key);
    if (
      field?.type === "multi-select" &&
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      return (
        new Set(value).size !== value.length ||
        value.some((item) => !field.options.includes(item))
      );
    }
    return !isDeepStrictEqual(value, values[key]);
  }).length;
};

const wrapJsonError = (
  operation: "read" | "write",
  error: JsonFileError,
): ScriptInputRepositoryError =>
  new ScriptInputRepositoryError({
    operation,
    detail: error.message,
    cause: error,
  });

export const layer = Layer.effect(
  ScriptInputRepository,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const jsonFile = makeJsonFile(yield* FileSystem);
    const path = join(env.appDataDir, "script-inputs.json");
    const writes = yield* Semaphore.make(1);

    const readStore = Effect.fnUntraced(function* (
      definition?: ScriptInputsDefinition,
    ) {
      const result = yield* jsonFile.read(path).pipe(
        Effect.catch((error) =>
          error.operation === "parse"
            ? Effect.succeed({ status: "malformed" as const, error })
            : Effect.fail(error),
        ),
        Effect.mapError((error) => wrapJsonError("read", error)),
      );
      if (result.status === "missing") return {};
      const decoded = result.status === "ok" ? decodeStore(result.value) : null;
      if (decoded === null) {
        if (definition !== undefined) {
          yield* Effect.logWarning(
            "Saved script inputs could not be read; using defaults until the next save",
            ...(result.status === "malformed"
              ? [Cause.fail(result.error)]
              : []),
          ).pipe(
            Effect.annotateLogs({
              component: "script-inputs",
              data: { path, ignored: { file: 1 } },
            }),
          );
        }
        return {};
      }
      const fields =
        definition === undefined
          ? 0
          : ignoredInputFields(definition, decoded.store[definition.id] ?? {});
      if (
        definition !== undefined &&
        (decoded.ignoredScripts > 0 || fields > 0)
      ) {
        yield* Effect.logWarning(
          "Saved script inputs had invalid entries; ignoring them until the next save",
        ).pipe(
          Effect.annotateLogs({
            component: "script-inputs",
            data: {
              path,
              ignored: { scripts: decoded.ignoredScripts, fields },
            },
          }),
        );
      }
      return decoded.store;
    });

    const writeStore = (
      store: Store,
    ): Effect.Effect<void, ScriptInputRepositoryError> =>
      jsonFile
        .write(path, store)
        .pipe(
          Effect.mapError((error: JsonFileError) =>
            wrapJsonError("write", error),
          ),
        );

    const getValues = (definition: ScriptInputsDefinition) =>
      readStore(definition).pipe(
        Effect.map((store) =>
          normalizeScriptInputValues(definition, store[definition.id] ?? {}),
        ),
      );

    const saveValues = (
      definition: ScriptInputsDefinition,
      values: ScriptInputValues,
    ) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const normalized = normalizeScriptInputValues(definition, values);
          const store = yield* readStore();
          yield* writeStore({
            ...store,
            [definition.id]: normalized,
          });
          return normalized;
        }),
      );

    return ScriptInputRepository.of({
      getValues,
      saveValues,
    });
  }),
);
