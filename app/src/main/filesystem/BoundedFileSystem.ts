import { constants } from "node:buffer";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
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

export const readFileBounded = Effect.fn("readFileBounded")(function* (
  fileSystem: FileSystem,
  path: string,
  maxBytes: number,
) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > constants.MAX_LENGTH
  ) {
    return yield* PlatformError.badArgument({
      module: "FileSystem",
      method: "readFileBounded",
    });
  }
  const chunks = yield* Stream.runCollect(
    fileSystem.stream(path, {
      bytesToRead: BigInt(maxBytes) + 1n,
      chunkSize: 64 * 1024,
    }),
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
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0) {
      return yield* PlatformError.badArgument({
        module: "FileSystem",
        method: "readDirectoryBounded",
      });
    }
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
