import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { setTimeout } from "node:timers/promises";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { create as createTar } from "tar";

import type {
  ScriptCatalog,
  ScriptCatalogOverview,
  ScriptPackageIntegrity,
} from "@lucent/core/scriptPackages";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import {
  GitHubScriptPackageClient,
  type GitHubCommitResolution,
  type GitHubScriptPackageClientShape,
} from "./GitHubScriptPackageClient";
import {
  ScriptPackageCatalog,
  type DiscoveredScriptCatalog,
} from "./ScriptPackageCatalog";
import { scriptPackageDirectorySlug } from "./ScriptPackageDirectories";
import { hashDirectory } from "./ScriptPackageFileSystem";
import {
  extractScriptPackageArchive,
  layer as scriptPackageManagerLayer,
  ScriptPackageManager,
  validateScriptPackageArchive,
} from "./ScriptPackageManager";
import {
  ScriptPackageState,
  ScriptPackageStateError,
  type ManagedScriptPackage,
} from "./ScriptPackageState";

vi.mock("electron", () => ({ app: {} }));

const directories: string[] = [];
const INSTALLED_COMMIT = "1".repeat(40);
const REMOTE_COMMIT = "2".repeat(40);
const INSTALLED_TREE = "3".repeat(40);
const REMOTE_TREE = "4".repeat(40);
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

const findFiles = async (
  root: string,
  contents: string,
): Promise<readonly string[]> => {
  const entries = await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await fs.readFile(path, "utf8")) === contents) matches.push(path);
  }
  return matches;
};

const refuseRenamesInto = (
  destination: string,
  isLocked: () => boolean = () => true,
) => {
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation((from, to) =>
    resolve(String(to)) === destination && isLocked()
      ? Promise.reject(
          Object.assign(new Error("EPERM: operation not permitted"), {
            code: "EPERM",
          }),
        )
      : rename(from, to),
  );
};

