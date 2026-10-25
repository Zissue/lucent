import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";

import {
  activateManagedGamePartitionProfile,
  cleanupStaleGamePartitionProfiles,
  defaultGamePartition,
  makeGamePartitionRegistry,
  managedGamePartition,
  listPersistentGamePartitions,
  retireManagedGamePartitionProfile,
} from "./GamePartitions";

const tempDirs = new Set<string>();

const makeTempDir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "lucent-game-partitions-"));
  tempDirs.add(path);
  return path;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

describe("Electron game partitions", () => {
  it.effect("retires managed profiles without exposing account names", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() => makeTempDir());
      const fileSystem = yield* FileSystem.FileSystem.pipe(
        Effect.provide(nodeFileSystemLayer),
      );
      const partition = managedGamePartition("Alice");
      const profilePath = join(
        appDataDir,
        "Partitions",
        partition.slice("persist:".length),
      );
      yield* Effect.promise(() => mkdir(profilePath, { recursive: true }));

      expect(partition).not.toContain("Alice");
      expect(
        yield* retireManagedGamePartitionProfile(profilePath, fileSystem),
      ).toBe(true);
      yield* Effect.promise(() =>
        expect(
          readFile(join(profilePath, ".lucent-retired"), "utf8"),
        ).resolves.toBe("1\n"),
      );

      yield* activateManagedGamePartitionProfile(profilePath, fileSystem);
      yield* Effect.promise(() =>
        expect(
          readFile(join(profilePath, ".lucent-retired"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" }),
      );
    }),
  );

  it.effect("cleans retired and dead profiles without touching live data", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() => makeTempDir());
      const fileSystem = yield* FileSystem.FileSystem.pipe(
        Effect.provide(nodeFileSystemLayer),
      );
      const partitionsPath = join(appDataDir, "Partitions");
      const retiredManaged = basename(
        managedGamePartition("Retired").slice("persist:".length),
      );
      const activeManaged = basename(
        managedGamePartition("Active").slice("persist:".length),
      );
      const removable = [
        `lucent-game-temporary-10-${"a".repeat(24)}`,
        retiredManaged,
      ];
      const retained = [
        `lucent-game-temporary-20-${"b".repeat(24)}`,
        basename(defaultGamePartition.slice("persist:".length)),
        activeManaged,
        "unrelated",
      ];
      yield* Effect.promise(() =>
        Promise.all(
          [...removable, ...retained].map((name) =>
            mkdir(join(partitionsPath, name), { recursive: true }),
          ),
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(partitionsPath, retiredManaged, ".lucent-retired"),
          "1\n",
          "utf8",
        ),
      );

      expect(
        (yield* listPersistentGamePartitions(appDataDir)).toSorted(),
      ).toEqual(
        [...removable, ...retained.filter((name) => name !== "unrelated")]
          .map((name) => `persist:${name}`)
          .toSorted(),
      );

      const result = yield* cleanupStaleGamePartitionProfiles(
        appDataDir,
        fileSystem,
        {
          isProcessAlive: (processId) => processId === 20,
        },
      );

      expect(result.failedPaths).toEqual([]);
      expect(
        result.removedPaths.map((path) => basename(path)).toSorted(),
      ).toEqual(removable.toSorted());
      for (const name of retained) {
        expect(
          (yield* Effect.promise(() =>
            stat(join(partitionsPath, name)),
          )).isDirectory(),
        ).toBe(true);
      }
    }),
  );

  it.effect(
    "records a failed removal and still cleans the next stale profile",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() => makeTempDir());
        const fileSystem = yield* FileSystem.FileSystem.pipe(
          Effect.provide(nodeFileSystemLayer),
        );
        const failedPath = join(
          appDataDir,
          "Partitions",
          `lucent-game-temporary-10-${"a".repeat(24)}`,
        );
        const removedPath = join(
          appDataDir,
          "Partitions",
          `lucent-game-temporary-20-${"b".repeat(24)}`,
        );
        yield* Effect.promise(() => mkdir(failedPath, { recursive: true }));
        yield* Effect.promise(() => mkdir(removedPath, { recursive: true }));
        const failingFileSystem = {
          ...fileSystem,
          remove: (
            path: string,
            options?: Parameters<typeof fileSystem.remove>[1],
          ) =>
            path === failedPath
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: path,
                  }),
                )
              : fileSystem.remove(path, options),
        };

        expect(
          yield* cleanupStaleGamePartitionProfiles(
            appDataDir,
            failingFileSystem,
            {
              isProcessAlive: () => false,
            },
          ),
        ).toEqual({ failedPaths: [failedPath], removedPaths: [removedPath] });
        expect(
          (yield* Effect.promise(() => stat(failedPath))).isDirectory(),
        ).toBe(true);
        yield* Effect.promise(() =>
          expect(stat(removedPath)).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }),
  );

  it.effect(
    "ignores missing roots and rejects unreadable directory shapes",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() => makeTempDir());
        const fileSystem = yield* FileSystem.FileSystem.pipe(
          Effect.provide(nodeFileSystemLayer),
        );
        expect(
          yield* cleanupStaleGamePartitionProfiles(appDataDir, fileSystem),
        ).toEqual({
          failedPaths: [],
          removedPaths: [],
        });
        expect(yield* listPersistentGamePartitions(appDataDir)).toEqual([]);
        yield* Effect.promise(() =>
          writeFile(join(appDataDir, "Partitions"), "not a directory"),
        );

        const error = yield* listPersistentGamePartitions(appDataDir).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ code: "ENOTDIR" });
        const cleanupError = yield* cleanupStaleGamePartitionProfiles(
          appDataDir,
          fileSystem,
        ).pipe(Effect.flip);
        expect(cleanupError).toMatchObject({ code: "ENOTDIR" });
      }),
  );

  it.effect("skips files, symlinks, and invalid profile names", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() => makeTempDir());
      const fileSystem = yield* FileSystem.FileSystem.pipe(
        Effect.provide(nodeFileSystemLayer),
      );
      const root = join(appDataDir, "Partitions");
      yield* Effect.promise(() =>
        mkdir(join(root, "lucent-game-default"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        mkdir(join(root, "lucent-game-temporary-0-aaaaaaaaaaaaaaaaaaaaaaaa")),
      );
      yield* Effect.promise(() =>
        mkdir(join(root, "lucent-game-account-short")),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(root, "lucent-game-temporary-10-aaaaaaaaaaaaaaaaaaaaaaaa"),
          "file",
        ),
      );
      yield* Effect.promise(() =>
        symlink(
          join(root, "lucent-game-default"),
          join(root, "lucent-game-account-" + "a".repeat(64)),
        ),
      );

      expect(yield* listPersistentGamePartitions(appDataDir)).toEqual([
        "persist:lucent-game-default",
      ]);
      expect(
        yield* cleanupStaleGamePartitionProfiles(appDataDir, fileSystem, {
          isProcessAlive: () => false,
        }),
      ).toEqual({ failedPaths: [], removedPaths: [] });
      expect(
        yield* Effect.promise(() =>
          readFile(
            join(root, "lucent-game-temporary-10-aaaaaaaaaaaaaaaaaaaaaaaa"),
            "utf8",
          ),
        ),
      ).toBe("file");
      expect(
        (yield* Effect.promise(() =>
          stat(join(root, "lucent-game-default")),
        )).isDirectory(),
      ).toBe(true);
    }),
  );

  it.effect(
    "keeps activation and retirement idempotent without creating missing profiles",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() => makeTempDir());
        const fileSystem = yield* FileSystem.FileSystem.pipe(
          Effect.provide(nodeFileSystemLayer),
        );
        const missingPath = join(appDataDir, "missing");
        expect(
          yield* retireManagedGamePartitionProfile(missingPath, fileSystem),
        ).toBe(false);
        yield* activateManagedGamePartitionProfile(missingPath, fileSystem);
        yield* Effect.promise(() => mkdir(missingPath));
        expect(
          yield* retireManagedGamePartitionProfile(missingPath, fileSystem),
        ).toBe(true);
        expect(
          yield* retireManagedGamePartitionProfile(missingPath, fileSystem),
        ).toBe(true);
        expect(
          yield* Effect.promise(() =>
            readFile(join(missingPath, ".lucent-retired"), "utf8"),
          ),
        ).toBe("1\n");
        yield* activateManagedGamePartitionProfile(missingPath, fileSystem);
        yield* activateManagedGamePartitionProfile(missingPath, fileSystem);
        expect(
          (yield* Effect.promise(() => stat(missingPath))).isDirectory(),
        ).toBe(true);
        yield* Effect.promise(() =>
          expect(
            stat(join(missingPath, ".lucent-retired")),
          ).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }),
  );

  it.effect(
    "preserves a directory-shaped retirement marker when activation fails",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() => makeTempDir());
        const fileSystem = yield* FileSystem.FileSystem.pipe(
          Effect.provide(nodeFileSystemLayer),
        );
        const markerPath = join(appDataDir, ".lucent-retired");
        yield* Effect.promise(() => mkdir(markerPath));

        const error = yield* activateManagedGamePartitionProfile(
          appDataDir,
          fileSystem,
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "PlatformError",
          reason: { pathOrDescriptor: markerPath },
        });
        expect(
          (yield* Effect.promise(() => stat(markerPath))).isDirectory(),
        ).toBe(true);
      }),
  );

  it.effect(
    "treats failed existence checks as absent profiles and markers",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() => makeTempDir());
        const fileSystem = yield* FileSystem.FileSystem.pipe(
          Effect.provide(nodeFileSystemLayer),
        );
        const profilePath = join(
          appDataDir,
          "Partitions",
          "lucent-game-account-" + "a".repeat(64),
        );
        yield* Effect.promise(() => mkdir(profilePath, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(join(profilePath, ".lucent-retired"), "1\n"),
        );
        const failingFileSystem = {
          ...fileSystem,
          exists: (path: string) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "access",
                pathOrDescriptor: path,
              }),
            ),
        };

        expect(
          yield* retireManagedGamePartitionProfile(
            profilePath,
            failingFileSystem,
          ),
        ).toBe(false);
        expect(
          yield* cleanupStaleGamePartitionProfiles(
            appDataDir,
            failingFileSystem,
          ),
        ).toEqual({ failedPaths: [], removedPaths: [] });
        expect(
          yield* Effect.promise(() =>
            readFile(join(profilePath, ".lucent-retired"), "utf8"),
          ),
        ).toBe("1\n");
      }),
  );

  it.effect(
    "keeps profiles for live processes and permission-protected processes",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() => makeTempDir());
        const fileSystem = yield* FileSystem.FileSystem.pipe(
          Effect.provide(nodeFileSystemLayer),
        );
        const root = join(appDataDir, "Partitions");
        const protectedPath = join(
          root,
          "lucent-game-temporary-10-aaaaaaaaaaaaaaaaaaaaaaaa",
        );
        const livePath = join(
          root,
          "lucent-game-temporary-20-bbbbbbbbbbbbbbbbbbbbbbbb",
        );
        const deadPath = join(
          root,
          "lucent-game-temporary-30-cccccccccccccccccccccccc",
        );
        yield* Effect.promise(() =>
          Promise.all(
            [protectedPath, livePath, deadPath].map((path) =>
              mkdir(path, { recursive: true }),
            ),
          ),
        );
        vi.spyOn(process, "kill").mockImplementation((pid) => {
          if (pid === 20) return true;
          throw Object.assign(new Error("Process probe failed"), {
            code: pid === 10 ? "EPERM" : "ESRCH",
          });
        });

        expect(
          yield* cleanupStaleGamePartitionProfiles(appDataDir, fileSystem),
        ).toEqual({
          failedPaths: [],
          removedPaths: [deadPath],
        });
        expect(
          (yield* Effect.promise(() => stat(protectedPath))).isDirectory(),
        ).toBe(true);
        expect(
          (yield* Effect.promise(() => stat(livePath))).isDirectory(),
        ).toBe(true);
        yield* Effect.promise(() =>
          expect(stat(deadPath)).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }),
  );
});

