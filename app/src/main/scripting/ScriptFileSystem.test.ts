import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { vi } from "vitest";

import { desktopLogErrorDetails } from "../../shared/logRecord";
import { makeScriptFileSystem } from "./ScriptFileSystem";

const directories: string[] = [];

const makeFixture = async (): Promise<string> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "lucent-script-files-"));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("ScriptFileSystem", () => {
  it.effect("preserves the native read failure through the public error", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() =>
        fs.writeFile(join(directory, "state.txt"), "value"),
      );
      const native = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const original = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFile",
        cause: native,
      });
      const service = yield* makeScriptFileSystem(
        FileSystem.makeNoop({ stream: () => Stream.fail(original) }),
        directory,
      );
      const session = yield* service.openSession(42);

      const error = yield* service
        .readText(42, session, "state.txt")
        .pipe(Effect.flip);

      expect(error.message).toBe(
        "Filesystem read-text failed at state.txt: permission-denied.",
      );
      expect(error.cause).toBe(original);
      expect(desktopLogErrorDetails(error).cause?.cause?.message).toBe(
        "EACCES: permission denied",
      );
    }),
  );

  it.effect(
    "preserves the native directory failure through the public error",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(makeFixture);
        const original = Object.assign(
          new Error("EMFILE: too many open files"),
          { code: "EMFILE" },
        );
        vi.spyOn(fs, "opendir").mockRejectedValueOnce(original);
        const service = yield* makeScriptFileSystem(
          FileSystem.makeNoop({}),
          directory,
        );
        const session = yield* service.openSession(42);

        const error = yield* service.list(42, session).pipe(Effect.flip);

        expect(error.message).toBe("Filesystem list failed: busy.");
        expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
        if (!(error.cause instanceof PlatformError.PlatformError)) return;
        expect(error.cause.cause).toBe(original);
        expect(desktopLogErrorDetails(error).cause?.cause?.message).toBe(
          "EMFILE: too many open files",
        );
      }),
  );

  it.effect("keeps malformed JSON contents out of the error chain", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() =>
        fs.writeFile(
          join(directory, "state.json"),
          '{"token":"private-file-contents" broken}',
        ),
      );
      const service = yield* makeScriptFileSystem(
        FileSystem.makeNoop({
          stream: () =>
            Stream.make(
              new TextEncoder().encode(
                '{"token":"private-file-contents" broken}',
              ),
            ),
        }),
        directory,
      );
      const session = yield* service.openSession(42);

      const error = yield* service
        .readJson(42, session, "state.json")
        .pipe(Effect.flip);

      expect(error.message).toBe(
        "Filesystem read-json failed at state.json: invalid-json.",
      );
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(desktopLogErrorDetails(error))).not.toContain(
        "private-file-contents",
      );
    }),
  );
});
