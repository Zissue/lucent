import { randomBytes } from "crypto";
import { promises as fs, type Stats } from "fs";
import { join } from "path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  ScriptPackageNameSchema,
  ScriptPackageRepositorySubdirectorySchema,
} from "@lucent/core/scriptPackages";
import appPackage from "../../../package.json";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { FileSystem } from "effect/FileSystem";
import { makeJsonFile } from "../filesystem/JsonFile";
import { acquireBundledScriptPackageLock } from "./BundledScriptPackageLock";
import { copyBundledScriptPackage } from "./BundledScriptPackageSnapshot";
import {
  inspectScriptPackageDirectory,
  readScriptPackageManifest,
} from "./ScriptPackageInspection";
import { ScriptPackageCatalog } from "./ScriptPackageCatalog";
import {
  allocatePackageDirectory,
  packageDirectoryPath,
  pathExists,
} from "./ScriptPackageDirectories";
import {
  ManagedScriptPackageSchema,
  ScriptPackageState,
  type ManagedScriptPackage,
} from "./ScriptPackageState";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";

const StagingDirectorySchema = Schema.String.check(
  Schema.makeFilter(
    (value) => /^\.lucent-package-seed-[a-f0-9]{16}$/u.test(value),
    { expected: "a bundled package staging directory" },
  ),
);

export const BundledScriptPackageSetupSchema = Schema.Struct({
  version: Schema.Literal(1),
  completed: Schema.Array(ScriptPackageNameSchema),
  pending: Schema.Array(
    Schema.Struct({
      stagingDirectory: StagingDirectorySchema,
      directoryIdentity: Schema.String,
      managed: ManagedScriptPackageSchema,
      previousInstalledAt: Schema.optionalKey(Schema.String),
    }),
  ),
});

type SetupState = typeof BundledScriptPackageSetupSchema.Type;
type PendingSetup = SetupState["pending"][number];
const decodeSetupState = Schema.decodeUnknownEffect(
  BundledScriptPackageSetupSchema,
);
const decodePackageName = Schema.decodeUnknownEffect(ScriptPackageNameSchema);
const decodePackageSubdirectory = Schema.decodeUnknownEffect(
  ScriptPackageRepositorySubdirectorySchema,
);

