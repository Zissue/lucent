import { promises as fs, lstatSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, layer } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { PreventSchedulerYield } from "effect/Scheduler";
import * as Stream from "effect/Stream";
import { vi } from "vitest";

import { desktopLogErrorDetails } from "../../shared/logRecord";
import * as BoundedFileSystem from "../filesystem/BoundedFileSystem";
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
      const service = makeScriptFileSystem(
        FileSystem.makeNoop({ stream: () => Stream.fail(original) }),
        directory,
      );

      const error = yield* service.readText("state.txt").pipe(Effect.flip);

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
        const service = makeScriptFileSystem(
          FileSystem.makeNoop({}),
          directory,
        );

        const error = yield* service.list().pipe(Effect.flip);

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
      const service = makeScriptFileSystem(
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

      const error = yield* service.readJson("state.json").pipe(Effect.flip);

      expect(error.message).toBe(
        "Filesystem read-json failed at state.json: invalid-json.",
      );
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(desktopLogErrorDetails(error))).not.toContain(
        "private-file-contents",
      );
    }),
  );

  layer(NodeFileSystem.layer)((it) => {
    it.effect("keeps the latest write when saves overlap on one path", () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(makeFixture);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = join(directory, "state.txt");
        yield* fileSystem.writeFileString(path, "initial");
        const firstRenameStarted = yield* Deferred.make<void>();
        const releaseFirstRename = yield* Deferred.make<void>();
        vi.spyOn(BoundedFileSystem, "lstat").mockImplementation((path) =>
          Effect.sync(() => lstatSync(path)),
        );
        const service = makeScriptFileSystem(
          FileSystem.FileSystem.of({
            ...fileSystem,
            writeFile: (path, data, options) =>
              Effect.sync(() => writeFileSync(path, data, options)),
            rename: (from, to) =>
              Effect.gen(function* () {
                if (yield* Deferred.succeed(firstRenameStarted, undefined)) {
                  yield* Deferred.await(releaseFirstRename);
                }
                yield* Effect.sync(() => renameSync(from, to));
              }),
          }),
          directory,
        );

        const first = yield* service
          .writeText("state.txt", "older")
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstRenameStarted);
        const second = yield* service
          .writeText("state.txt", "latest")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(releaseFirstRename, undefined);
        yield* Fiber.joinAll([first, second]);

        expect(yield* fileSystem.readFileString(path)).toBe("latest");
      }).pipe(Effect.provideService(PreventSchedulerYield, true)),
    );

    it.effect(
      "writes independent files concurrently into a new shared directory",
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(makeFixture);
          const service = makeScriptFileSystem(
            yield* FileSystem.FileSystem,
            join(root, "scripts"),
          );
          const paths = Array.from(
            { length: 40 },
            (_, index) => `nested/file-${index}.txt`,
          );

          yield* Effect.forEach(
            paths,
            (path) => service.writeText(path, "saved"),
            {
              concurrency: "unbounded",
            },
          );

          expect(yield* service.list()).toEqual([
            { name: "nested", kind: "directory" },
          ]);
          expect(yield* service.list("nested")).toHaveLength(40);
          const contents = yield* Effect.forEach(paths, (path) =>
            service.readText(path),
          );
          expect([...new Set(contents)]).toEqual(["saved"]);
        }),
    );

    it.effect(
      "rejects reserved and oversized paths and keeps temporary files private",
      () =>
        Effect.gen(function* () {
          const directory = yield* Effect.promise(makeFixture);
          const fileSystem = yield* FileSystem.FileSystem;
          const service = makeScriptFileSystem(fileSystem, directory);
          yield* service.writeText("visible.txt", "saved");
          yield* fileSystem.writeFileString(
            join(directory, ".lucent-atomic-hidden.tmp"),
            "private",
          );

          for (const path of [
            ".lucent-atomic-hidden.tmp",
            "nested/.lucent-atomic-hidden.tmp",
            "e\u0301.txt",
            "a".repeat(256),
            `${"a/".repeat(32)}file`,
            Array(5).fill("a".repeat(205)).join("/"),
          ]) {
            expect(
              yield* service.readText(path).pipe(Effect.flip),
            ).toMatchObject({ reason: "invalid-path" });
            expect(
              yield* service.writeText(path, "lost").pipe(Effect.flip),
            ).toMatchObject({ reason: "invalid-path" });
            expect(yield* service.remove(path).pipe(Effect.flip)).toMatchObject(
              { reason: "invalid-path" },
            );
          }
          expect(yield* service.list()).toEqual([
            { name: "visible.txt", kind: "file" },
          ]);
          expect(yield* service.readText("visible.txt")).toBe("saved");
          expect(
            yield* fileSystem.readFileString(
              join(directory, ".lucent-atomic-hidden.tmp"),
            ),
          ).toBe("private");
        }),
    );

    it.effect("preserves text and JSON behavior and byte limits", () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(makeFixture);
        const fileSystem = yield* FileSystem.FileSystem;
        const service = makeScriptFileSystem(fileSystem, directory);
        expect(yield* service.exists("state.json")).toBe(false);
        expect(yield* service.readText("missing")).toBeUndefined();
        expect(yield* service.readJson("missing")).toBeUndefined();
        yield* service.remove("missing");
        yield* service.writeJson("state.json", { count: 3 });
        expect(yield* service.exists("state.json")).toBe(true);
        expect(yield* service.readJson("state.json")).toEqual({ count: 3 });
        expect(yield* service.readText("state.json")).toBe(
          '{\n  "count": 3\n}\n',
        );
        expect(
          yield* service.writeJson("state.json", undefined).pipe(Effect.flip),
        ).toMatchObject({ reason: "not-json-serializable" });
        expect(
          yield* service
            .writeText("state.json", "a".repeat(8_388_609))
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "too-large" });
        expect(yield* service.readJson("state.json")).toEqual({ count: 3 });
        yield* fileSystem.writeFile(
          join(directory, "large"),
          new Uint8Array(8_388_609),
        );
        expect(
          yield* service.readText("large").pipe(Effect.flip),
        ).toMatchObject({ reason: "too-large" });
        yield* fileSystem.writeFile(
          join(directory, "invalid-utf8"),
          new Uint8Array([255]),
        );
        expect(
          yield* service.readText("invalid-utf8").pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid-utf8" });
        yield* service.remove("state.json");
        expect(yield* service.exists("state.json")).toBe(false);
      }),
    );

    it.effect(
      "keeps script access inside its root and preserves files on rejected operations",
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(makeFixture);
          const fileSystem = yield* FileSystem.FileSystem;
          const scriptRoot = join(root, "scripts");
          const service = makeScriptFileSystem(fileSystem, scriptRoot);

          yield* service.writeText("nested/value.txt", "saved");
          expect(yield* service.readText("nested/value.txt")).toBe("saved");
          expect(
            yield* service.remove("nested").pipe(Effect.flip),
          ).toMatchObject({ reason: "directory-not-empty" });
          expect(
            yield* service.readText("../outside").pipe(Effect.flip),
          ).toMatchObject({ reason: "invalid-path" });
          yield* fileSystem.writeFileString(join(root, "outside"), "keep");
          yield* fileSystem.symlink(
            join(root, "outside"),
            join(scriptRoot, "link"),
          );
          expect(
            yield* service.readText("link").pipe(Effect.flip),
          ).toMatchObject({ reason: "invalid-path" });
          yield* service.remove("link");
          expect(yield* fileSystem.readFileString(join(root, "outside"))).toBe(
            "keep",
          );
          expect(
            yield* fileSystem.readFileString(
              join(scriptRoot, "nested/value.txt"),
            ),
          ).toBe("saved");
        }),
    );
  });
});
