import { createHash } from "node:crypto";
import { basename, resolve as resolvePath } from "node:path";

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import {
  FileChangedWhileReading,
  FileSystemLimitError,
  isMissingFileError,
  readStableFile,
} from "../filesystem/BoundedFileSystem";

import type {
  ScriptFile,
  ScriptFileResolution,
} from "@lucent/core/scriptInputs";
import { logFailure } from "../../shared/logFailure";
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

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return typeof error === "string" && error.trim() !== ""
    ? error
    : "Script file processing failed.";
};

class ScriptFileValidationError extends Error {}

export const analyzeScriptFile = Effect.fnUntraced(function* (path: string) {
  path = resolvePath(path);
  return yield* Effect.gen(function* () {
    const stable = yield* readStableFile(path, SCRIPT_FILE_MAX_BYTES, {
      missingAfterReadIsChange: true,
    }).pipe(
      Effect.retry({
        schedule: Schedule.recurs(1),
        while: (cause) => cause instanceof FileChangedWhileReading,
      }),
      Effect.mapError((cause) =>
        cause instanceof FileSystemLimitError
          ? new ScriptFileValidationError(
              `Script file exceeds the ${formatBytes(SCRIPT_FILE_MAX_BYTES)} limit: ${path}.`,
            )
          : cause instanceof FileChangedWhileReading
            ? new ScriptFileValidationError(
                `Script file changed while it was being read: ${path}.`,
              )
            : cause,
      ),
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
      const missing = isMissingFileError(cause);
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

export const logScriptFileResolutionFailure = (
  path: string,
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> => {
  if (cause.reasons.length === 0) return Effect.void;
  return (
    Cause.hasDies(cause)
      ? logFailure("Script file analysis failed unexpectedly", cause)
      : logFailure("Failed to resolve script file", cause, {
          failure: "warning",
        })
  ).pipe(
    Effect.annotateLogs({
      component: "script-files",
      data: { path },
      repeatKey: path,
    }),
  );
};

export const resolveScriptFile = (
  path: string,
): Effect.Effect<ScriptFileResolution> =>
  analyzeScriptFile(path).pipe(
    Effect.map(
      (analysis): ScriptFileResolution => ({
        status: "found",
        file: analysis.file,
      }),
    ),
    Effect.catch((error): Effect.Effect<ScriptFileResolution> => {
      if (isMissingFileError(error.cause)) {
        return Effect.succeed({
          status: "missing" as const,
          path: error.path,
        });
      }
      const detailsText =
        error.cause instanceof Error ? error.cause.stack : undefined;
      return (
        error.failureCause === undefined
          ? Effect.void
          : logScriptFileResolutionFailure(error.path, error.failureCause)
      ).pipe(
        Effect.as({
          status: "failed" as const,
          path: error.path,
          message: error.message,
          ...(detailsText === undefined ? {} : { detailsText }),
        }),
      );
    }),
  );

export const readScriptFile = (
  path: string,
): Effect.Effect<ScriptFile, ScriptFilesError> =>
  analyzeScriptFile(path).pipe(Effect.map((analysis) => analysis.file));
