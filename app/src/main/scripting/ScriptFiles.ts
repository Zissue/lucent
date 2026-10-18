import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  ScriptFile,
  ScriptFileResolution,
} from "@lucent/core/scriptInputs";
import { logFailure } from "../../shared/logFailure";
import {
  analyzeScriptFile,
  isMissingError,
  type ScriptFileAnalysis,
  type ScriptFilesError,
} from "./ScriptFileAnalysis";

export interface ScriptFilesShape {
  readonly analyze: (
    path: string,
  ) => Effect.Effect<ScriptFileAnalysis, ScriptFilesError>;
  readonly read: (path: string) => Effect.Effect<ScriptFile, ScriptFilesError>;
  readonly resolve: (path: string) => Effect.Effect<ScriptFileResolution>;
}

export class ScriptFiles extends Context.Service<
  ScriptFiles,
  ScriptFilesShape
>()("lucent/desktop/scripting/ScriptFiles") {}

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

export const makeScriptFiles = (): ScriptFilesShape => {
  const analyze: ScriptFilesShape["analyze"] = analyzeScriptFile;
  const resolve: ScriptFilesShape["resolve"] = (path) =>
    analyze(path).pipe(
      Effect.map(
        (analysis): ScriptFileResolution => ({
          status: "found",
          file: analysis.file,
        }),
      ),
      Effect.catch((error): Effect.Effect<ScriptFileResolution> => {
        if (isMissingError(error.cause)) {
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

  const read: ScriptFilesShape["read"] = (path) =>
    analyze(path).pipe(Effect.map((analysis) => analysis.file));

  return ScriptFiles.of({ analyze, read, resolve });
};

export const layer = Layer.succeed(ScriptFiles, makeScriptFiles());
