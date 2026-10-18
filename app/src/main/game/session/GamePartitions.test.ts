import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";

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
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

describe("Electron game partitions", () => {
  it("retires managed profiles without exposing account names", async () => {
    const appDataDir = await makeTempDir();
    const partition = managedGamePartition("Alice");
    const profilePath = join(
      appDataDir,
      "Partitions",
      partition.slice("persist:".length),
    );
    await mkdir(profilePath, { recursive: true });

    expect(partition).not.toContain("Alice");
    expect(retireManagedGamePartitionProfile(profilePath)).toBe(true);
    await expect(
      readFile(join(profilePath, ".lucent-retired"), "utf8"),
    ).resolves.toBe("1\n");

    activateManagedGamePartitionProfile(profilePath);
    await expect(
      readFile(join(profilePath, ".lucent-retired"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans retired and dead profiles without touching live data", async () => {
    const appDataDir = await makeTempDir();
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
    await Promise.all(
      [...removable, ...retained].map((name) =>
        mkdir(join(partitionsPath, name), { recursive: true }),
      ),
    );
    await writeFile(
      join(partitionsPath, retiredManaged, ".lucent-retired"),
      "1\n",
      "utf8",
    );

    expect(listPersistentGamePartitions(appDataDir).toSorted()).toEqual(
      [...removable, ...retained.filter((name) => name !== "unrelated")]
        .map((name) => `persist:${name}`)
        .toSorted(),
    );

    const result = cleanupStaleGamePartitionProfiles(appDataDir, {
      isProcessAlive: (processId) => processId === 20,
    });

    expect(result.failedPaths).toEqual([]);
    expect(
      result.removedPaths.map((path) => basename(path)).toSorted(),
    ).toEqual(removable.toSorted());
    for (const name of retained) {
      expect((await stat(join(partitionsPath, name))).isDirectory()).toBe(true);
    }
  });
});

describe("Electron game partition leases", () => {
  it("uses memory sessions for concurrent clients of the same managed account", () => {
    const partitions = makeGamePartitionRegistry({
      makeRandomId: () => "a".repeat(24),
      processId: 42,
    });
    const managed = partitions.acquire({
      kind: "managed-account",
      key: "Alice",
    });
    const duplicate = partitions.acquire({
      kind: "managed-account",
      key: "alice",
    });

    expect(managed).toBe(managedGamePartition("ALICE"));
    expect(duplicate).toBe(`lucent-game-temporary-42-${"a".repeat(24)}`);

    partitions.release(managed);
    expect(
      partitions.acquire({ kind: "managed-account", key: "Alice" }),
    ).toEqual(managed);
  });

  it("persists one default profile and keeps concurrent clients in memory", () => {
    const partitions = makeGamePartitionRegistry({
      makeRandomId: () => "b".repeat(24),
      processId: 42,
    });
    const primary = partitions.acquire({ kind: "default" });
    const concurrent = partitions.acquire({ kind: "default" });

    expect(primary).toBe(defaultGamePartition);
    expect(concurrent).toBe(`lucent-game-temporary-42-${"b".repeat(24)}`);

    partitions.release(primary);
    expect(partitions.acquire({ kind: "default" })).toEqual(primary);
  });
});
