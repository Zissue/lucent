import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeAtomicFile } from "./AtomicFile";
import type { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { FileSystemLimitError, readFileBounded } from "./BoundedFileSystem";
import { parseLocalJson } from "./parseLocalJson";

/** JSON state files are intentionally bounded to protect the main process. */
export const JSON_FILE_MAX_BYTES = 8 * 1024 * 1024;

type JsonFileReadResult =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly value: unknown };

const jsonFileOperationSchema = Schema.Literals([
  "mkdir",
  "parse",
  "read",
  "rename",
  "unlink",
  "write",
]);

type JsonFileOperation = typeof jsonFileOperationSchema.Type;

export class JsonFileError extends Schema.TaggedError<JsonFileError>()(
  "JsonFileError",
  {
    operation: jsonFileOperationSchema,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const reason =
      this.cause instanceof FileSystemLimitError
        ? ` The document exceeds the limit of ${this.cause.limit} ${this.cause.kind}.`
        : "";
    return `JSON file ${this.operation} failed at ${this.path}.${reason}`;
  }
}

const makeError = (
  path: string,
  operation: JsonFileOperation,
  cause: unknown,
): JsonFileError => new JsonFileError({ operation, path, cause });

const atomicOperation = (error: PlatformError): JsonFileOperation => {
  switch (error.reason.method) {
    case "makeDirectory":
      return "mkdir";
    case "rename":
      return "rename";
    case "remove":
      return "unlink";
    default:
      return "write";
  }
};

export const makeJsonFile = (fileSystem: FileSystem) => {
  const atomicFile = makeAtomicFile(fileSystem);

  const read = Effect.fn("JsonFile.read")(function* (
    path: string,
  ): Effect.fn.Return<JsonFileReadResult, JsonFileError> {
    const bytes = yield* readFileBounded(
      fileSystem,
      path,
      JSON_FILE_MAX_BYTES,
    ).pipe(
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(makeError(path, "read", error)),
      ),
    );
    if (bytes === undefined) return { status: "missing" };

    return yield* Effect.try({
      try: () =>
        ({
          status: "ok",
          value: parseLocalJson(Buffer.from(bytes).toString("utf8")),
        }) as const,
      catch: (cause) => makeError(path, "parse", cause),
    });
  });

  const write = Effect.fn("JsonFile.write")(function* (
    path: string,
    value: unknown,
    options: { readonly mode?: number } = {},
  ): Effect.fn.Return<void, JsonFileError> {
    const source = yield* Effect.try({
      try: () => {
        const serialized = JSON.stringify(value, null, 2);
        if (serialized === undefined) {
          throw new Error("Value is not JSON serializable");
        }
        return `${serialized}\n`;
      },
      catch: (cause) => makeError(path, "write", cause),
    });

    const bytes = Buffer.from(source, "utf8");
    if (bytes.byteLength > JSON_FILE_MAX_BYTES) {
      return yield* makeError(
        path,
        "write",
        new FileSystemLimitError({
          path,
          limit: JSON_FILE_MAX_BYTES,
          kind: "bytes",
        }),
      );
    }

    return yield* atomicFile
      .write(path, bytes, options)
      .pipe(
        Effect.mapError((error) =>
          makeError(path, atomicOperation(error), error),
        ),
      );
  });

  return { read, write };
};
