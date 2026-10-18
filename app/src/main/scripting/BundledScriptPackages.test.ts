import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { ElectronApp } from "../electron/ElectronApp";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { copyBundledScriptPackage } from "./BundledScriptPackageSnapshot";
import {
  BundledScriptPackageSetupSchema,
  initializeBundledScriptPackages,
} from "./BundledScriptPackages";
import {
  layer as catalogLayer,
  ScriptPackageCatalog,
} from "./ScriptPackageCatalog";
import { hashDirectory } from "./ScriptPackageFileSystem";
import { pathExists } from "./ScriptPackageDirectories";
import {
  layer as stateLayer,
  ScriptPackageState,
  ScriptPackageStateError,
} from "./ScriptPackageState";

vi.mock("electron", () => ({ app: {} }));

const directories: string[] = [];
const decodeSetupState = Schema.decodeUnknownSync(
  BundledScriptPackageSetupSchema,
);

const write = async (path: string, contents: string): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, contents);
};

const writePackage = async (path: string, name: string, version = "1.0.0") => {
  await write(
    join(path, "package.json"),
    JSON.stringify({
      name,
      version,
      lucent: { version: ">=1.0.0" },
    }),
  );
  await write(
    join(path, "index.js"),
    `exports.version = ${JSON.stringify(version)};\n`,
  );
  await write(
    join(path, "scripts", "run.js"),
    "module.exports = function* () {};\n",
  );
};

const makeFixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-bundled-packages-"));
  directories.push(root);
  const sourceRoot = join(root, "resources", "script-packages");
  const workspace = join(root, "Documents", "Lucent");
  const appData = join(root, "app-data");
  const historyPath = join(workspace, ".script-package-setup.json");
  await fs.mkdir(sourceRoot, { recursive: true });
  const environment = Layer.succeed(
    DesktopEnvironment,
    DesktopEnvironment.of({
      workspaceDir: workspace,
      appDataDir: appData,
      assetsDir: join(root, "resources", "assets"),
      isDev: false,
      platform: "darwin",
    }),
  );
  const app = Layer.succeed(
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
  );

  const makeLayer = (failSaves = false) => {
    const stored = stateLayer.pipe(
      Layer.provide(Layer.mergeAll(environment, desktopFileSystemLayer)),
    );
    const state = failSaves
      ? Layer.effect(
          ScriptPackageState,
          Effect.gen(function* () {
            const original = yield* ScriptPackageState;
            return ScriptPackageState.of({
              ...original,
              save: () =>
                Effect.fail(
                  new ScriptPackageStateError({
                    operation: "save",
                    cause: new Error("Simulated save failure"),
                  }),
                ),
            });
          }),
        ).pipe(Layer.provide(stored))
      : stored;
    return Layer.mergeAll(
      environment,
      desktopFileSystemLayer,
      state,
      catalogLayer.pipe(
        Layer.provide(
          Layer.mergeAll(environment, state, app, desktopFileSystemLayer),
        ),
      ),
    );
  };

  const start = (failSaves = false) =>
    Effect.gen(function* () {
      yield* initializeBundledScriptPackages;
      const catalog = yield* ScriptPackageCatalog;
      const state = yield* ScriptPackageState;
      return {
        catalog: yield* catalog.getOverview,
        managed: yield* state.getAll,
      };
    }).pipe(Effect.provide(makeLayer(failSaves)));

  const readHistory = async (): Promise<unknown> =>
    JSON.parse(await fs.readFile(historyPath, "utf8")) as unknown;

  return {
    root,
    sourceRoot,
    workspace,
    appData,
    historyPath,
    makeLayer,
    start,
    readHistory,
    addPackage: (folder: string, name = folder, version = "1.0.0") =>
      writePackage(join(sourceRoot, folder), name, version),
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

describe("bundled script packages", () => {
  it.effect(
    "installs ordinary managed packages without contacting GitHub",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1234567890000);
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() =>
          fixture.addPackage("farming", "@lucent/farming"),
        );
        const result = yield* fixture.start();
        expect(result.managed[0]?.installedAt).toBe("2009-02-13T23:31:30.000Z");
        expect(result.catalog.scriptCount).toBe(1);
        expect(result.catalog.packages).toMatchObject([
          {
            name: "@lucent/farming",
            integrity: "verified",
            update: { status: "unchecked" },
            source: {
              kind: "directory",
              repositoryUrl: "https://github.com/toommyliu/lucent",
              subdirectory: "script-packages/farming",
            },
          },
        ]);
        expect(result.managed[0]?.files).toEqual(
          yield* Effect.promise(() =>
            hashDirectory(join(fixture.sourceRoot, "farming")),
          ),
        );
        expect(yield* Effect.promise(fixture.readHistory)).toEqual({
          version: 1,
          completed: ["@lucent/farming"],
        });
      }),
  );

  it.effect(
    "adds new packages without restoring removals or overwriting installed versions",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() =>
          Promise.all([fixture.addPackage("a"), fixture.addPackage("b")]),
        );
        yield* fixture.start();
        const packages = join(fixture.workspace, "packages");
        yield* Effect.promise(() =>
          Promise.all([
            fs.rm(join(packages, "a"), { recursive: true }),
            writePackage(join(packages, "b"), "b", "3.0.0"),
            fixture.addPackage("a", "a", "2.0.0"),
            fixture.addPackage("b", "b", "2.0.0"),
            fixture.addPackage("c"),
          ]),
        );

        const result = yield* fixture.start();
        expect(result.catalog.packages.map((entry) => entry.name)).toEqual([
          "b",
          "c",
        ]);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(packages, "b", "index.js"), "utf8"),
          ),
        ).toContain('"3.0.0"');
        expect(
          yield* Effect.promise(() => pathExists(join(packages, "a"))),
        ).toBe(false);
        expect(yield* Effect.promise(fixture.readHistory)).toEqual({
          version: 1,
          completed: ["a", "b", "c"],
        });
      }),
  );

  it.effect(
    "resets only with the whole workspace, not the packages directory or app data",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() => fixture.addPackage("a"));
        yield* fixture.start();
        yield* Effect.promise(() =>
          fs.rm(join(fixture.workspace, "packages"), { recursive: true }),
        );
        expect((yield* fixture.start()).catalog.packages).toEqual([]);
        yield* Effect.promise(() =>
          fs.rm(fixture.appData, { recursive: true, force: true }),
        );
        expect((yield* fixture.start()).catalog.packages).toEqual([]);
        yield* Effect.promise(() => fixture.addPackage("b"));
        expect(
          (yield* fixture.start()).catalog.packages.map((entry) => entry.name),
        ).toEqual(["b"]);
        yield* Effect.promise(() =>
          fs.rm(fixture.workspace, { recursive: true }),
        );
        expect(
          (yield* fixture.start()).catalog.packages.map((entry) => entry.name),
        ).toEqual(["a", "b"]);
      }),
  );

  it.effect(
    "preserves existing local packages and allocates around occupied folders",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        const packages = join(fixture.workspace, "packages");
        yield* Effect.promise(() =>
          Promise.all([
            fixture.addPackage("one", "same-name"),
            fixture.addPackage("two", "new-name"),
            writePackage(join(packages, "custom-folder"), "same-name", "9.0.0"),
            writePackage(join(packages, "new-name"), "someone-else"),
          ]),
        );
        const result = yield* fixture.start();
        expect(result.managed.map((entry) => entry.name)).toEqual(["new-name"]);
        expect(result.managed[0]?.directory).toBe("new-name-2");
        expect(
          result.catalog.packages.find((entry) => entry.name === "same-name"),
        ).toMatchObject({
          integrity: "unmanaged",
          version: "9.0.0",
        });
        expect(
          yield* Effect.promise(() =>
            fs.readFile(join(packages, "new-name", "package.json"), "utf8"),
          ),
        ).toContain("someone-else");
      }),
  );

  it.effect("adopts an identical local package in its existing folder", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() => fixture.addPackage("one", "same-name"));
      const destination = join(fixture.workspace, "packages", "custom-folder");
      yield* Effect.promise(() => writePackage(destination, "same-name"));
      const result = yield* fixture.start();
      expect(result.managed).toMatchObject([
        {
          name: "same-name",
          directory: "custom-folder",
          source: { subdirectory: "script-packages/one" },
        },
      ]);
      expect(result.catalog.packages).toMatchObject([
        { name: "same-name", version: "1.0.0", integrity: "verified" },
      ]);
      expect(
        yield* Effect.promise(() =>
          fs.readdir(join(fixture.workspace, "packages")),
        ),
      ).toEqual(["custom-folder"]);
      expect(yield* Effect.promise(fixture.readHistory)).toEqual({
        version: 1,
        completed: ["same-name"],
      });
    }),
  );

  it.effect("preserves completed packages from the old journal format", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() =>
        Promise.all([
          fixture.addPackage("a"),
          fixture.addPackage("b"),
          write(
            fixture.historyPath,
            JSON.stringify({ version: 1, completed: ["a"], pending: [] }),
          ),
        ]),
      );
      const result = yield* fixture.start();
      expect(result.catalog.packages).toMatchObject([
        { name: "b", integrity: "verified" },
      ]);
      expect(result.managed.map((entry) => entry.name)).toEqual(["b"]);
      expect(yield* Effect.promise(fixture.readHistory)).toEqual({
        version: 1,
        completed: ["a", "b"],
      });
    }),
  );

  it.effect("does not treat corrupt setup history as a first install", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() => fixture.addPackage("a"));
      yield* Effect.promise(() => write(fixture.historyPath, "{broken"));
      expect((yield* fixture.start()).catalog.packages).toEqual([]);
      expect(
        yield* Effect.promise(() => fs.readFile(fixture.historyPath, "utf8")),
      ).toBe("{broken");
    }),
  );

  it.effect(
    "retries an invalid bundle later while preserving successful installations",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() =>
          Promise.all([
            fixture.addPackage("a"),
            write(join(fixture.sourceRoot, "b", "package.json"), "{broken"),
          ]),
        );
        expect(
          (yield* fixture.start()).catalog.packages.map((entry) => entry.name),
        ).toEqual(["a"]);
        yield* Effect.promise(() =>
          fs.rm(join(fixture.workspace, "packages", "a"), { recursive: true }),
        );
        yield* Effect.promise(() => fixture.addPackage("b"));
        expect(
          (yield* fixture.start()).catalog.packages.map((entry) => entry.name),
        ).toEqual(["b"]);
      }),
  );

  it.effect("leaves edits after interrupted publication unmanaged", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() => fixture.addPackage("a"));
      yield* fixture.start(true);
      expect(yield* Effect.promise(fixture.readHistory)).toEqual({
        version: 1,
        completed: [],
      });
      const file = join(fixture.workspace, "packages", "a", "index.js");
      yield* Effect.promise(async () => {
        await write(`${file}.tmp`, "user edits\n");
        await fs.rename(`${file}.tmp`, file);
      });
      const result = yield* fixture.start();
      expect(result.catalog.packages).toMatchObject([
        { name: "a", integrity: "unmanaged" },
      ]);
      expect(result.managed).toEqual([]);
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(
        "user edits\n",
      );
      expect(yield* Effect.promise(fixture.readHistory)).toMatchObject({
        completed: ["a"],
      });
    }),
  );

  it.effect("adopts matching files after interrupted publication", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() => fixture.addPackage("a"));
      yield* fixture.start(true);
      expect(yield* Effect.promise(fixture.readHistory)).toEqual({
        version: 1,
        completed: [],
      });
      yield* TestClock.setTime(1234567890000);
      const result = yield* fixture.start();
      expect(result.catalog.packages).toMatchObject([
        { name: "a", version: "1.0.0", integrity: "verified" },
      ]);
      expect(result.managed).toMatchObject([
        {
          name: "a",
          directory: "a",
          installedAt: "2009-02-13T23:31:30.000Z",
          source: {
            repositoryUrl: "https://github.com/toommyliu/lucent",
            subdirectory: "script-packages/a",
          },
        },
      ]);
      expect(
        yield* Effect.promise(() =>
          fs.readdir(join(fixture.workspace, "packages")),
        ),
      ).toEqual(["a"]);
      expect(yield* Effect.promise(fixture.readHistory)).toEqual({
        version: 1,
        completed: ["a"],
      });
      expect((yield* fixture.start()).managed).toMatchObject([
        {
          name: "a",
          directory: "a",
          installedAt: "2009-02-13T23:31:30.000Z",
        },
      ]);
    }),
  );

  it.effect(
    "adopts a republished package after a workspace reset with stale state",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() => fixture.addPackage("a"));
        yield* fixture.start();
        yield* Effect.promise(() =>
          fs.rm(fixture.workspace, { recursive: true }),
        );

        const interrupted = yield* fixture.start(true);
        expect(interrupted.managed).toMatchObject([
          { name: "a", directory: "a" },
        ]);
        expect(interrupted.catalog.packages).toMatchObject([
          { name: "a", integrity: "unmanaged" },
        ]);
        expect(
          yield* Effect.promise(() =>
            fs.readdir(join(fixture.workspace, "packages")),
          ),
        ).toEqual(["a-2"]);
        expect(yield* Effect.promise(fixture.readHistory)).toEqual({
          version: 1,
          completed: [],
        });

        const recovered = yield* fixture.start();
        expect(recovered.managed).toMatchObject([
          { name: "a", directory: "a-2" },
        ]);
        expect(recovered.catalog.packages).toMatchObject([
          { name: "a", version: "1.0.0", integrity: "verified" },
        ]);
        expect(yield* Effect.promise(fixture.readHistory)).toEqual({
          version: 1,
          completed: ["a"],
        });
        expect((yield* fixture.start()).managed).toEqual(recovered.managed);
      }),
  );

  for (const version of ["1.0.0", "2.0.0"]) {
    it.effect(
      `compares replacement files at version ${version} after interrupted publication`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(makeFixture);
          yield* Effect.promise(() => fixture.addPackage("a"));
          yield* fixture.start(true);
          const destination = join(fixture.workspace, "packages", "a");
          yield* Effect.promise(() =>
            fs.rename(destination, join(fixture.root, "original-package")),
          );
          yield* Effect.promise(() => writePackage(destination, "a", version));

          const result = yield* fixture.start();
          if (version === "1.0.0") {
            expect(result.managed).toMatchObject([
              { name: "a", directory: "a" },
            ]);
            expect(result.catalog.packages).toMatchObject([
              { name: "a", version: "1.0.0", integrity: "verified" },
            ]);
          } else {
            expect(result.managed).toEqual([]);
            expect(result.catalog.packages).toMatchObject([
              { name: "a", version: "2.0.0", integrity: "unmanaged" },
            ]);
          }
          expect(yield* Effect.promise(fixture.readHistory)).toEqual({
            version: 1,
            completed: ["a"],
          });
        }),
    );
  }

  for (const change of ["added", "removed"]) {
    it.effect(`leaves a package with ${change} files unmanaged`, () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() => fixture.addPackage("a"));
        yield* fixture.start(true);
        const destination = join(fixture.workspace, "packages", "a");
        yield* Effect.promise(() =>
          change === "added"
            ? write(join(destination, "extra.txt"), "user file")
            : fs.rm(join(destination, "index.js")),
        );
        const result = yield* fixture.start();
        expect(result.managed).toEqual([]);
        expect(result.catalog.packages).toMatchObject([
          { name: "a", integrity: "unmanaged" },
        ]);
        expect(yield* Effect.promise(fixture.readHistory)).toEqual({
          version: 1,
          completed: ["a"],
        });
      }),
    );
  }

  it.effect(
    "seeds a regular folder around a symlink after interrupted publication",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() => fixture.addPackage("a"));
        yield* fixture.start(true);
        const destination = join(fixture.workspace, "packages", "a");
        const original = join(fixture.root, "original-package");
        yield* Effect.promise(() => fs.rename(destination, original));
        yield* Effect.promise(() =>
          fs.symlink(original, destination, "junction"),
        );

        expect((yield* fixture.start()).managed).toMatchObject([
          { name: "a", directory: "a-2" },
        ]);
        expect(
          (yield* Effect.promise(() => fs.lstat(destination))).isSymbolicLink(),
        ).toBe(true);
        expect(yield* Effect.promise(fixture.readHistory)).toEqual({
          version: 1,
          completed: ["a"],
        });
      }),
  );

  it.effect("reseeds a package removed before completion is recorded", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() => fixture.addPackage("a"));
      yield* fixture.start(true);
      yield* Effect.promise(() =>
        fs.rm(join(fixture.workspace, "packages", "a"), { recursive: true }),
      );
      expect((yield* fixture.start()).catalog.packages).toMatchObject([
        { name: "a", integrity: "verified" },
      ]);
      expect(yield* Effect.promise(fixture.readHistory)).toMatchObject({
        completed: ["a"],
      });
    }),
  );

  it.effect(
    "preserves a later installation when completing interrupted setup",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(makeFixture);
        yield* Effect.promise(() => fixture.addPackage("a"));
        const rename = fs.rename;
        const failure = vi
          .spyOn(fs, "rename")
          .mockImplementation(async (source, target) => {
            if (String(target) === fixture.historyPath) {
              const contents = await fs.readFile(source, "utf8");
              if (
                decodeSetupState(
                  JSON.parse(contents) as unknown,
                ).completed.includes("a")
              ) {
                throw new Error("Simulated failure recording completed setup");
              }
            }
            return rename(source, target);
          });
        const initial = yield* fixture.start();
        failure.mockRestore();
        const installed = initial.managed[0];
        if (installed === undefined)
          throw new Error("Package was not installed");
        const replacement = {
          ...installed,
          installedAt: "2026-09-01T00:00:00.000Z",
          source: {
            ...installed.source,
            repositoryUrl: "https://github.com/example/other-tools",
          },
        };
        yield* Effect.gen(function* () {
          const state = yield* ScriptPackageState;
          yield* state.save(replacement);
        }).pipe(Effect.provide(fixture.makeLayer()));

        expect((yield* fixture.start()).managed).toEqual([replacement]);
        expect(yield* Effect.promise(fixture.readHistory)).toMatchObject({
          completed: ["a"],
        });
      }),
  );

  it.effect("cleans failed staging and retries with the current bundle", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() => fixture.addPackage("a"));
      const rename = fs.rename;
      const failure = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (source, target) => {
          if (
            String(source).endsWith("/package") &&
            String(target).endsWith("/packages/a")
          ) {
            throw new Error("Simulated interruption before publication");
          }
          return rename(source, target);
        });
      yield* fixture.start();
      failure.mockRestore();
      expect(yield* Effect.promise(fixture.readHistory)).toEqual({
        version: 1,
        completed: [],
      });
      expect(
        (yield* Effect.promise(() => fs.readdir(fixture.workspace))).filter(
          (name) => name.startsWith(".lucent-package-seed-"),
        ),
      ).toEqual([]);
      expect(
        yield* Effect.promise(() =>
          pathExists(join(fixture.workspace, "packages", "a")),
        ),
      ).toBe(false);
      yield* Effect.promise(() => fixture.addPackage("a", "a", "2.0.0"));
      expect((yield* fixture.start()).catalog.packages).toMatchObject([
        { name: "a", version: "2.0.0", integrity: "verified" },
      ]);
      expect(yield* Effect.promise(fixture.readHistory)).toEqual({
        version: 1,
        completed: ["a"],
      });
    }),
  );

  it.effect("does not copy through a symlinked packages directory", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(makeFixture);
      yield* Effect.promise(() => fixture.addPackage("a"));
      const elsewhere = join(fixture.root, "elsewhere");
      yield* Effect.promise(() => fs.mkdir(elsewhere));
      yield* Effect.promise(() =>
        fs.mkdir(fixture.workspace, { recursive: true }),
      );
      yield* Effect.promise(() =>
        fs.symlink(elsewhere, join(fixture.workspace, "packages"), "junction"),
      );
      yield* fixture.start();
      expect(yield* Effect.promise(() => fs.readdir(elsewhere))).toEqual([]);
    }),
  );
});

