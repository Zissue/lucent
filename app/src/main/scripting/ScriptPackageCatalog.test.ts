import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { ElectronApp } from "../electron/ElectronApp";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../shared/logRecord";
import { hashDirectory } from "./ScriptPackageFileSystem";
import { discoverScriptCatalog } from "./ScriptCatalogDiscovery";
import { inspectScriptPackageDirectory } from "./ScriptPackageInspection";
import {
  layer as scriptPackageCatalogLayer,
  ScriptPackageCatalog,
} from "./ScriptPackageCatalog";
import {
  type ManagedScriptPackage,
  ScriptPackageState,
} from "./ScriptPackageState";

vi.mock("effect/SynchronizedRef", async (importOriginal) => ({
  ...(await importOriginal<typeof import("effect/SynchronizedRef")>()),
}));

vi.mock("electron", () => ({ app: {} }));

const directories: string[] = [];

const makeWorkspace = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-script-catalog-"));
  directories.push(root);
  const scriptsDir = join(root, "scripts");
  const packagesDir = join(root, "packages");
  await Promise.all([
    fs.mkdir(scriptsDir, { recursive: true }),
    fs.mkdir(packagesDir, { recursive: true }),
  ]);
  return { packagesDir, root, scriptsDir };
};

const write = async (path: string, source: string): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, source, "utf8");
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("discoverScriptCatalog", () => {
  it("discovers every loose script without assigning package meaning to its folders", async () => {
    const workspace = await makeWorkspace();
    await Promise.all([
      write(join(workspace.scriptsDir, "farm.js"), ""),
      write(join(workspace.scriptsDir, "packages", "nested.cjs"), ""),
      write(
        join(workspace.scriptsDir, "packages", "package.json"),
        '{"name":"ignored"}',
      ),
      write(join(workspace.scriptsDir, "notes.txt"), ""),
    ]);

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });

    expect(
      discovery.catalog.scripts.map((script) => script.relativePath),
    ).toEqual(["farm.js", "packages/nested.cjs"]);
    expect(
      discovery.catalog.scripts.every(
        (script) => script.reference.kind === "loose",
      ),
    ).toBe(true);
  });

  it("reads a package name independently from its folder", async () => {
    const workspace = await makeWorkspace();
    const packageRoot = join(workspace.packagesDir, "daily-package");
    await Promise.all([
      write(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@a/b/c/d",
          main: "index.cjs",
          lucent: { version: ">=1.0.0 <2.0.0" },
        }),
      ),
      write(join(packageRoot, "index.cjs"), "exports.value = 1"),
      write(join(packageRoot, "lib", "helper.js"), ""),
      write(join(packageRoot, "scripts", "farm.js"), ""),
      write(join(packageRoot, "scripts", "nested", "quest.cjs"), ""),
    ]);

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });

    expect(discovery.catalog.packages).toHaveLength(1);
    expect(discovery.catalog.packages[0]).toMatchObject({
      status: "valid",
      name: "@a/b/c/d",
      compatibility: { status: "compatible" },
    });
    expect(
      discovery.catalog.scripts.map((script) => script.relativePath),
    ).toEqual(["farm.js", "nested/quest.cjs"]);
    expect(discovery.catalog.scripts[0]?.reference).toEqual({
      kind: "package",
      packageName: "@a/b/c/d",
      path: "scripts/farm.js",
    });
    expect(discovery.packages.get("@a/b/c/d")?.files).toHaveLength(4);
    expect(discovery.packages.get("@a/b/c/d")?.directory).toBe("daily-package");
  });

  it("does not discover packages below a direct child folder", async () => {
    const workspace = await makeWorkspace();
    const containerRoot = join(workspace.packagesDir, "namespace");
    const nestedRoot = join(containerRoot, "nested");
    await Promise.all([
      write(join(nestedRoot, "package.json"), '{"name":"namespace/nested"}'),
      write(join(nestedRoot, "scripts", "hidden.js"), ""),
    ]);

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });

    expect(discovery.catalog.packages).toHaveLength(1);
    expect(discovery.catalog.packages[0]).toMatchObject({
      status: "invalid",
      path: containerRoot,
    });
    expect(discovery.catalog.scripts).toEqual([]);
    expect(discovery.packages.size).toBe(0);
  });

  it("rejects duplicate package names", async () => {
    const workspace = await makeWorkspace();
    await Promise.all([
      write(
        join(workspace.packagesDir, "first-folder", "package.json"),
        '{"name":"shared-name"}',
      ),
      write(
        join(workspace.packagesDir, "second-folder", "package.json"),
        '{"name":"shared-name"}',
      ),
    ]);

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });

    expect(discovery.catalog.packages).toHaveLength(2);
    expect(
      discovery.catalog.packages.every(
        (entry) =>
          entry.status === "invalid" &&
          entry.diagnostic.includes("More than one package folder"),
      ),
    ).toBe(true);
    expect(discovery.packages.has("shared-name")).toBe(false);
  });

  it("classifies incompatible and malformed minimum versions", async () => {
    const workspace = await makeWorkspace();
    await Promise.all([
      write(
        join(workspace.packagesDir, "future", "package.json"),
        '{"name":"future","lucent":{"version":">=9.0.0"}}',
      ),
      write(join(workspace.packagesDir, "future", "scripts", "run.js"), ""),
      write(
        join(workspace.packagesDir, "unknown", "package.json"),
        '{"name":"unknown","lucent":{"version":"definitely-not-semver"}}',
      ),
      write(join(workspace.packagesDir, "unknown", "scripts", "run.js"), ""),
    ]);

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });
    const valid = discovery.catalog.packages.filter(
      (entry) => entry.status === "valid",
    );
    expect(
      valid.find((entry) => entry.name === "future")?.compatibility.status,
    ).toBe("incompatible");
    expect(valid.find((entry) => entry.name === "unknown")).toMatchObject({
      compatibility: { status: "unknown" },
      warning: expect.stringContaining(
        "The Lucent version requirement is invalid",
      ),
    });
  });

  it.each([
    [">=0.0.1 <0.1.0", "0.0.3-beta.1", "compatible"],
    ["*", "0.0.3-beta.1", "compatible"],
    ["^0.0.3", "0.0.3-beta.1", "compatible"],
    [">=0.0.3", "0.0.3-beta.1", "incompatible"],
    [">=0.0.1 <0.1.0-0", "0.1.0-beta.1", "incompatible"],
    [">=0.0.3-beta.2 <0.1.0", "0.0.3-beta.1", "incompatible"],
    [">=0.0.3-beta.2 <0.1.0", "0.0.3-beta.3", "compatible"],
  ])(
    "checks prerelease app compatibility for %s against %s",
    async (requiredVersion, currentVersion, status) => {
      const workspace = await makeWorkspace();
      await write(
        join(workspace.packagesDir, "tools", "package.json"),
        JSON.stringify({ name: "tools", lucent: { version: requiredVersion } }),
      );

      const discovery = await discoverScriptCatalog({
        currentVersion,
        packagesDir: workspace.packagesDir,
        scriptsDir: workspace.scriptsDir,
      });

      expect(discovery.packages.get("tools")?.compatibility).toEqual({
        status,
        currentVersion,
        requiredVersion,
      });
    },
  );

  it("accepts semver dependency ranges and keeps compatible cycles ready", async () => {
    const workspace = await makeWorkspace();
    const firstRoot = join(workspace.packagesDir, "first");
    const secondRoot = join(workspace.packagesDir, "second");
    await Promise.all([
      write(
        join(firstRoot, "package.json"),
        JSON.stringify({
          name: "first",
          version: "1.0.0",
          lucent: { dependencies: { second: "^2.0.0" } },
        }),
      ),
      write(join(firstRoot, "index.js"), "exports.first = true;"),
      write(
        join(secondRoot, "package.json"),
        JSON.stringify({
          name: "second",
          version: "2.3.0",
          lucent: { dependencies: { first: "*" } },
        }),
      ),
      write(join(secondRoot, "index.js"), "exports.second = true;"),
    ]);

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });

    expect(discovery.packages.get("first")?.dependencyStatus).toEqual({
      status: "ready",
    });
    expect(discovery.packages.get("second")?.dependencyStatus).toEqual({
      status: "ready",
    });
  });

  it("blocks missing, mismatched, unversioned, and transitive dependencies", async () => {
    const workspace = await makeWorkspace();
    const manifests = [
      {
        name: "missing-consumer",
        version: "1.0.0",
        lucent: { dependencies: { absent: "1.0.0" } },
      },
      {
        name: "mismatch-consumer",
        version: "1.0.0",
        lucent: { dependencies: { versioned: "^2.0.0" } },
      },
      {
        name: "unversioned-consumer",
        version: "1.0.0",
        lucent: { dependencies: { unversioned: "*" } },
      },
      {
        name: "transitive-consumer",
        version: "1.0.0",
        lucent: { dependencies: { "missing-consumer": "1.0.0" } },
      },
      { name: "versioned", version: "1.5.0" },
      { name: "unversioned" },
    ] as const;
    await Promise.all(
      manifests.flatMap((manifest) => {
        const root = join(workspace.packagesDir, manifest.name);
        return [
          write(join(root, "package.json"), JSON.stringify(manifest)),
          write(join(root, "index.js"), "exports.value = true;"),
        ];
      }),
    );

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });

    expect(
      discovery.packages.get("missing-consumer")?.dependencyStatus,
    ).toMatchObject({
      status: "blocked",
      issues: [{ reason: "missing", packageName: "absent" }],
    });
    expect(
      discovery.packages.get("mismatch-consumer")?.dependencyStatus,
    ).toMatchObject({
      status: "blocked",
      issues: [{ reason: "version-mismatch", installedVersion: "1.5.0" }],
    });
    expect(
      discovery.packages.get("unversioned-consumer")?.dependencyStatus,
    ).toMatchObject({
      status: "blocked",
      issues: [{ reason: "version-unavailable" }],
    });
    expect(
      discovery.packages.get("transitive-consumer")?.dependencyStatus,
    ).toMatchObject({
      status: "blocked",
      issues: [{ reason: "unavailable", packageName: "missing-consumer" }],
    });
  });

  it("derives verified and modified integrity from the app-owned baseline", async () => {
    const workspace = await makeWorkspace();
    const packageRoot = join(workspace.packagesDir, "tools-folder");
    await Promise.all([
      write(join(packageRoot, "package.json"), '{"name":"@author/tools"}'),
      write(join(packageRoot, "index.js"), "exports.value = 1"),
    ]);
    const managed: ManagedScriptPackage = {
      directory: "tools-folder",
      files: await hashDirectory(packageRoot),
      installedAt: new Date(0).toISOString(),
      name: "@author/tools",
      source: {
        kind: "repository",
        repositoryUrl: "https://github.com/example/tools",
        resolvedCommit: "abc123",
      },
    };

    const verified = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      managedPackages: [managed],
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });
    expect(verified.catalog.packages[0]).toMatchObject({
      integrity: "verified",
    });

    await write(join(packageRoot, "index.js"), "exports.value = 2");
    const modified = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      managedPackages: [managed],
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });
    expect(modified.catalog.packages[0]).toMatchObject({
      integrity: "modified",
    });
  });

  it("rejects a managed folder that declares a different package name", async () => {
    const workspace = await makeWorkspace();
    const packageRoot = join(workspace.packagesDir, "tracked-folder");
    await write(join(packageRoot, "package.json"), '{"name":"other-name"}');
    const managed: ManagedScriptPackage = {
      directory: "tracked-folder",
      files: await hashDirectory(packageRoot),
      installedAt: new Date(0).toISOString(),
      name: "expected-name",
      source: {
        kind: "repository",
        repositoryUrl: "https://github.com/example/package",
        resolvedCommit: "abc123",
      },
    };

    const discovery = await discoverScriptCatalog({
      currentVersion: "1.2.3",
      managedPackages: [managed],
      packagesDir: workspace.packagesDir,
      scriptsDir: workspace.scriptsDir,
    });

    expect(discovery.catalog.packages[0]).toMatchObject({
      status: "invalid",
      name: "other-name",
      diagnostic: expect.stringContaining(
        'installed package name is "expected-name"',
      ),
    });
    expect(discovery.packages.size).toBe(0);
  });
});

