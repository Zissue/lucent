import { createHash } from "crypto";
import { promises as fs } from "fs";
import { basename, dirname, join } from "path";

import {
  listRegularFilePaths,
  readStableFile,
  sha256Revision,
} from "./ScriptPackageFileSystem";
import {
  formatBytes,
  SCRIPT_PACKAGE_FILE_MAX_BYTES,
  SCRIPT_PACKAGE_MAX_BYTES,
  SCRIPT_PACKAGE_MAX_FILES,
} from "./ScriptLimits";

type GitEntry =
  | {
      readonly kind: "file";
      readonly hash: Buffer;
      readonly executable: boolean;
    }
  | { readonly kind: "directory"; readonly entries: Map<string, GitEntry> };

const gitObjectHash = (kind: "blob" | "tree", contents: Buffer): Buffer =>
  createHash("sha1")
    .update(`${kind} ${contents.byteLength}\0`)
    .update(contents)
    .digest();

// Git sorts directory names as though they have a trailing slash.
const gitTreeHash = (entries: ReadonlyMap<string, GitEntry>): Buffer => {
  const ordered = [...entries];
  ordered.sort(([leftName, left], [rightName, right]) =>
    Buffer.compare(
      Buffer.from(leftName + (left.kind === "directory" ? "/" : "")),
      Buffer.from(rightName + (right.kind === "directory" ? "/" : "")),
    ),
  );
  return gitObjectHash(
    "tree",
    Buffer.concat(
      ordered.flatMap(([name, entry]) => [
        Buffer.from(
          `${entry.kind === "directory" ? "40000" : entry.executable ? "100755" : "100644"} ${name}\0`,
        ),
        entry.kind === "directory" ? gitTreeHash(entry.entries) : entry.hash,
      ]),
    ),
  );
};

export const copyBundledScriptPackage = async (
  source: string,
  destination: string,
): Promise<{
  readonly files: Readonly<Record<string, string>>;
  readonly tree: string;
}> => {
  const root = await fs.lstat(source);
  if (!root.isDirectory()) {
    throw new Error(
      "A bundled package must be a directory, not a symbolic link.",
    );
  }
  const inventory = await listRegularFilePaths(source, {
    maxFiles: SCRIPT_PACKAGE_MAX_FILES,
    rejectSymlinks: true,
  });
  const files = new Map<string, string>();
  const tree = new Map<string, GitEntry>();
  let totalBytes = 0;

  for (const file of inventory) {
    const contents = await readStableFile(
      file.absolutePath,
      SCRIPT_PACKAGE_FILE_MAX_BYTES,
    );
    totalBytes += contents.byteLength;
    if (totalBytes > SCRIPT_PACKAGE_MAX_BYTES) {
      throw new Error(
        `The bundled package exceeds the ${formatBytes(SCRIPT_PACKAGE_MAX_BYTES)} limit.`,
      );
    }
    const stat = await fs.lstat(file.absolutePath);
    if (!stat.isFile()) {
      throw new Error("Bundled packages must contain only regular files.");
    }
    const executable = (stat.mode & 0o111) !== 0;
    const target = join(destination, file.relativePath);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, contents, {
      flag: "wx",
      mode: executable ? 0o755 : 0o644,
    });
    files.set(file.relativePath, `sha256-${sha256Revision(contents)}`);

    const parts = file.relativePath.split("/").slice(0, -1);
    let entries = tree;
    for (const part of parts) {
      const entry = entries.get(part);
      if (entry?.kind === "file") throw new Error("Conflicting package paths.");
      const directory = entry ?? {
        kind: "directory" as const,
        entries: new Map<string, GitEntry>(),
      };
      entries.set(part, directory);
      entries = directory.entries;
    }
    entries.set(basename(file.relativePath), {
      kind: "file",
      hash: gitObjectHash("blob", contents),
      executable,
    });
  }
  return {
    files: Object.fromEntries(files),
    tree: gitTreeHash(tree).toString("hex"),
  };
};