// Unlike modification times, these identify the directory across renames and edits.
const directoryIdentity = (stat: Stats): string =>
  `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

class BundledScriptPackageSetupError extends Schema.TaggedError<BundledScriptPackageSetupError>()(
  "BundledScriptPackageSetupError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Installs bundled copies once, preserving user removals and unfinished setup. */
export const initializeBundledScriptPackages = Effect.gen(function* () {
  const env = yield* DesktopEnvironment;
  const jsonFile = makeJsonFile(yield* FileSystem);
  const state = yield* ScriptPackageState;
  const catalog = yield* ScriptPackageCatalog;
  const sourceRoot = join(env.assetsDir, "..", "script-packages");
  const historyPath = join(env.workspaceDir, ".script-package-setup.json");
  const { packagesDir } = resolveScriptWorkspacePaths(env.workspaceDir);
  yield* Effect.tryPromise(() =>
    fs.mkdir(env.workspaceDir, { recursive: true }),
  );

  yield* Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      acquireBundledScriptPackageLock(`${historyPath}.lock`),
    ),
    (release) =>
      Effect.gen(function* () {
        if (release === undefined) return;
        const loaded = yield* jsonFile.read(historyPath);
        let history: SetupState =
          loaded.status === "missing"
            ? { version: 1, completed: [], pending: [] }
            : yield* decodeSetupState(loaded.value);

        const pendingNames = history.pending.map((entry) => entry.managed.name);
        const pendingDirectories = history.pending.map(
          (entry) => entry.managed.directory,
        );
        const stagingDirectories = history.pending.map(
          (entry) => entry.stagingDirectory,
        );
        if (
          new Set(pendingNames).size !== pendingNames.length ||
          new Set(pendingDirectories).size !== pendingDirectories.length ||
          new Set(stagingDirectories).size !== stagingDirectories.length ||
          pendingNames.some((name) => history.completed.includes(name))
        ) {
          return yield* new BundledScriptPackageSetupError({
            detail: "Bundled package setup history has conflicting entries.",
          });
        }

        const persist = Effect.fn("BundledScriptPackages.persist")(function* (
          next: SetupState,
        ) {
          yield* jsonFile.write(historyPath, next);
          history = next;
        }, Effect.uninterruptible);
        if (loaded.status === "missing") yield* persist(history);

        yield* Effect.tryPromise(() =>
          fs.mkdir(packagesDir, { recursive: true }),
        );
        const packagesStat = yield* Effect.tryPromise(() =>
          fs.lstat(packagesDir),
        );
        if (!packagesStat.isDirectory() || packagesStat.isSymbolicLink()) {
          return yield* new BundledScriptPackageSetupError({
            detail:
              "Automatic package setup requires a regular packages directory.",
          });
        }

        const cleanup = (directory: string) =>
          Effect.tryPromise(async () => {
            const path = join(env.workspaceDir, directory);
            if (await pathExists(path)) await fs.rm(path, { recursive: true });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Failed to clean bundled package staging.",
                Cause.fail(cause),
              ).pipe(
                Effect.annotateLogs({ component: "bundled-script-packages" }),
              ),
            ),
          );

        const finish = Effect.fn("BundledScriptPackages.finish")(function* (
          name: string,
        ) {
          const pending = history.pending.find(
            (entry) => entry.managed.name === name,
          );
          yield* persist({
            ...history,
            completed: [...new Set([...history.completed, name])],
            pending: history.pending.filter(
              (entry) => entry.managed.name !== name,
            ),
          });
          if (pending !== undefined) yield* cleanup(pending.stagingDirectory);
        });

        const recover = Effect.fn("BundledScriptPackages.recover")(function* (
          pending: PendingSetup,
        ) {
          const { managed } = pending;
          const stagingRoot = join(env.workspaceDir, pending.stagingDirectory);
          const staged = join(stagingRoot, "package");
          const destination = packageDirectoryPath(
            packagesDir,
            managed.directory,
          );
          const hasStagedPackage = yield* Effect.tryPromise(() =>
            pathExists(staged),
          );

          if (hasStagedPackage) {
            const current = yield* catalog.refresh;
            if (current.packages.some((entry) => entry.name === managed.name)) {
              yield* finish(managed.name);
              return;
            }
            if (yield* Effect.tryPromise(() => pathExists(destination))) {
              // A user claimed the chosen folder before publication. Allocate anew later.
              yield* persist({
                ...history,
                pending: history.pending.filter((entry) => entry !== pending),
              });
              yield* cleanup(pending.stagingDirectory);
              return;
            }
            yield* Effect.tryPromise(() => fs.rename(staged, destination));
          }

          // The staged directory disappears only when publication succeeds. If the
          // destination is now absent, the user removed it; never recreate it.
          if (yield* Effect.tryPromise(() => pathExists(destination))) {
            const directory = yield* Effect.tryPromise(() =>
              fs.lstat(destination),
            );
            if (
              !directory.isDirectory() ||
              directoryIdentity(directory) !== pending.directoryIdentity
            ) {
              yield* finish(managed.name);
              return;
            }
            const existing = yield* state.get(managed.name);
            if (
              existing === undefined ||
              existing.installedAt === pending.previousInstalledAt
            ) {
              const manifest = yield* Effect.tryPromise(() =>
                readScriptPackageManifest(join(destination, "package.json")),
              );
              if (manifest.name === managed.name) yield* state.save(managed);
            }
          }
          yield* finish(managed.name);
        }, Effect.uninterruptible);

        for (const pending of history.pending) {
          yield* recover(pending).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Failed to finish bundled package setup.",
                Cause.fail(cause),
              ).pipe(
                Effect.annotateLogs({
                  component: "bundled-script-packages",
                  data: { packageName: pending.managed.name },
                }),
              ),
            ),
          );
        }

        const install = Effect.fn("BundledScriptPackages.install")(function* (
          sourceDirectory: string,
        ) {
          const source = join(sourceRoot, sourceDirectory);
          const manifest = yield* Effect.tryPromise(() =>
            readScriptPackageManifest(join(source, "package.json")),
          );
          const name = yield* decodePackageName(manifest.name);
          if (
            history.completed.includes(name) ||
            history.pending.some((entry) => entry.managed.name === name)
          )
            return;
          const current = yield* catalog.getOverview;
          if (current.packages.some((entry) => entry.name === name)) {
            yield* finish(name);
            return;
          }

          const stagingDirectory = `.lucent-package-seed-${randomBytes(8).toString("hex")}`;
          const stagingRoot = join(env.workspaceDir, stagingDirectory);
          const staged = join(stagingRoot, "package");
          yield* Effect.tryPromise(() => fs.mkdir(stagingRoot));
          yield* Effect.acquireUseRelease(
            Effect.succeed(stagingDirectory),
            () =>
              Effect.gen(function* () {
                const snapshot = yield* Effect.tryPromise(() =>
                  copyBundledScriptPackage(source, staged),
                );
                const inspected = yield* Effect.tryPromise(() =>
                  inspectScriptPackageDirectory(staged),
                );
                if (inspected.manifest.name !== name) {
                  return yield* new BundledScriptPackageSetupError({
                    detail: "The bundled package changed while being copied.",
                  });
                }
                const previous = yield* state.get(name);
                const reserved = new Set(
                  (yield* state.getAll).map((entry) => entry.directory),
                );
                for (const entry of history.pending)
                  reserved.add(entry.managed.directory);
                const directory = yield* Effect.tryPromise(() =>
                  allocatePackageDirectory(packagesDir, name, reserved),
                );
                const subdirectory = yield* decodePackageSubdirectory(
                  `script-packages/${sourceDirectory}`,
                );
                const managed: ManagedScriptPackage = {
                  name,
                  directory,
                  installedAt: (yield* DateTime.nowAsDate).toISOString(),
                  files: snapshot.files,
                  source: {
                    kind: "directory",
                    repositoryUrl: appPackage.repository.url.replace(
                      /\.git$/u,
                      "",
                    ),
                    subdirectory,
                    resolvedTree: snapshot.tree,
                  },
                  update: { status: "unchecked" },
                };
                const stagedDirectory = yield* Effect.tryPromise(() =>
                  fs.lstat(staged),
                );
                const pending: PendingSetup = {
                  stagingDirectory,
                  directoryIdentity: directoryIdentity(stagedDirectory),
                  managed,
                  ...(previous === undefined
                    ? {}
                    : { previousInstalledAt: previous.installedAt }),
                };
                // Persist the staged path before publishing. Its disappearance lets
                // recovery recognize publication even after the user removes it.
                yield* persist({
                  ...history,
                  pending: [...history.pending, pending],
                });
                yield* recover(pending);
              }),
            () =>
              history.pending.some(
                (entry) => entry.stagingDirectory === stagingDirectory,
              )
                ? Effect.void
                : cleanup(stagingDirectory),
          );
        }, Effect.uninterruptible);

        if (yield* Effect.tryPromise(() => pathExists(sourceRoot))) {
          const entries = yield* Effect.tryPromise(() =>
            fs.readdir(sourceRoot, { withFileTypes: true }),
          );
          entries.sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            yield* install(entry.name).pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Failed to install a bundled script package; setup will retry on the next launch.",
                  Cause.fail(cause),
                ).pipe(
                  Effect.annotateLogs({
                    component: "bundled-script-packages",
                    data: { directory: entry.name },
                  }),
                ),
              ),
            );
          }
        }
        yield* catalog.refresh;
      }),
    (release) =>
      release === undefined
        ? Effect.void
        : Effect.tryPromise(release).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Failed to release bundled package setup lock.",
                Cause.fail(cause),
              ).pipe(
                Effect.annotateLogs({ component: "bundled-script-packages" }),
              ),
            ),
          ),
  );
}).pipe(
  Effect.catch((cause) =>
    Effect.logWarning(
      "Bundled package setup could not finish. Existing packages have been left alone.",
      Cause.fail(cause),
    ).pipe(Effect.annotateLogs({ component: "bundled-script-packages" })),
  ),
);
