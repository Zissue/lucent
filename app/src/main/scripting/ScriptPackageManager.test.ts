import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { FileSystem } from "effect/FileSystem";
import { create as createTar } from "tar";

import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { nativeFileError } from "../filesystem/BoundedFileSystem";
import { layer as desktopObservabilityLayer } from "../app/observability/DesktopObservability";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../shared/logRecord";
import { initializeBundledScriptPackages } from "./BundledScriptPackages";
import { ElectronApp } from "../electron/ElectronApp";
import {
  GitHubScriptPackageClient,
  GitHubScriptPackageClientError,
  type GitHubCommitResolution,
  type GitHubScriptPackageClientShape,
} from "./GitHubScriptPackageClient";
import {
  layer as scriptPackageCatalogLayer,
  ScriptPackageCatalog,
  ScriptPackageCatalogError,
} from "./ScriptPackageCatalog";
import { scriptPackageDirectorySlug } from "./ScriptPackageDirectories";
import { hashDirectory } from "./ScriptPackageFileSystem";
import {
  layer as scriptPackageManagerLayer,
  ScriptPackageManager,
} from "./ScriptPackageManager";
import {
  layer as scriptPackageStateLayer,
  ScriptPackageState,
  ScriptPackageStateError,
  type ManagedScriptPackage,
} from "./ScriptPackageState";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: {}, ipcMain: new EventEmitter() };
});

const directories: string[] = [];
const INSTALLED_COMMIT = "1".repeat(40);
const REMOTE_COMMIT = "2".repeat(40);
const INSTALLED_TREE = "3".repeat(40);
const REMOTE_TREE = "4".repeat(40);
const PACKAGE_NAME = "example";
const PACKAGE_SUBDIRECTORY = "packages/example";

const packageFileSystemLayer = Layer.effect(
  FileSystem,
  Effect.map(FileSystem, (fileSystem) => ({
    ...fileSystem,
    makeTempDirectory: (options) => {
      const prefix = join(
        options?.directory ?? tmpdir(),
        options?.prefix ?? "",
      );
      return Effect.tryPromise({
        try: () => fs.mkdtemp(prefix),
        catch: (cause) => nativeFileError("makeTempDirectory", prefix, cause),
      });
    },
    rename: (from, to) =>
      Effect.tryPromise({
        try: () => fs.rename(from, to),
        catch: (cause) => nativeFileError("rename", from, cause),
      }),
    remove: (path, options) =>
      Effect.tryPromise({
        try: () => fs.rm(path, options),
        catch: (cause) => nativeFileError("remove", path, cause),
      }),
  })),
).pipe(Layer.provide(desktopFileSystemLayer));

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
  readonly assetsDir?: string;
  readonly archivePath?: string | ((ref: string | undefined) => string);
  readonly downloadError?: GitHubScriptPackageClientError;
  readonly directoryTree?: string | Effect.Effect<string>;
  readonly onRemove?: (
    name: string,
  ) => Effect.Effect<void, ScriptPackageStateError>;
  readonly onSave?: (
    value: ManagedScriptPackage,
  ) => Effect.Effect<void, ScriptPackageStateError>;
  readonly managed?: ManagedScriptPackage;
  readonly onDownload?: () => Promise<void>;
  readonly resolution:
    | GitHubCommitResolution
    | Effect.Effect<GitHubCommitResolution, GitHubScriptPackageClientError>;
  readonly workspaceDir: string;
}) => {
  let downloadCount = 0;
  const archiveRequests: Parameters<
    GitHubScriptPackageClientShape["downloadArchive"]
  >[0][] = [];
  const requests: Parameters<
    GitHubScriptPackageClientShape["resolveCommit"]
  >[0][] = [];
  const directoryRequests: Parameters<
    GitHubScriptPackageClientShape["resolveDirectory"]
  >[0][] = [];

  const client = GitHubScriptPackageClient.of({
    downloadArchive: (request) =>
      options.downloadError !== undefined
        ? Effect.fail(options.downloadError)
        : Effect.promise(async () => {
            const { ref, targetPath } = request;
            archiveRequests.push(request);
            downloadCount += 1;
            if (options.archivePath !== undefined) {
              await fs.copyFile(
                typeof options.archivePath === "string"
                  ? options.archivePath
                  : options.archivePath(ref),
                targetPath,
              );
            }
            await options.onDownload?.();
          }),
    resolveCommit: (input) =>
      Effect.suspend(() => {
        requests.push(input);
        return Effect.isEffect(options.resolution)
          ? options.resolution
          : Effect.succeed(options.resolution);
      }),
    resolveDirectory: (input) =>
      Effect.suspend(() => {
        directoryRequests.push(input);
        const tree = options.directoryTree ?? REMOTE_TREE;
        return Effect.map(
          Effect.isEffect(tree) ? tree : Effect.succeed(tree),
          (sha) => ({ tree: sha }),
        );
      }),
  });
  const environment = DesktopEnvironment.of({
    appDataDir: join(dirname(options.workspaceDir), "app-data"),
    assetsDir: options.assetsDir ?? "/tmp/lucent-package-manager-assets",
    isDev: true,
    platform: "darwin",
    workspaceDir: options.workspaceDir,
  });
  const environmentLayer = Layer.succeed(DesktopEnvironment, environment);
  const stateLayer = Layer.effect(
    ScriptPackageState,
    Effect.gen(function* () {
      const state = yield* ScriptPackageState;
      if (options.managed !== undefined) yield* state.save(options.managed);
      return ScriptPackageState.of({
        ...state,
        remove: Effect.fnUntraced(function* (name) {
          yield* options.onRemove?.(name) ?? Effect.void;
          yield* state.remove(name);
        }),
        save: Effect.fnUntraced(function* (value) {
          yield* options.onSave?.(value) ?? Effect.void;
          yield* state.save(value);
        }),
      });
    }),
  ).pipe(
    Layer.provide(
      scriptPackageStateLayer.pipe(
        Layer.provide(Layer.mergeAll(environmentLayer, desktopFileSystemLayer)),
      ),
    ),
  );
  const catalogLayer = scriptPackageCatalogLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environmentLayer,
        desktopFileSystemLayer,
        stateLayer,
        Layer.succeed(
          ElectronApp,
          ElectronApp.of({
            exit: () => Effect.void,
            getAppMetrics: Effect.succeed([]),
            getVersion: Effect.succeed("1.0.0"),
            on: () => Effect.void,
            relaunch: Effect.void,
            quit: Effect.void,
            whenReady: Effect.void,
          }),
        ),
      ),
    ),
  );
  const layer = scriptPackageManagerLayer.pipe(
    Layer.provide(packageFileSystemLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        environmentLayer,
        Layer.succeed(GitHubScriptPackageClient, client),
        catalogLayer,
        stateLayer,
      ),
    ),
  );

  return {
    archiveRequests,
    downloadCount: () => downloadCount,
    directoryRequests,
    layer,
    requests,
    services: Effect.all({
      manager: ScriptPackageManager,
      catalog: ScriptPackageCatalog,
      state: ScriptPackageState,
    }).pipe(Effect.provide(layer)),
  };
};

const seededBundledPackage = Effect.gen(function* () {
  const root = yield* Effect.promise(makeDirectory);
  const workspaceDir = join(root, "workspace");
  const assetsDir = join(root, "assets");
  const source = join(root, "script-packages", "example-bundle");
  yield* Effect.promise(() =>
    Promise.all([
      write(join(source, "package.json"), '{"name":"example"}'),
      write(join(source, "index.js"), OLD_SOURCE),
    ]),
  );
  const harness = makeManagerHarness({
    assetsDir,
    workspaceDir,
    resolution: { status: "modified", commit: REMOTE_COMMIT },
  });
  yield* initializeBundledScriptPackages.pipe(
    Effect.provide(harness.layer),
    Effect.provide(desktopFileSystemLayer),
  );
  const services = yield* harness.services;
  const managed = yield* services.state.get(PACKAGE_NAME);
  if (managed === undefined)
    throw new Error("Bundled setup did not install example.");
  return {
    ...services,
    harness,
    source,
    managed,
    destination: join(workspaceDir, "packages", managed.directory),
  };
});