describe("Electron game partition leases", () => {
  it("uses memory sessions for concurrent clients of the same managed account", () => {
    const partitions = makeGamePartitionRegistry();
    const managed = partitions.acquire({
      kind: "managed-account",
      key: "Alice",
    });
    const duplicate = partitions.acquire({
      kind: "managed-account",
      key: "alice",
    });

    expect(managed).toBe(managedGamePartition("ALICE"));
    expect(duplicate).toMatch(/^lucent-game-temporary-[a-f0-9]{24}$/);

    partitions.release(managed);
    expect(
      partitions.acquire({ kind: "managed-account", key: "Alice" }),
    ).toEqual(managed);
  });

  it("persists one default profile and keeps concurrent clients in memory", () => {
    const partitions = makeGamePartitionRegistry();
    const primary = partitions.acquire({ kind: "default" });
    const concurrent = partitions.acquire({ kind: "default" });

    expect(primary).toBe(defaultGamePartition);
    expect(concurrent).toMatch(/^lucent-game-temporary-[a-f0-9]{24}$/);
    const another = partitions.acquire({ kind: "default" });
    expect(another).toMatch(/^lucent-game-temporary-[a-f0-9]{24}$/);
    expect(another).not.toBe(concurrent);

    partitions.release(primary);
    expect(partitions.acquire({ kind: "default" })).toEqual(primary);
  });
});
