import { promises as fs } from "fs";
import { join } from "path";

import type { ScriptPackageLeftoverCopy } from "@lucent/core/scriptPackages";
import { readScriptPackageManifest } from "./ScriptPackageCatalog";
import { isMissingFileError } from "./ScriptPackageFileSystem";

export const SCRIPT_PACKAGE_BACKUP_PREFIX = ".lucent-package-backup-";
export const SCRIPT_PACKAGE_REMOVE_PREFIX = ".lucent-package-remove-";

export const findLeftoverPackageCopies = async (
  workspaceDir: string,
): Promise<readonly ScriptPackageLeftoverCopy[]> => {
  const entries = await fs
    .readdir(workspaceDir, { withFileTypes: true })
    .catch((cause: unknown) => {
      if (isMissingFileError(cause)) return [];
      throw cause;
    });
  const copies: ScriptPackageLeftoverCopy[] = [];
  for (const entry of entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      !entry.isDirectory() ||
      ![SCRIPT_PACKAGE_BACKUP_PREFIX, SCRIPT_PACKAGE_REMOVE_PREFIX].some(
        (prefix) => entry.name.startsWith(prefix),
      )
    )
      continue;
    const path = join(workspaceDir, entry.name);
    const children = await fs
      .readdir(path, { withFileTypes: true })
      .catch(() => []);
    let packageName: string | undefined;
    for (const child of children.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!child.isDirectory()) continue;
      try {
        packageName = (
          await readScriptPackageManifest(
            join(path, child.name, "package.json"),
          )
        ).name;
        break;
      } catch {
        continue;
      }
    }
    copies.push({
      path,
      ...(packageName === undefined ? {} : { packageName }),
    });
  }
  return copies;
};
