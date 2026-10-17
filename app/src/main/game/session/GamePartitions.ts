import { createHash, randomBytes } from "crypto";
import { existsSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

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

const temporaryGamePartition = (
  processId: number,
  randomId: string,
): string => {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error(`Invalid game partition process ID: ${processId}`);
  }
  if (!/^[a-f0-9]{24}$/.test(randomId)) {
    throw new Error(`Invalid game partition random ID: ${randomId}`);
  }
  return `${TEMPORARY_PARTITION_PREFIX}${processId}-${randomId}`;
};

export const makeGamePartitionRegistry = (
  options: {
    readonly makeRandomId?: () => string;
    readonly processId?: number;
  } = {},
): GamePartitionRegistry => {
  const inUse = new Set<string>();
  const makeRandomId =
    options.makeRandomId ?? (() => randomBytes(12).toString("hex"));
  const processId = options.processId ?? process.pid;

  const acquireTemporary = (): string => {
    let partition: string;
    do {
      partition = temporaryGamePartition(processId, makeRandomId());
    } while (inUse.has(partition));
    return partition;
  };

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

      const partition = acquireTemporary();
      inUse.add(partition);
      return partition;
    },
    release: (partition) => {
      inUse.delete(partition);
    },
  };
};

const partitionsDirectory = (sessionDataDir: string): string =>
  join(sessionDataDir, "Partitions");

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const directoryNames = (path: string): readonly string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (cause) {
    if (isMissing(cause)) return [];
    throw cause;
  }
};

const defaultProcessIsAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    return (
      cause instanceof Error &&
      "code" in cause &&
      (cause as { readonly code?: unknown }).code === "EPERM"
    );
  }
};

/** Removes only profiles that cannot belong to a live game session. */
export const cleanupStaleGamePartitionProfiles = (
  sessionDataDir: string,
  options: {
    readonly isProcessAlive?: (processId: number) => boolean;
  } = {},
): GamePartitionCleanupResult => {
  const directory = partitionsDirectory(sessionDataDir);
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;
  const failedPaths: string[] = [];
  const removedPaths: string[] = [];

  for (const name of directoryNames(directory)) {
    const path = join(directory, name);
    const temporaryMatch = TEMPORARY_PARTITION_PATTERN.exec(name);
    const removable =
      (MANAGED_PARTITION_PATTERN.test(name) &&
        existsSync(join(path, RETIRED_PROFILE_MARKER))) ||
      (temporaryMatch !== null && !isProcessAlive(Number(temporaryMatch[1])));
    if (!removable) continue;

    try {
      rmSync(path, { recursive: true, force: true });
      removedPaths.push(path);
    } catch {
      failedPaths.push(path);
    }
  }

  return { failedPaths, removedPaths };
};

export const activateManagedGamePartitionProfile = (
  profilePath: string,
): void => {
  const markerPath = join(profilePath, RETIRED_PROFILE_MARKER);
  try {
    unlinkSync(markerPath);
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
};

export const retireManagedGamePartitionProfile = (
  profilePath: string,
): boolean => {
  if (!existsSync(profilePath)) return false;
  writeFileSync(join(profilePath, RETIRED_PROFILE_MARKER), "1\n", "utf8");
  return true;
};

/** Discovers inactive Lucent profiles so clearing data also covers unopened accounts. */
export const listPersistentGamePartitions = (
  sessionDataDir: string,
): readonly string[] =>
  directoryNames(partitionsDirectory(sessionDataDir))
    .filter(
      (name) =>
        name === DEFAULT_PARTITION_NAME ||
        MANAGED_PARTITION_PATTERN.test(name) ||
        TEMPORARY_PARTITION_PATTERN.test(name),
    )
    .map((name) => `${PERSISTENT_PARTITION_PREFIX}${name}`);
