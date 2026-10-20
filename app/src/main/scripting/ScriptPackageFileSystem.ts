import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { relative, resolve, sep } from "node:path";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";

import {
  FileChangedWhileReading,
  FileSystemLimitError,
  fileFingerprint,
  isMissingFileError,
  readStableFile as readStableFileEffect,
} from "../filesystem/BoundedFileSystem";

import {
  formatBytes,
  SCRIPT_PACKAGE_FILE_MAX_BYTES,
  SCRIPT_PACKAGE_MAX_FILES,
} from "./ScriptLimits";

export interface RegularFilePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface ListRegularFilesOptions {
  readonly maxFiles?: number;
  readonly rejectSymlinks?: boolean;
}

const systemMetadataNames = new Set(["desktop.ini", "thumbs.db"]);

const isSystemMetadataFile = (name: string): boolean =>
  name === ".DS_Store" ||
  name === ".directory" ||
  name.startsWith("._") ||
  systemMetadataNames.has(name.toLowerCase());

export const portablePath = (value: string): string =>
  value.split(sep).join("/");

export const isPathInside = (root: string, candidate: string): boolean => {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const path = relative(normalizedRoot, normalizedCandidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

export const readStableFile = async (
  path: string,
  maxBytes: number,
): Promise<Buffer> => {
  const exit = await Effect.runPromiseExit(
    readStableFileEffect(path, maxBytes, { requireRegularFile: true }).pipe(
      Effect.retry({
        schedule: Schedule.recurs(2),
        while: (cause) => cause instanceof FileChangedWhileReading,
      }),
      Effect.mapError((cause) =>
        cause instanceof FileSystemLimitError
          ? new Error(
              `File exceeds the ${formatBytes(maxBytes)} limit: ${path}.`,
            )
          : cause instanceof FileChangedWhileReading
            ? new Error(`File changed while it was being read: ${path}.`)
            : cause,
      ),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value.contents;
};

export const regularFileFingerprint = async (path: string): Promise<string> => {
  const stat = await fs.stat(path);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}.`);
  return fileFingerprint(stat);
};

export const sha256Revision = (contents: Buffer | string): string =>
  createHash("sha256").update(contents).digest("hex");

export const listRegularFilePaths = async (
  root: string,
  options: ListRegularFilesOptions = {},
): Promise<readonly RegularFilePath[]> => {
  const files: RegularFilePath[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (options.rejectSymlinks === true) {
          throw new Error(`Symbolic links are not supported: ${path}.`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSystemMetadataFile(entry.name)) continue;

      const relativePath = portablePath(relative(root, path));
      files.push({ absolutePath: path, relativePath });
      if (options.maxFiles !== undefined && files.length > options.maxFiles) {
        throw new Error(
          `Directory contains more than ${options.maxFiles} files: ${root}.`,
        );
      }
    }
  };

  try {
    await visit(root);
  } catch (cause) {
    if (isMissingFileError(cause)) return [];
    throw cause;
  }
  return files;
};

export const hashDirectory = async (
  root: string,
): Promise<Readonly<Record<string, string>>> => {
  const inventory = await listRegularFilePaths(root, {
    maxFiles: SCRIPT_PACKAGE_MAX_FILES,
    rejectSymlinks: true,
  });
  const hashes = new Map<string, string>();
  for (const file of inventory) {
    const contents = await readStableFile(
      file.absolutePath,
      SCRIPT_PACKAGE_FILE_MAX_BYTES,
    );
    hashes.set(file.relativePath, `sha256-${sha256Revision(contents)}`);
  }
  return Object.fromEntries(hashes);
};
