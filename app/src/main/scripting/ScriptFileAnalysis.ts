import { createHash } from "crypto";
import { createReadStream, promises as fs } from "fs";
import { basename } from "path";

import * as Effect from "effect/Effect";

import {
  formatBytes,
  SCRIPT_ANALYSIS_CACHE_MAX_BYTES,
  SCRIPT_ANALYSIS_CACHE_MAX_ENTRIES,
  SCRIPT_FILE_MAX_BYTES,
} from "./ScriptLimits";
import {
  analyzeScriptSource,
  type ScriptSourceAnalysis,
} from "./ScriptInputsExtractor";
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

const failed = (path: string, error: unknown): ScriptFileAnalysisResolution => {
  const detailsText = errorDetailsText(error);
  return {
    status: "failed",
    path,
    message: errorMessage(error),
    ...(detailsText === undefined ? {} : { detailsText }),
  };
};

const isMissingError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

const fingerprint = (stat: Awaited<ReturnType<typeof fs.stat>>): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

const assertFileSize = (path: string, size: number): void => {
  if (size > SCRIPT_FILE_MAX_BYTES) {
    throw new Error(
      `Script file exceeds the ${formatBytes(SCRIPT_FILE_MAX_BYTES)} limit: ${path}.`,
    );
  }
};

const readBoundedFile = async (path: string): Promise<Buffer> => {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      assertFileSize(path, size);
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }

  return Buffer.concat(chunks, size);
};

const readStableFile = async (
  path: string,
): Promise<
  | { readonly contents: Buffer; readonly fingerprint: string }
  | { readonly missing: true }
> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: Awaited<ReturnType<typeof fs.stat>>;
    try {
      before = await fs.stat(path);
    } catch (error) {
      if (isMissingError(error)) return { missing: true };
      throw error;
    }

    assertFileSize(path, before.size);
    const contents = await readBoundedFile(path);
    assertFileSize(path, contents.byteLength);

    let after: Awaited<ReturnType<typeof fs.stat>>;
    try {
      after = await fs.stat(path);
    } catch (error) {
      if (isMissingError(error)) continue;
      throw error;
    }

    const afterFingerprint = fingerprint(after);
    if (fingerprint(before) === afterFingerprint) {
      return { contents, fingerprint: afterFingerprint };
    }
  }

  throw new Error(`Script file changed while it was being read: ${path}.`);
};

const analyzeSource = (source: string, path: string) =>
  Effect.runPromise(analyzeScriptSource(source, path));

const cachedAnalysis = async (
  source: string,
  path: string,
  revision: string,
) => {
  const key = `${revision}:${path}`;
  const cached = extractionCache.get(key);
  if (cached !== undefined) {
    extractionCache.delete(key);
    extractionCache.set(key, cached);
    return cached.analysis;
  }

  const analysis = await analyzeSource(source, path);
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
};

export const processScriptFile = async (
  path: string,
): Promise<ScriptFileAnalysisResolution> => {
  try {
    const stable = await readStableFile(path);
    if ("missing" in stable) return { status: "missing", path };

    const { contents } = stable;
    const source = contents.toString("utf8");
    const revision = createHash("sha256").update(contents).digest("hex");
    const analysis = await cachedAnalysis(source, path, revision);
    return {
      status: "found",
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
  } catch (error) {
    return isMissingError(error)
      ? { status: "missing", path }
      : failed(path, error);
  }
};