describe("bundled package snapshots", () => {
  it("matches Git's directory revision, including sorting, nested files, and executable modes", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.root, "git-source");
    await writePackage(source, "example");
    await write(join(source, "lib", "helper.js"), "exports.value = 1;\n");
    await write(join(source, "lib.js"), "module.exports = {};\n");
    await write(join(source, "__proto__"), "an ordinary package file\n");
    await write(join(source, "run.sh"), "#!/bin/sh\n");
    await fs.chmod(join(source, "run.sh"), 0o755);
    execFileSync("git", ["init", "--quiet"], { cwd: source });
    execFileSync("git", ["add", "."], { cwd: source });
    const expected = execFileSync("git", ["write-tree"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    await fs.rm(join(source, ".git"), { recursive: true });
    const target = join(fixture.root, "copied");
    const result = await copyBundledScriptPackage(source, target);
    expect(result.tree).toBe(expected);
    expect(result.files).toEqual(await hashDirectory(target));
  });

  it("rejects links inside a bundled package", async () => {
    const fixture = await makeFixture();
    await fixture.addPackage("a");
    const source = join(fixture.sourceRoot, "a");
    await fs.symlink(join(source, "index.js"), join(source, "linked.js"));
    await expect(
      copyBundledScriptPackage(source, join(fixture.root, "copy")),
    ).rejects.toThrow("Symbolic links");
  });
});