const interruptDuringSwap = <A, E>(
  destination: string,
  workspaceDir: string,
  operation: Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const swapping = yield* Deferred.make<void>();
    const cleaningStaging = yield* Deferred.make<void>();
    const finishSwap = Promise.withResolvers<void>();
    let stagingCleanup: Promise<void> | undefined;
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
        String(path).startsWith(join(workspaceDir, ".lucent-package-install-"))
      ) {
        stagingCleanup = removing;
        Deferred.doneUnsafe(cleaningStaging, Effect.void);
      }
      return removing;
    });

    const running = yield* operation.pipe(Effect.forkScoped);
    yield* Deferred.await(swapping);
    const interrupting = yield* Fiber.interrupt(running).pipe(
      Effect.forkScoped,
    );
    yield* Effect.raceFirst(
      Deferred.await(cleaningStaging),
      Effect.promise(() => setTimeout(100)),
    );
    finishSwap.resolve();
    yield* Fiber.join(interrupting);
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

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

describe("script package folders", () => {
  it.effect(
    "removes staging when interrupted immediately after its creation",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeDirectory);
        const workspaceDir = join(root, "workspace");
        const harness = makeManagerHarness({
          workspaceDir,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager } = yield* harness.services;
        const created = yield* Deferred.make<string>();
        const resume = Promise.withResolvers<void>();
        const mkdtemp = fs.mkdtemp;
        vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
          const path = await mkdtemp(...args);
          Deferred.doneUnsafe(created, Effect.succeed(String(path)));
          await resume.promise;
          return path;
        });
        const installing = yield* manager
          .install({
            repositoryUrl: "https://github.com/example/package",
          })
          .pipe(Effect.forkScoped);
        const staging = yield* Deferred.await(created);
        expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toContain(
          staging.slice(workspaceDir.length + 1),
        );
        const stopping = yield* Fiber.interrupt(installing).pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        resume.resolve();
        yield* Fiber.join(stopping);
        expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
          "packages",
        ]);
        expect(harness.downloadCount()).toBe(0);
      }).pipe(Effect.scoped),
  );

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
      yield* TestClock.setTime(1234567890000);
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
      const { manager, state } = yield* harness.services;

      const result = yield* manager.install({
        repositoryUrl: "https://github.com/example/daily-tools",
      });

      expect(result).toMatchObject({ status: "completed", packageName });
      expect(yield* state.get(packageName)).toMatchObject({
        directory: "author-daily-tools-3",
        installedAt: "2009-02-13T23:31:30.000Z",
        update: { checkedAt: "2009-02-13T23:31:30.000Z" },
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
          files: yield* Effect.promise(() => hashDirectory(packageRoot)),
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

      expect(result).toMatchObject({
        status: "completed",
        catalog: { packages: [], scriptCount: 0 },
      });
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
        const { managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed: {
            ...managed,
            etag: "stale-etag-without-a-commit",
          },
          resolution: {
            status: "modified",
            commit: INSTALLED_COMMIT,
            etag: "current-etag",
          },
          workspaceDir,
        });
        const { manager, state } = yield* harness.services;

        const result = yield* manager.update({ packageName: PACKAGE_NAME });

        expect(result.status).toBe("unchanged");
        expect(harness.downloadCount()).toBe(0);
        expect(harness.requests[0]?.etag).toBeUndefined();
        expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
          etag: "current-etag",
          remoteRevision: { kind: "commit", sha: INSTALLED_COMMIT },
          update: { status: "current" },
        });
      }),
  );

  it.effect(
    "clears a stale modified row when restore finds the files unchanged",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        yield* Effect.promise(() =>
          write(join(destination, "index.js"), NEW_SOURCE),
        );
        const harness = makeManagerHarness({
          managed,
          resolution: { status: "modified", commit: INSTALLED_COMMIT },
          workspaceDir,
        });
        const { manager, catalog } = yield* harness.services;
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          integrity: "modified",
        });
        yield* Effect.promise(() =>
          write(join(destination, "index.js"), OLD_SOURCE),
        );

        const result = yield* manager.update({
          packageName: PACKAGE_NAME,
          replaceModified: true,
        });

        expect(result.status).toBe("unchanged");
        expect(result).toMatchObject({
          catalog: { packages: [{ integrity: "verified" }] },
        });
        expect(harness.downloadCount()).toBe(0);
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
      const { workspaceDir } = yield* installedPackage;
      const harness = makeManagerHarness({
        workspaceDir,
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
      const { manager, state } = yield* harness.services;

      const catalog = yield* manager.checkUpdate({ packageName: PACKAGE_NAME });

      expect(harness.requests[0]?.etag).toBe("remote-etag");
      expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
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
        const { workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          workspaceDir,
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
        const { manager, state } = yield* harness.services;

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
        expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
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
          files: yield* Effect.promise(() => hashDirectory(destination)),
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
      const { manager, state } = yield* harness.services;

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
      expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
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

        const copies = yield* Effect.promise(() =>
          findFiles(workspaceDir, OLD_SOURCE),
        );
        expect(failure.message).toBe(
          `Failed to replace the package directory. The previous package is saved at ${dirname(copies[0] ?? "")}.`,
        );
        expect(copies).toHaveLength(1);
        expect(
          yield* Effect.promise(() => hashDirectory(dirname(copies[0] ?? ""))),
        ).toEqual(managed.files);
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
        expect(
          yield* Effect.promise(() => hashDirectory(dirname(copies[0] ?? ""))),
        ).toEqual(managed.files);
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
        expect(
          yield* Effect.promise(() => hashDirectory(dirname(copies[0] ?? ""))),
        ).toEqual(managed.files);
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
          "scripts",
        ]);
      }),
  );

  it.effect("finishes an interrupted swap before cleaning up staging", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      const harness = makeManagerHarness({
        archivePath,
        managed,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const { manager, state } = yield* harness.services;
      yield* interruptDuringSwap(
        destination,
        workspaceDir,
        manager.update({ packageName: PACKAGE_NAME }),
      );

      const installed = yield* Effect.promise(() =>
        fs.readFile(join(destination, "index.js"), "utf8").catch(() => null),
      );
      expect({
        commit: (yield* state.get(PACKAGE_NAME))?.source.resolvedCommit,
        installed,
      }).toEqual({ commit: REMOTE_COMMIT, installed: NEW_SOURCE });
      expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
        "packages",
        "scripts",
      ]);
    }),
  );

  it.effect("publishes an interrupted update to the catalog", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      const harness = makeManagerHarness({
        archivePath,
        managed,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const { manager, catalog, state } = yield* harness.services;
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        source: { resolvedCommit: INSTALLED_COMMIT },
      });
      yield* interruptDuringSwap(
        destination,
        workspaceDir,
        manager.update({ packageName: PACKAGE_NAME }),
      );

      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "verified",
        source: { resolvedCommit: REMOTE_COMMIT },
      });
      expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
        source: { resolvedCommit: REMOTE_COMMIT },
      });
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(NEW_SOURCE);
    }),
  );

  it.effect("publishes an interrupted fresh install to the catalog", () =>
    Effect.gen(function* () {
      const { archivePath, destination, workspaceDir } =
        yield* installedPackage;
      yield* Effect.promise(() =>
        fs.rm(destination, { recursive: true, force: true }),
      );
      const harness = makeManagerHarness({
        archivePath,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const { manager, catalog } = yield* harness.services;
      yield* interruptDuringSwap(
        destination,
        workspaceDir,
        manager.install({
          repositoryUrl: "https://github.com/example/package",
        }),
      );

      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        source: { resolvedCommit: REMOTE_COMMIT },
      });
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(NEW_SOURCE);
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
      const { manager, state } = yield* harness.services;

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
        commit: (yield* state.get(PACKAGE_NAME))?.source.resolvedCommit,
        installed: yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      }).toEqual({ commit: REMOTE_COMMIT, installed: NEW_SOURCE });
      expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
        "packages",
        "scripts",
      ]);
    }),
  );
});

