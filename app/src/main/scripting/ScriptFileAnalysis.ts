import { createHash } from "crypto";
import { promises as fs } from "node:fs";
import { basename } from "path";

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import { FileSystem } from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import {
  FileChangedWhileReading,
  readFileBounded,
} from "../filesystem/BoundedFileSystem";

import {
  formatBytes,
  SCRIPT_ANALYSIS_CACHE_MAX_BYTES,
  SCRIPT_ANALYSIS_CACHE_MAX_ENTRIES,
  SCRIPT_FILE_MAX_BYTES,
} from "./ScriptLimits";
import {
  analyzeScriptSource,
  type ScriptSourceAnalysis,
} from "./ScriptSourceParser";
import type { ScriptFileAnalysisResolution } from "./ScriptFileWorkerProtocol";

interface ExtractionCacheEntry {
  readonly analysis: ScriptSourceAnalysis;
  readonly weight: number;
}
const extractionCache = new Map<string, ExtractionCacheEntry>();
let extractionCacheBytes = 0;

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

const errorDetailsText = (error: unknown): string | undefined =>
  error instanceof Error && error.stack?.trim() !== ""
    ? error.stack
    : undefined;

const failed = (
  path: string,
  error: unknown,
  failureCause?: Cause.Cause<unknown>,
): ScriptFileAnalysisResolution => {
  const detailsText = errorDetailsText(error);
  return {
    status: "failed",
    path,
    message: errorMessage(error),
    ...(detailsText === undefined ? {} : { detailsText }),
    ...(failureCause === undefined ? {} : { failureCause }),
  };
};

const isMissingError = (error: unknown): boolean => {
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
    const before = yield* stat.pipe(
      Effect.catch((cause) =>
        isMissingError(cause) ? Effect.succeed(undefined) : Effect.fail(cause),
      ),
    );
    if (before === undefined) return { missing: true } as const;
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

const cachedAnalysis = Effect.fnUntraced(function* (
  source: string,
  path: string,
  revision: string,
) {
  const key = `${revision}:${path}`;
  const cached = extractionCache.get(key);
  if (cached !== undefined) {
    extractionCache.delete(key);
    extractionCache.set(key, cached);
    return cached.analysis;
  }

  const analysis = yield* analyzeScriptSource(source, path);
  const entry: ExtractionCacheEntry = {
    analysis,
    weight: Buffer.byteLength(source, "utf8"),
  };
  extractionCache.set(key, entry);
  extractionCacheBytes += entry.weight;
  while (
    extractionCache.size > SCRIPT_ANALYSIS_CACHE_MAX_ENTRIES ||
    extractionCacheBytes > SCRIPT_ANALYSIS_CACHE_MAX_BYTES
  ) {
    const oldestKey = extractionCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = extractionCache.get(oldestKey);
    extractionCache.delete(oldestKey);
    extractionCacheBytes -= oldest?.weight ?? 0;
  }
  return analysis;
});

export const analyzeScriptFile = Effect.fnUntraced(function* (
  path: string,
): Effect.fn.Return<ScriptFileAnalysisResolution> {
  const read = yield* Effect.exit(
    readStableFile(path).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (Exit.isFailure(read)) {
    const error = Cause.squash(read.cause);
    return isMissingError(error)
      ? { status: "missing", path }
      : failed(
          path,
          error,
          error instanceof ScriptFileValidationError
            ? undefined
            : Cause.fail(error),
        );
  }
  const stable = read.value;
  if ("missing" in stable) return { status: "missing", path };

  return yield* Effect.gen(function* () {
    const { contents } = stable;
    const source = contents.toString("utf8");
    const revision = createHash("sha256").update(contents).digest("hex");
    const analysis = yield* cachedAnalysis(source, path, revision);
    return {
      status: "found" as const,
      analysis: {
        file: {
          inputs: analysis.inputs,
          name: basename(path),
          path,
          revision,
          source,
        },
        fingerprint: stable.fingerprint,
        requirements: analysis.requirements,
      },
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(
        failed(
          path,
          Cause.squash(cause),
          Cause.hasDies(cause) || Cause.hasInterruptsOnly(cause)
            ? cause
            : undefined,
        ),
      ),
    ),
  );
});

export const processScriptFile = (
  path: string,
): Promise<ScriptFileAnalysisResolution> =>
  Effect.runPromise(analyzeScriptFile(path));
