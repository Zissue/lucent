import { promises as fs } from "node:fs";

import * as Schema from "effect/Schema";
import { list as listTar, extract as extractTar } from "tar";

import { ScriptPackageRepositorySubdirectorySchema } from "@lucent/core/scriptPackages";
import {
  formatBytes,
  SCRIPT_PACKAGE_ARCHIVE_MAX_ENTRIES,
  SCRIPT_PACKAGE_ARCHIVE_PATH_MAX_BYTES,
  SCRIPT_PACKAGE_MAX_BYTES,
  SCRIPT_PACKAGE_PATH_COMPONENT_MAX_BYTES,
} from "./ScriptLimits";

export const decodeRepositorySubdirectory = Schema.decodeUnknownSync(
  ScriptPackageRepositorySubdirectorySchema,
);

interface ArchiveInventory {
  readonly root: string;
}

interface ArchiveValidationOptions {
  readonly subdirectory?: string;
}

const archivePath = (rawPath: string): readonly string[] => {
  if (
    rawPath === "" ||
    rawPath.startsWith("/") ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    Buffer.byteLength(rawPath, "utf8") > SCRIPT_PACKAGE_ARCHIVE_PATH_MAX_BYTES
  ) {
    throw new Error(
      `Archive contains an unsafe path: ${JSON.stringify(rawPath)}.`,
    );
  }
  const parts = rawPath.endsWith("/")
    ? rawPath.slice(0, -1).split("/")
    : rawPath.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part, "utf8") >
          SCRIPT_PACKAGE_PATH_COMPONENT_MAX_BYTES,
    )
  ) {
    throw new Error(
      `Archive contains an unsafe path: ${JSON.stringify(rawPath)}.`,
    );
  }
  return parts;
};

export const validateScriptPackageArchive = async (
  path: string,
  options: ArchiveValidationOptions = {},
): Promise<ArchiveInventory> => {
  const caseInsensitivePaths =
    process.platform === "darwin" || process.platform === "win32";
  const subdirectory =
    options.subdirectory === undefined
      ? undefined
      : decodeRepositorySubdirectory(options.subdirectory);
  const subdirectoryPrefix =
    subdirectory === undefined ? undefined : `${subdirectory}/`;
  const platformPaths = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;
  let root: string | undefined;
  let selectedDirectoryFound = subdirectory === undefined;
  let validationError: Error | undefined;

  await listTar({
    file: path,
    strict: true,
    onReadEntry: (entry) => {
      if (validationError !== undefined) return;
      try {
        if (
          entry.type !== "File" &&
          entry.type !== "OldFile" &&
          entry.type !== "Directory"
        ) {
          throw new Error(
            `Archive entry ${JSON.stringify(entry.path)} has unsupported type ${entry.type}.`,
          );
        }
        const [entryRoot, ...relativeParts] = archivePath(entry.path);
        if (entryRoot === undefined) {
          throw new Error("Archive entry has no root directory.");
        }
        root ??= entryRoot;
        if (root !== entryRoot) {
          throw new Error("Archive contains more than one root directory.");
        }
        if (relativeParts.length === 0) return;

        const relativePath = relativeParts.join("/");
        if (relativePath === subdirectory) {
          if (entry.type !== "Directory") {
            throw new Error(
              `Selected package path ${JSON.stringify(subdirectory)} is not a directory.`,
            );
          }
          selectedDirectoryFound = true;
        } else if (
          subdirectoryPrefix !== undefined &&
          relativePath.startsWith(subdirectoryPrefix)
        ) {
          selectedDirectoryFound = true;
        }
        const normalizedPath = relativePath.normalize("NFC");
        const platformPath = caseInsensitivePaths
          ? normalizedPath.toLocaleLowerCase("en-US")
          : normalizedPath;
        if (platformPaths.has(platformPath)) {
          throw new Error(
            `Archive contains a colliding path: ${relativePath}.`,
          );
        }
        platformPaths.add(platformPath);

        entryCount += 1;
        const size = entry.type === "Directory" ? 0 : entry.size;
        if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
          throw new Error(
            `Archive entry ${JSON.stringify(entry.path)} has an invalid size.`,
          );
        }
        extractedBytes += size;
        if (entryCount > SCRIPT_PACKAGE_ARCHIVE_MAX_ENTRIES) {
          throw new Error(
            `Archive contains more than ${SCRIPT_PACKAGE_ARCHIVE_MAX_ENTRIES} entries.`,
          );
        }
        if (extractedBytes > SCRIPT_PACKAGE_MAX_BYTES) {
          throw new Error(
            `Archive expands beyond ${formatBytes(SCRIPT_PACKAGE_MAX_BYTES)}.`,
          );
        }
      } catch (cause) {
        validationError =
          cause instanceof Error
            ? cause
            : new Error("Archive validation failed.");
      }
    },
  });
  if (validationError !== undefined) throw validationError;
  if (root === undefined) throw new Error("Archive is empty.");
  if (!selectedDirectoryFound) {
    throw new Error(
      `Archive does not contain package directory ${JSON.stringify(subdirectory)}.`,
    );
  }
  return { root };
};

export const extractScriptPackageArchive = async (
  archivePath: string,
  targetPath: string,
  subdirectory?: string,
): Promise<void> => {
  const inventory = await validateScriptPackageArchive(
    archivePath,
    subdirectory === undefined ? {} : { subdirectory },
  );
  await fs.mkdir(targetPath, { recursive: true });
  const selectedPrefix =
    subdirectory === undefined
      ? undefined
      : `${inventory.root}/${subdirectory}/`;
  await extractTar({
    cwd: targetPath,
    file: archivePath,
    ...(selectedPrefix === undefined
      ? {}
      : { filter: (path) => path.startsWith(selectedPrefix) }),
    noMtime: true,
    preserveOwner: false,
    preservePaths: false,
    strict: true,
    strip: subdirectory === undefined ? 1 : subdirectory.split("/").length + 1,
    unlink: true,
  });
};
