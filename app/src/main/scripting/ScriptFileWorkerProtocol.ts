import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { ScriptFileSchema } from "@lucent/core/scriptInputs";

export const SCRIPT_FILE_WORKER_HEAP_MB = 256;
export const SCRIPT_FILE_WORKER_QUEUE_LIMIT = 64;
export const SCRIPT_FILE_WORKER_TIMEOUT_MS = 10_000;

export const ScriptFileAnalysisSchema = Schema.Struct({
  file: ScriptFileSchema,
  fingerprint: Schema.String,
  requirements: Schema.Array(Schema.String),
});
export type ScriptFileAnalysis = typeof ScriptFileAnalysisSchema.Type;

export const ScriptFileAnalysisResolutionSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("found"),
    analysis: ScriptFileAnalysisSchema,
  }),
  Schema.Struct({ status: Schema.Literal("missing"), path: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    path: Schema.String,
    message: Schema.String,
    detailsText: Schema.optionalKey(Schema.String),
  }),
]);
export type ScriptFileAnalysisResolution =
  typeof ScriptFileAnalysisResolutionSchema.Type;

export const ScriptFileWorkerRpcs = RpcGroup.make(
  Rpc.make("ResolveScriptFile", {
    payload: { path: Schema.String },
    success: ScriptFileAnalysisResolutionSchema,
  }),
);
