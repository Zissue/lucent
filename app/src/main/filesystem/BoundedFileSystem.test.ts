import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { readDirectoryBounded, readFileBounded } from "./BoundedFileSystem";

const directories: string[] = [];
const fixture = () =>
  Effect.promise(async () => {
    const path = await fs.mkdtemp(join(tmpdir(), "lucent-bounded-fs-"));
    directories.push(path);
    return path;
  });
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

layer(NodeFileSystem.layer)("bounded filesystem operations", (it) => {
  it.effect("accepts the exact byte limit and rejects one extra byte", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const fileSystem = yield* FileSystem;
      const path = join(root, "value");
      yield* fileSystem.writeFileString(path, "12345678");
      expect(
        new TextDecoder().decode(yield* readFileBounded(fileSystem, path, 8)),
      ).toBe("12345678");
      expect(
        yield* readFileBounded(fileSystem, path, 7).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "FileSystemLimitError",
        kind: "bytes",
        limit: 7,
      });
      yield* fileSystem.writeFileString(path, "");
      expect((yield* readFileBounded(fileSystem, path, 0)).byteLength).toBe(0);
    }),
  );

  it.effect(
    "counts included entries and reports links without following them",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture();
        const fileSystem = yield* FileSystem;
        yield* fileSystem.writeFileString(join(root, "file"), "value");
        yield* fileSystem.writeFileString(join(root, "ignored"), "value");
        yield* fileSystem.symlink(join(root, "file"), join(root, "link"));
        const include = (name: string) => name !== "ignored";
        const entries = yield* readDirectoryBounded(root, {
          include,
          maxEntries: 2,
        });
        expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
          { name: "file", kind: "file" },
          { name: "link", kind: "symbolic-link" },
        ]);
        expect(
          yield* readDirectoryBounded(root, { include, maxEntries: 1 }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({
          _tag: "FileSystemLimitError",
          kind: "entries",
          limit: 1,
        });
      }),
  );
});
