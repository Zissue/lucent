import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeScriptFiles, ScriptFiles } from "./ScriptFiles";
import { processScriptFile } from "./ScriptFileAnalysis";
import {
  discoverScriptCatalog,
  type DiscoveredScriptCatalog,
  ScriptPackageCatalog,
} from "./ScriptPackageCatalog";
import {
  layer as scriptSourceRegistryLayer,
  ScriptSourceRegistry,
} from "./ScriptSourceRegistry";

const directories: string[] = [];

const write = async (path: string, source: string): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, source, "utf8");
};

const makeWorkspace = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-script-sources-"));
  directories.push(root);
  const scriptsDir = join(root, "scripts");
  const packagesDir = join(root, "packages");
  await Promise.all([
    fs.mkdir(scriptsDir, { recursive: true }),
    fs.mkdir(packagesDir, { recursive: true }),
  ]);
  return { packagesDir, scriptsDir };
};

const makeLayer = (discovery: DiscoveredScriptCatalog) => {
  const overview = {
    packages: discovery.catalog.packages,
    revision: discovery.catalog.revision,
    scriptCount: discovery.catalog.scripts.length,
  };
  const catalog = ScriptPackageCatalog.of({
    getDiscovery: Effect.succeed(discovery),
    getOverview: Effect.succeed(overview),
    getPage: (request) =>
      Effect.succeed({
        entries: discovery.catalog.scripts.slice(
          request.offset,
          request.offset + request.limit,
        ),
        offset: request.offset,
        revision: discovery.catalog.revision,
        total: discovery.catalog.scripts.length,
      }),
    onChanged: () => Effect.succeed(() => undefined),
    referenceForPath: (path) => Effect.succeed(discovery.paths.get(path)),
    refresh: Effect.succeed(overview),
    removePackage: () => Effect.succeed(overview),
    replacePackage: () => Effect.succeed(overview),
    resolveReference: (reference) =>
      Effect.succeed(
        discovery.scripts.get(
          reference.kind === "loose"
            ? `loose:${reference.path}`
            : `package:${reference.packageName}:${reference.path}`,
        ),
      ),
    updateManagedPackage: () => Effect.succeed(overview),
  });
  return scriptSourceRegistryLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ScriptPackageCatalog, catalog),
        Layer.succeed(
          ScriptFiles,
          makeScriptFiles((path) => processScriptFile(path)),
        ),
      ),
    ),
  );
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("script source dependency discovery", () => {
  it.effect(
    "collects relative, package, and cyclic reachable modules only",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Effect.promise(makeWorkspace);
        yield* Effect.promise(() =>
          Promise.all([
            write(
              join(workspace.scriptsDir, "entry.js"),
              `
              require("lucent/api");
              require("lucent/autorelogin");
              require("lucent/autozone");
              require("lucent/filesystem");
              require("lucent/schema");
              require("lucent/http");
              require("lucent/script");
              require("effect");
              require("./lib/helper");
              require("tools");
              module.exports = function* run() {};
            `,
            ),
            write(
              join(workspace.scriptsDir, "lib", "helper.js"),
              'require("./cycle"); exports.value = 1;',
            ),
            write(
              join(workspace.scriptsDir, "lib", "cycle.js"),
              'require("./helper"); exports.value = 2;',
            ),
            write(
              join(workspace.scriptsDir, "unrelated.js"),
              "throw new Error('must not be snapshotted');",
            ),
            write(
              join(workspace.packagesDir, "tools", "package.json"),
              '{"name":"tools","main":"index.js"}',
            ),
            write(
              join(workspace.packagesDir, "tools", "index.js"),
              'require("./lib/value"); exports.value = 1;',
            ),
            write(
              join(workspace.packagesDir, "tools", "lib", "value.js"),
              "exports.value = 2;",
            ),
            write(
              join(workspace.packagesDir, "tools", "lib", "unrelated.js"),
              "throw new Error('must not be snapshotted');",
            ),
          ]),
        );
        const discovery = yield* Effect.promise(() =>
          discoverScriptCatalog({
            currentVersion: "1.0.0",
            packagesDir: workspace.packagesDir,
            scriptsDir: workspace.scriptsDir,
          }),
        );
        const registry = yield* ScriptSourceRegistry.pipe(
          Effect.provide(makeLayer(discovery)),
        );

        const file = yield* registry.readReference({
          kind: "loose",
          path: "entry.js",
        });

        expect(file.snapshot?.modules.map((module) => module.id)).toEqual([
          "loose:entry.js",
          "loose:lib/cycle.js",
          "loose:lib/helper.js",
          "package:tools:index.js",
          "package:tools:lib/value.js",
        ]);
        expect(file.snapshot?.packages.map((entry) => entry.name)).toEqual([
          "tools",
        ]);
      }),
  );

  it.effect("resolves package scripts and imports on prerelease builds", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(makeWorkspace);
      const firstRoot = join(workspace.packagesDir, "lucent-first");
      const secondRoot = join(workspace.packagesDir, "lucent-second");
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(firstRoot, "package.json"),
            JSON.stringify({
              name: "@lucent/first",
              version: "1.0.0",
              lucent: {
                version: ">=1.0.0 <2.0.0",
                dependencies: { "@lucent/second": "^2.0.0" },
              },
            }),
          ),
          write(join(firstRoot, "index.js"), 'exports.first = "first";'),
          write(
            join(firstRoot, "scripts", "run.js"),
            `
              const first = require("@lucent/first");
              const second = require("@lucent/second");
              module.exports = function* run() {
                return [first.first, second.second];
              };
            `,
          ),
          write(
            join(secondRoot, "package.json"),
            JSON.stringify({
              name: "@lucent/second",
              version: "2.1.0",
              lucent: { version: ">=1.0.0 <2.0.0" },
            }),
          ),
          write(join(secondRoot, "index.js"), 'exports.second = "second";'),
        ]),
      );
      const discovery = yield* Effect.promise(() =>
        discoverScriptCatalog({
          currentVersion: "1.0.1-beta.1",
          packagesDir: workspace.packagesDir,
          scriptsDir: workspace.scriptsDir,
        }),
      );
      const registry = yield* ScriptSourceRegistry.pipe(
        Effect.provide(makeLayer(discovery)),
      );

      const file = yield* registry.readReference({
        kind: "package",
        packageName: "@lucent/first",
        path: "scripts/run.js",
      });

      expect(file.snapshot?.modules.map((module) => module.id)).toEqual([
        "package:@lucent/first:index.js",
        "package:@lucent/first:scripts/run.js",
        "package:@lucent/second:index.js",
      ]);
      expect(
        file.snapshot?.modules.find(
          (module) => module.id === "package:@lucent/first:scripts/run.js",
        )?.imports,
      ).toEqual({
        "@lucent/first": {
          kind: "module",
          moduleId: "package:@lucent/first:index.js",
        },
        "@lucent/second": {
          kind: "module",
          moduleId: "package:@lucent/second:index.js",
        },
      });
    }),
  );

  it.effect("rejects undeclared package imports before execution", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(makeWorkspace);
      const firstRoot = join(workspace.packagesDir, "first");
      const secondRoot = join(workspace.packagesDir, "second");
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(firstRoot, "package.json"),
            JSON.stringify({ name: "first", version: "1.0.0" }),
          ),
          write(join(firstRoot, "index.js"), "exports.value = true;"),
          write(
            join(firstRoot, "scripts", "run.js"),
            'require("second"); module.exports = function* run() {};',
          ),
          write(
            join(secondRoot, "package.json"),
            JSON.stringify({ name: "second", version: "1.0.0" }),
          ),
          write(join(secondRoot, "index.js"), "exports.value = true;"),
        ]),
      );
      const discovery = yield* Effect.promise(() =>
        discoverScriptCatalog({
          currentVersion: "1.0.0",
          packagesDir: workspace.packagesDir,
          scriptsDir: workspace.scriptsDir,
        }),
      );
      const registry = yield* ScriptSourceRegistry.pipe(
        Effect.provide(makeLayer(discovery)),
      );

      const error = yield* registry
        .readReference({
          kind: "package",
          packageName: "first",
          path: "scripts/run.js",
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("lucent.dependencies");
      expect(error.message).toContain("second");
    }),
  );

  it.effect("keeps computed dependencies outside the prepared snapshot", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(makeWorkspace);
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(workspace.scriptsDir, "entry.js"),
            `
              const computed = "./computed";
              if (false) require(computed);
              module.exports = function* run() {};
            `,
          ),
          write(
            join(workspace.scriptsDir, "computed.js"),
            "exports.value = 1;",
          ),
        ]),
      );
      const discovery = yield* Effect.promise(() =>
        discoverScriptCatalog({
          currentVersion: "1.0.0",
          packagesDir: workspace.packagesDir,
          scriptsDir: workspace.scriptsDir,
        }),
      );
      const registry = yield* ScriptSourceRegistry.pipe(
        Effect.provide(makeLayer(discovery)),
      );

      const file = yield* registry.readReference({
        kind: "loose",
        path: "entry.js",
      });

      expect(file.snapshot?.modules.map((module) => module.id)).toEqual([
        "loose:entry.js",
      ]);
    }),
  );

  it.effect("rejects unresolved literal imports before execution", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(makeWorkspace);
      yield* Effect.promise(() =>
        write(
          join(workspace.scriptsDir, "entry.js"),
          'if (false) require("./missing"); module.exports = function* run() {};',
        ),
      );
      const discovery = yield* Effect.promise(() =>
        discoverScriptCatalog({
          currentVersion: "1.0.0",
          packagesDir: workspace.packagesDir,
          scriptsDir: workspace.scriptsDir,
        }),
      );
      const registry = yield* ScriptSourceRegistry.pipe(
        Effect.provide(makeLayer(discovery)),
      );

      const error = yield* registry
        .readReference({ kind: "loose", path: "entry.js" })
        .pipe(Effect.flip);

      expect(error.message).toContain("relative module was not found");
      expect(error.message).toContain("./missing");
    }),
  );
});
