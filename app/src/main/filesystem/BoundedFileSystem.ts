import { promises as fs, type Dirent, type Stats } from "node:fs";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class FileSystemLimitError extends Schema.TaggedError<FileSystemLimitError>()(
  "FileSystemLimitError",
  {
    path: Schema.String,
    limit: Schema.Number,
    kind: Schema.Literals(["bytes", "entries"]),
  },
) {}

export class FileChangedWhileReading extends Schema.TaggedError<FileChangedWhileReading>()(
  "FileChangedWhileReading",
  { path: Schema.String },
) {}

export const fileFingerprint = (stat: Stats): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

export const isMissingFileError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

export const readFileBounded = Effect.fn("readFileBounded")(function* (
  fileSystem: FileSystem,
  path: string,
  maxBytes: number,
) {
  const chunks = yield* Stream.runCollect(
    fileSystem.stream(path, { bytesToRead: BigInt(maxBytes) + 1n }),
  );
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (size > maxBytes)
    return yield* new FileSystemLimitError({
      path,
      limit: maxBytes,
      kind: "bytes",
    });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

export const readStableFile = Effect.fnUntraced(function* (
  path: string,
  maxBytes: number,
  options: {
    readonly requireRegularFile?: boolean;
    readonly missingAfterReadIsChange?: boolean;
  } = {},
) {
  const fileSystem = yield* FileSystem;
  const stat = Effect.tryPromise({
    try: () => fs.stat(path),
    catch: (cause) => cause,
  });
  const before = yield* stat;
  if (options.requireRegularFile && !before.isFile())
    return yield* Effect.fail(new Error(`Expected a regular file: ${path}.`));
  if (before.size > maxBytes)
    return yield* new FileSystemLimitError({
      path,
      limit: maxBytes,
      kind: "bytes",
    });
  const bytes = yield* readFileBounded(fileSystem, path, maxBytes).pipe(
    Effect.mapError((cause) =>
      cause._tag === "FileSystemLimitError"
        ? cause
        : (cause.reason.cause ?? cause),
    ),
  );
  const after = yield* stat.pipe(
    Effect.mapError((cause) =>
      options.missingAfterReadIsChange && isMissingFileError(cause)
        ? new FileChangedWhileReading({ path })
        : cause,
    ),
  );
  const fingerprint = fileFingerprint(after);
  if (fileFingerprint(before) !== fingerprint)
    return yield* new FileChangedWhileReading({ path });
  return {
    contents: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    fingerprint,
  };
});

export const nativeFileError = (
  method: string,
  path: string,
  cause: unknown,
): PlatformError.PlatformError => {
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  return PlatformError.systemError({
    _tag:
      code === "ENOENT"
        ? "NotFound"
        : code === "EEXIST"
          ? "AlreadyExists"
          : code === "EACCES" || code === "EPERM" || code === "EROFS"
            ? "PermissionDenied"
            : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    cause,
  });
};

export const lstat = (path: string) =>
  Effect.tryPromise({
    try: () => fs.lstat(path),
    catch: (cause) => nativeFileError("lstat", path, cause),
  });

export const fileKind = (
  info: Stats | Dirent,
): "file" | "directory" | "symbolic-link" | "other" =>
  info.isFile()
    ? "file"
    : info.isDirectory()
      ? "directory"
      : info.isSymbolicLink()
        ? "symbolic-link"
        : "other";

export const readDirectoryBounded = Effect.fn("readDirectoryBounded")(
  function* (
    path: string,
    options: {
      readonly maxEntries: number;
      readonly include: (name: string) => boolean;
    },
  ) {
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => fs.opendir(path),
        catch: (cause) => nativeFileError("opendir", path, cause),
      }),
      Effect.fn(function* (directory) {
        const entries: {
          readonly name: string;
          readonly kind: ReturnType<typeof fileKind>;
        }[] = [];
        while (true) {
          const entry = yield* Effect.tryPromise({
            try: () => directory.read(),
            catch: (cause) => nativeFileError("readdir", path, cause),
          }).pipe(Effect.uninterruptible);
          if (entry === null) return entries;
          if (!options.include(entry.name)) continue;
          if (entries.length === options.maxEntries)
            return yield* new FileSystemLimitError({
              path,
              limit: options.maxEntries,
              kind: "entries",
            });
          entries.push({ name: entry.name, kind: fileKind(entry) });
        }
      }),
      (directory) => Effect.promise(() => directory.close()),
    );
  },
);

export const removeScriptPath = (path: string, directory: boolean) =>
  Effect.tryPromise({
    try: () => (directory ? fs.rmdir(path) : fs.unlink(path)),
    catch: (cause) =>
      nativeFileError(directory ? "rmdir" : "unlink", path, cause),
  }).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
    Effect.uninterruptible,
  );