const makeCatalogHarness = (
  onScan: Effect.Effect<void> = Effect.void,
  managedPackages: readonly ManagedScriptPackage[] = [],
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = nodeFileSystemLayer,
) =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(makeWorkspace);
    yield* Effect.promise(() =>
      write(join(workspace.scriptsDir, "first.js"), ""),
    );
    let scanCount = 0;
    const environment = DesktopEnvironment.of({
      appDataDir: join(workspace.root, "app-data"),
      assetsDir: join(workspace.root, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir: workspace.root,
    });
    const app = ElectronApp.of({
      exit: () => Effect.void,
      getAppMetrics: Effect.succeed([]),
      getVersion: Effect.succeed("1.0.0"),
      on: () => Effect.void,
      quit: Effect.void,
      relaunch: Effect.void,
      whenReady: Effect.void,
    });
    const state = ScriptPackageState.of({
      get: () => Effect.sync((): ManagedScriptPackage | undefined => undefined),
      getAll: Effect.sync(() => {
        scanCount += 1;
        return managedPackages;
      }).pipe(Effect.tap(() => onScan)),
      remove: () => Effect.void,
      save: () => Effect.void,
    });
    const testLayer = scriptPackageCatalogLayer.pipe(
      Layer.provide(fileSystemLayer),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopEnvironment, environment),
          Layer.succeed(ElectronApp, app),
          Layer.succeed(ScriptPackageState, state),
        ),
      ),
    );

    const catalog = yield* ScriptPackageCatalog.pipe(Effect.provide(testLayer));
    return { catalog, workspace, scanCount: () => scanCount };
  });