const makeManagerHarness = (options: {
  readonly archivePath?: string;
  readonly directoryTree?: string;
  readonly onSave?: (
    value: ManagedScriptPackage,
  ) => Effect.Effect<void, ScriptPackageStateError>;
  readonly integrity?: ScriptPackageIntegrity;
  readonly managed?: ManagedScriptPackage;
  readonly resolution: GitHubCommitResolution;
  readonly workspaceDir?: string;
}) => {
  let managed = options.managed;
  let downloadCount = 0;
  const requests: Parameters<
    GitHubScriptPackageClientShape["resolveCommit"]
  >[0][] = [];
  const directoryRequests: Parameters<
    GitHubScriptPackageClientShape["resolveDirectory"]
  >[0][] = [];

  const currentCatalog = (): ScriptCatalog => ({
    packages:
      managed === undefined
        ? []
        : [
            {
              status: "valid",
              compatibility: {
                status: "compatible",
                currentVersion: "1.0.0",
                requiredVersion: "*",
              },
              dependencyStatus: { status: "ready" },
              integrity: options.integrity ?? "verified",
              name: managed.name,
              path: join(
                options.workspaceDir ?? "/tmp/lucent",
                "packages",
                managed.directory,
              ),
              source: managed.source,
              update: managed.update ?? { status: "unchecked" },
            },
          ],
    revision: "test-catalog",
    scripts: [],
  });
  const currentDiscovery = (): DiscoveredScriptCatalog => ({
    catalog: currentCatalog(),
    paths: new Map(),
    packages: new Map(),
    scripts: new Map(),
  });
  const currentOverview = (): ScriptCatalogOverview => ({
    packages: currentCatalog().packages,
    revision: currentCatalog().revision,
    scriptCount: 0,
  });
  const catalog = ScriptPackageCatalog.of({
    getDiscovery: Effect.sync(currentDiscovery),
    getOverview: Effect.sync(currentOverview),
    getPage: () =>
      Effect.succeed({
        entries: [],
        offset: 0,
        revision: currentCatalog().revision,
        total: 0,
      }),
    onChanged: () => Effect.succeed(() => undefined),
    referenceForPath: () => Effect.succeed(undefined),
    refresh: Effect.sync(currentOverview),
    removePackage: () => Effect.sync(currentOverview),
    replacePackage: () => Effect.sync(currentOverview),
    resolveReference: () => Effect.succeed(undefined),
    updateManagedPackage: () => Effect.sync(currentOverview),
  });
  const client = GitHubScriptPackageClient.of({
    downloadArchive: ({ targetPath }) =>
      Effect.promise(async () => {
        downloadCount += 1;
        if (options.archivePath !== undefined) {
          await fs.copyFile(options.archivePath, targetPath);
        }
      }),
    resolveCommit: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return options.resolution;
      }),
    resolveDirectory: (input) =>
      Effect.sync(() => {
        directoryRequests.push(input);
        return { tree: options.directoryTree ?? REMOTE_TREE };
      }),
  });
  const state = ScriptPackageState.of({
    get: (name) =>
      Effect.sync(() => (name === managed?.name ? managed : undefined)),
    getAll: Effect.sync(() => (managed === undefined ? [] : [managed])),
    remove: () => Effect.void,
    save: Effect.fnUntraced(function* (value) {
      yield* options.onSave?.(value) ?? Effect.void;
      managed = value;
    }),
  });
  const environment = DesktopEnvironment.of({
    appDataDir: "/tmp/lucent-package-manager-data",
    assetsDir: "/tmp/lucent-package-manager-assets",
    isDev: true,
    platform: "darwin",
    workspaceDir: options.workspaceDir ?? "/tmp/lucent",
  });
  const layer = scriptPackageManagerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment, environment),
        Layer.succeed(GitHubScriptPackageClient, client),
        Layer.succeed(ScriptPackageCatalog, catalog),
        Layer.succeed(ScriptPackageState, state),
      ),
    ),
  );

  return {
    downloadCount: () => downloadCount,
    directoryRequests,
    layer,
    managed: () => managed,
    requests,
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("script package folders", () => {
  it("makes a readable folder slug from the complete package name", () => {
    expect(scriptPackageDirectorySlug("tools")).toBe("tools");
    expect(scriptPackageDirectorySlug("@author/daily tools")).toBe(
      "author-daily-tools",
    );
    expect(scriptPackageDirectorySlug("team/shared/tools")).toBe(
      "team-shared-tools",
    );
    expect(scriptPackageDirectorySlug("@con")).toBe("package-con");
  });

  it.effect("stores the available folder chosen during installation", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeDirectory);
      const workspaceDir = join(root, "workspace");
      const sourceRoot = join(root, "source");
      const source = join(sourceRoot, "repository-commit");
      const packageName = "@author/daily-tools";
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(source, "package.json"),
            JSON.stringify({ name: packageName }),
          ),
          write(join(source, "index.js"), "module.exports = 'installed';"),
          write(
            join(workspaceDir, "packages", "author-daily-tools", "keep.txt"),
            "existing folder",
          ),
        ]),
      );
      const archivePath = join(root, "package.tgz");
      yield* Effect.promise(() =>
        createTar({ cwd: sourceRoot, file: archivePath, gzip: true }, [
          "repository-commit",
        ]),
      );
      const harness = makeManagerHarness({
        archivePath,
        managed: {
          directory: "author-daily-tools-2",
          files: {},
          installedAt: "2026-08-01T00:00:00.000Z",
          name: "other-package",
          source: {
            kind: "repository",
            repositoryUrl: "https://github.com/example/other-package",
            resolvedCommit: INSTALLED_COMMIT,
          },
        },
        resolution: {
          status: "modified",
          commit: REMOTE_COMMIT,
        },
        workspaceDir,
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );

      const result = yield* manager.install({
        repositoryUrl: "https://github.com/example/daily-tools",
      });

      expect(result).toMatchObject({ status: "completed", packageName });
      expect(harness.managed()).toMatchObject({
        directory: "author-daily-tools-3",
        name: packageName,
      });
      expect(
        yield* Effect.promise(() =>
          fs.readFile(
            join(workspaceDir, "packages", "author-daily-tools-3", "index.js"),
            "utf8",
          ),
        ),
      ).toBe("module.exports = 'installed';");
    }),
  );

  it.effect("removes a package from its saved folder", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeDirectory);
      const workspaceDir = join(root, "workspace");
      const directory = "custom-example-folder";
      const packageRoot = join(workspaceDir, "packages", directory);
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(packageRoot, "package.json"),
            JSON.stringify({ name: PACKAGE_NAME }),
          ),
          write(join(packageRoot, "index.js"), "module.exports = true;"),
        ]),
      );
      const harness = makeManagerHarness({
        managed: {
          directory,
          files: {},
          installedAt: "2026-08-01T00:00:00.000Z",
          name: PACKAGE_NAME,
          source: {
            kind: "repository",
            repositoryUrl: "https://github.com/example/package",
            resolvedCommit: INSTALLED_COMMIT,
          },
        },
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );

      const result = yield* manager.remove({ packageName: PACKAGE_NAME });

      expect(result.status).toBe("completed");
      expect(
        yield* Effect.promise(() =>
          fs.access(packageRoot).then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
    }),
  );
});