describe("script package local modifications", () => {
  const EDITED_SOURCE = "module.exports = 'edited';";
  const localModifications = {
    status: "confirmation-required",
    packageName: PACKAGE_NAME,
    reason: "local-modifications",
  };
  const editBeforeMovingOut = (destination: string) => {
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation((from, to) =>
      resolve(String(from)) === destination
        ? fs
            .writeFile(join(destination, "index.js"), EDITED_SOURCE)
            .then(() => rename(from, to))
        : rename(from, to),
    );
  };

  it.effect("asks before updating files edited after the catalog scan", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      yield* Effect.promise(() =>
        write(join(destination, "index.js"), EDITED_SOURCE),
      );
      const harness = makeManagerHarness({
        archivePath,
        managed,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );

      const result = yield* manager.update({ packageName: PACKAGE_NAME });

      expect(result).toEqual(localModifications);
      expect(harness.downloadCount()).toBe(0);
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(EDITED_SOURCE);
    }),
  );

  it.effect("asks before replacing files edited during the download", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      const harness = makeManagerHarness({
        archivePath,
        managed,
        onDownload: () => write(join(destination, "index.js"), EDITED_SOURCE),
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const { manager, catalog } = yield* harness.services;
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "verified",
      });

      const result = yield* manager.update({ packageName: PACKAGE_NAME });

      expect(result).toEqual(localModifications);
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(EDITED_SOURCE);
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "modified",
      });
    }),
  );

  it.effect("asks before replacing files edited just before the move", () =>
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
      editBeforeMovingOut(destination);

      const result = yield* manager.update({ packageName: PACKAGE_NAME });

      expect(result).toEqual(localModifications);
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(EDITED_SOURCE);
      expect(
        (yield* Effect.promise(() => fs.readdir(workspaceDir))).filter((name) =>
          name.startsWith(".lucent-package-backup-"),
        ),
      ).toEqual([]);
    }),
  );

  it.effect("asks before removing files edited just before the move", () =>
    Effect.gen(function* () {
      const { destination, managed, workspaceDir } = yield* installedPackage;
      const harness = makeManagerHarness({
        managed,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const manager = yield* ScriptPackageManager.pipe(
        Effect.provide(harness.layer),
      );
      editBeforeMovingOut(destination);

      const result = yield* manager.remove({ packageName: PACKAGE_NAME });

      expect(result).toEqual(localModifications);
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(EDITED_SOURCE);
      expect(
        (yield* Effect.promise(() => fs.readdir(workspaceDir))).filter((name) =>
          name.startsWith(".lucent-package-remove-"),
        ),
      ).toEqual([]);
    }),
  );

  it.effect("asks before removing files edited after the catalog scan", () =>
    Effect.gen(function* () {
      const { destination, managed, workspaceDir } = yield* installedPackage;
      const harness = makeManagerHarness({
        managed,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        workspaceDir,
      });
      const { manager, catalog } = yield* harness.services;
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "verified",
      });
      yield* Effect.promise(() =>
        write(join(destination, "index.js"), EDITED_SOURCE),
      );

      const result = yield* manager.remove({ packageName: PACKAGE_NAME });

      expect(result).toEqual(localModifications);
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(EDITED_SOURCE);
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "modified",
      });
    }),
  );
});

