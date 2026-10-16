import { extname, relative, resolve } from "path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type {
  ScriptFile,
  ScriptFileResolution,
} from "@lucent/core/scriptInputs";
import type {
  ScriptCatalogEntry,
  ScriptExecutionPackage,
  ScriptExecutionSnapshot,
  ScriptModuleImport,
  ScriptModuleSource,
  ScriptReference,
} from "@lucent/core/scriptPackages";
import {
  isScriptBuiltinModuleSpecifier,
  isRelativeScriptModuleSpecifier,
  resolveRelativeScriptModulePath,
  scriptModulePathCandidates,
} from "@lucent/core/scriptPackages";
import { ScriptFiles } from "./ScriptFiles";
import type { ScriptFileAnalysis } from "./ScriptFileWorkerProtocol";
import {
  type DiscoveredScriptPackage,
  ScriptPackageCatalog,
} from "./ScriptPackageCatalog";
import {
  portablePath,
  regularFileFingerprint,
  sha256Revision,
} from "./ScriptPackageFileSystem";
import {
  formatBytes,
  SCRIPT_SNAPSHOT_MAX_BYTES,
  SCRIPT_SOURCE_CACHE_MAX_BYTES,
  SCRIPT_SOURCE_CACHE_MAX_ENTRIES,
} from "./ScriptLimits";

const SNAPSHOT_MAX_ATTEMPTS = 3;
const SOURCE_READ_CONCURRENCY = 8;

