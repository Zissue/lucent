import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { makeSavedDocument } from "../filesystem/SavedDocument";

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
const isStoredInput = Schema.is(UnknownRecordSchema);
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

const decodeStore =
  (definition: ScriptInputsDefinition) => (document: UnknownRecord) => {
    const store: Store = {};
    let scripts = 0;
    for (const [key, entry] of Object.entries(document)) {
      if (isStoredInput(entry)) store[key] = entry;
      else scripts++;
    }
    const fields = ignoredInputFields(definition, store[definition.id] ?? {});
    return { value: store, issues: { ignored: { scripts, fields } } };
  };

const wrapJsonError = (error: JsonFileError): ScriptInputRepositoryError =>
  new ScriptInputRepositoryError({
    operation: error.operation === "read" ? "read" : "write",
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

    const documentFor = (definition: ScriptInputsDefinition) =>
      makeSavedDocument(jsonFile, {
        kind: "script-inputs",
        path,
        defaults: (): Store => ({}),
        decode: decodeStore(definition),
        encode: (value) => value,
        mapError: wrapJsonError,
      });

    const getValues = Effect.fn("ScriptInputRepository.getValues")(function* (
      definition: ScriptInputsDefinition,
    ) {
      const document = yield* documentFor(definition);
      const store = yield* document.load({ diagnostics: true });
      return normalizeScriptInputValues(definition, store[definition.id] ?? {});
    });

    const saveValues = (
      definition: ScriptInputsDefinition,
      values: ScriptInputValues,
    ) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const normalized = normalizeScriptInputValues(definition, values);
          const document = yield* documentFor(definition);
          const store = yield* document.load({ diagnostics: false });
          yield* document.save({
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