describe("script package update check races", () => {
  it.effect.each(["update", "remove"] as const)(
    "logs inspection and fallback scan failures once during %s",
    (operation) =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          resolution: { status: "modified", commit: INSTALLED_COMMIT },
          workspaceDir,
        });
        const { manager, catalog } = yield* harness.services;
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          name: "example",
          integrity: "verified",
        });
        const readdir = fs.readdir;
        vi.spyOn(fs, "readdir").mockImplementation((path, options) =>
          String(path) === destination ||
          String(path).includes(".lucent-package-remove-")
            ? Promise.reject(
                Object.assign(new Error("EACCES"), { code: "EACCES" }),
              )
            : readdir(path, options),
        );
        const logs: DesktopLogRecord[] = [];
        const result = yield* manager[operation]({
          packageName: "example",
        }).pipe(
          Effect.withLogger(
            Logger.make((options) => logs.push(desktopLogRecord(options))),
          ),
        );
        expect(result).toEqual({
          status: "confirmation-required",
          packageName: "example",
          reason: "local-modifications",
        });
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          status: "invalid",
          name: "example",
          diagnostic: "EACCES",
        });
        expect(
          logs.map(({ level, component, message, repeatKey, data }) => ({
            level,
            component,
            message,
            repeatKey,
            data,
          })),
        ).toEqual([
          {
            level: "warn",
            component: "script-packages",
            message: "Failed to inspect script package files",
            repeatKey: "example",
            data: { packageNames: ["example"] },
          },
        ]);
        expect(logs[0]?.error).toEqual([
          expect.objectContaining({ name: "Error", message: "EACCES" }),
        ]);
      }),
  );

  it.effect.each([
    { operation: "update", warmed: true },
    { operation: "update", warmed: false },
    { operation: "remove", warmed: true },
    { operation: "remove", warmed: false },
  ] as const)(
    "logs unexpected integrity failures once during $operation with warmed catalog $warmed",
    ({ operation, warmed }) =>
      Effect.gen(function* () {
        const { managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          resolution: { status: "modified", commit: INSTALLED_COMMIT },
          workspaceDir,
        });
        const { manager, catalog } = yield* harness.services;
        if (warmed) {
          expect((yield* catalog.getOverview).packages[0]).toMatchObject({
            name: "example",
            integrity: "verified",
          });
        }
        const stat = fs.stat;
        vi.spyOn(fs, "stat").mockImplementation(
          (...args: Parameters<typeof fs.stat>) =>
            String(args[0]).endsWith("index.js")
              ? Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }))
              : stat(...args),
        );
        const logs: DesktopLogRecord[] = [];
        const result = yield* manager[operation]({
          packageName: "example",
        }).pipe(
          Effect.withLogger(
            Logger.make((options) => logs.push(desktopLogRecord(options))),
          ),
        );
        expect(result).toEqual({
          status: "confirmation-required",
          packageName: "example",
          reason: "local-modifications",
        });
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          name: "example",
          integrity: "modified",
        });
        expect(
          logs.map(({ level, component, message, repeatKey, data }) => ({
            level,
            component,
            message,
            repeatKey,
            data,
          })),
        ).toEqual([
          {
            level: "warn",
            component: "script-packages",
            message: "Failed to inspect script package files",
            repeatKey: "example",
            data: { packageNames: ["example"] },
          },
        ]);
        expect(logs[0]?.error).toEqual([
          expect.objectContaining({ name: "Error", message: "EIO" }),
        ]);
      }),
  );

  it.effect.each(["update", "remove"] as const)(
    "keeps missing tracked files silent during %s",
    (operation) =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          resolution: { status: "modified", commit: INSTALLED_COMMIT },
          workspaceDir,
        });
        const { manager, catalog } = yield* harness.services;
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          name: "example",
          integrity: "verified",
        });
        yield* Effect.promise(() => fs.unlink(join(destination, "index.js")));
        const logs: DesktopLogRecord[] = [];
        const result = yield* manager[operation]({
          packageName: "example",
        }).pipe(
          Effect.withLogger(
            Logger.make((options) => logs.push(desktopLogRecord(options))),
          ),
        );
        expect(result).toEqual({
          status: "confirmation-required",
          packageName: "example",
          reason: "local-modifications",
        });
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          name: "example",
          integrity: "modified",
        });
        expect(logs).toEqual([]);
      }),
  );

  it.effect(
    "logs recovered update-check failures with safe package context",
    () =>
      Effect.gen(function* () {
        const { managed, workspaceDir } = yield* installedPackage;
        const failure = new GitHubScriptPackageClientError({
          kind: "rate-limited",
          detail: "GitHub's request limit has been reached.",
          retryAt: "2026-10-17T12:00:00.000Z",
        });
        const harness = makeManagerHarness({
          managed,
          resolution: Effect.fail(failure),
          workspaceDir,
        });
        const { manager, state } = yield* harness.services;
        const logs: DesktopLogRecord[] = [];
        const catalog = yield* manager
          .checkUpdate({ packageName: "example" })
          .pipe(
            Effect.withLogger(
              Logger.make((options) => logs.push(desktopLogRecord(options))),
            ),
          );
        expect(catalog.packages[0]).toMatchObject({
          name: "example",
          update: {
            status: "rate-limited",
            retryAt: "2026-10-17T12:00:00.000Z",
          },
        });
        expect((yield* state.get("example"))?.update).toEqual({
          status: "rate-limited",
          message: "GitHub's request limit has been reached.",
          retryAt: "2026-10-17T12:00:00.000Z",
        });
        expect(
          logs.map(({ level, component, message, repeatKey, data }) => ({
            level,
            component,
            message,
            repeatKey,
            data,
          })),
        ).toEqual([
          {
            level: "warn",
            component: "script-packages",
            message: "Failed to check script package updates",
            repeatKey: "rate-limited",
            data: {
              packageName: "example",
              category: "rate-limited",
              retryAt: "2026-10-17T12:00:00.000Z",
            },
          },
        ]);
        expect(logs[0]?.error).toEqual([
          expect.objectContaining({
            name: "GitHubScriptPackageClientError",
            message: "GitHub's request limit has been reached.",
          }),
        ]);
      }),
  );

  it.effect("keeps successful and interrupted update checks silent", () =>
    Effect.gen(function* () {
      const { managed, workspaceDir } = yield* installedPackage;
      const harness = makeManagerHarness({
        managed,
        resolution: { status: "modified", commit: INSTALLED_COMMIT },
        workspaceDir,
      });
      const { manager } = yield* harness.services;
      const logs: DesktopLogRecord[] = [];
      const logger = Logger.make((options) =>
        logs.push(desktopLogRecord(options)),
      );
      const result = yield* manager
        .checkUpdate({ packageName: "example" })
        .pipe(Effect.withLogger(logger));
      expect(result.packages[0]).toMatchObject({
        name: "example",
        update: { status: "current" },
      });
      const interrupted = makeManagerHarness({
        managed,
        resolution: Effect.interrupt,
        workspaceDir,
      });
      const interruptedManager = yield* ScriptPackageManager.pipe(
        Effect.provide(interrupted.layer),
      );
      const exit = yield* interruptedManager
        .checkUpdate({ packageName: "example" })
        .pipe(Effect.withLogger(logger), Effect.exit);
      expect(exit).toMatchObject({ _tag: "Failure" });
      expect(logs).toEqual([]);
    }),
  );

  it.effect("waits for an in-flight remove before saving a check", () =>
    Effect.gen(function* () {
      const { managed, workspaceDir } = yield* installedPackage;
      const checkStarted = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      const removeStarted = yield* Deferred.make<void>();
      const finishRemove = yield* Deferred.make<void>();
      const harness = makeManagerHarness({
        managed,
        onRemove: () =>
          Deferred.succeed(removeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishRemove)),
          ),
        resolution: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishCheck)),
          Effect.as<GitHubCommitResolution>({
            status: "modified",
            commit: REMOTE_COMMIT,
          }),
        ),
        workspaceDir,
      });
      const { manager, state } = yield* harness.services;

      const checking = yield* manager
        .checkUpdate({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checkStarted);
      const removing = yield* manager
        .remove({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(removeStarted);
      yield* Deferred.succeed(finishCheck, undefined);
      yield* Effect.promise(() => setTimeout(50));
      yield* Deferred.succeed(finishRemove, undefined);
      const removed = yield* Fiber.join(removing);
      const checked = yield* Fiber.join(checking);

      expect(removed.status).toBe("completed");
      expect(checked.packages).toEqual([]);
      expect(yield* state.get(PACKAGE_NAME)).toBeUndefined();
    }),
  );

  it.effect("does not restore a package removed during an update check", () =>
    Effect.gen(function* () {
      const { managed, workspaceDir } = yield* installedPackage;
      const checkStarted = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      const harness = makeManagerHarness({
        managed,
        resolution: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishCheck)),
          Effect.as<GitHubCommitResolution>({
            status: "modified",
            commit: REMOTE_COMMIT,
          }),
        ),
        workspaceDir,
      });
      const { manager, catalog, state } = yield* harness.services;
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "verified",
        source: { resolvedCommit: INSTALLED_COMMIT },
      });

      const checking = yield* manager
        .checkUpdate({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checkStarted);
      const removed = yield* manager.remove({ packageName: PACKAGE_NAME });
      yield* Deferred.succeed(finishCheck, undefined);
      const checked = yield* Fiber.join(checking);

      expect(removed.status).toBe("completed");
      expect(checked.packages).toEqual([]);
      expect(yield* state.get(PACKAGE_NAME)).toBeUndefined();
      expect((yield* catalog.getOverview).packages).toEqual([]);
    }),
  );

  it.effect("keeps a new install when an update check finishes after it", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      const checkStarted = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      let resolveCommitCalls = 0;
      const harness = makeManagerHarness({
        archivePath,
        managed,
        resolution: Effect.suspend(() =>
          resolveCommitCalls++ === 0
            ? Deferred.succeed(checkStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishCheck)),
              )
            : Effect.void,
        ).pipe(
          Effect.as<GitHubCommitResolution>({
            status: "modified",
            commit: REMOTE_COMMIT,
          }),
        ),
        workspaceDir,
      });
      const { manager, catalog, state } = yield* harness.services;
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "verified",
        source: { resolvedCommit: INSTALLED_COMMIT },
      });

      const checking = yield* manager
        .checkUpdate({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checkStarted);
      const updated = yield* manager.update({ packageName: PACKAGE_NAME });
      yield* Deferred.succeed(finishCheck, undefined);
      const checked = yield* Fiber.join(checking);

      expect(updated.status).toBe("completed");
      expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
        files: yield* Effect.promise(() => hashDirectory(destination)),
        source: { resolvedCommit: REMOTE_COMMIT },
        update: { status: "current" },
      });
      expect(checked.packages[0]).toMatchObject({
        source: { resolvedCommit: REMOTE_COMMIT },
        update: { status: "current" },
      });
    }),
  );

  it.effect.each([
    { label: "directory", patch: { directory: "moved" } },
    { label: "files", patch: { files: { "index.js": "edited" } } },
    {
      label: "installedAt",
      patch: { installedAt: "2026-10-17T00:00:00.000Z" },
    },
    { label: "etag", patch: { etag: "changed-etag" } },
    {
      label: "remote revision kind",
      patch: { remoteRevision: { kind: "commit", sha: INSTALLED_TREE } },
    },
    {
      label: "remote revision sha",
      patch: { remoteRevision: { kind: "tree", sha: REMOTE_TREE } },
    },
    {
      label: "repository URL",
      source: { repositoryUrl: "https://github.com/example/other" },
    },
    { label: "requested ref", source: { requestedRef: "next" } },
    { label: "credential", source: { credentialId: "changed-credential" } },
    { label: "resolved commit", source: { resolvedCommit: REMOTE_COMMIT } },
    { label: "resolved tree", source: { resolvedTree: REMOTE_TREE } },
    { label: "subdirectory", source: { subdirectory: "packages/other" } },
    {
      label: "source kind",
      patch: {
        source: {
          kind: "repository",
          repositoryUrl: "https://github.com/example/package",
          resolvedCommit: INSTALLED_COMMIT,
        },
      },
    },
    { label: "update status", patch: { update: { status: "unchecked" } } },
    {
      label: "update checkedAt",
      patch: {
        update: {
          status: "available",
          checkedAt: "2026-10-17T00:00:00.000Z",
          revision: { kind: "tree", sha: INSTALLED_TREE },
        },
      },
    },
    {
      label: "update revision kind",
      patch: {
        update: {
          status: "available",
          checkedAt: "2026-08-01T00:00:00.000Z",
          revision: { kind: "commit", sha: INSTALLED_TREE },
        },
      },
    },
    {
      label: "update revision sha",
      patch: {
        update: {
          status: "available",
          checkedAt: "2026-08-01T00:00:00.000Z",
          revision: { kind: "tree", sha: REMOTE_TREE },
        },
      },
    },
    {
      label: "update message",
      initialUpdate: { status: "unknown", message: "before" },
      patch: { update: { status: "unknown", message: "after" } },
    },
    {
      label: "update retryAt",
      initialUpdate: {
        status: "rate-limited",
        message: "limited",
        retryAt: "2026-08-01T00:00:00.000Z",
      },
      patch: {
        update: {
          status: "rate-limited",
          message: "limited",
          retryAt: "2026-10-17T00:00:00.000Z",
        },
      },
    },
  ] satisfies readonly {
    readonly label: string;
    readonly patch?: Partial<ManagedScriptPackage>;
    readonly source?: Partial<ManagedScriptPackage["source"]>;
    readonly initialUpdate?: ManagedScriptPackage["update"];
  }[])("drops an update check when $label changes", (change) =>
    Effect.gen(function* () {
      const { managed, workspaceDir } = yield* installedPackage;
      const checkStarted = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      const initial: ManagedScriptPackage = {
        ...managed,
        etag: "initial-etag",
        remoteRevision: { kind: "tree", sha: INSTALLED_TREE },
        source: {
          kind: "directory",
          repositoryUrl: "https://github.com/example/package",
          requestedRef: "main",
          credentialId: "initial-credential",
          resolvedCommit: INSTALLED_COMMIT,
          resolvedTree: INSTALLED_TREE,
          subdirectory: PACKAGE_SUBDIRECTORY,
        },
        update: change.initialUpdate ?? {
          status: "available",
          checkedAt: "2026-08-01T00:00:00.000Z",
          revision: { kind: "tree", sha: INSTALLED_TREE },
        },
      };
      let saves = 0;
      const harness = makeManagerHarness({
        managed: initial,
        workspaceDir,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
        directoryTree: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishCheck)),
          Effect.as(REMOTE_TREE),
        ),
        onSave: () =>
          Effect.sync(() => {
            saves += 1;
          }),
      });
      const { manager, state } = yield* harness.services;
      const checking = yield* manager
        .checkUpdate({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(checkStarted);
      const patch: Partial<ManagedScriptPackage> =
        change.source === undefined
          ? (change.patch ?? {})
          : { source: { ...initial.source, ...change.source } };
      yield* state.save({ ...initial, ...patch });
      yield* Deferred.succeed(finishCheck, undefined);
      yield* Fiber.join(checking);

      expect(yield* state.get(PACKAGE_NAME)).toMatchObject(patch);
      expect(saves).toBe(1);
    }),
  );

  it.effect("drops a check whose record another check changed", () =>
    Effect.gen(function* () {
      const { managed, workspaceDir } = yield* installedPackage;
      const firstStarted = yield* Deferred.make<void>();
      const finishFirst = yield* Deferred.make<void>();
      let resolveCommitCalls = 0;
      const harness = makeManagerHarness({
        managed,
        resolution: Effect.suspend(() =>
          resolveCommitCalls++ === 0
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishFirst)),
                Effect.as<GitHubCommitResolution>({
                  status: "modified",
                  commit: INSTALLED_COMMIT,
                }),
              )
            : Effect.succeed<GitHubCommitResolution>({
                status: "modified",
                commit: REMOTE_COMMIT,
              }),
        ),
        workspaceDir,
      });
      const { manager, catalog, state } = yield* harness.services;
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "verified",
        update: { status: "unchecked" },
      });

      const first = yield* manager
        .checkUpdate({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* manager.checkUpdate({
        packageName: PACKAGE_NAME,
      });
      yield* Deferred.succeed(finishFirst, undefined);
      const firstChecked = yield* Fiber.join(first);

      const available = {
        status: "available",
        revision: { kind: "commit", sha: REMOTE_COMMIT },
      };
      expect(second.packages[0]).toMatchObject({ update: available });
      expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
        remoteRevision: { kind: "commit", sha: REMOTE_COMMIT },
        update: available,
      });
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        update: available,
      });
      expect(firstChecked.packages[0]).toMatchObject({ update: available });
    }),
  );

  it.effect(
    "does not restore a directory package removed during an update check",
    () =>
      Effect.gen(function* () {
        const { managed, workspaceDir } = yield* installedPackage;
        const checkStarted = yield* Deferred.make<void>();
        const finishCheck = yield* Deferred.make<void>();
        const harness = makeManagerHarness({
          directoryTree: Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishCheck)),
            Effect.as(REMOTE_TREE),
          ),
          managed: {
            ...managed,
            source: {
              kind: "directory",
              repositoryUrl: "https://github.com/example/monorepo",
              resolvedTree: INSTALLED_TREE,
              subdirectory: PACKAGE_SUBDIRECTORY,
            },
          },
          resolution: { status: "modified", commit: REMOTE_COMMIT },
          workspaceDir,
        });
        const { manager, catalog, state } = yield* harness.services;
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          integrity: "verified",
          source: { kind: "directory", resolvedTree: INSTALLED_TREE },
        });

        const checking = yield* manager
          .checkUpdate({ packageName: PACKAGE_NAME })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(checkStarted);
        const removed = yield* manager.remove({ packageName: PACKAGE_NAME });
        yield* Deferred.succeed(finishCheck, undefined);
        const checked = yield* Fiber.join(checking);

        expect(removed.status).toBe("completed");
        expect(checked.packages).toEqual([]);
        expect(yield* state.get(PACKAGE_NAME)).toBeUndefined();
        expect((yield* catalog.getOverview).packages).toEqual([]);
      }),
  );
});

