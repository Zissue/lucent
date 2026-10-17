import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";

import { readScriptPackageManifest } from "./ScriptPackageInspection";

const reads = vi.hoisted(() => ({ bytes: 0, largestChunk: 0 }));

vi.mock("@effect/platform-node/NodeFileSystem", async (importOriginal) => {
  const native =
    await importOriginal<
      typeof import("@effect/platform-node/NodeFileSystem")
    >();
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Stream = await import("effect/Stream");
  const { FileSystem } = await import("effect/FileSystem");
  return {
    layer: Layer.effect(
      FileSystem,
      Effect.map(FileSystem, (fileSystem) => ({
        ...fileSystem,
        stream: (path, options) =>
          fileSystem.stream(path, options).pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => {
                reads.bytes += chunk.byteLength;
                reads.largestChunk = Math.max(
                  reads.largestChunk,
                  chunk.byteLength,
                );
              }),
            ),
          ),
      })),
    ).pipe(Layer.provide(native.layer)),
  };
});

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

it("bounds a manifest that grows after its no-follow size check", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-manifest-"));
  directories.push(root);
  const path = join(root, "package.json");
  await fs.writeFile(path, '{"name":"example"}');
  expect(await readScriptPackageManifest(path)).toEqual({
    dependencies: {},
    main: "index.js",
    name: "example",
  });
  reads.bytes = 0;
  reads.largestChunk = 0;
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementationOnce(async (...args) => {
    const info = await lstat(...args);
    await fs.appendFile(path, " ".repeat(2 * 1024 * 1024));
    return info;
  });

  await expect(readScriptPackageManifest(path)).rejects.toThrow(
    "package.json exceeds the 1 MiB limit.",
  );
  expect(reads.bytes).toBe(1_048_577);
  expect(reads.largestChunk).toBe(65_536);
});
