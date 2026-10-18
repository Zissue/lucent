import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

import * as Schema from "effect/Schema";

import {
  ScriptPackageDirectorySchema,
  ScriptPackageNameSchema,
  type ScriptPackageDirectory,
} from "@lucent/core/scriptPackages";
import { isMissingFileError } from "../filesystem/BoundedFileSystem";
import { SCRIPT_PACKAGE_DIRECTORY_SLUG_MAX_BYTES } from "./ScriptLimits";

const decodePackageDirectory = Schema.decodeUnknownSync(
  ScriptPackageDirectorySchema,
);
const decodePackageName = Schema.decodeUnknownSync(ScriptPackageNameSchema);

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.lstat(path);
    return true;
  } catch (cause) {
    if (isMissingFileError(cause)) return false;
    throw cause;
  }
};

const truncateUtf8 = (value: string, maxBytes: number): string => {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
};

/** Returns the readable starting folder name used for a new installation. */
export const scriptPackageDirectorySlug = (
  name: string,
): ScriptPackageDirectory => {
  const decodedName = decodePackageName(name);
  const base = decodedName
    .normalize("NFKC")
    .replace(/^@/u, "")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .toLocaleLowerCase("en-US")
    .normalize("NFC");
  const truncated = truncateUtf8(
    base === "" ? "package" : base,
    SCRIPT_PACKAGE_DIRECTORY_SLUG_MAX_BYTES,
  ).replace(/[._-]+$/u, "");
  const candidate = truncated === "" ? "package" : truncated;
  try {
    return decodePackageDirectory(candidate);
  } catch {
    return decodePackageDirectory(`package-${candidate}`);
  }
};

export const packageDirectoryPath = (
  packagesDir: string,
  directory: string,
): string => {
  const decodedDirectory = decodePackageDirectory(directory);
  const root = resolve(packagesDir);
  const path = resolve(root, decodedDirectory);
  if (dirname(path) !== root) {
    throw new Error("Package folder escapes the package directory.");
  }
  return path;
};

export const allocatePackageDirectory = async (
  packagesDir: string,
  packageName: string,
  reservedDirectories: ReadonlySet<string>,
): Promise<ScriptPackageDirectory> => {
  const slug = scriptPackageDirectorySlug(packageName);
  for (let index = 1; index <= 10_000; index += 1) {
    const directory =
      index === 1 ? slug : decodePackageDirectory(`${slug}-${index}`);
    if (
      !reservedDirectories.has(directory) &&
      !(await pathExists(packageDirectoryPath(packagesDir, directory)))
    ) {
      return directory;
    }
  }
  throw new Error("Could not find an unused package folder name.");
};