describe("script package removal failures", () => {
  const failStateRemoval = () =>
    Effect.fail(
      new ScriptPackageStateError({
        operation: "save",
        cause: new Error("Disk full."),
      }),
    );

  it.effect(
    "reports a restored package when the rename home moves then throws",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          workspaceDir,
          onRemove: failStateRemoval,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager, state } = yield* harness.services;
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation((from, to) =>
          rename(from, to).then(() => {
            if (resolve(String(to)) === destination)
              throw Object.assign(new Error("EIO"), { code: "EIO" });
          }),
        );
        const error = yield* manager
          .remove({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        expect(error.message).toBe(
          "Failed to update package state. The package was restored.",
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
        expect(yield* state.get(PACKAGE_NAME)).toEqual(managed);
        expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
          "packages",
          "scripts",
        ]);
      }),
  );

  it.effect(
    "reports both possible locations when the removal copy cannot be checked",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          workspaceDir,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager } = yield* harness.services;
        let removedPath = "";
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation((from, to) => {
          if (resolve(String(from)) !== destination) return rename(from, to);
          removedPath = String(to);
          return Promise.reject(
            Object.assign(new Error("EPERM"), { code: "EPERM" }),
          );
        });
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(
          (...args: Parameters<typeof fs.lstat>) =>
            String(args[0]).includes(".lucent-package-remove-")
              ? Promise.reject(
                  Object.assign(new Error("EACCES"), { code: "EACCES" }),
                )
              : lstat(...args),
        );
        const error = yield* manager
          .remove({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        expect(error.message).toBe(
          `Failed to remove the package. Its location could not be checked. Check ${destination} and ${removedPath}.`,
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
        expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toContain(
          dirname(removedPath).split("/").at(-1),
        );
      }),
  );

  it.effect(
    "keeps a committed removal completed and logs a failed staging cleanup",
    () =>
      Effect.gen(function* () {
        const { managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          workspaceDir,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager, state, catalog } = yield* harness.services;
        let removalFolder = "";
        const rm = fs.rm;
        vi.spyOn(fs, "rm").mockImplementation((path, options) => {
          if (!String(path).includes(".lucent-package-remove-"))
            return rm(path, options);
          removalFolder = String(path);
          return Promise.reject(
            Object.assign(new Error("EPERM"), { code: "EPERM" }),
          );
        });
        const logs: unknown[] = [];
        const causes: unknown[] = [];
        const result = yield* manager
          .remove({ packageName: PACKAGE_NAME })
          .pipe(
            Effect.withLogger(
              Logger.make((options) => {
                logs.push(desktopLogRecord(options));
                causes.push(
                  Cause.prettyErrors(options.cause).map((error) => ({
                    name: error.name,
                    message: error.message,
                  })),
                );
              }),
            ),
          );
        expect(result.status).toBe("completed");
        expect(yield* state.get(PACKAGE_NAME)).toBeUndefined();
        expect((yield* catalog.getOverview).packages).toEqual([]);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(removalFolder, PACKAGE_NAME, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
        expect(logs).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "warn",
            component: "script-packages",
            message: "Failed to clean package removal folder",
            repeatKey: removalFolder,
            data: { path: removalFolder },
            error: [
              {
                name: "ScriptPackageManagerError",
                message: "Failed to clean removal staging.",
                stack: expect.any(String),
                cause: {
                  name: "Error",
                  message: "EPERM",
                  stack: expect.any(String),
                },
              },
            ],
          },
        ]);
        expect(causes).toEqual([
          [
            {
              name: "ScriptPackageManagerError",
              message: "Failed to clean removal staging.",
            },
          ],
        ]);
      }),
  );

  it.effect(
    "writes every cleanup failure when different removal folders fail",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeDirectory);
        const first = yield* installedPackage;
        const second = yield* installedPackage;
        const paths: string[] = [];
        const rm = fs.rm;
        vi.spyOn(fs, "rm").mockImplementation((path, options) => {
          if (!String(path).includes(".lucent-package-remove-"))
            return rm(path, options);
          paths.push(String(path));
          return Promise.reject(
            Object.assign(new Error("EPERM"), { code: "EPERM" }),
          );
        });
        const logging = desktopObservabilityLayer.pipe(
          Layer.provide(
            Layer.succeed(
              DesktopEnvironment,
              DesktopEnvironment.of({
                appDataDir: root,
                assetsDir: root,
                debug: false,
                isDev: false,
                platform: "darwin",
                workspaceDir: root,
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          for (const { managed, workspaceDir } of [first, second]) {
            const { manager } = yield* makeManagerHarness({
              managed,
              workspaceDir,
              resolution: { status: "modified", commit: REMOTE_COMMIT },
            }).services;
            expect(
              (yield* manager.remove({ packageName: PACKAGE_NAME })).status,
            ).toBe("completed");
          }
        }).pipe(Effect.provide(logging));
        const source = yield* Effect.promise(() =>
          fs.readFile(join(root, "logs", "lucent.log"), "utf8"),
        );
        expect(paths).toHaveLength(2);
        expect(
          source
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          paths.map((path) => ({
            at: "1970-01-01T00:00:00.000Z",
            level: "warn",
            component: "script-packages",
            message: "Failed to clean package removal folder",
            data: { path },
            error: [
              {
                name: "ScriptPackageManagerError",
                message: "Failed to clean removal staging.",
                stack: expect.any(String),
                cause: {
                  name: "Error",
                  message: "EPERM",
                  stack: expect.any(String),
                },
              },
            ],
          })),
        );
      }),
  );

  it.effect("preserves the catalog error after a removal has committed", () =>
    Effect.gen(function* () {
      const { destination, managed, workspaceDir } = yield* installedPackage;
      const harness = makeManagerHarness({
        managed,
        workspaceDir,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
      });
      const { manager, state, catalog } = yield* harness.services;
      vi.spyOn(catalog, "removePackage").mockReturnValue(
        Effect.fail(
          new ScriptPackageCatalogError({
            operation: "scan",
            cause: new Error("Catalog failed"),
          }),
        ),
      );
      const error = yield* manager
        .remove({ packageName: PACKAGE_NAME })
        .pipe(Effect.flip);
      expect(error.operation).toBe("validate");
      expect(error.message).toBe("Failed to update the script catalog.");
      expect(yield* state.get(PACKAGE_NAME)).toBeUndefined();
      expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
        "packages",
        "scripts",
      ]);
      expect(
        yield* Effect.promise(() => fs.readdir(dirname(destination))),
      ).toEqual([]);
    }),
  );

  it.effect(
    "names the saved removal copy when state and restoration fail",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          workspaceDir,
          onRemove: failStateRemoval,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager } = yield* harness.services;
        refuseRenamesInto(destination);
        const error = yield* manager
          .remove({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        const copies = yield* Effect.promise(() =>
          findFiles(workspaceDir, OLD_SOURCE),
        );
        expect(copies).toHaveLength(1);
        expect(copies[0]).toContain(".lucent-package-remove-");
        expect(error.message).toContain(dirname(copies[0] ?? ""));
        expect(
          yield* Effect.promise(() => hashDirectory(dirname(copies[0] ?? ""))),
        ).toEqual(managed.files);
      }),
  );

  it.effect(
    "names the removal copy when its rename moves then throws EIO",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          workspaceDir,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager } = yield* harness.services;
        const rename = fs.rename;
        vi.spyOn(fs, "rename").mockImplementation((from, to) =>
          rename(from, to).then(() => {
            if (resolve(String(from)) === destination)
              throw Object.assign(new Error("EIO: input/output error"), {
                code: "EIO",
              });
          }),
        );
        const error = yield* manager
          .remove({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        const copies = yield* Effect.promise(() =>
          findFiles(workspaceDir, OLD_SOURCE),
        );
        expect(copies).toHaveLength(1);
        expect(copies[0]).toContain(".lucent-package-remove-");
        expect(error.message).toContain(dirname(copies[0] ?? ""));
        expect(
          yield* Effect.promise(() => hashDirectory(dirname(copies[0] ?? ""))),
        ).toEqual(managed.files);
      }),
  );

  it.effect(
    "removes empty removal staging after state fails and restore succeeds",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          workspaceDir,
          onRemove: failStateRemoval,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager, state } = yield* harness.services;
        const error = yield* manager
          .remove({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        expect(error.message).toBe(
          "Failed to update package state. The package was restored.",
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
        expect(yield* state.get(PACKAGE_NAME)).toEqual(managed);
        expect(yield* Effect.promise(() => fs.readdir(workspaceDir))).toEqual([
          "packages",
          "scripts",
        ]);
      }),
  );
});

