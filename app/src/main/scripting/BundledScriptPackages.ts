import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
import { hashDirectory } from "./ScriptPackageFileSystem";
import {
  ScriptPackageState,
  type ManagedScriptPackage,
} from "./ScriptPackageState";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";

export const BundledScriptPackageSetupSchema = Schema.Struct({
  version: Schema.Literal(1),
  completed: Schema.Array(ScriptPackageNameSchema),
});

const decodeSetupState = Schema.decodeUnknownEffect(
  BundledScriptPackageSetupSchema,
);
const decodePackageName = Schema.decodeUnknownEffect(ScriptPackageNameSchema);
const decodePackageSubdirectory = Schema.decodeUnknownEffect(
  ScriptPackageRepositorySubdirectorySchema,
);

class BundledScriptPackageSetupError extends Schema.TaggedError<BundledScriptPackageSetupError>()(
  "BundledScriptPackageSetupError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const initializeBundledScriptPackages = Effect.gen(function* () {
  const env = yield* DesktopEnvironment;
  const jsonFile = makeJsonFile(yield* FileSystem);
  const state = yield* ScriptPackageState;
  const catalog = yield* ScriptPackageCatalog;
  const sourceRoot = join(env.assetsDir, "..", "script-packages");
  const historyPath = join(env.workspaceDir, ".script-package-setup.json");
  const { packagesDir } = resolveScriptWorkspacePaths(env.workspaceDir);
  const loaded = yield* jsonFile.read(historyPath);
  let history: typeof BundledScriptPackageSetupSchema.Type =
    loaded.status === "missing"
      ? { version: 1, completed: [] }
      : yield* decodeSetupState(loaded.value);
  let packagesChanged = false;

  const finish = Effect.fn("BundledScriptPackages.finish")(function* (
    name: string,
  ) {
    const next = {
      ...history,
      completed: [...history.completed, name],
    };
    yield* jsonFile.write(historyPath, next);
    history = next;
  }, Effect.uninterruptible);
  yield* Effect.tryPromise(() => fs.mkdir(packagesDir, { recursive: true }));
  const packagesStat = yield* Effect.tryPromise(() => fs.lstat(packagesDir));
  if (!packagesStat.isDirectory() || packagesStat.isSymbolicLink()) {
    return yield* new BundledScriptPackageSetupError({
      detail: "Automatic package setup requires a regular packages directory.",
    });
  }

  const install = Effect.fn("BundledScriptPackages.install")(function* (
    sourceDirectory: string,
  ) {
    const source = join(sourceRoot, sourceDirectory);
    const manifest = yield* Effect.tryPromise(() =>
      readScriptPackageManifest(join(source, "package.json")),
    );
    const name = yield* decodePackageName(manifest.name);
    if (history.completed.includes(name)) return;
    yield* catalog.refresh;
    const current = yield* catalog.getDiscovery;
    const existing = current.packages.get(name);
    if (
      current.catalog.packages.some((entry) => entry.name === name) &&
      (existing === undefined ||
        (yield* state.get(name))?.directory === existing.directory)
    ) {
      yield* finish(name);
      return;
    }

    yield* Effect.acquireUseRelease(
      Effect.tryPromise(() =>
        fs.mkdtemp(join(env.workspaceDir, ".lucent-package-seed-")),
      ),
      (stagingRoot) =>
        Effect.gen(function* () {
          const staged = join(stagingRoot, "package");
          const snapshot = yield* Effect.tryPromise(() =>
            copyBundledScriptPackage(source, staged),
          );
          yield* Effect.tryPromise(() => inspectScriptPackageDirectory(staged));
          if (existing !== undefined) {
            const files = yield* Effect.tryPromise(() =>
              hashDirectory(existing.rootPath),
            ).pipe(Effect.orElseSucceed(() => undefined));
            if (!isDeepStrictEqual(files, snapshot.files)) {
              yield* finish(name);
              return;
            }
          }
          const reserved = new Set(
            (yield* state.getAll).map((entry) => entry.directory),
          );
          const directory =
            existing?.directory ??
            (yield* Effect.tryPromise(() =>
              allocatePackageDirectory(packagesDir, name, reserved),
            ));
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
              repositoryUrl: appPackage.repository.url.replace(/\.git$/u, ""),
              subdirectory,
              resolvedTree: snapshot.tree,
            },
            update: { status: "unchecked" },
          };
          if (existing === undefined) {
            yield* Effect.tryPromise(() =>
              fs.rename(staged, packageDirectoryPath(packagesDir, directory)),
            );
            packagesChanged = true;
          }
          yield* state.save(managed);
          packagesChanged = true;
          yield* finish(name);
        }),
      (stagingRoot) =>
        Effect.tryPromise(() =>
          fs.rm(stagingRoot, { recursive: true, force: true }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Failed to clean bundled package staging.",
              Cause.fail(cause),
            ).pipe(
              Effect.annotateLogs({ component: "bundled-script-packages" }),
            ),
          ),
        ),
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
  if (packagesChanged) yield* catalog.refresh;
}).pipe(
  Effect.catch((cause) =>
    Effect.logWarning(
      "Bundled package setup could not finish. Existing packages have been left alone.",
      Cause.fail(cause),
    ).pipe(Effect.annotateLogs({ component: "bundled-script-packages" })),
  ),
);