describe("script package updates", () => {
  it.effect(
    "does not download when the remote commit is already installed",
    () =>
      Effect.gen(function* () {
        const harness = makeManagerHarness({
          managed: {
            directory: PACKAGE_NAME,
            etag: "stale-etag-without-a-commit",
            files: {},
            installedAt: "2026-07-27T00:00:00.000Z",
            name: PACKAGE_NAME,
            source: {
              kind: "repository",
              repositoryUrl: "https://github.com/example/package",
              resolvedCommit: INSTALLED_COMMIT,
            },
          },
          resolution: {
            status: "modified",
            commit: INSTALLED_COMMIT,
            etag: "current-etag",
          },
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );

        const result = yield* manager.update({ packageName: PACKAGE_NAME });

        expect(result.status).toBe("unchanged");
        expect(harness.downloadCount()).toBe(0);
        expect(harness.requests[0]?.etag).toBeUndefined();
        expect(harness.managed()).toMatchObject({
          etag: "current-etag",
          remoteRevision: { kind: "commit", sha: INSTALLED_COMMIT },
          update: { status: "current" },
        });
      }),
  );

  it.effect(
    "reinstalls the current commit when restoring local modifications",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeDirectory);
        const workspaceDir = join(root, "workspace");
        const sourceRoot = join(root, "source");
        const source = join(sourceRoot, "repository-commit");
        const directory = "custom-example-folder";
        const destination = join(workspaceDir, "packages", directory);
        yield* Effect.promise(() =>
          Promise.all([
            write(
              join(source, "package.json"),
              JSON.stringify({ name: PACKAGE_NAME }),
            ),
            write(join(source, "index.js"), "module.exports = 'remote';"),
            write(
              join(destination, "package.json"),
              JSON.stringify({ name: PACKAGE_NAME }),
            ),
            write(
              join(destination, "index.js"),
              "module.exports = 'locally modified';",
            ),
          ]),
        );
        const archivePath = join(root, "package.tgz");
        yield* Effect.promise(() =>
          createTar({ cwd: sourceRoot, file: archivePath, gzip: true }, [
            "repository-commit",
          ]),
        );
        const harness = makeManagerHarness({
          archivePath,
          integrity: "modified",
          managed: {
            directory,
            etag: "current-etag",
            files: {},
            installedAt: "2026-07-27T00:00:00.000Z",
            name: PACKAGE_NAME,
            remoteRevision: { kind: "commit", sha: INSTALLED_COMMIT },
            source: {
              kind: "repository",
              repositoryUrl: "https://github.com/example/package",
              resolvedCommit: INSTALLED_COMMIT,
            },
          },
          resolution: {
            status: "modified",
            commit: INSTALLED_COMMIT,
            etag: "current-etag",
          },
          workspaceDir,
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );

        const confirmation = yield* manager.update({
          packageName: PACKAGE_NAME,
        });
        expect(confirmation).toMatchObject({
          status: "confirmation-required",
          reason: "local-modifications",
        });

        const result = yield* manager.update({
          packageName: PACKAGE_NAME,
          replaceModified: true,
        });

        expect(result.status).toBe("completed");
        expect(harness.downloadCount()).toBe(1);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe("module.exports = 'remote';");
      }),
  );

  it.effect("keeps an observed update available after a 304 response", () =>
    Effect.gen(function* () {
      const harness = makeManagerHarness({
        managed: {
          directory: PACKAGE_NAME,
          etag: "remote-etag",
          files: {},
          installedAt: "2026-07-27T00:00:00.000Z",
          name: PACKAGE_NAME,
          remoteRevision: { kind: "commit", sha: REMOTE_COMMIT },
          source: {
            kind: "repository",
            repositoryUrl: "https://github.com/example/package",
            resolvedCommit: INSTALLED_COMMIT,
          },
          update: {
            status: "available",
            checkedAt: "2026-08-01T00:00:00.000Z",
            revision: { kind: "commit", sha: REMOTE_COMMIT },
          },
        },
        resolution: { status: "not-modified" },
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );

      const catalog = yield* manager.checkUpdate({ packageName: PACKAGE_NAME });

      expect(harness.requests[0]?.etag).toBe("remote-etag");
      expect(harness.managed()).toMatchObject({
        etag: "remote-etag",
        remoteRevision: { kind: "commit", sha: REMOTE_COMMIT },
        update: {
          status: "available",
          revision: { kind: "commit", sha: REMOTE_COMMIT },
        },
      });
      expect(catalog.packages[0]).toMatchObject({
        update: {
          status: "available",
          revision: { kind: "commit", sha: REMOTE_COMMIT },
        },
      });
    }),
  );

  it.effect(
    "checks a bundled package directory without a previously resolved commit",
    () =>
      Effect.gen(function* () {
        const harness = makeManagerHarness({
          directoryTree: REMOTE_TREE,
          managed: {
            directory: PACKAGE_NAME,
            files: {},
            installedAt: "2026-08-01T00:00:00.000Z",
            name: PACKAGE_NAME,
            source: {
              kind: "directory",
              repositoryUrl: "https://github.com/example/monorepo",
              requestedRef: "main",
              resolvedTree: INSTALLED_TREE,
              subdirectory: PACKAGE_SUBDIRECTORY,
            },
          },
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );

        const catalog = yield* manager.checkUpdate({
          packageName: PACKAGE_NAME,
        });

        expect(harness.requests).toHaveLength(0);
        expect(harness.directoryRequests).toEqual([
          expect.objectContaining({
            ref: "main",
            subdirectory: PACKAGE_SUBDIRECTORY,
          }),
        ]);
        expect(harness.managed()).toMatchObject({
          remoteRevision: { kind: "tree", sha: REMOTE_TREE },
          update: {
            status: "available",
            revision: { kind: "tree", sha: REMOTE_TREE },
          },
        });
        expect(catalog.packages[0]).toMatchObject({
          update: {
            status: "available",
            revision: { kind: "tree", sha: REMOTE_TREE },
          },
        });
      }),
  );

  it.effect("updates from the selected package directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeDirectory);
      const workspaceDir = join(root, "workspace");
      const sourceRoot = join(root, "source");
      const repository = join(sourceRoot, "repository-commit");
      const destination = join(workspaceDir, "packages", PACKAGE_NAME);
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(repository, PACKAGE_SUBDIRECTORY, "package.json"),
            JSON.stringify({ name: PACKAGE_NAME }),
          ),
          write(
            join(repository, PACKAGE_SUBDIRECTORY, "index.js"),
            "module.exports = 'updated';",
          ),
          write(join(repository, "README.md"), "not installed"),
          write(
            join(destination, "package.json"),
            JSON.stringify({ name: PACKAGE_NAME }),
          ),
          write(join(destination, "index.js"), "module.exports = 'old';"),
        ]),
      );
      const archivePath = join(root, "package.tgz");
      yield* Effect.promise(() =>
        createTar({ cwd: sourceRoot, file: archivePath, gzip: true }, [
          "repository-commit",
        ]),
      );
      const harness = makeManagerHarness({
        archivePath,
        directoryTree: REMOTE_TREE,
        managed: {
          directory: PACKAGE_NAME,
          files: {},
          installedAt: "2026-08-01T00:00:00.000Z",
          name: PACKAGE_NAME,
          source: {
            kind: "directory",
            repositoryUrl: "https://github.com/example/monorepo",
            requestedRef: "main",
            resolvedTree: INSTALLED_TREE,
            subdirectory: PACKAGE_SUBDIRECTORY,
          },
        },
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );

      const result = yield* manager.update({ packageName: PACKAGE_NAME });

      expect(result.status).toBe("completed");
      expect(harness.downloadCount()).toBe(1);
      expect(harness.requests).toEqual([
        expect.objectContaining({ ref: "main" }),
      ]);
      expect(harness.directoryRequests).toEqual([
        expect.objectContaining({
          ref: REMOTE_COMMIT,
          subdirectory: PACKAGE_SUBDIRECTORY,
        }),
      ]);
      expect(harness.managed()).toMatchObject({
        remoteRevision: { kind: "tree", sha: REMOTE_TREE },
        source: {
          kind: "directory",
          resolvedCommit: REMOTE_COMMIT,
          resolvedTree: REMOTE_TREE,
          subdirectory: PACKAGE_SUBDIRECTORY,
        },
        update: { status: "current" },
      });
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe("module.exports = 'updated';");
      expect(
        yield* Effect.promise(() =>
          fs.access(join(destination, "README.md")).then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
    }),
  );
});