describe("script package integrity rows", () => {
  it.effect(
    "marks reverted edits verified on update without scanning packages again",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          managed,
          workspaceDir,
          resolution: { status: "modified", commit: INSTALLED_COMMIT },
        });
        const { manager, catalog } = yield* harness.services;
        yield* catalog.getOverview;
        yield* Effect.promise(() =>
          write(join(destination, "index.js"), "edited"),
        );
        expect((yield* catalog.refresh).packages[0]).toMatchObject({
          name: PACKAGE_NAME,
          integrity: "modified",
        });
        yield* Effect.promise(() =>
          write(join(destination, "index.js"), OLD_SOURCE),
        );
        const reads = vi.spyOn(fs, "readdir");
        const result = yield* manager.update({ packageName: PACKAGE_NAME });
        expect(result.status).toBe("unchanged");
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          name: PACKAGE_NAME,
          integrity: "verified",
          update: { status: "current" },
        });
        expect(
          reads.mock.calls.filter(
            ([path]) =>
              resolve(String(path)) === join(workspaceDir, "packages"),
          ),
        ).toEqual([]);
        expect(harness.downloadCount()).toBe(0);
      }),
  );

  for (const operation of ["remove", "update"] as const) {
    it.effect(
      `marks a rejected ${operation} modified without another package scan`,
      () =>
        Effect.gen(function* () {
          const { archivePath, destination, managed, workspaceDir } =
            yield* installedPackage;
          const harness = makeManagerHarness({
            archivePath,
            managed,
            workspaceDir,
            resolution: { status: "modified", commit: REMOTE_COMMIT },
          });
          const { manager, catalog } = yield* harness.services;
          expect((yield* catalog.getOverview).packages[0]).toMatchObject({
            integrity: "verified",
          });
          const reads = vi.spyOn(fs, "readdir");
          yield* Effect.promise(() =>
            write(join(destination, "index.js"), "edited"),
          );
          const result = yield* manager[operation]({
            packageName: PACKAGE_NAME,
          });
          expect(result).toEqual({
            status: "confirmation-required",
            packageName: PACKAGE_NAME,
            reason: "local-modifications",
          });
          expect((yield* catalog.getOverview).packages[0]).toMatchObject({
            integrity: "modified",
            ...(operation === "update"
              ? {
                  update: {
                    status: "available",
                    revision: { kind: "commit", sha: REMOTE_COMMIT },
                  },
                }
              : {}),
          });
          expect(
            reads.mock.calls.filter(
              ([path]) =>
                resolve(String(path)) === join(workspaceDir, "packages"),
            ),
          ).toEqual([]);
        }),
    );

    it.effect(
      `reinserts the modified row after a refresh during ${operation}'s moved-copy hash`,
      () =>
        Effect.gen(function* () {
          const { archivePath, destination, managed, workspaceDir } =
            yield* installedPackage;
          const harness = makeManagerHarness({
            archivePath,
            managed,
            workspaceDir,
            resolution: { status: "modified", commit: REMOTE_COMMIT },
          });
          const { manager, catalog } = yield* harness.services;
          yield* catalog.getOverview;
          const rename = fs.rename;
          vi.spyOn(fs, "rename").mockImplementation((from, to) =>
            resolve(String(from)) === destination
              ? write(join(destination, "index.js"), "edited").then(() =>
                  rename(from, to),
                )
              : rename(from, to),
          );
          const readdir = fs.readdir;
          let refreshed = false;
          const hashStarted = Promise.withResolvers<void>();
          const finishHash = Promise.withResolvers<void>();
          const reads = vi
            .spyOn(fs, "readdir")
            .mockImplementation((path, options) => {
              const result = readdir(path, options);
              if (
                !refreshed &&
                String(path).includes(
                  `.lucent-package-${operation === "remove" ? "remove" : "backup"}-`,
                )
              ) {
                refreshed = true;
                return result.then((entries) => {
                  hashStarted.resolve();
                  return finishHash.promise.then(() => entries);
                });
              }
              return result;
            });
          const running = yield* manager[operation]({
            packageName: PACKAGE_NAME,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => hashStarted.promise);
          const during = yield* catalog.refresh;
          expect(during.packages).toEqual([]);
          finishHash.resolve();
          const result = yield* Fiber.join(running);
          expect(result).toEqual({
            status: "confirmation-required",
            packageName: PACKAGE_NAME,
            reason: "local-modifications",
          });
          expect(refreshed).toBe(true);
          expect((yield* catalog.getOverview).packages[0]).toMatchObject({
            name: PACKAGE_NAME,
            integrity: "modified",
            ...(operation === "update"
              ? { update: { status: "available" } }
              : {}),
          });
          expect(
            reads.mock.calls.filter(
              ([path]) =>
                resolve(String(path)) === join(workspaceDir, "packages"),
            ),
          ).toHaveLength(1);
        }),
    );
  }

  it.effect("keeps invalid edited manifests invalid after rejection", () =>
    Effect.gen(function* () {
      const { destination, managed, workspaceDir } = yield* installedPackage;
      const harness = makeManagerHarness({
        managed,
        workspaceDir,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
      });
      const { manager, catalog } = yield* harness.services;
      yield* catalog.getOverview;
      yield* Effect.promise(() =>
        write(join(destination, "package.json"), '{"name":"different"}'),
      );
      const result = yield* manager.remove({ packageName: PACKAGE_NAME });
      expect(result).toEqual({
        status: "confirmation-required",
        packageName: PACKAGE_NAME,
        reason: "local-modifications",
      });
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        status: "invalid",
        path: destination,
        diagnostic:
          'The installed package name is "example", but package.json declares "different".',
      });
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "package.json"), "utf8"),
        ),
      ).toBe('{"name":"different"}');
    }),
  );
});

