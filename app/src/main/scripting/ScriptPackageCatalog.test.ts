import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as References from "effect/References";

import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { ElectronApp } from "../electron/ElectronApp";
import { hashDirectory } from "./ScriptPackageFileSystem";
import {
  discoverScriptCatalog,
  inspectScriptPackageDirectory,
  layer as scriptPackageCatalogLayer,
  ScriptPackageCatalog,
} from "./ScriptPackageCatalog";
import {
  type ManagedScriptPackage,
  ScriptPackageState,
} from "./ScriptPackageState";

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

const makeCatalogHarness = (onScan: Effect.Effect<void> = Effect.void) =>
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
      on: () => Effect.succeed(() => undefined),
      quit: Effect.void,
      relaunch: Effect.void,
      whenReady: Effect.void,
    });
    const state = ScriptPackageState.of({
      get: () => Effect.sync((): ManagedScriptPackage | undefined => undefined),
      getAll: Effect.sync(() => {
        scanCount += 1;
        return [];
      }).pipe(Effect.tap(() => onScan)),
      remove: () => Effect.void,
      save: () => Effect.void,
    });
    const testLayer = scriptPackageCatalogLayer.pipe(
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
        expect(revisions).toEqual([refreshed.revision, removed.revision]);
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
      const initial = yield* catalog.getOverview;
      yield* Effect.promise(async () => {
        await fs.rm(workspace.packagesDir, { recursive: true });
        await fs.writeFile(workspace.packagesDir, "not a directory");
      });
      const failure = yield* catalog.refresh.pipe(Effect.flip);
      expect(failure.operation).toBe("scan");
      expect(yield* catalog.getOverview).toEqual(initial);
      yield* Effect.promise(async () => {
        await fs.unlink(workspace.packagesDir);
        await write(join(workspace.scriptsDir, "second.js"), "");
      });
      expect((yield* catalog.refresh).scriptCount).toBe(2);
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
});
