import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";

import {
  listRegularFilePaths,
  readStableFile,
} from "./ScriptPackageFileSystem";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("readStableFile", () => {
  it("retries changed files up to three attempts", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lucent-stable-file-"));
    directories.push(root);
    const path = join(root, "value.js");
    await fs.writeFile(path, "initial");
    const stat = fs.stat;
    let checks = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      checks += 1;
      if (checks === 2) await fs.writeFile(path, "second");
      if (checks === 4) await fs.writeFile(path, "third");
      return stat(...args);
    });

    expect((await readStableFile(path)).toString("utf8")).toBe("third");
    expect(checks).toBe(6);
  });

  it("fails after three changed reads without a fourth attempt", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lucent-stable-file-"));
    directories.push(root);
    const path = join(root, "value.js");
    await fs.writeFile(path, "initial");
    const stat = fs.stat;
    let checks = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      checks += 1;
      if (checks % 2 === 0) await fs.appendFile(path, "!");
      return stat(...args);
    });

    await expect(readStableFile(path)).rejects.toThrow(
      `File changed while it was being read: ${path}.`,
    );
    expect(await fs.readFile(path, "utf8")).toBe("initial!!!");
    expect(checks).toBe(6);
  });

  it("does not retry a file that exceeds the bound while being read", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lucent-stable-file-"));
    directories.push(root);
    const path = join(root, "value.js");
    await fs.writeFile(path, "1234");
    const stat = fs.stat;
    let checks = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      checks += 1;
      const info = await stat(...args);
      await fs.appendFile(path, "56789");
      return info;
    });

    await expect(readStableFile(path, 8)).rejects.toThrow(
      `File exceeds the 8 bytes limit: ${path}.`,
    );
    expect(await fs.readFile(path, "utf8")).toBe("123456789");
    expect(checks).toBe(1);
  });
});

describe("listRegularFilePaths", () => {
  it("applies file limits only when the caller requests one", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lucent-file-inventory-"));
    directories.push(root);
    await Promise.all(
      ["one.js", "two.js", "three.js"].map((name) =>
        fs.writeFile(join(root, name), "", "utf8"),
      ),
    );

    const paths = await listRegularFilePaths(root);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toEqual({
      absolutePath: join(root, "one.js"),
      relativePath: "one.js",
    });
    await expect(listRegularFilePaths(root, { maxFiles: 2 })).rejects.toThrow(
      "Directory contains more than 2 files",
    );
  });
});