describe("script package leftovers", () => {
  it.effect("lists another manager's saved package copy during an update", () =>
    Effect.gen(function* () {
      const { archivePath, destination, managed, workspaceDir } =
        yield* installedPackage;
      const first = makeManagerHarness({
        archivePath,
        managed,
        workspaceDir,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
      });
      const { manager } = yield* first.services;
      const moved = Promise.withResolvers<string>();
      const finishMove = Promise.withResolvers<void>();
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation((from, to) =>
        rename(from, to).then(() => {
          if (
            resolve(String(from)) === destination &&
            String(to).includes(".lucent-package-backup-")
          ) {
            moved.resolve(String(to));
            return finishMove.promise;
          }
          return undefined;
        }),
      );
      const updating = yield* manager
        .update({ packageName: PACKAGE_NAME })
        .pipe(Effect.forkScoped);
      const savedPath = yield* Effect.promise(() => moved.promise);
      const second = makeManagerHarness({
        workspaceDir,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
      });
      const { manager: other } = yield* second.services;
      const ownListing = yield* manager.listLeftovers.pipe(Effect.forkScoped);
      const copies = yield* other.listLeftovers;
      const contents = yield* Effect.promise(() =>
        fs.readFile(join(savedPath, "index.js"), "utf8"),
      );
      finishMove.resolve();
      const updated = yield* Fiber.join(updating);
      expect(updated.status).toBe("completed");
      expect(contents).toBe(OLD_SOURCE);
      expect(yield* Fiber.join(ownListing)).toEqual([]);
      expect(copies).toEqual([
        { path: dirname(savedPath), packageName: PACKAGE_NAME },
      ]);
    }),
  );

  it.effect(
    "reports unknown saved folders and skips staging and symlinks without changing files",
    () =>
      Effect.gen(function* () {
        const { workspaceDir } = yield* installedPackage;
        const empty = join(workspaceDir, ".lucent-package-backup-empty");
        const unknown = join(workspaceDir, ".lucent-package-remove-unknown");
        yield* Effect.promise(() =>
          Promise.all([
            fs.mkdir(empty),
            write(join(unknown, "example", "package.json"), "invalid"),
            fs.mkdir(join(workspaceDir, ".lucent-package-install-ignore")),
            fs.mkdir(join(workspaceDir, ".lucent-package-seed-ignore")),
          ]),
        );
        yield* Effect.promise(() =>
          fs.symlink(empty, join(workspaceDir, ".lucent-package-backup-link")),
        );
        const harness = makeManagerHarness({
          workspaceDir,
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager } = yield* harness.services;
        expect(yield* manager.listLeftovers).toEqual([
          { path: empty },
          { path: unknown },
        ]);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(unknown, "example", "package.json"), "utf8"),
          ),
        ).toBe("invalid");
        expect(yield* Effect.promise(() => fs.readdir(empty))).toEqual([]);
      }),
  );
});

