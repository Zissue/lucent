import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { FileSystem } from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import {
  FileChangedWhileReading,
  readFileBounded,
} from "../filesystem/BoundedFileSystem";

import type { ScriptFile } from "@lucent/core/scriptInputs";
import { formatBytes, SCRIPT_FILE_MAX_BYTES } from "./ScriptLimits";
import { analyzeScriptSource } from "./ScriptSourceParser";

export interface ScriptFileAnalysis {
  readonly file: ScriptFile;
  readonly fingerprint: string;
  readonly requirements: readonly string[];
}

export class ScriptFilesError extends Schema.TaggedError<ScriptFilesError>()(
  "ScriptFilesError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
    failureCause: Schema.optionalKey(
      Schema.Cause(Schema.Defect(), Schema.Defect()),
    ),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return typeof error === "string" && error.trim() !== ""
    ? error
    : "Script file processing failed.";
};

export const isMissingError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

const fingerprint = (stat: Awaited<ReturnType<typeof fs.stat>>): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

class ScriptFileValidationError extends Error {}

const readStableFile = Effect.fnUntraced(
  function* (path: string) {
    const fileSystem = yield* FileSystem;
    const stat = Effect.tryPromise({
      try: () => fs.stat(path),
      catch: (cause) => cause,
    });
    const before = yield* stat;
    const sizeError = () =>
      new ScriptFileValidationError(
        `Script file exceeds the ${formatBytes(SCRIPT_FILE_MAX_BYTES)} limit: ${path}.`,
      );
    if (before.size > SCRIPT_FILE_MAX_BYTES)
      return yield* Effect.fail(sizeError());
    const bytes = yield* readFileBounded(
      fileSystem,
      path,
      SCRIPT_FILE_MAX_BYTES,
    ).pipe(
      Effect.mapError((cause) =>
        cause._tag === "FileSystemLimitError"
          ? sizeError()
          : (cause.reason.cause ?? cause),
      ),
    );
    const after = yield* stat.pipe(
      Effect.catch((cause) =>
        isMissingError(cause)
          ? Effect.fail(new FileChangedWhileReading({ path }))
          : Effect.fail(cause),
      ),
    );
    const afterFingerprint = fingerprint(after);
    if (fingerprint(before) !== afterFingerprint) {
      return yield* new FileChangedWhileReading({ path });
    }
    return {
      contents: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      fingerprint: afterFingerprint,
    };
  },
  Effect.retry({
    schedule: Schedule.recurs(1),
    while: (cause) => cause instanceof FileChangedWhileReading,
  }),
  Effect.mapError((cause) =>
    cause instanceof FileChangedWhileReading
      ? new ScriptFileValidationError(
          `Script file changed while it was being read: ${cause.path}.`,
        )
      : cause,
  ),
);

export const analyzeScriptFile = Effect.fnUntraced(function* (path: string) {
  path = resolvePath(path);
  return yield* Effect.gen(function* () {
    const stable = yield* readStableFile(path).pipe(
      Effect.provide(NodeFileSystem.layer),
    );
    const source = stable.contents.toString("utf8");
    const revision = createHash("sha256").update(stable.contents).digest("hex");
    const analysis = yield* analyzeScriptSource(source, path).pipe(
      Effect.mapError(
        (cause) => new ScriptFilesError({ path, detail: cause.message, cause }),
      ),
    );
    return {
      file: {
        inputs: analysis.inputs,
        name: basename(path),
        path,
        revision,
        source,
      },
      fingerprint: stable.fingerprint,
      requirements: analysis.requirements,
    } satisfies ScriptFileAnalysis;
  }).pipe(
    Effect.catchCause((failureCause) => {
      const cause = Cause.squash(failureCause);
      if (cause instanceof ScriptFilesError) return Effect.fail(cause);
      const missing = isMissingError(cause);
      return Effect.fail(
        new ScriptFilesError({
          path,
          detail: missing
            ? `Script file was not found at ${path}.`
            : errorMessage(cause),
          cause,
          ...(missing || cause instanceof ScriptFileValidationError
            ? {}
            : { failureCause }),
        }),
      );
    }),
  );
});
