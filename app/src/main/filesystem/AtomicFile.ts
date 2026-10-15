import { randomBytes } from "crypto";
import { dirname, join } from "path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

export const ATOMIC_FILE_TEMPORARY_PREFIX = ".lucent-atomic-";

export const isAtomicFileTemporaryName = (name: string): boolean =>
  name.startsWith(ATOMIC_FILE_TEMPORARY_PREFIX);

/** Publishes through a same-directory rename; visibility is atomic, durability is not. */
export const makeAtomicFile = (fileSystem: FileSystem) => {
  const removeTemp = (path: string) =>
    fileSystem
      .remove(path, { force: true })
      .pipe(Effect.ignore, Effect.uninterruptible);

  const writeToExistingParent = Effect.fn("AtomicFile.writeToExistingParent")(
    function* (
      path: string,
      data: string | Uint8Array,
      options: { readonly mode?: number } = {},
    ): Effect.fn.Return<void, PlatformError> {
      const tempPath = join(
        dirname(path),
        `${ATOMIC_FILE_TEMPORARY_PREFIX}${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
      );

      const createTemp = fileSystem
        .writeFile(
          tempPath,
          typeof data === "string" ? new TextEncoder().encode(data) : data,
          {
            flag: "wx",
            ...(options.mode === undefined ? {} : { mode: options.mode }),
          },
        )
        .pipe(
          Effect.tapError((error) =>
            error.reason._tag === "AlreadyExists"
              ? Effect.void
              : removeTemp(tempPath),
          ),
          Effect.as(tempPath),
        );

      yield* Effect.acquireUseRelease(
        createTemp,
        (temporaryPath) =>
          fileSystem.rename(temporaryPath, path).pipe(Effect.uninterruptible),
        (temporaryPath, exit) =>
          Exit.isSuccess(exit) ? Effect.void : removeTemp(temporaryPath),
      );
    },
  );

  const write = Effect.fn("AtomicFile.write")(function* (
    path: string,
    data: string | Uint8Array,
    options: { readonly mode?: number } = {},
  ): Effect.fn.Return<void, PlatformError> {
    yield* fileSystem
      .makeDirectory(dirname(path), { recursive: true })
      .pipe(Effect.uninterruptible);
    yield* writeToExistingParent(path, data, options);
  });

  return { write, writeToExistingParent };
};