describe("script package replacement failures", () => {
  const OLD_SOURCE = "module.exports = 'old';";
  const NEW_SOURCE = "module.exports = 'new';";

  const installedPackage = Effect.promise(async () => {
    const root = await makeDirectory();
    const workspaceDir = join(root, "workspace");
    const repository = join(root, "source", "repository-commit");
    const destination = join(workspaceDir, "packages", PACKAGE_NAME);
    await Promise.all([
      write(
        join(repository, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME }),
      ),
      write(join(repository, "index.js"), NEW_SOURCE),
      write(
        join(destination, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME }),
      ),
      write(join(destination, "index.js"), OLD_SOURCE),
    ]);
    const archivePath = join(root, "package.tgz");
    await createTar(
      { cwd: join(root, "source"), file: archivePath, gzip: true },
      ["repository-commit"],
    );
    const managed: ManagedScriptPackage = {
      directory: PACKAGE_NAME,
      files: await hashDirectory(destination),
      installedAt: "2026-08-01T00:00:00.000Z",
      name: PACKAGE_NAME,
      source: {
        kind: "repository",
        repositoryUrl: "https://github.com/example/package",
        resolvedCommit: INSTALLED_COMMIT,
      },
    };
    return { archivePath, destination, managed, workspaceDir };
  });

  it.effect(
    "keeps the previous package when moving it aside fails after the move",
    () =>
      Effect.gen(function* () {
        const { archivePath, destination, managed, workspaceDir } =
          yield* installedPackage;
        const harness = makeManagerHarness({
          archivePath,
          managed,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
          workspaceDir,
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation((from, to) =>
          rename(from, to).then(() => {
            if (resolve(String(from)) === destination) {
              throw Object.assign(new Error("EIO: input/output error"), {
                code: "EIO",
              });
            }
          }),
        );

        const failure = yield* manager
          .update({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);

        expect(failure.message).toBe(
          "Failed to replace the package directory.",
        );
        expect(
          yield* Effect.promise(() => findFiles(workspaceDir, OLD_SOURCE)),
        ).toHaveLength(1);
      }),
  );

  it.effect(
    "keeps the previous package when replacement and restoration fail",
    () =>
      Effect.gen(function* () {
        const { archivePath, destination, managed, workspaceDir } =
          yield* installedPackage;
        const harness = makeManagerHarness({
          archivePath,
          managed,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
          workspaceDir,
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );
        refuseRenamesInto(destination);

        const failure = yield* manager
          .update({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);

        const copies = yield* Effect.promise(() =>
          findFiles(workspaceDir, OLD_SOURCE),
        );
        expect(copies).toHaveLength(1);
        expect(failure.message).toBe(
          `Failed to replace the package directory and could not restore the previous package. The previous package is saved at ${dirname(copies[0] ?? "")}.`,
        );
      }),
  );

  it.effect(
    "keeps the previous package when saving state and restoration fail",
    () =>
      Effect.gen(function* () {
        const { archivePath, destination, managed, workspaceDir } =
          yield* installedPackage;
        let saveFailed = false;
        const harness = makeManagerHarness({
          archivePath,
          onSave: (value) =>
            value.source.resolvedCommit === REMOTE_COMMIT
              ? Effect.sync(() => {
                  saveFailed = true;
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ScriptPackageStateError({
                        operation: "save",
                        cause: new Error("Disk full."),
                      }),
                    ),
                  ),
                )
              : Effect.void,
          managed,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
          workspaceDir,
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );
        refuseRenamesInto(destination, () => saveFailed);

        const failure = yield* manager
          .update({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);

        const copies = yield* Effect.promise(() =>
          findFiles(workspaceDir, OLD_SOURCE),
        );
        expect(copies).toHaveLength(1);
        expect(failure.message).toBe(
          `Package state failed and the previous package could not be restored. The previous package is saved at ${dirname(copies[0] ?? "")}.`,
        );
      }),
  );

  it.effect(
    "names the new package folder when a fresh install cannot undo a failed save",
    () =>
      Effect.gen(function* () {
        const { archivePath, destination, workspaceDir } =
          yield* installedPackage;
        yield* Effect.promise(() =>
          fs.rm(destination, { recursive: true, force: true }),
        );
        const harness = makeManagerHarness({
          archivePath,
          onSave: () =>
            Effect.fail(
              new ScriptPackageStateError({
                operation: "save",
                cause: new Error("Disk full."),
              }),
            ),
          resolution: { status: "modified", commit: REMOTE_COMMIT },
          workspaceDir,
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation((from, to) =>
          resolve(String(from)) === destination
            ? Promise.reject(
                Object.assign(new Error("EPERM: operation not permitted"), {
                  code: "EPERM",
                }),
              )
            : rename(from, to),
        );

        const failure = yield* manager
          .install({ repositoryUrl: "https://github.com/example/package" })
          .pipe(Effect.flip);

        expect(failure.message).toBe(
          `Failed to save package installation state. The new package was left at ${destination}.`,
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(NEW_SOURCE);
      }),
  );

  it.effect(
    "restores the previous package and removes its backup when replacement fails",
    () =>
      Effect.gen(function* () {
        const { archivePath, destination, managed, workspaceDir } =
          yield* installedPackage;
        const harness = makeManagerHarness({
          archivePath,
          managed,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
          workspaceDir,
        });
        const manager = yield* ScriptPackageManager.pipe(
          Effect.provide(harness.layer),
        );
        let replacementAttempts = 0;
        refuseRenamesInto(destination, () => ++replacementAttempts === 1);

        const failure = yield* manager
          .update({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);

        expect(failure.message).toBe(
          "Failed to replace the package directory; the previous package was restored.",
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
        expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
          "packages",
        ]);
      }),
  );

  it.effect("finishes an interrupted swap before cleaning up staging", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      const swapping = yield* Deferred.make<void>();
      const cleaningStaging = yield* Deferred.make<void>();
      const finishSwap = Promise.withResolvers<void>();
      let stagingCleanup: Promise<void> | undefined;
      const harness = makeManagerHarness({
        archivePath,
        managed,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation((from, to) => {
        if (resolve(String(to)) === destination) {
          Deferred.doneUnsafe(swapping, Effect.void);
          return finishSwap.promise
            .then(() => stagingCleanup)
            .then(() => rename(from, to));
        }
        return rename(from, to);
      });
      const rm = fs.rm;
      vi.spyOn(fs, "rm").mockImplementation((path, options) => {
        const removing = rm(path, options);
        if (
          String(path).startsWith(
            join(workspaceDir, ".lucent-package-install-"),
          )
        ) {
          stagingCleanup = removing;
          Deferred.doneUnsafe(cleaningStaging, Effect.void);
        }
        return removing;
      });

      const updating = yield* manager
        .update({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(swapping);
      const interrupting = yield* Fiber.interrupt(updating).pipe(
        Effect.forkScoped,
      );
      yield* Effect.raceFirst(
        Deferred.await(cleaningStaging),
        Effect.promise(() => setTimeout(100)),
      );
      finishSwap.resolve();
      yield* Fiber.join(interrupting);

      const installed = yield* Effect.promise(() =>
        fs.readFile(join(destination, "index.js"), "utf8").catch(() => null),
      );
      expect({
        commit: harness.managed()?.source.resolvedCommit,
        installed,
      }).toEqual({ commit: REMOTE_COMMIT, installed: NEW_SOURCE });
      expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
        "packages",
      ]);
    }),
  );

  it.effect("finishes an interrupted replacement before cleaning up", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      const saving = yield* Deferred.make<void>();
      const saveInterrupted = yield* Deferred.make<void>();
      const finishSave = yield* Deferred.make<void>();
      const harness = makeManagerHarness({
        archivePath,
        managed,
        onSave: (value) =>
          value.source.resolvedCommit === REMOTE_COMMIT
            ? Deferred.succeed(saving, undefined).pipe(
                Effect.andThen(Deferred.await(finishSave)),
                Effect.onInterrupt(() =>
                  Deferred.succeed(saveInterrupted, undefined),
                ),
              )
            : Effect.void,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );

      const updating = yield* manager
        .update({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(saving);
      const interrupting = yield* Fiber.interrupt(updating).pipe(
        Effect.forkScoped,
      );
      yield* Effect.raceFirst(
        Deferred.await(saveInterrupted),
        Effect.promise(() => setTimeout(100)),
      );
      yield* Deferred.succeed(finishSave, undefined);
      yield* Fiber.join(interrupting);

      expect({
        commit: harness.managed()?.source.resolvedCommit,
        installed: yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      }).toEqual({ commit: REMOTE_COMMIT, installed: NEW_SOURCE });
      expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
        "packages",
      ]);
    }),
  );
});
