import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  FileSystemError,
  type FileSystemEntry,
  type FileSystemErrorReason,
  type FileSystemOperation,
  SCRIPT_FILE_SYSTEM_MAX_BYTES,
  SCRIPT_FILE_SYSTEM_MAX_ENTRIES,
} from "@lucent/core/filesystem";
import { parseScriptPathSegments } from "@lucent/core/scriptPath";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import {
  isAtomicFileTemporaryName,
  makeAtomicFile,
} from "../filesystem/AtomicFile";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import type { Stats } from "node:fs";
import {
  FileSystemLimitError,
  lstat,
  readDirectoryBounded,
  readFileBounded,
  removeScriptPath,
} from "../filesystem/BoundedFileSystem";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";

const MAX_PATH_BYTES = 1_024;
const MAX_PATH_SEGMENTS = 32;
const MAX_SEGMENT_BYTES = 255;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

interface ParsedPath {
  readonly absolute: string;
  readonly path: string;
  readonly segments: readonly string[];
}

type ParentMode = "create" | "lookup";

interface ScriptFileSystemShape {
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
  readonly list: (
    path?: string,
  ) => Effect.Effect<readonly FileSystemEntry[], FileSystemError>;
  readonly readJson: (
    path: string,
  ) => Effect.Effect<Schema.Json | undefined, FileSystemError>;
  readonly readText: (
    path: string,
  ) => Effect.Effect<string | undefined, FileSystemError>;
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
  readonly writeJson: (
    path: string,
    value: unknown,
  ) => Effect.Effect<void, FileSystemError>;
  readonly writeText: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, FileSystemError>;
}

export class ScriptFileSystem extends Context.Service<
  ScriptFileSystem,
  ScriptFileSystemShape
>()("lucent/desktop/scripting/ScriptFileSystem") {}

const makeError = (
  operation: FileSystemOperation,
  reason: FileSystemErrorReason,
  path?: string,
  cause?: PlatformError | FileSystemLimitError,
): FileSystemError => {
  const error = new FileSystemError({
    operation,
    reason,
    ...(path === undefined ? {} : { path }),
  });
  if (cause !== undefined) error.cause = cause;
  return error;
};

const mapFileSystemReason = (
  error: PlatformError | FileSystemLimitError,
): FileSystemErrorReason => {
  if (error._tag === "FileSystemLimitError") return "too-large";
  const cause = error.reason.cause;
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  switch (code) {
    case "EMFILE":
    case "ENFILE":
    case "EBUSY":
      return "busy";
    case "ENOTEMPTY":
      return "directory-not-empty";
    case "ELOOP":
    case "ENAMETOOLONG":
    case "EINVAL":
      return "invalid-path";
    case "EISDIR":
      return "not-file";
    case "ENOTDIR":
      return "not-directory";
    case "EPERM":
    case "EROFS":
      return "permission-denied";
    case "EFBIG":
      return "too-large";
  }
  switch (error.reason._tag) {
    case "Busy":
      return "busy";
    case "BadArgument":
    case "BadResource":
      return "invalid-path";
    case "NotFound":
      return "not-found";
    case "PermissionDenied":
      return "permission-denied";
    default:
      return "unavailable";
  }
};

const mapFileSystemError = (
  operation: FileSystemOperation,
  path: string | undefined,
  error: PlatformError | FileSystemLimitError,
): FileSystemError =>
  makeError(operation, mapFileSystemReason(error), path, error);

const safePathSegments = (path: string): readonly string[] | null => {
  const segments = parseScriptPathSegments(path);
  if (
    segments === null ||
    path.normalize("NFC") !== path ||
    utf8Encoder.encode(path).byteLength > MAX_PATH_BYTES ||
    segments.length > MAX_PATH_SEGMENTS
  ) {
    return null;
  }

  for (const segment of segments) {
    if (
      isAtomicFileTemporaryName(segment) ||
      utf8Encoder.encode(segment).byteLength > MAX_SEGMENT_BYTES
    ) {
      return null;
    }
  }
  return segments;
};

