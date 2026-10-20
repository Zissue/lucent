import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { create as createTar } from "tar";

import {
  extractScriptPackageArchive,
  validateScriptPackageArchive,
} from "./ScriptPackageArchive";

const directories: string[] = [];
const PACKAGE_NAME = "example";
const PACKAGE_SUBDIRECTORY = "packages/example";

const makeDirectory = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "lucent-package-archive-"));
  directories.push(path);
  return path;
};

const write = async (path: string, source: string): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, source, "utf8");
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("script package archives", () => {
  it("validates and extracts a normal GitHub-style root", async () => {
    const root = await makeDirectory();
    const source = join(root, "source", "repository-commit");
    await Promise.all([
      write(join(source, "package.json"), '{"name":"tools"}'),
      write(join(source, "scripts", "farm.js"), "module.exports = 1"),
    ]);
    const archive = join(root, "package.tgz");
    await createTar({ cwd: join(root, "source"), file: archive, gzip: true }, [
      "repository-commit",
    ]);

    await expect(validateScriptPackageArchive(archive)).resolves.toEqual({
      root: "repository-commit",
    });
    const extracted = join(root, "extracted");
    await extractScriptPackageArchive(archive, extracted);
    await expect(
      fs.readFile(join(extracted, "package.json"), "utf8"),
    ).resolves.toContain('"tools"');
  });

  it("extracts only the selected package directory", async () => {
    const root = await makeDirectory();
    const sourceRoot = join(root, "source");
    const repository = join(sourceRoot, "repository-commit");
    await Promise.all([
      write(join(repository, "README.md"), "repository"),
      write(
        join(repository, PACKAGE_SUBDIRECTORY, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME }),
      ),
      write(
        join(repository, PACKAGE_SUBDIRECTORY, "index.js"),
        "module.exports = 'selected';",
      ),
      write(join(repository, "packages", "other", "private.txt"), "other"),
    ]);
    const archive = join(root, "package.tgz");
    await createTar({ cwd: sourceRoot, file: archive, gzip: true }, [
      "repository-commit",
    ]);

    await expect(
      validateScriptPackageArchive(archive, {
        subdirectory: PACKAGE_SUBDIRECTORY,
      }),
    ).resolves.toEqual({ root: "repository-commit" });
    const extracted = join(root, "extracted");
    await extractScriptPackageArchive(archive, extracted, PACKAGE_SUBDIRECTORY);

    await expect(
      fs.readFile(join(extracted, "index.js"), "utf8"),
    ).resolves.toBe("module.exports = 'selected';");
    await expect(fs.access(join(extracted, "README.md"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(fs.access(join(extracted, "other"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      validateScriptPackageArchive(archive, {
        subdirectory: "packages/missing",
      }),
    ).rejects.toThrow('package directory "packages/missing"');
  });

  it("rejects unsafe entries outside the selected package directory", async () => {
    const root = await makeDirectory();
    const sourceRoot = join(root, "source");
    const repository = join(sourceRoot, "repository-commit");
    await write(
      join(repository, PACKAGE_SUBDIRECTORY, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME }),
    );
    await write(join(repository, "packages", "other", "target.txt"), "other");
    await fs.symlink(
      "target.txt",
      join(repository, "packages", "other", "linked.txt"),
    );
    const archive = join(root, "package.tgz");
    await createTar({ cwd: sourceRoot, file: archive, gzip: true }, [
      "repository-commit",
    ]);

    await expect(
      extractScriptPackageArchive(
        archive,
        join(root, "extracted"),
        PACKAGE_SUBDIRECTORY,
      ),
    ).rejects.toThrow("unsupported type SymbolicLink");
  });

  it("rejects symbolic links before extraction", async () => {
    const root = await makeDirectory();
    const sourceRoot = join(root, "source");
    const source = join(sourceRoot, "repository-commit");
    await write(join(source, "package.json"), '{"name":"tools"}');
    await fs.symlink("package.json", join(source, "linked.json"));
    const archive = join(root, "package.tgz");
    await createTar({ cwd: sourceRoot, file: archive, gzip: true }, [
      "repository-commit",
    ]);

    await expect(validateScriptPackageArchive(archive)).rejects.toThrow(
      "unsupported type SymbolicLink",
    );
  });
});