describe("script package restore", () => {
  it.effect(
    "restores the installed commit after the tracked branch moves",
    () =>
      Effect.gen(function* () {
        const { archivePath, destination, workspaceDir } =
          yield* installedPackage;
        const initialArchive = join(dirname(workspaceDir), "initial.tgz");
        const initialSource = join(dirname(workspaceDir), "initial-source");
        yield* Effect.promise(() =>
          Promise.all([
            write(
              join(initialSource, "repository-commit", "package.json"),
              '{"name":"example"}',
            ),
            write(
              join(initialSource, "repository-commit", "index.js"),
              OLD_SOURCE,
            ),
            fs.rm(destination, { recursive: true }),
          ]),
        );
        yield* Effect.promise(() =>
          createTar({ cwd: initialSource, file: initialArchive, gzip: true }, [
            "repository-commit",
          ]),
        );
        let remoteCommit = INSTALLED_COMMIT;
        const harness = makeManagerHarness({
          workspaceDir,
          archivePath: (ref) =>
            ref === INSTALLED_COMMIT ? initialArchive : archivePath,
          resolution: Effect.sync(() => ({
            status: "modified",
            commit: remoteCommit,
          })),
        });
        const { manager, catalog, state } = yield* harness.services;
        const installed = yield* manager.install({
          repositoryUrl: "https://github.com/example/package",
          ref: "main",
          credentialId: "restore-token",
        });
        expect(installed.status).toBe("completed");
        remoteCommit = REMOTE_COMMIT;
        yield* manager.checkUpdate({ packageName: PACKAGE_NAME });
        yield* Effect.promise(() =>
          write(join(destination, "index.js"), "local edit"),
        );
        const restored = yield* manager.restore({ packageName: PACKAGE_NAME });
        expect(restored.status).toBe("completed");
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
        expect(harness.archiveRequests.map(({ ref }) => ref)).toEqual([
          INSTALLED_COMMIT,
          INSTALLED_COMMIT,
        ]);
        expect(
          harness.archiveRequests.map(({ ref, credentialId }) => ({
            ref,
            credentialId,
          })),
        ).toEqual([
          { ref: INSTALLED_COMMIT, credentialId: "restore-token" },
          { ref: INSTALLED_COMMIT, credentialId: "restore-token" },
        ]);
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          integrity: "verified",
          source: { resolvedCommit: INSTALLED_COMMIT, requestedRef: "main" },
          update: {
            status: "available",
            revision: { kind: "commit", sha: REMOTE_COMMIT },
          },
        });
        expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
          source: { resolvedCommit: INSTALLED_COMMIT, requestedRef: "main" },
        });
      }),
  );

  it.effect(
    "points to Update when the installed commit cannot be downloaded",
    () =>
      Effect.gen(function* () {
        const { managed, workspaceDir, destination } = yield* installedPackage;
        const harness = makeManagerHarness({
          workspaceDir,
          managed,
          downloadError: new GitHubScriptPackageClientError({
            kind: "not-found",
            detail: "Not found",
          }),
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager, state } = yield* harness.services;
        const error = yield* manager
          .restore({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        expect(error.message).toContain(
          "Check for updates, then use Update to install the latest version.",
        );
        expect(yield* state.get(PACKAGE_NAME)).toEqual(managed);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
      }),
  );

  it.effect(
    "refuses to follow a branch when a bundled copy has only an installed tree",
    () =>
      Effect.gen(function* () {
        const { managed, workspaceDir } = yield* installedPackage;
        const harness = makeManagerHarness({
          workspaceDir,
          managed: {
            ...managed,
            source: {
              kind: "directory",
              repositoryUrl: "https://github.com/example/package",
              requestedRef: "main",
              subdirectory: PACKAGE_SUBDIRECTORY,
              resolvedTree: INSTALLED_TREE,
            },
          },
          resolution: { status: "modified", commit: REMOTE_COMMIT },
        });
        const { manager, state } = yield* harness.services;
        const error = yield* manager
          .restore({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        expect(error.message).toContain(
          "Check for updates, then use Update to install the latest version.",
        );
        expect(harness.requests).toEqual([]);
        expect(harness.downloadCount()).toBe(0);
        expect(yield* state.get(PACKAGE_NAME)).toMatchObject({
          source: { resolvedTree: INSTALLED_TREE, requestedRef: "main" },
        });
      }),
  );

  it.effect(
    "restores a directory package from its installed repository commit and tree",
    () =>
      Effect.gen(function* () {
        const { destination, managed, workspaceDir } = yield* installedPackage;
        const root = dirname(workspaceDir);
        const source = join(root, "directory-source");
        yield* Effect.promise(() =>
          Promise.all([
            write(
              join(
                source,
                "repository-commit",
                PACKAGE_SUBDIRECTORY,
                "package.json",
              ),
              '{"name":"example"}',
            ),
            write(
              join(
                source,
                "repository-commit",
                PACKAGE_SUBDIRECTORY,
                "index.js",
              ),
              OLD_SOURCE,
            ),
          ]),
        );
        const archivePath = join(root, "directory.tgz");
        yield* Effect.promise(() =>
          createTar({ cwd: source, file: archivePath, gzip: true }, [
            "repository-commit",
          ]),
        );
        const sourceRecord = {
          kind: "directory",
          repositoryUrl: "https://github.com/example/package",
          requestedRef: "main",
          subdirectory: PACKAGE_SUBDIRECTORY,
          resolvedCommit: INSTALLED_COMMIT,
          resolvedTree: INSTALLED_TREE,
        } as const;
        const harness = makeManagerHarness({
          archivePath,
          workspaceDir,
          managed: { ...managed, source: sourceRecord },
          resolution: { status: "modified", commit: REMOTE_COMMIT },
          directoryTree: REMOTE_TREE,
        });
        const { manager, state, catalog } = yield* harness.services;
        yield* Effect.promise(() =>
          write(join(destination, "index.js"), "edited"),
        );
        const result = yield* manager.restore({ packageName: PACKAGE_NAME });
        expect(result.status).toBe("completed");
        expect(harness.archiveRequests.map(({ ref }) => ref)).toEqual([
          INSTALLED_COMMIT,
        ]);
        expect(harness.requests).toEqual([]);
        expect(harness.directoryRequests).toEqual([]);
        expect((yield* state.get(PACKAGE_NAME))?.source).toEqual(sourceRecord);
        expect((yield* catalog.getOverview).packages[0]).toMatchObject({
          integrity: "verified",
          update: { status: "unchecked" },
        });
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
      }),
  );
});

describe("bundled package restore", () => {
  it.effect("restores the seeded bundled copy offline", () =>
    Effect.gen(function* () {
      const { manager, state, catalog, harness, destination, managed } =
        yield* seededBundledPackage;
      yield* Effect.promise(() =>
        write(join(destination, "index.js"), "local edit"),
      );
      expect((yield* catalog.refresh).packages[0]).toMatchObject({
        integrity: "modified",
      });
      const result = yield* manager.restore({ packageName: PACKAGE_NAME });
      expect(result.status).toBe("completed");
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(OLD_SOURCE);
      expect((yield* catalog.getOverview).packages[0]).toMatchObject({
        integrity: "verified",
        update: { status: "unchecked" },
        source: managed.source,
      });
      expect((yield* state.get(PACKAGE_NAME))?.source).toEqual(managed.source);
      expect(harness.archiveRequests).toEqual([]);
      expect(harness.requests).toEqual([]);
      expect(harness.directoryRequests).toEqual([]);
    }),
  );

  it.effect.each(["changed", "missing"] as const)(
    "preserves edits when the app bundle is %s",
    (change) =>
      Effect.gen(function* () {
        const { manager, state, harness, source, destination, managed } =
          yield* seededBundledPackage;
        yield* Effect.promise(() =>
          write(join(destination, "index.js"), "local edit"),
        );
        yield* Effect.promise(() =>
          change === "changed"
            ? write(join(source, "index.js"), NEW_SOURCE)
            : fs.rm(source, { recursive: true }),
        );
        const error = yield* manager
          .restore({ packageName: PACKAGE_NAME })
          .pipe(Effect.flip);
        expect(error.message).toContain(
          "Check for updates, then use Update to install the latest version.",
        );
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe("local edit");
        expect(yield* state.get(PACKAGE_NAME)).toEqual(managed);
        expect(harness.archiveRequests).toEqual([]);
        expect(harness.requests).toEqual([]);
        expect(harness.directoryRequests).toEqual([]);
      }),
  );

  it.effect(
    "refuses bundled restore after its package moves out of the saved folder",
    () =>
      Effect.gen(function* () {
        const { manager, catalog, destination, managed, state } =
          yield* seededBundledPackage;
        const moved = join(dirname(destination), "moved-example");
        yield* Effect.promise(() => fs.rename(destination, moved));
        yield* Effect.promise(() =>
          Promise.all([
            write(join(destination, "package.json"), '{"name":"unrelated"}'),
            write(join(destination, "index.js"), "unrelated files"),
          ]),
        );
        yield* catalog.refresh;
        const result = yield* manager
          .restore({ packageName: PACKAGE_NAME })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                status: "failed",
                message: error.message,
              }),
              onSuccess: (value) => value,
            }),
          );
        expect(result).toEqual({
          status: "failed",
          message: 'Package "example" is not in its saved folder.',
        });
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(destination, "index.js"), "utf8"),
          ),
        ).toBe("unrelated files");
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(moved, "index.js"), "utf8"),
          ),
        ).toBe(OLD_SOURCE);
        expect(yield* state.get(PACKAGE_NAME)).toEqual(managed);
      }),
  );

  it.effect("tags a downloaded name mismatch as a restore failure", () =>
    Effect.gen(function* () {
      const { destination, managed, workspaceDir } = yield* installedPackage;
      const source = join(dirname(workspaceDir), "mismatched-source");
      yield* Effect.promise(() =>
        write(
          join(source, "repository-commit", "package.json"),
          '{"name":"different"}',
        ),
      );
      const archivePath = join(dirname(workspaceDir), "mismatched.tgz");
      yield* Effect.promise(() =>
        createTar({ cwd: source, file: archivePath, gzip: true }, [
          "repository-commit",
        ]),
      );
      const harness = makeManagerHarness({
        managed,
        workspaceDir,
        archivePath,
        resolution: { status: "modified", commit: REMOTE_COMMIT },
      });
      const { manager } = yield* harness.services;
      const error = yield* manager
        .restore({ packageName: PACKAGE_NAME })
        .pipe(Effect.flip);
      expect(error.operation).toBe("restore");
      expect(error.message).toBe(
        'The downloaded package declares "different" instead of "example".',
      );
      expect(
        yield* Effect.promise(() =>
          fs.readFile(join(destination, "index.js"), "utf8"),
        ),
      ).toBe(OLD_SOURCE);
    }),
  );
});