export const makeScriptFileSystem = (
  fileSystem: FileSystem,
  dataDir: string,
): ScriptFileSystem["Service"] => {
  const atomicFile = makeAtomicFile(fileSystem);
  const mutations = Semaphore.makeUnsafe(1);

  const parsePath = (
    operation: FileSystemOperation,
    path: string,
  ): Effect.Effect<ParsedPath, FileSystemError> => {
    const segments = safePathSegments(path);
    return segments === null
      ? Effect.fail(makeError(operation, "invalid-path", path))
      : Effect.succeed({
          absolute: join(dataDir, ...segments),
          path,
          segments,
        });
  };

  const requireDirectory = (
    operation: FileSystemOperation,
    path: string | undefined,
    info: Stats,
  ): Effect.Effect<void, FileSystemError> =>
    info.isDirectory()
      ? Effect.void
      : Effect.fail(
          makeError(
            operation,
            info.isSymbolicLink() ? "invalid-path" : "not-directory",
            path,
          ),
        );

  const lstatOptional = (
    operation: FileSystemOperation,
    publicPath: string | undefined,
    absolutePath: string,
  ): Effect.Effect<Stats | undefined, FileSystemError> =>
    lstat(absolutePath).pipe(
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(mapFileSystemError(operation, publicPath, error)),
      ),
    );

  const ensureRoot = Effect.fnUntraced(function* (
    operation: FileSystemOperation,
  ): Effect.fn.Return<void, FileSystemError> {
    let info = yield* lstatOptional(operation, undefined, dataDir);
    if (info === undefined) {
      yield* fileSystem
        .makeDirectory(dataDir, { mode: 0o700, recursive: true })
        .pipe(
          Effect.uninterruptible,
          Effect.mapError((error) =>
            mapFileSystemError(operation, undefined, error),
          ),
        );
      info = yield* lstat(dataDir).pipe(
        Effect.mapError((error) =>
          mapFileSystemError(operation, undefined, error),
        ),
      );
    }
    yield* requireDirectory(operation, undefined, info);
  });

  const resolveParent = Effect.fnUntraced(function* (
    operation: FileSystemOperation,
    parsed: ParsedPath,
    mode: ParentMode,
  ): Effect.fn.Return<string | undefined, FileSystemError> {
    yield* ensureRoot(operation);
    let current = dataDir;
    for (const segment of parsed.segments.slice(0, -1)) {
      current = join(current, segment);
      let info = yield* lstatOptional(operation, parsed.path, current);
      if (info === undefined && mode === "create") {
        yield* fileSystem
          .makeDirectory(current, { mode: 0o700, recursive: false })
          .pipe(
            Effect.uninterruptible,
            Effect.catch((error) =>
              error.reason._tag === "AlreadyExists"
                ? Effect.void
                : Effect.fail(
                    mapFileSystemError(operation, parsed.path, error),
                  ),
            ),
          );
        info = yield* lstat(current).pipe(
          Effect.mapError((error) =>
            mapFileSystemError(operation, parsed.path, error),
          ),
        );
      }
      if (info === undefined) return undefined;
      yield* requireDirectory(operation, parsed.path, info);
    }
    return current;
  });

  const requireReadableFile = Effect.fnUntraced(function* (
    operation: "read-json" | "read-text",
    parsed: ParsedPath,
  ): Effect.fn.Return<Stats | undefined, FileSystemError> {
    const parent = yield* resolveParent(operation, parsed, "lookup");
    if (parent === undefined) return undefined;
    const info = yield* lstatOptional(operation, parsed.path, parsed.absolute);
    if (info === undefined) return undefined;
    if (!info.isFile()) {
      return yield* makeError(
        operation,
        info.isSymbolicLink() ? "invalid-path" : "not-file",
        parsed.path,
      );
    }
    return info;
  });

  const prepareWritableFile = Effect.fnUntraced(function* (
    operation: "write-json" | "write-text",
    parsed: ParsedPath,
  ): Effect.fn.Return<void, FileSystemError> {
    yield* resolveParent(operation, parsed, "create");
    const info = yield* lstatOptional(operation, parsed.path, parsed.absolute);
    if (info !== undefined && !info.isFile()) {
      return yield* makeError(
        operation,
        info.isSymbolicLink() ? "invalid-path" : "not-file",
        parsed.path,
      );
    }
  });

  const exists = Effect.fnUntraced(function* (path: string) {
    const parsed = yield* parsePath("exists", path);
    const parent = yield* resolveParent("exists", parsed, "lookup");
    if (parent === undefined) return false;
    return (
      (yield* lstatOptional("exists", path, parsed.absolute)) !== undefined
    );
  });

  const list = Effect.fnUntraced(function* (path?: string) {
    let absolute = dataDir;
    if (path === undefined) {
      yield* ensureRoot("list");
    } else {
      const parsed = yield* parsePath("list", path);
      const parent = yield* resolveParent("list", parsed, "lookup");
      if (parent === undefined) {
        return yield* makeError("list", "not-found", path);
      }
      absolute = parsed.absolute;
      const info = yield* lstatOptional("list", path, absolute);
      if (info === undefined) {
        return yield* makeError("list", "not-found", path);
      }
      yield* requireDirectory("list", path, info);
    }

    return yield* readDirectoryBounded(absolute, {
      include: (name) => !isAtomicFileTemporaryName(name),
      maxEntries: SCRIPT_FILE_SYSTEM_MAX_ENTRIES,
    }).pipe(
      Effect.map((entries) =>
        entries
          .map(
            (entry): FileSystemEntry => ({
              kind: entry.kind,
              name: entry.name,
            }),
          )
          .sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
          ),
      ),
      Effect.mapError((error) =>
        makeError(
          "list",
          error._tag === "FileSystemLimitError"
            ? "too-many-entries"
            : mapFileSystemReason(error),
          path,
          error,
        ),
      ),
    );
  });

  const readTextInternal = Effect.fnUntraced(function* (
    operation: "read-json" | "read-text",
    path: string,
  ): Effect.fn.Return<string | undefined, FileSystemError> {
    const parsed = yield* parsePath(operation, path);
    const info = yield* requireReadableFile(operation, parsed);
    if (info === undefined) return undefined;
    const bytes = yield* readFileBounded(
      fileSystem,
      parsed.absolute,
      SCRIPT_FILE_SYSTEM_MAX_BYTES,
    ).pipe(
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(mapFileSystemError(operation, path, error)),
      ),
    );
    if (bytes === undefined) return undefined;
    return yield* Effect.try({
      try: () => utf8Decoder.decode(bytes),
      catch: () => makeError(operation, "invalid-utf8", path),
    });
  });

  const readText: ScriptFileSystemShape["readText"] = (path) =>
    readTextInternal("read-text", path);

  const readJson = Effect.fnUntraced(function* (path: string) {
    const source = yield* readTextInternal("read-json", path);
    if (source === undefined) return undefined;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: () => makeError("read-json", "invalid-json", path),
    });
    return yield* decodeJson(parsed).pipe(
      Effect.mapError(() => makeError("read-json", "invalid-json", path)),
    );
  });

  const writeTextInternal = Effect.fnUntraced(function* (
    operation: "write-json" | "write-text",
    path: string,
    contents: string,
  ): Effect.fn.Return<void, FileSystemError> {
    const bytes = utf8Encoder.encode(contents);
    if (bytes.byteLength > SCRIPT_FILE_SYSTEM_MAX_BYTES) {
      return yield* makeError(operation, "too-large", path);
    }
    const parsed = yield* parsePath(operation, path);
    yield* prepareWritableFile(operation, parsed);
    yield* atomicFile
      .writeToExistingParent(parsed.absolute, bytes, { mode: 0o600 })
      .pipe(
        Effect.mapError((error) => mapFileSystemError(operation, path, error)),
      );
  });

  const writeText: ScriptFileSystemShape["writeText"] = (path, contents) =>
    writeTextInternal("write-text", path, contents);

  const writeJson = Effect.fnUntraced(function* (path: string, value: unknown) {
    const json = yield* decodeJson(value).pipe(
      Effect.mapError(() =>
        makeError("write-json", "not-json-serializable", path),
      ),
    );
    const source = `${JSON.stringify(json, null, 2)}\n`;
    yield* writeTextInternal("write-json", path, source);
  });

  const remove = Effect.fnUntraced(function* (path: string) {
    const parsed = yield* parsePath("remove", path);
    const parent = yield* resolveParent("remove", parsed, "lookup");
    if (parent === undefined) return;
    const info = yield* lstatOptional("remove", path, parsed.absolute);
    if (info === undefined) return;

    if (info.isDirectory() || info.isFile() || info.isSymbolicLink()) {
      yield* removeScriptPath(parsed.absolute, info.isDirectory()).pipe(
        Effect.mapError((error) => mapFileSystemError("remove", path, error)),
      );
      return;
    }
    return yield* makeError("remove", "unavailable", path);
  });

  return ScriptFileSystem.of({
    exists,
    list,
    readJson,
    readText,
    remove: (path) => mutations.withPermit(remove(path)),
    writeJson: (path, value) => mutations.withPermit(writeJson(path, value)),
    writeText: (path, contents) =>
      mutations.withPermit(writeText(path, contents)),
  });
};

export const layer = Layer.effect(
  ScriptFileSystem,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const fileSystem = yield* FileSystem;
    const { dataDir } = resolveScriptWorkspacePaths(env.workspaceDir);
    return makeScriptFileSystem(fileSystem, dataDir);
  }),
);