describe("ScriptPackageCatalog", () => {
  it.effect("recreates missing catalog folders recursively", () =>
    Effect.gen(function* () {
      const { catalog, workspace } = yield* makeCatalogHarness();
      yield* Effect.promise(() => fs.rm(workspace.root, { recursive: true }));
      expect(yield* catalog.refresh).toMatchObject({
        packages: [],
        scriptCount: 0,
      });
      expect(
        (yield* Effect.promise(() => fs.readdir(workspace.root))).sort(),
      ).toEqual(["packages", "scripts"]);
      expect(
        (yield* Effect.promise(() =>
          fs.stat(workspace.scriptsDir),
        )).isDirectory(),
      ).toBe(true);
      expect(
        (yield* Effect.promise(() =>
          fs.stat(workspace.packagesDir),
        )).isDirectory(),
      ).toBe(true);
    }),
  );

  it.effect("preserves scan errors and their native mkdir cause", () =>
    Effect.gen(function* () {
      const native = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const failingFileSystem = FileSystem.layerNoop({
        makeDirectory: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "makeDirectory",
              cause: native,
            }),
          ),
      });
      const { catalog } = yield* makeCatalogHarness(
        Effect.void,
        [],
        failingFileSystem,
      );
      const error = yield* catalog.refresh.pipe(Effect.flip);
      expect(error._tag).toBe("ScriptPackageCatalogError");
      expect(error.operation).toBe("scan");
      expect(error.message).toBe("Failed to scan the script package catalog.");
      expect(error.cause).toBe(native);
    }),
  );

  it.effect("logs unexpected package inspection failures once per scan", () =>
    Effect.gen(function* () {
      const { catalog, workspace } = yield* makeCatalogHarness();
      yield* Effect.promise(() =>
        Promise.all(
          ["first", "second"].flatMap((name) => [
            write(
              join(workspace.packagesDir, name, "package.json"),
              JSON.stringify({ name }),
            ),
            write(
              join(workspace.packagesDir, name, "index.js"),
              "exports.value = 1",
            ),
          ]),
        ),
      );
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(
        (...args: Parameters<typeof fs.lstat>) =>
          String(args[0]).endsWith("package.json")
            ? Promise.reject(
                Object.assign(
                  new Error(
                    String(args[0]).includes("second") ? "EIO" : "EACCES",
                  ),
                  { code: "EACCES" },
                ),
              )
            : lstat(...args),
      );
      const logs: DesktopLogRecord[] = [];
      const result = yield* catalog.refresh.pipe(
        Effect.withLogger(
          Logger.make((options) => logs.push(desktopLogRecord(options))),
        ),
      );
      expect(result.packages).toEqual([
        {
          status: "invalid",
          diagnostic: "EACCES",
          path: join(workspace.packagesDir, "first"),
        },
        {
          status: "invalid",
          diagnostic: "EIO",
          path: join(workspace.packagesDir, "second"),
        },
      ]);
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
          repeatKey: "first,second",
          data: { packageNames: ["first", "second"] },
        },
      ]);
      expect(
        logs[0]?.error?.map(({ name, message }) => ({ name, message })),
      ).toEqual([
        { name: "Error", message: "EACCES" },
        { name: "Error", message: "EIO" },
      ]);
    }),
  );

  it.effect(
    "logs failed integrity reads while retaining the modified result",
    () =>
      Effect.gen(function* () {
        const managedPackages: ManagedScriptPackage[] = [];
        const { catalog, workspace } = yield* makeCatalogHarness(
          Effect.void,
          managedPackages,
        );
        const rootPath = join(workspace.packagesDir, "tools");
        yield* Effect.promise(() =>
          Promise.all([
            write(join(rootPath, "package.json"), '{"name":"tools"}'),
            write(join(rootPath, "index.js"), "exports.value = 1"),
          ]),
        );
        managedPackages.push({
          directory: "tools",
          files: yield* Effect.promise(() => hashDirectory(rootPath)),
          installedAt: "2026-10-17T00:00:00.000Z",
          name: "tools",
          source: {
            kind: "repository",
            repositoryUrl: "https://github.com/example/tools",
            resolvedCommit: "abc123",
          },
        });
        const stat = fs.stat;
        vi.spyOn(fs, "stat").mockImplementation(
          (...args: Parameters<typeof fs.stat>) =>
            String(args[0]) === join(rootPath, "index.js")
              ? Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }))
              : stat(...args),
        );
        const logs: DesktopLogRecord[] = [];
        const result = yield* catalog.refresh.pipe(
          Effect.withLogger(
            Logger.make((options) => logs.push(desktopLogRecord(options))),
          ),
        );
        expect(result.packages[0]).toMatchObject({
          status: "valid",
          name: "tools",
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
            repeatKey: "tools",
            data: { packageNames: ["tools"] },
          },
        ]);
        expect(
          logs[0]?.error?.map(({ name, message }) => ({ name, message })),
        ).toEqual([{ name: "Error", message: "EIO" }]);
      }),
  );

  it.effect(
    "keeps invalid manifests, missing manifests, and local modifications silent",
    () =>
      Effect.gen(function* () {
        const managedPackages: ManagedScriptPackage[] = [];
        const { catalog, workspace } = yield* makeCatalogHarness(
          Effect.void,
          managedPackages,
        );
        const rootPath = join(workspace.packagesDir, "tools");
        yield* Effect.promise(() =>
          Promise.all([
            write(join(rootPath, "package.json"), '{"name":"tools"}'),
            write(join(rootPath, "index.js"), "exports.value = 1"),
            write(
              join(workspace.packagesDir, "invalid", "package.json"),
              "private invalid contents",
            ),
            write(join(workspace.packagesDir, "missing", "index.js"), ""),
          ]),
        );
        managedPackages.push({
          directory: "tools",
          files: yield* Effect.promise(() => hashDirectory(rootPath)),
          installedAt: "2026-10-17T00:00:00.000Z",
          name: "tools",
          source: {
            kind: "repository",
            repositoryUrl: "https://github.com/example/tools",
            resolvedCommit: "abc123",
          },
        });
        yield* Effect.promise(() =>
          write(join(rootPath, "index.js"), "exports.value = 2"),
        );
        const logs: DesktopLogRecord[] = [];
        const result = yield* catalog.refresh.pipe(
          Effect.withLogger(
            Logger.make((options) => logs.push(desktopLogRecord(options))),
          ),
        );
        expect(result.packages.map((entry) => entry.status)).toEqual([
          "invalid",
          "invalid",
          "valid",
        ]);
        expect(result.packages[2]).toMatchObject({
          name: "tools",
          integrity: "modified",
        });
        expect(logs).toEqual([]);
      }),
  );

  it.effect.each([8, 16, 32])(
    "publishes revisions in order with a %i-operation scheduling budget",
    (maxOps) =>
      Effect.gen(function* () {
        const scanStarted = yield* Deferred.make<void>();
        const { catalog, workspace } = yield* makeCatalogHarness(
          Deferred.succeed(scanStarted, undefined).pipe(Effect.asVoid),
        );
        yield* Effect.promise(() =>
          write(
            join(workspace.packagesDir, "tools", "package.json"),
            '{"name":"tools"}',
          ),
        );
        const revisions: string[] = [];
        yield* catalog.onChanged((change) => {
          revisions.push(change.revision);
        });

        const refreshing = yield* catalog.refresh.pipe(
          Effect.provideService(References.MaxOpsBeforeYield, maxOps),
          Effect.forkScoped,
        );
        yield* Deferred.await(scanStarted);
        const removing = yield* catalog
          .removePackage("tools")
          .pipe(Effect.forkScoped);
        const refreshed = yield* Fiber.join(refreshing);
        const removed = yield* Fiber.join(removing);

        expect(refreshed.packages.map((entry) => entry.name)).toEqual([
          "tools",
        ]);
        expect(removed.packages).toEqual([]);
        expect(revisions).toEqual(
          maxOps === 8
            ? [removed.revision]
            : [refreshed.revision, removed.revision],
        );
        expect((yield* catalog.getOverview).revision).toBe(revisions.at(-1));
      }),
  );

  it.effect(
    "coalesces the first scan and rescans only on explicit refresh",
    () =>
      Effect.gen(function* () {
        const { catalog, workspace, scanCount } = yield* makeCatalogHarness();
        expect(scanCount()).toBe(0);
        const [first, concurrent] = yield* Effect.all(
          [catalog.getOverview, catalog.getOverview],
          { concurrency: "unbounded" },
        );
        expect(first.scriptCount).toBe(1);
        expect(concurrent.revision).toBe(first.revision);
        expect(scanCount()).toBe(1);

        yield* Effect.promise(() =>
          write(join(workspace.scriptsDir, "second.js"), ""),
        );
        expect((yield* catalog.getOverview).scriptCount).toBe(1);
        expect(scanCount()).toBe(1);

        const refreshed = yield* catalog.refresh;
        expect(refreshed.scriptCount).toBe(2);
        expect(scanCount()).toBe(2);
      }),
  );

  it.effect("filters catalog pages from the requested revision", () =>
    Effect.gen(function* () {
      const { catalog, workspace } = yield* makeCatalogHarness();
      yield* Effect.promise(() =>
        write(join(workspace.scriptsDir, "second.js"), ""),
      );
      const refreshed = yield* catalog.getOverview;
      const page = yield* catalog.getPage({
        limit: 128,
        offset: 0,
        query: "second",
        revision: refreshed.revision,
      });
      expect(page.total).toBe(1);
      expect(page.entries[0]?.relativePath).toBe("second.js");
    }),
  );

  it.effect("keeps the last catalog after a failed refresh and can retry", () =>
    Effect.gen(function* () {
      const { catalog, workspace } = yield* makeCatalogHarness();
      const initial = yield* catalog.refresh;
      const revisions: string[] = [];
      yield* catalog.onChanged((change) => {
        revisions.push(change.revision);
      });
      yield* Effect.promise(async () => {
        await fs.rm(workspace.packagesDir, { recursive: true });
        await fs.writeFile(workspace.packagesDir, "not a directory");
      });
      const failure = yield* catalog.refresh.pipe(Effect.flip);
      expect(failure.operation).toBe("scan");
      expect(revisions).toEqual([]);
      expect(yield* catalog.getOverview).toEqual(initial);
      yield* Effect.promise(async () => {
        await fs.unlink(workspace.packagesDir);
        await write(join(workspace.scriptsDir, "second.js"), "");
      });
      const retried = yield* catalog.refresh;
      expect(retried.scriptCount).toBe(2);
      expect(revisions).toEqual([retried.revision]);
    }),
  );

  it.effect(
    "rescans instead of hiding another folder with the replacement name",
    () =>
      Effect.gen(function* () {
        const { catalog, workspace, scanCount } = yield* makeCatalogHarness();
        const duplicatePath = join(workspace.packagesDir, "other-tools");
        yield* Effect.promise(() =>
          write(join(duplicatePath, "package.json"), '{"name":"tools"}'),
        );
        expect((yield* catalog.getOverview).packages).toMatchObject([
          { status: "valid", name: "tools", path: duplicatePath },
        ]);
        const rootPath = join(workspace.packagesDir, "tools");
        yield* Effect.promise(() =>
          write(join(rootPath, "package.json"), '{"name":"tools"}'),
        );
        const inspected = yield* Effect.promise(() =>
          inspectScriptPackageDirectory(rootPath),
        );
        const replaced = yield* catalog.replacePackage({
          inspected,
          integrity: "modified",
          managed: {
            directory: "tools",
            name: "tools",
            files: {},
            installedAt: new Date(0).toISOString(),
            source: {
              kind: "repository",
              repositoryUrl: "https://github.com/example/tools",
              resolvedCommit: "abc123",
            },
          },
          rootPath,
          sourceRoot: rootPath,
        });
        expect(replaced.packages).toEqual(
          [duplicatePath, rootPath].map((path) => ({
            status: "invalid",
            name: "tools",
            path,
            diagnostic:
              'More than one package folder declares the name "tools".',
          })),
        );
        expect((yield* catalog.getDiscovery).packages.size).toBe(0);
        expect(scanCount()).toBe(2);
      }),
  );
  it.effect("replaces and removes a package without a full rescan", () =>
    Effect.gen(function* () {
      const { catalog, workspace, scanCount } = yield* makeCatalogHarness();
      yield* catalog.getOverview;
      const sourceRoot = join(workspace.root, "staged-tools");
      const rootPath = join(workspace.packagesDir, "tools");
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(sourceRoot, "package.json"),
            JSON.stringify({ name: "tools" }),
          ),
          write(join(sourceRoot, "scripts", "tool.js"), ""),
        ]),
      );
      const inspected = yield* Effect.promise(() =>
        inspectScriptPackageDirectory(sourceRoot),
      );
      yield* Effect.promise(() => fs.rename(sourceRoot, rootPath));
      const managed: ManagedScriptPackage = {
        directory: "tools",
        files: yield* Effect.promise(() => hashDirectory(rootPath)),
        installedAt: new Date(0).toISOString(),
        name: "tools",
        source: {
          kind: "repository",
          repositoryUrl: "https://github.com/example/tools",
          resolvedCommit: "abc123",
        },
      };
      const replaced = yield* catalog.replacePackage({
        inspected,
        managed,
        rootPath,
        sourceRoot,
      });
      expect(replaced.scriptCount).toBe(2);
      expect(scanCount()).toBe(1);
      expect(
        (yield* catalog.getPage({
          limit: 128,
          offset: 0,
          query: "tool",
          revision: replaced.revision,
        })).entries[0]?.reference,
      ).toEqual({
        kind: "package",
        packageName: "tools",
        path: "scripts/tool.js",
      });

      const removed = yield* catalog.removePackage("tools");
      expect(removed.scriptCount).toBe(1);
      expect(scanCount()).toBe(1);
    }),
  );

  it.live.each(["refresh", "remove"] as const)(
    "allows a %s listener to read the committed catalog",
    (operation) =>
      Effect.gen(function* () {
        const { catalog, workspace } = yield* makeCatalogHarness();
        yield* Effect.promise(() =>
          write(
            join(workspace.packagesDir, "tools", "package.json"),
            '{"name":"tools"}',
          ),
        );
        yield* catalog.getOverview;
        const names: (readonly string[])[] = [];
        yield* catalog.onChanged(() =>
          catalog.getOverview.pipe(
            Effect.tap((overview) =>
              Effect.sync(() => {
                names.push(
                  overview.packages.map((entry) => entry.name ?? "invalid"),
                );
              }),
            ),
          ),
        );
        const result = yield* (
          operation === "refresh"
            ? catalog.refresh
            : catalog.removePackage("tools")
        ).pipe(Effect.timeout("2 seconds"));
        expect(names).toEqual([operation === "refresh" ? ["tools"] : []]);
        expect(result.packages.map((entry) => entry.name)).toEqual(
          operation === "refresh" ? ["tools"] : [],
        );
      }),
  );

  it.effect.each(["refresh", "remove"] as const)(
    "publishes a committed %s even when interrupted after the commit",
    (operation) =>
      Effect.gen(function* () {
        const committed = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        let armed = false;
        const modifyEffect = SynchronizedRef.modifyEffect;
        vi.spyOn(SynchronizedRef, "modifyEffect").mockImplementation(
          (ref, change) =>
            modifyEffect(ref, change).pipe(
              Effect.tap(() => {
                if (!armed) return Effect.void;
                armed = false;
                return Deferred.succeed(committed, undefined).pipe(
                  Effect.andThen(Deferred.await(hold)),
                );
              }),
            ),
        );
        const { catalog, workspace } = yield* makeCatalogHarness();
        yield* Effect.promise(() =>
          write(
            join(workspace.packagesDir, "tools", "package.json"),
            '{"name":"tools"}',
          ),
        );
        yield* catalog.getOverview;
        if (operation === "refresh")
          yield* Effect.promise(() =>
            write(join(workspace.scriptsDir, "second.js"), ""),
          );
        const received: {
          revision: string;
          names: readonly string[];
          count: number;
        }[] = [];
        yield* catalog.onChanged((change) =>
          catalog.getOverview.pipe(
            Effect.tap((current) =>
              Effect.sync(() => {
                received.push({
                  revision: change.revision,
                  names: current.packages.map(
                    (entry) => entry.name ?? "missing",
                  ),
                  count: current.scriptCount,
                });
              }),
            ),
          ),
        );
        armed = true;
        const running = yield* (
          operation === "refresh"
            ? catalog.refresh
            : catalog.removePackage("tools")
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(committed);
        const current = yield* catalog.getOverview;
        expect(current.scriptCount).toBe(operation === "refresh" ? 2 : 1);
        expect(current.packages.map((entry) => entry.name)).toEqual(
          operation === "refresh" ? ["tools"] : [],
        );
        yield* Fiber.interrupt(running);
        expect(received).toEqual([
          {
            revision: current.revision,
            names: operation === "refresh" ? ["tools"] : [],
            count: operation === "refresh" ? 2 : 1,
          },
        ]);
      }),
  );

  it.effect(
    "interrupts a scan before commit without repeating the previous event",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let block = false;
        const { catalog } = yield* makeCatalogHarness(
          Effect.suspend(() =>
            block
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                )
              : Effect.void,
          ),
        );
        const initial = yield* catalog.refresh;
        const revisions: string[] = [];
        yield* catalog.onChanged((change) => {
          revisions.push(change.revision);
        });
        block = true;
        const scanning = yield* catalog.refresh.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const stopping = yield* Fiber.interrupt(scanning).pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        const outcome = scanning.pollUnsafe();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        expect(outcome).toMatchObject({ _tag: "Failure" });
        expect(yield* catalog.getOverview).toEqual(initial);
        expect(revisions).toEqual([]);
      }),
  );
});
