import { createHash, randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";

const PERSISTENT_PARTITION_PREFIX = "persist:";
const DEFAULT_PARTITION_NAME = "lucent-game-default";
const MANAGED_PARTITION_PREFIX = "lucent-game-account-";
const TEMPORARY_PARTITION_PREFIX = "lucent-game-temporary-";
const MANAGED_PARTITION_PATTERN = /^lucent-game-account-[a-f0-9]{64}$/;
const TEMPORARY_PARTITION_PATTERN =
  /^lucent-game-temporary-([1-9][0-9]*)-([a-f0-9]{24})$/;
/**
 * Electron may keep a Session alive after its game client closes, so account
 * deletion and identity-changing renames cannot safely remove the profile at
 * once. This marker schedules removal for the next cold start. Reopening the
 * same account before then cancels the removal.
 */
const RETIRED_PROFILE_MARKER = ".lucent-retired";

export type GamePartitionOwner =
  | { readonly kind: "default" }
  | { readonly kind: "managed-account"; readonly key: string };

export interface GamePartitionRegistry {
  readonly acquire: (owner: GamePartitionOwner) => string;
  readonly release: (partition: string) => void;
}

export interface GamePartitionCleanupResult {
  readonly failedPaths: readonly string[];
  readonly removedPaths: readonly string[];
}

const normalizeManagedAccountKey = (key: string): string => {
  const normalized = key.trim().toLowerCase();
  if (normalized === "") {
    throw new Error("Managed game partition key cannot be empty.");
  }
  return normalized;
};

export const managedGamePartition = (key: string): string => {
  const digest = createHash("sha256")
    .update(normalizeManagedAccountKey(key), "utf8")
    .digest("hex");
  return `${PERSISTENT_PARTITION_PREFIX}${MANAGED_PARTITION_PREFIX}${digest}`;
};

export const defaultGamePartition = `${PERSISTENT_PARTITION_PREFIX}${DEFAULT_PARTITION_NAME}`;

export const makeGamePartitionRegistry = (): GamePartitionRegistry => {
  const inUse = new Set<string>();

  return {
    acquire: (owner) => {
      const persistentPartition =
        owner.kind === "managed-account"
          ? managedGamePartition(owner.key)
          : defaultGamePartition;
      if (!inUse.has(persistentPartition)) {
        inUse.add(persistentPartition);
        return persistentPartition;
      }

      return `${TEMPORARY_PARTITION_PREFIX}${randomBytes(12).toString("hex")}`;
    },
    release: (partition) => {
      inUse.delete(partition);
    },
  };
};

const partitionsDirectory = (sessionDataDir: string): string =>
  join(sessionDataDir, "Partitions");

const isMissing = (cause: unknown): boolean =>
  Predicate.isError(cause) &&
  Predicate.hasProperty(cause, "code") &&
  cause.code === "ENOENT";

const directoryNames = Effect.fnUntraced(function* (path: string) {
  const entries = yield* Effect.tryPromise({
    try: () => readdir(path, { withFileTypes: true }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      isMissing(cause) ? Effect.succeed([]) : Effect.fail(cause),
    ),
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
});

const defaultProcessIsAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    return (
      Predicate.isError(cause) &&
      Predicate.hasProperty(cause, "code") &&
      cause.code === "EPERM"
    );
  }
};

/** Removes only profiles that cannot belong to a live game session. */
export const cleanupStaleGamePartitionProfiles = Effect.fnUntraced(function* (
  sessionDataDir: string,
  fileSystem: FileSystem.FileSystem,
  options: {
    readonly isProcessAlive?: (processId: number) => boolean;
  } = {},
): Effect.fn.Return<GamePartitionCleanupResult, unknown> {
  const directory = partitionsDirectory(sessionDataDir);
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;
  const failedPaths: string[] = [];
  const removedPaths: string[] = [];

  for (const name of yield* directoryNames(directory)) {
    const path = join(directory, name);
    const temporaryMatch = TEMPORARY_PARTITION_PATTERN.exec(name);
    const removable =
      (MANAGED_PARTITION_PATTERN.test(name) &&
        (yield* fileSystem
          .exists(join(path, RETIRED_PROFILE_MARKER))
          .pipe(Effect.orElseSucceed(() => false)))) ||
      (temporaryMatch !== null && !isProcessAlive(Number(temporaryMatch[1])));
    if (!removable) continue;

    const removed = yield* fileSystem
      .remove(path, { recursive: true, force: true })
      .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
    if (removed) removedPaths.push(path);
    else failedPaths.push(path);
  }

  return { failedPaths, removedPaths };
});

export const activateManagedGamePartitionProfile = (
  profilePath: string,
  fileSystem: FileSystem.FileSystem,
) =>
  fileSystem
    .remove(join(profilePath, RETIRED_PROFILE_MARKER))
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));

export const retireManagedGamePartitionProfile = Effect.fnUntraced(function* (
  profilePath: string,
  fileSystem: FileSystem.FileSystem,
) {
  const exists = yield* fileSystem
    .exists(profilePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  yield* fileSystem.writeFileString(
    join(profilePath, RETIRED_PROFILE_MARKER),
    "1\n",
  );
  return true;
});

/** Discovers inactive Lucent profiles so clearing data also covers unopened accounts. */
export const listPersistentGamePartitions = Effect.fnUntraced(function* (
  sessionDataDir: string,
) {
  return (yield* directoryNames(partitionsDirectory(sessionDataDir)))
    .filter(
      (name) =>
        name === DEFAULT_PARTITION_NAME ||
        MANAGED_PARTITION_PATTERN.test(name) ||
        TEMPORARY_PARTITION_PATTERN.test(name),
    )
    .map((name) => `${PERSISTENT_PARTITION_PREFIX}${name}`);
});
