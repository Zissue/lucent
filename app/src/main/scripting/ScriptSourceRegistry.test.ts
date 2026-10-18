import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { vi } from "vitest";
import { desktopLogRecord } from "../../shared/logRecord";

import { makeScriptFiles, ScriptFiles } from "./ScriptFiles";
import * as ScriptSourceParser from "./ScriptSourceParser";
import {
  discoverScriptCatalog,
  type DiscoveredScriptCatalog,
} from "./ScriptCatalogDiscovery";
import {
  ScriptPackageCatalog,
  ScriptPackageCatalogError,
  type ScriptPackageCatalogShape,
} from "./ScriptPackageCatalog";
import {
  makeScriptSourceRegistry,
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

const makeLayer = (
  discovery: DiscoveredScriptCatalog,
  scriptFiles = makeScriptFiles(),
  limits?: Parameters<typeof makeScriptSourceRegistry>[0],
  catalogOverrides: Partial<ScriptPackageCatalogShape> = {},
) => {
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
    onChanged: () => Effect.void,
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
    ...catalogOverrides,
  });
  return Layer.effect(
    ScriptSourceRegistry,
    makeScriptSourceRegistry(limits),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ScriptPackageCatalog, catalog),
        Layer.succeed(ScriptFiles, scriptFiles),
      ),
    ),
  );
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("script source dependency discovery", () => {
  for (const kind of ["loose", "package"] as const) {
    it.effect(`keeps the ${kind} sources read while preparing a snapshot`, () =>
      Effect.gen(function* () {
        const workspace = yield* Effect.promise(makeWorkspace);
        const root =
          kind === "loose"
            ? workspace.scriptsDir
            : join(workspace.packagesDir, "tools");
        const entryPath = join(root, "scripts", "run.js");
        const helperPath = join(root, "helper.js");
        const initialSource =
          'require("../helper"); module.exports = function* initial() {};';
        const updatedSource =
          'require("../helper"); module.exports = function* updatedScript() {};';
        yield* Effect.promise(() =>
          Promise.all([
            ...(kind === "package"
              ? [write(join(root, "package.json"), '{"name":"tools"}')]
              : []),
            write(entryPath, initialSource),
            write(helperPath, "exports.value = 1;"),
          ]),
        );
        const discovery = yield* Effect.promise(() =>
          discoverScriptCatalog({
            currentVersion: "1.0.0",
            packagesDir: workspace.packagesDir,
            scriptsDir: workspace.scriptsDir,
          }),
        );
        const scriptFiles = makeScriptFiles();
        const registry = yield* ScriptSourceRegistry.pipe(
          Effect.provide(
            makeLayer(discovery, {
              ...scriptFiles,
              analyze: Effect.fnUntraced(function* (path: string) {
                const analysis = yield* scriptFiles.analyze(path);
                if (path === helperPath) {
                  yield* Effect.promise(() =>
                    Promise.all([
                      write(entryPath, updatedSource),
                      write(helperPath, "exports.value = 20;"),
                    ]),
                  );
                }
                return analysis;
              }),
            }),
          ),
        );
        const reference =
          kind === "loose"
            ? ({ kind, path: "scripts/run.js" } as const)
            : ({ kind, packageName: "tools", path: "scripts/run.js" } as const);

        const initial = yield* registry.readReference(reference);
        const updated = yield* registry.readReference(reference);

        expect(initial.source).toBe(initialSource);
        expect(
          initial.snapshot?.modules.map((module) => module.source),
        ).toEqual(["exports.value = 1;", initialSource]);
        expect(updated.source).toBe(updatedSource);
        expect(
          updated.snapshot?.modules.map((module) => module.source),
        ).toEqual(["exports.value = 20;", updatedSource]);
      }),
    );
  }

  it.effect("rejects unavailable package entries and module targets", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(makeWorkspace);
      const root = join(workspace.packagesDir, "tools");
      yield* Effect.promise(() =>
        Promise.all([
          write(join(root, "package.json"), '{"name":"tools"}'),
          write(
            join(root, "scripts", "run.js"),
            "module.exports = function* run() {};",
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
      for (const missing of ["entry", "module"] as const) {
        const registry = yield* ScriptSourceRegistry.pipe(
          Effect.provide(
            makeLayer(
              discovery,
              undefined,
              undefined,
              missing === "entry"
                ? { resolveReference: () => Effect.succeed(undefined) }
                : {
                    getDiscovery: Effect.succeed({
                      ...discovery,
                      packages: new Map(),
                    }),
                  },
            ),
          ),
        );

        const error = yield* registry
          .readReference({
            kind: "package",
            packageName: "tools",
            path: "scripts/run.js",
          })
          .pipe(Effect.flip);

        expect(error.message).toBe(
          "The selected script is no longer available.",
        );
        expect(error.path).toBe(
          missing === "entry" ? undefined : join(root, "scripts", "run.js"),
        );
      }
    }),
  );

  it.effect("counts concurrent cache misses for one file once", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(makeWorkspace);
      const sharedPath = join(workspace.scriptsDir, "shared.js");
      const otherPath = join(workspace.scriptsDir, "other.js");
      yield* Effect.promise(() =>
        Promise.all([
          write(join(workspace.scriptsDir, "entry.js"), 'require("./shared");'),
          write(join(workspace.scriptsDir, "probe.js"), 'require("./other");'),
          write(sharedPath, "exports.value = 1;"),
          write(otherPath, "exports.value = 2;"),
        ]),
      );
      const discovery = yield* Effect.promise(() =>
        discoverScriptCatalog({
          currentVersion: "1.0.0",
          packagesDir: workspace.packagesDir,
          scriptsDir: workspace.scriptsDir,
        }),
      );
      const bothReading = yield* Deferred.make<void>();
      const scriptFiles = makeScriptFiles();
      let sharedReads = 0;
      let otherReads = 0;
      const registry = yield* ScriptSourceRegistry.pipe(
        Effect.provide(
          makeLayer(
            discovery,
            {
              ...scriptFiles,
              analyze: Effect.fnUntraced(function* (path: string) {
                if (path === sharedPath) {
                  sharedReads += 1;
                  if (sharedReads === 2) {
                    yield* Deferred.succeed(bothReading, undefined);
                  }
                  if (sharedReads <= 2) yield* Deferred.await(bothReading);
                }
                if (path === otherPath) otherReads += 1;
                return yield* scriptFiles.analyze(path);
              }),
            },
            { maxBytes: 36, maxEntries: 8 },
          ),
        ),
      );
      const readShared = registry.readReference({
        kind: "loose",
        path: "entry.js",
      });

      const concurrent = yield* Effect.all([readShared, readShared], {
        concurrency: 2,
      });
      const probe = yield* registry.readReference({
        kind: "loose",
        path: "probe.js",
      });
      const repeated = yield* readShared;

      expect(
        [...concurrent, repeated].map(
          (file) =>
            file.snapshot?.modules.find((module) => module.path === "shared.js")
              ?.source,
        ),
      ).toEqual([
        "exports.value = 1;",
        "exports.value = 1;",
        "exports.value = 1;",
      ]);
      expect(
        probe.snapshot?.modules.find((module) => module.path === "other.js")
          ?.source,
      ).toBe("exports.value = 2;");
      expect([sharedReads, otherReads]).toEqual([2, 1]);
    }),
  );

  it.effect(
    "enforces the byte limit after concurrent shrinking replacements",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Effect.promise(makeWorkspace);
        const sharedPath = join(workspace.scriptsDir, "shared.js");
        yield* Effect.promise(() =>
          Promise.all([
            write(
              join(workspace.scriptsDir, "entry.js"),
              'require("./shared");',
            ),
            write(
              join(workspace.scriptsDir, "probe.js"),
              'require("./other"); require("./tiny");',
            ),
            write(sharedPath, "exports.value = 100;"),
            write(join(workspace.scriptsDir, "other.js"), "exports.value = 2;"),
            write(join(workspace.scriptsDir, "tiny.js"), "0;"),
          ]),
        );
        const discovery = yield* Effect.promise(() =>
          discoverScriptCatalog({
            currentVersion: "1.0.0",
            packagesDir: workspace.packagesDir,
            scriptsDir: workspace.scriptsDir,
          }),
        );
        const bothReading = yield* Deferred.make<void>();
        const scriptFiles = makeScriptFiles();
        let sharedReads = 0;
        const registry = yield* ScriptSourceRegistry.pipe(
          Effect.provide(
            makeLayer(
              discovery,
              {
                ...scriptFiles,
                analyze: Effect.fnUntraced(function* (path: string) {
                  if (path === sharedPath) {
                    sharedReads += 1;
                    if (sharedReads === 3) {
                      yield* Deferred.succeed(bothReading, undefined);
                    }
                    if (sharedReads === 2 || sharedReads === 3) {
                      yield* Deferred.await(bothReading);
                    }
                  }
                  return yield* scriptFiles.analyze(path);
                }),
              },
              { maxBytes: 36, maxEntries: 8 },
            ),
          ),
        );
        const readShared = registry.readReference({
          kind: "loose",
          path: "entry.js",
        });
        const initial = yield* readShared;
        yield* Effect.promise(() => write(sharedPath, "exports.value = 1;"));

        const concurrent = yield* Effect.all([readShared, readShared], {
          concurrency: 2,
        });
        const probe = yield* registry.readReference({
          kind: "loose",
          path: "probe.js",
        });
        const repeated = yield* readShared;

        expect(
          initial.snapshot?.modules.find(
            (module) => module.path === "shared.js",
          )?.source,
        ).toBe("exports.value = 100;");
        expect(
          [...concurrent, repeated].map(
            (file) =>
              file.snapshot?.modules.find(
                (module) => module.path === "shared.js",
              )?.source,
          ),
        ).toEqual([
          "exports.value = 1;",
          "exports.value = 1;",
          "exports.value = 1;",
        ]);
        expect(probe.snapshot?.modules.map((module) => module.source)).toEqual([
          "exports.value = 2;",
          'require("./other"); require("./tiny");',
          "0;",
        ]);
        expect(sharedReads).toBe(4);
      }),
  );

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

  it.effect("snapshots a package script with a 3 MiB vendor module", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(makeWorkspace);
      const packageRoot = join(workspace.packagesDir, "tools");
      const vendorSource = "exports.value = 7;\n".padEnd(3 * 1024 * 1024, " ");
      yield* Effect.promise(() =>
        Promise.all([
          write(
            join(packageRoot, "package.json"),
            JSON.stringify({ name: "tools", version: "1.0.0" }),
          ),
          write(
            join(packageRoot, "scripts", "run.js"),
            'require("../vendor"); module.exports = function* run() {};',
          ),
          write(join(packageRoot, "vendor.js"), vendorSource),
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
        kind: "package",
        packageName: "tools",
        path: "scripts/run.js",
      });

      expect(file.snapshot?.modules.map((module) => module.id)).toEqual([
        "package:tools:scripts/run.js",
        "package:tools:vendor.js",
      ]);
      expect(
        file.snapshot?.modules.find(
          (module) => module.id === "package:tools:vendor.js",
        )?.source,
      ).toBe(vendorSource);
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

describe("terminal script resolution logging", () => {
  for (const method of ["resolvePath", "resolveReference"] as const) {
    it.effect(`logs one analyzer failure through ${method}`, () =>
      Effect.gen(function* () {
        const workspace = yield* Effect.promise(makeWorkspace);
        const path = join(workspace.scriptsDir, "entry.js");
        yield* Effect.promise(() =>
          write(path, "module.exports = function* run() {};"),
        );
        const discovery = yield* Effect.promise(() =>
          discoverScriptCatalog({
            currentVersion: "1.0.0",
            packagesDir: workspace.packagesDir,
            scriptsDir: workspace.scriptsDir,
          }),
        );
        vi.spyOn(ScriptSourceParser, "analyzeScriptSource").mockReturnValue(
          Effect.die(new Error("Analyzer defect")),
        );
        const registry = yield* ScriptSourceRegistry.pipe(
          Effect.provide(makeLayer(discovery)),
        );
        const logs: unknown[] = [];
        const operation =
          method === "resolvePath"
            ? registry.resolvePath(path)
            : registry.resolveReference({ kind: "loose", path: "entry.js" });
        const result = yield* operation.pipe(
          Effect.withLogger(
            Logger.make((options) => {
              const { level, component, message, data, repeatKey } =
                desktopLogRecord(options);
              logs.push({ level, component, message, data, repeatKey });
            }),
          ),
        );
        expect(result).toMatchObject({
          status: "failed",
          path: "entry.js",
          message: "Analyzer defect",
        });
        expect(logs).toEqual([
          {
            level: "error",
            component: "script-files",
            message: "Script file analysis failed unexpectedly",
            data: { path: "entry.js" },
            repeatKey: "entry.js",
          },
        ]);
      }),
    );
  }

  it.effect(
    "logs unexpected reads once and keeps missing and invalid sources silent",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Effect.promise(makeWorkspace);
        const path = join(workspace.scriptsDir, "entry.js");
        yield* Effect.promise(() =>
          write(path, "module.exports = function* run() {};"),
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
        const logs: unknown[] = [];
        const logger = Logger.make((options) => {
          const { level, component, message, data, repeatKey } =
            desktopLogRecord(options);
          logs.push({ level, component, message, data, repeatKey });
        });
        const reference = { kind: "loose", path: "entry.js" } as const;
        vi.spyOn(fs, "stat").mockRejectedValueOnce(
          Object.assign(new Error("access denied"), { code: "EACCES" }),
        );
        const failed = yield* registry
          .resolveReference(reference)
          .pipe(Effect.withLogger(logger));
        vi.restoreAllMocks();
        yield* Effect.promise(() =>
          write(path, "module.exports = function* ("),
        );
        const malformed = yield* registry
          .resolveReference(reference)
          .pipe(Effect.withLogger(logger));
        yield* Effect.promise(() => write(path, 'require("./missing");'));
        const invalidImport = yield* registry
          .resolveReference(reference)
          .pipe(Effect.withLogger(logger));
        yield* Effect.promise(() => fs.rm(path));
        const missing = yield* registry
          .resolveReference(reference)
          .pipe(Effect.withLogger(logger));
        expect(failed).toMatchObject({
          status: "failed",
          path: "entry.js",
          message: "access denied",
        });
        expect(malformed).toMatchObject({
          status: "failed",
          message: "Script source could not be parsed.",
        });
        expect(invalidImport).toMatchObject({
          status: "failed",
          message:
            'entry.js can\'t import "./missing". The relative module was not found.',
        });
        expect(missing).toMatchObject({
          status: "failed",
          message: `Script file was not found at ${path}.`,
        });
        expect(logs).toEqual([
          {
            level: "warn",
            component: "script-files",
            message: "Failed to resolve script file",
            data: { path: "entry.js" },
            repeatKey: "entry.js",
          },
        ]);
      }),
  );

  for (const method of ["resolvePath", "resolveReference"] as const) {
    it.effect(
      `logs a catalog failure converted by ${method} and keeps absent entries silent`,
      () =>
        Effect.gen(function* () {
          const workspace = yield* Effect.promise(makeWorkspace);
          const discovery = yield* Effect.promise(() =>
            discoverScriptCatalog({
              currentVersion: "1.0.0",
              packagesDir: workspace.packagesDir,
              scriptsDir: workspace.scriptsDir,
            }),
          );
          const path = join(workspace.scriptsDir, "missing.js");
          const failing = yield* ScriptSourceRegistry.pipe(
            Effect.provide(
              makeLayer(discovery, undefined, undefined, {
                [method === "resolvePath"
                  ? "referenceForPath"
                  : "resolveReference"]: () =>
                  Effect.fail(
                    new ScriptPackageCatalogError({
                      operation: "scan",
                      cause: new Error("access denied"),
                    }),
                  ),
              }),
            ),
          );
          const normal = yield* ScriptSourceRegistry.pipe(
            Effect.provide(makeLayer(discovery)),
          );
          const logs: unknown[] = [];
          const logger = Logger.make((options) => {
            const { level, component, message, data, repeatKey } =
              desktopLogRecord(options);
            logs.push({ level, component, message, data, repeatKey });
          });
          const request = (registry: typeof normal) =>
            method === "resolvePath"
              ? registry.resolvePath(path)
              : registry.resolveReference({
                  kind: "loose",
                  path: "missing.js",
                });
          const result = yield* request(failing).pipe(
            Effect.withLogger(logger),
          );
          const missing = yield* request(normal).pipe(
            Effect.withLogger(logger),
          );
          const displayPath = method === "resolvePath" ? path : "missing.js";
          expect(result).toMatchObject({
            status: "failed",
            path: displayPath,
            message: "Failed to scan the script package catalog.",
          });
          expect(missing).toEqual({ status: "missing", path: displayPath });
          expect(logs).toEqual([
            {
              level: "warn",
              component: "script-files",
              message: "Failed to resolve script file",
              data: { path: displayPath },
              repeatKey: displayPath,
            },
          ]);
        }),
    );
  }
});