export class ScriptSourceRegistryError extends Schema.TaggedError<ScriptSourceRegistryError>()(
  "ScriptSourceRegistryError",
  {
    detail: Schema.String,
    path: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScriptSourceRegistryShape {
  readonly readPath: (
    path: string,
  ) => Effect.Effect<ScriptFile, ScriptSourceRegistryError>;
  readonly readReference: (
    reference: ScriptReference,
  ) => Effect.Effect<ScriptFile, ScriptSourceRegistryError>;
  readonly resolvePath: (path: string) => Effect.Effect<ScriptFileResolution>;
  readonly resolveReference: (
    reference: ScriptReference,
  ) => Effect.Effect<ScriptFileResolution>;
}

export class ScriptSourceRegistry extends Context.Service<
  ScriptSourceRegistry,
  ScriptSourceRegistryShape
>()("lucent/desktop/scripting/ScriptSourceRegistry") {}

interface ModuleTarget {
  readonly absolutePath: string;
  readonly format: ScriptModuleSource["format"];
  readonly id: string;
  readonly packageName?: string;
  readonly path: string;
}

interface LoadedSource {
  readonly bytes: number;
  readonly fingerprint: string;
  readonly module: ScriptModuleSource;
  readonly requirements: readonly string[];
}

type CachedSource = LoadedSource;

const looseModuleId = (path: string): string => `loose:${path}`;
const packageModuleId = (packageName: string, path: string): string =>
  `package:${packageName}:${path}`;

const moduleFormat = (
  packageEntry: DiscoveredScriptPackage,
  path: string,
): ScriptModuleSource["format"] =>
  packageEntry.manifest.type === "module" &&
  extname(path).toLowerCase() === ".js"
    ? "unsupported-esm"
    : "commonjs";

const looseTarget = (entry: ScriptCatalogEntry): ModuleTarget => ({
  absolutePath: entry.path,
  format: "commonjs",
  id: looseModuleId(entry.relativePath),
  path: entry.relativePath,
});

const packageTarget = (
  packageEntry: DiscoveredScriptPackage,
  path: string,
): ModuleTarget | undefined => {
  const absolutePath = packageEntry.modules.get(path);
  return absolutePath === undefined
    ? undefined
    : {
        absolutePath,
        format: moduleFormat(packageEntry, path),
        id: packageModuleId(packageEntry.name, path),
        packageName: packageEntry.name,
        path,
      };
};

const packageSnapshot = (
  packageEntry: DiscoveredScriptPackage,
): ScriptExecutionPackage => ({
  compatibility: packageEntry.compatibility,
  mainModuleId:
    packageEntry.mainPath === null
      ? null
      : packageModuleId(
          packageEntry.name,
          portablePath(relative(packageEntry.rootPath, packageEntry.mainPath)),
        ),
  name: packageEntry.name,
  rootPath: packageEntry.rootPath,
});

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : fallback;

const failedResolution = (
  path: string,
  cause: unknown,
): ScriptFileResolution => {
  const message = errorMessage(cause, "Script source preparation failed.");
  const detailsText = cause instanceof Error ? cause.stack : undefined;
  return {
    status: "failed",
    path,
    message,
    ...(detailsText === undefined ? {} : { detailsText }),
  };
};

const moduleFromAnalysis = (
  target: ModuleTarget,
  analysis: ScriptFileAnalysis,
): ScriptModuleSource => ({
  format: target.format,
  id: target.id,
  imports: {},
  localPath: target.absolutePath,
  path: target.path,
  ...(target.packageName === undefined
    ? {}
    : { packageName: target.packageName }),
  revision: analysis.file.revision,
  source: analysis.file.source,
});

export const layer = Layer.effect(
  ScriptSourceRegistry,
  Effect.gen(function* () {
    const catalog = yield* ScriptPackageCatalog;
    const scriptFiles = yield* ScriptFiles;
    const sourceCache = new Map<string, CachedSource>();
    let sourceCacheBytes = 0;

    const registryError = (cause: Error) =>
      new ScriptSourceRegistryError({ detail: cause.message, cause });
    const getDiscovery = catalog.getDiscovery.pipe(
      Effect.mapError(registryError),
    );
    const resolveEntry = (reference: ScriptReference) =>
      catalog.resolveReference(reference).pipe(Effect.mapError(registryError));

    const resolveRelativeTarget = Effect.fn(
      "ScriptSourceRegistry.resolveRelativeTarget",
    )(function* (
      importer: ModuleTarget,
      specifier: string,
      owner: DiscoveredScriptPackage | undefined,
    ) {
      const normalized = resolveRelativeScriptModulePath(
        importer.path,
        specifier,
      );
      if (normalized === null) return undefined;
      for (const candidate of scriptModulePathCandidates(normalized)) {
        if (importer.packageName === undefined) {
          const entry = yield* resolveEntry({ kind: "loose", path: candidate });
          if (entry !== undefined) return looseTarget(entry);
        } else if (owner !== undefined) {
          const target = packageTarget(owner, candidate);
          if (target !== undefined) return target;
        }
      }
      return undefined;
    });

    const readModule = Effect.fn("ScriptSourceRegistry.readModule")(function* (
      target: ModuleTarget,
    ) {
      const currentFingerprint = yield* Effect.tryPromise({
        try: () => regularFileFingerprint(target.absolutePath),
        catch: (cause) =>
          new ScriptSourceRegistryError({
            detail: errorMessage(cause, "Failed to inspect script source."),
            path: target.absolutePath,
            cause,
          }),
      });
      const cached = sourceCache.get(target.absolutePath);
      if (
        cached?.fingerprint === currentFingerprint &&
        cached.module.format === target.format &&
        cached.module.id === target.id
      ) {
        sourceCache.delete(target.absolutePath);
        sourceCache.set(target.absolutePath, cached);
        return cached;
      }

      const analysis = yield* scriptFiles.analyze(target.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new ScriptSourceRegistryError({
              detail: cause.message,
              path: target.absolutePath,
              cause,
            }),
        ),
      );
      const next: CachedSource = {
        bytes: Buffer.byteLength(analysis.file.source, "utf8"),
        fingerprint: analysis.fingerprint,
        module: moduleFromAnalysis(target, analysis),
        requirements: target.format === "commonjs" ? analysis.requirements : [],
      };
      if (cached !== undefined) sourceCacheBytes -= cached.bytes;
      sourceCache.delete(target.absolutePath);
      sourceCache.set(target.absolutePath, next);
      sourceCacheBytes += next.bytes;
      while (
        sourceCacheBytes > SCRIPT_SOURCE_CACHE_MAX_BYTES ||
        sourceCache.size > SCRIPT_SOURCE_CACHE_MAX_ENTRIES
      ) {
        const oldestPath = sourceCache.keys().next().value;
        if (oldestPath === undefined) break;
        const oldest = sourceCache.get(oldestPath);
        sourceCache.delete(oldestPath);
        sourceCacheBytes -= oldest?.bytes ?? 0;
      }
      return next;
    });

    const importError = (
      importer: ModuleTarget,
      specifier: string,
      detail: string,
    ): ScriptSourceRegistryError =>
      new ScriptSourceRegistryError({
        detail: `${importer.packageName ?? importer.path} can't import ${JSON.stringify(specifier)}. ${detail}`,
        path: importer.absolutePath,
      });

    /** Reads only modules reachable through Lucent's literal CommonJS contract. */
    const collectExecutionClosure = Effect.fn(
      "ScriptSourceRegistry.collectExecutionClosure",
    )(function* (
      getSnapshotDiscovery: typeof getDiscovery,
      selectedTarget: ModuleTarget,
      selectedAnalysis: ScriptFileAnalysis,
    ) {
      const modules = new Map<string, ScriptModuleSource>();
      const packages = new Map<string, ScriptExecutionPackage>();
      const fingerprints = new Map<string, string>();
      const scheduled = new Set([selectedTarget.id]);
      const queue: ModuleTarget[] = [selectedTarget];
      let totalBytes = 0;

      const schedule = (target: ModuleTarget | undefined): void => {
        if (target === undefined || scheduled.has(target.id)) return;
        scheduled.add(target.id);
        queue.push(target);
      };

      while (queue.length > 0) {
        const batch = queue.splice(0, SOURCE_READ_CONCURRENCY);
        const loadedBatch = yield* Effect.all(
          batch.map((target) =>
            target.id === selectedTarget.id
              ? Effect.succeed({
                  target,
                  loaded: {
                    bytes: Buffer.byteLength(
                      selectedAnalysis.file.source,
                      "utf8",
                    ),
                    fingerprint: selectedAnalysis.fingerprint,
                    module: moduleFromAnalysis(target, selectedAnalysis),
                    requirements:
                      target.format === "commonjs"
                        ? selectedAnalysis.requirements
                        : [],
                  } satisfies LoadedSource,
                })
              : readModule(target).pipe(
                  Effect.map((loaded) => ({ target, loaded })),
                ),
          ),
          { concurrency: SOURCE_READ_CONCURRENCY },
        );

        for (const { loaded, target } of loadedBatch) {
          if (target.id !== selectedTarget.id) {
            fingerprints.set(target.absolutePath, loaded.fingerprint);
          }
          totalBytes += loaded.bytes;
          if (totalBytes > SCRIPT_SNAPSHOT_MAX_BYTES) {
            return yield* new ScriptSourceRegistryError({
              detail: `Script sources exceed the ${formatBytes(SCRIPT_SNAPSHOT_MAX_BYTES)} execution limit.`,
              path: selectedTarget.absolutePath,
            });
          }

          const imports: Record<string, ScriptModuleImport> = Object.create(
            null,
          ) as Record<string, ScriptModuleImport>;
          for (const specifier of loaded.requirements) {
            if (isScriptBuiltinModuleSpecifier(specifier)) {
              imports[specifier] = { kind: "builtin", specifier };
              continue;
            }
            if (isRelativeScriptModuleSpecifier(specifier)) {
              const owner =
                target.packageName === undefined
                  ? undefined
                  : (yield* getSnapshotDiscovery).packages.get(
                      target.packageName,
                    );
              const resolved = yield* resolveRelativeTarget(
                target,
                specifier,
                owner,
              );
              if (resolved === undefined) {
                return yield* importError(
                  target,
                  specifier,
                  "The relative module was not found.",
                );
              }
              imports[specifier] = { kind: "module", moduleId: resolved.id };
              schedule(resolved);
              continue;
            }

            const discovery = yield* getSnapshotDiscovery;
            if (
              target.packageName !== undefined &&
              specifier !== target.packageName &&
              discovery.packages.get(target.packageName)?.manifest.dependencies[
                specifier
              ] === undefined
            ) {
              return yield* importError(
                target,
                specifier,
                `${target.packageName} must list it in lucent.dependencies.`,
              );
            }
            const packageEntry = discovery.packages.get(specifier);
            if (packageEntry === undefined) {
              return yield* importError(
                target,
                specifier,
                "The package is not installed.",
              );
            }
            packages.set(packageEntry.name, packageSnapshot(packageEntry));
            if (packageEntry.compatibility.status === "incompatible") {
              return yield* importError(
                target,
                specifier,
                "The package is not compatible with this version of Lucent.",
              );
            }
            if (packageEntry.dependencyStatus.status === "blocked") {
              return yield* importError(
                target,
                specifier,
                "One or more of the package's dependencies are unavailable.",
              );
            }
            if (packageEntry.mainPath === null) {
              return yield* importError(
                target,
                specifier,
                "The package's main file was not found.",
              );
            }
            const resolved = packageTarget(
              packageEntry,
              portablePath(
                relative(packageEntry.rootPath, packageEntry.mainPath),
              ),
            );
            if (resolved === undefined) {
              return yield* importError(
                target,
                specifier,
                "The package's main file is no longer available.",
              );
            }
            imports[specifier] = { kind: "module", moduleId: resolved.id };
            schedule(resolved);
          }
          modules.set(target.id, { ...loaded.module, imports });
        }
      }

      const fingerprintEntries = [...fingerprints];
      for (
        let index = 0;
        index < fingerprintEntries.length;
        index += SOURCE_READ_CONCURRENCY
      ) {
        const batch = fingerprintEntries.slice(
          index,
          index + SOURCE_READ_CONCURRENCY,
        );
        const current = yield* Effect.all(
          batch.map(([path]) =>
            Effect.tryPromise({
              try: () => regularFileFingerprint(path),
              catch: (cause) =>
                new ScriptSourceRegistryError({
                  detail: errorMessage(
                    cause,
                    "Failed to verify script source.",
                  ),
                  path,
                  cause,
                }),
            }),
          ),
          { concurrency: SOURCE_READ_CONCURRENCY },
        );
        if (
          current.some(
            (fingerprint, batchIndex) => fingerprint !== batch[batchIndex]?.[1],
          )
        ) {
          return null;
        }
      }

      return {
        modules: [...modules.values()].toSorted((left, right) =>
          left.id.localeCompare(right.id),
        ),
        packages: [...packages.values()].toSorted((left, right) =>
          left.name.localeCompare(right.name),
        ),
      };
    });

    const readReference = Effect.fn("ScriptSourceRegistry.readReference")(
      function* (reference: ScriptReference) {
        for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
          // Keep package metadata consistent within an attempt, but only discover
          // packages when the selected script or a reachable import needs them.
          const getSnapshotDiscovery = yield* Effect.cached(getDiscovery);
          const discovery =
            reference.kind === "package"
              ? yield* getSnapshotDiscovery
              : undefined;
          const entry =
            reference.kind === "loose"
              ? yield* resolveEntry(reference)
              : discovery?.scripts.get(
                  `package:${reference.packageName}:${reference.path}`,
                );
          if (entry === undefined) {
            return yield* new ScriptSourceRegistryError({
              detail: "The selected script is no longer available.",
            });
          }

          let target: ModuleTarget | undefined;
          if (reference.kind === "package") {
            const owner = discovery?.packages.get(reference.packageName);
            if (owner?.compatibility.status === "incompatible") {
              return yield* new ScriptSourceRegistryError({
                detail: `${owner.name} requires Lucent ${owner.compatibility.requiredVersion}; this app is ${owner.compatibility.currentVersion}.`,
                path: entry.path,
              });
            }
            if (owner?.dependencyStatus.status === "blocked") {
              return yield* new ScriptSourceRegistryError({
                detail: `${owner.name} can't run because one or more required packages are unavailable.`,
                path: entry.path,
              });
            }
            target =
              owner === undefined
                ? undefined
                : packageTarget(owner, reference.path);
          } else {
            target = looseTarget(entry);
          }
          if (target === undefined) continue;
          const parsedEntry = yield* scriptFiles.analyze(entry.path).pipe(
            Effect.mapError(
              (cause) =>
                new ScriptSourceRegistryError({
                  detail: cause.message,
                  path: entry.path,
                  cause,
                }),
            ),
          );
          const closure = yield* collectExecutionClosure(
            getSnapshotDiscovery,
            target,
            parsedEntry,
          );
          if (closure === null) continue;
          const verifiedEntry = yield* scriptFiles.analyze(entry.path).pipe(
            Effect.mapError(
              (cause) =>
                new ScriptSourceRegistryError({
                  detail: cause.message,
                  path: entry.path,
                  cause,
                }),
            ),
          );
          if (
            verifiedEntry.file.revision !== parsedEntry.file.revision ||
            verifiedEntry.fingerprint !== parsedEntry.fingerprint
          ) {
            continue;
          }

          const snapshotRevision = sha256Revision(
            JSON.stringify({
              entryId: target.id,
              modules: closure.modules.map(({ id, imports, revision }) => ({
                id,
                imports,
                revision,
              })),
              packages: closure.packages,
            }),
          );
          const snapshot: ScriptExecutionSnapshot = {
            entryModuleId: target.id,
            modules: closure.modules,
            packages: closure.packages,
            revision: snapshotRevision,
          };
          return {
            ...verifiedEntry.file,
            name: entry.name,
            path: entry.path,
            reference,
            snapshot,
          } satisfies ScriptFile;
        }

        return yield* new ScriptSourceRegistryError({
          detail:
            "Script files kept changing while Lucent prepared an execution snapshot. Try starting again.",
        });
      },
    );

    const readPath: ScriptSourceRegistryShape["readPath"] = (path) =>
      catalog.referenceForPath(path).pipe(
        Effect.mapError(
          (cause) =>
            new ScriptSourceRegistryError({
              detail: cause.message,
              path,
              cause,
            }),
        ),
        Effect.flatMap((reference) =>
          reference === undefined
            ? scriptFiles.read(path).pipe(
                Effect.mapError(
                  (cause) =>
                    new ScriptSourceRegistryError({
                      detail: cause.message,
                      path,
                      cause,
                    }),
                ),
              )
            : readReference(reference),
        ),
      );

    const resolveReference: ScriptSourceRegistryShape["resolveReference"] = (
      reference,
    ) => {
      const displayPath =
        reference.kind === "loose"
          ? reference.path
          : `${reference.packageName}/${reference.path}`;
      return catalog.resolveReference(reference).pipe(
        Effect.flatMap((entry) =>
          entry === undefined
            ? Effect.succeed({
                status: "missing",
                path: displayPath,
              } satisfies ScriptFileResolution)
            : readReference(reference).pipe(
                Effect.match({
                  onFailure: (cause) => failedResolution(displayPath, cause),
                  onSuccess: (file) =>
                    ({
                      status: "found",
                      file,
                    }) satisfies ScriptFileResolution,
                }),
              ),
        ),
        Effect.catch((cause) =>
          Effect.succeed(failedResolution(displayPath, cause)),
        ),
      );
    };

    const resolvePath: ScriptSourceRegistryShape["resolvePath"] = (path) =>
      catalog.referenceForPath(path).pipe(
        Effect.flatMap((reference) =>
          reference === undefined
            ? scriptFiles.resolve(path)
            : resolveReference(reference),
        ),
        Effect.catch((cause) =>
          Effect.succeed(failedResolution(resolve(path), cause)),
        ),
      );

    return ScriptSourceRegistry.of({
      readPath,
      readReference,
      resolvePath,
      resolveReference,
    });
  }),
);
