import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, expect, layer as testLayer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeAtomicFile } from "./AtomicFile";
import { FileSystem } from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { layer } from "@effect/platform-node/NodeFileSystem";

const fixtureDirectories = new Set<string>();

const makeFixture = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "lucent-atomic-file-"));
  fixtureDirectories.add(path);
  return path;
};

const makeWriteError = (
  path: string,
  reason: PlatformError.SystemErrorTag,
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: reason,
    module: "FileSystem",
    method: "writeFile",
    pathOrDescriptor: path,
  });

afterEach(async () => {
  await Promise.all(
    [...fixtureDirectories].map((path) =>
      fs.rm(path, { recursive: true, force: true }),
    ),
  );
  fixtureDirectories.clear();
});

testLayer(layer)("AtomicFile", (it) => {
  it.effect("publishes without cleaning the released temp path", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const path = join(root, "nested", "state.json");
      const fileSystem = yield* FileSystem;
      const guardedFileSystem = FileSystem.of({
        ...fileSystem,
        remove: () => Effect.die("successful publication ran cleanup"),
      });

      yield* makeAtomicFile(guardedFileSystem).write(path, "value");

      expect(yield* Effect.promise(() => fs.readFile(path, "utf8"))).toBe(
        "value",
      );
      expect(
        yield* Effect.promise(() => fs.readdir(join(root, "nested"))),
      ).toEqual(["state.json"]);
    }),
  );

  it.effect("cleans a partially written temp after write failure", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const destination = join(root, "state.json");
      const fileSystem = yield* FileSystem;
      const failingFileSystem = FileSystem.of({
        ...fileSystem,
        writeFile: (path, _data, options) =>
          fileSystem
            .writeFile(path, new TextEncoder().encode("partial"), options)
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(makeWriteError(path, "Unknown")),
              ),
            ),
      });

      yield* makeAtomicFile(failingFileSystem)
        .write(destination, "complete")
        .pipe(Effect.flip);

      expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([]);
    }),
  );

  it.effect("does not delete a temp owned by an AlreadyExists collision", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const destination = join(root, "state.json");
      const fileSystem = yield* FileSystem;
      const collidingFileSystem = FileSystem.of({
        ...fileSystem,
        writeFile: (path) =>
          fileSystem
            .writeFile(path, new TextEncoder().encode("other-owner"), {
              flag: "wx",
            })
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(makeWriteError(path, "AlreadyExists")),
              ),
            ),
      });

      yield* makeAtomicFile(collidingFileSystem)
        .write(destination, "value")
        .pipe(Effect.flip);

      const entries = yield* Effect.promise(() => fs.readdir(root));
      expect(entries).toHaveLength(1);
      const tempName = entries[0];
      if (tempName === undefined) {
        return yield* Effect.die("expected a colliding temp file");
      }
      expect(tempName).toMatch(/\.tmp$/);
      expect(
        yield* Effect.promise(() => fs.readFile(join(root, tempName), "utf8")),
      ).toBe("other-owner");
    }),
  );

  it.effect("cleans its temp when publication fails", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const destination = join(root, "occupied");
      yield* Effect.promise(() => fs.mkdir(destination));
      const atomicFile = makeAtomicFile(yield* FileSystem);

      yield* atomicFile.write(destination, "value").pipe(Effect.flip);

      expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([
        "occupied",
      ]);
    }),
  );

  it.effect("waits for an interrupted publication to settle", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const destination = join(root, "state.json");
      const fileSystem = yield* FileSystem;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delayed = FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          Effect.promise(() => {
            started.resolve();
            return release.promise;
          }).pipe(Effect.andThen(fileSystem.rename(from, to))),
      });
      const writer = yield* Effect.forkChild(
        makeAtomicFile(delayed).write(destination, "value"),
      );
      yield* Effect.promise(() => started.promise);
      let finished = false;
      const interruption = yield* Effect.forkChild(
        Fiber.interrupt(writer).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
        ),
      );
      yield* Effect.yieldNow;
      expect(finished).toBe(false);
      release.resolve();
      yield* Fiber.join(interruption);
      expect(
        yield* Effect.promise(() => fs.readFile(destination, "utf8")),
      ).toBe("value");
      expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([
        "state.json",
      ]);
    }),
  );
});
