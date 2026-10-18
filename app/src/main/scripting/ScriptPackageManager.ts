import { basename, dirname, join, resolve } from "node:path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FileSystem } from "effect/FileSystem";
import { isPlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  ScriptCatalogOverview,
  ScriptPackageMutationResult,
  ScriptPackageIntegrity,
  ScriptPackageRevision,
} from "@lucent/core/scriptPackages";
import { ScriptPackageDirectorySchema } from "@lucent/core/scriptPackages";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { logFailure } from "../../shared/logFailure";
import {
  GitHubScriptPackageClient,
  GitHubScriptPackageClientError,
  normalizeGitHubRepositoryUrl,
} from "./GitHubScriptPackageClient";
import {
  decodeRepositorySubdirectory,
  extractScriptPackageArchive,
} from "./ScriptPackageArchive";
import {
  inspectScriptPackageDirectory,
  inspectManagedPackageFolder,
  integrityFor,
  logScriptPackageInspectionFailures,
  type ScriptPackageInspectionFailure,
} from "./ScriptPackageInspection";
import { ScriptPackageCatalog } from "./ScriptPackageCatalog";
import type { ScriptPackageCatalogReplacement } from "./ScriptCatalogDiscovery";
import { hashDirectory, isPathInside } from "./ScriptPackageFileSystem";
import { copyBundledScriptPackage } from "./BundledScriptPackageSnapshot";
import {
  allocatePackageDirectory,
  packageDirectoryPath,
  pathExists,
} from "./ScriptPackageDirectories";
import {
  ScriptPackageState,
  ManagedScriptPackageSchema,
  type ManagedScriptPackage,
} from "./ScriptPackageState";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";

const decodePackageDirectory = Schema.decodeUnknownSync(
  ScriptPackageDirectorySchema,
);

const managedPackagesEquivalent = Schema.toEquivalence(
  ManagedScriptPackageSchema,
);

const packageManagerOperationSchema = Schema.Literals([
  "check-update",
  "extract",
  "install",
  "remove",
  "replace",
  "restore",
  "update",
  "validate",
]);

export class ScriptPackageManagerError extends Schema.TaggedError<ScriptPackageManagerError>()(
  "ScriptPackageManagerError",
  {
    operation: packageManagerOperationSchema,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScriptPackageManagerShape {
  readonly checkUpdate: (input: {
    readonly packageName: string;
  }) => Effect.Effect<ScriptCatalogOverview, ScriptPackageManagerError>;
  readonly install: (input: {
    readonly credentialId?: string;
    readonly ref?: string;
    readonly replaceExisting?: boolean;
    readonly repositoryUrl: string;
    readonly subdirectory?: string;
  }) => Effect.Effect<ScriptPackageMutationResult, ScriptPackageManagerError>;
  readonly remove: (input: {
    readonly confirmModified?: boolean;
    readonly packageName: string;
  }) => Effect.Effect<ScriptPackageMutationResult, ScriptPackageManagerError>;
  readonly restore: (input: {
    readonly packageName: string;
  }) => Effect.Effect<ScriptPackageMutationResult, ScriptPackageManagerError>;
  readonly update: (input: {
    readonly packageName: string;
    readonly replaceModified?: boolean;
  }) => Effect.Effect<ScriptPackageMutationResult, ScriptPackageManagerError>;
}

export class ScriptPackageManager extends Context.Service<
  ScriptPackageManager,
  ScriptPackageManagerShape
>()("lucent/desktop/scripting/ScriptPackageManager") {}

interface ResolvedPackageRevision {
  readonly checkedAt: string;
  readonly revision: ScriptPackageRevision;
  readonly etag?: string;
}

interface ResolvedInstallSource extends ResolvedPackageRevision {
  readonly commit: string;
}

type ManagedPackageReplacement = {
  readonly installed: ManagedScriptPackage;
} & (
  | {
      readonly kind: "update";
      readonly replaceModified: boolean;
      readonly source: ResolvedInstallSource;
    }
  | {
      readonly kind: "restore";
      readonly source: Pick<ResolvedInstallSource, "commit" | "revision">;
    }
);

const installedRevision = (
  managed: ManagedScriptPackage,
): ScriptPackageRevision =>
  managed.source.kind === "repository"
    ? { kind: "commit", sha: managed.source.resolvedCommit }
    : { kind: "tree", sha: managed.source.resolvedTree };

const revisionsMatch = (
  left: ScriptPackageRevision,
  right: ScriptPackageRevision,
): boolean => left.kind === right.kind && left.sha === right.sha;

const recordRemoteResolution = (
  managed: ManagedScriptPackage,
  resolution: ResolvedPackageRevision,
): ManagedScriptPackage => ({
  directory: managed.directory,
  files: managed.files,
  installedAt: managed.installedAt,
  name: managed.name,
  remoteRevision: resolution.revision,
  source: managed.source,
  update: revisionsMatch(resolution.revision, installedRevision(managed))
    ? { status: "current", checkedAt: resolution.checkedAt }
    : {
        status: "available",
        checkedAt: resolution.checkedAt,
        revision: resolution.revision,
      },
  ...(resolution.etag === undefined ? {} : { etag: resolution.etag }),
});

const nativeCause = (cause: unknown): unknown =>
  isPlatformError(cause) ? (cause.reason.cause ?? cause) : cause;

const managerError = (
  operation: typeof packageManagerOperationSchema.Type,
  detail: string,
  cause?: unknown,
) =>
  new ScriptPackageManagerError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause: nativeCause(cause) }),
  });

const localModifications = (
  packageName: string,
): ScriptPackageMutationResult => ({
  status: "confirmation-required",
  packageName,
  reason: "local-modifications",
});

export const layer = Layer.effect(
  ScriptPackageManager,
  Effect.gen(function* () {
    const catalog = yield* ScriptPackageCatalog;
    const client = yield* GitHubScriptPackageClient;
    const env = yield* DesktopEnvironment;
    const fileSystem = yield* FileSystem;
    const movePath = fileSystem.rename;
    const state = yield* ScriptPackageState;
    const { packagesDir } = resolveScriptWorkspacePaths(env.workspaceDir);
    const mutationGate = yield* Semaphore.make(1);

    const inspectIntegrity = Effect.fnUntraced(function* (
      rootPath: string,
      managed: ManagedScriptPackage | undefined,
    ) {
      const failures: ScriptPackageInspectionFailure[] = [];
      const integrity = yield* Effect.promise(() =>
        integrityFor(rootPath, managed, (failure) => failures.push(failure)),
      );
      if (failures.length > 0)
        yield* logScriptPackageInspectionFailures(failures);
      return integrity;
    });

    const mapCatalogError = (cause: unknown) =>
      managerError("validate", "Failed to update the script catalog.", cause);

    const refreshPackageIntegrity = Effect.fnUntraced(function* (
      name: string,
      rootPath: string,
      integrity: ScriptPackageIntegrity,
    ) {
      const managed = yield* state.get(name);
      if (managed === undefined) return yield* catalog.refresh;
      const inspected = yield* Effect.tryPromise(() =>
        inspectManagedPackageFolder(packagesDir, rootPath, managed),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (inspected === undefined) return yield* catalog.refresh;
      return yield* catalog.replacePackage({
        inspected,
        integrity,
        managed,
        rootPath,
        sourceRoot: rootPath,
      });
    });

    const resolveManagedRevision = Effect.fn(
      "ScriptPackageManager.resolveManagedRevision",
    )(function* (managed: ManagedScriptPackage) {
      if (managed.source.kind === "directory") {
        const result = yield* client.resolveDirectory({
          repositoryUrl: managed.source.repositoryUrl,
          subdirectory: managed.source.subdirectory,
          ...(managed.source.credentialId === undefined
            ? {}
            : { credentialId: managed.source.credentialId }),
          ...(managed.source.requestedRef === undefined
            ? {}
            : { ref: managed.source.requestedRef }),
        });
        return {
          checkedAt: (yield* DateTime.nowAsDate).toISOString(),
          revision: { kind: "tree", sha: result.tree },
        } satisfies ResolvedPackageRevision;
      }

      const etag =
        managed.remoteRevision?.kind === "commit" ? managed.etag : undefined;
      const result = yield* client.resolveCommit({
        repositoryUrl: managed.source.repositoryUrl,
        ...(managed.source.credentialId === undefined
          ? {}
          : { credentialId: managed.source.credentialId }),
        ...(managed.source.requestedRef === undefined
          ? {}
          : { ref: managed.source.requestedRef }),
        ...(etag === undefined ? {} : { etag }),
      });
      const checkedAt = (yield* DateTime.nowAsDate).toISOString();
      if (result.status === "modified") {
        return {
          checkedAt,
          revision: { kind: "commit", sha: result.commit },
          ...(result.etag === undefined ? {} : { etag: result.etag }),
        } satisfies ResolvedPackageRevision;
      }
      if (managed.remoteRevision?.kind !== "commit") {
        return yield* new GitHubScriptPackageClientError({
          kind: "unexpected-response",
          detail: "GitHub returned an incomplete update response. Try again.",
        });
      }
      return {
        checkedAt,
        revision: managed.remoteRevision,
        ...(result.etag === undefined && managed.etag === undefined
          ? {}
          : { etag: result.etag ?? managed.etag }),
      } satisfies ResolvedPackageRevision;
    });

    const resolveManagedInstallSource = Effect.fn(
      "ScriptPackageManager.resolveManagedInstallSource",
    )(function* (managed: ManagedScriptPackage) {
      if (managed.source.kind === "repository") {
        const resolution = yield* resolveManagedRevision(managed);
        if (resolution.revision.kind !== "commit") {
          return yield* new GitHubScriptPackageClientError({
            kind: "unexpected-response",
            detail: "GitHub returned an incomplete package revision.",
          });
        }
        return {
          ...resolution,
          commit: resolution.revision.sha,
        } satisfies ResolvedInstallSource;
      }

      const commit = yield* client.resolveCommit({
        repositoryUrl: managed.source.repositoryUrl,
        ...(managed.source.credentialId === undefined
          ? {}
          : { credentialId: managed.source.credentialId }),
        ...(managed.source.requestedRef === undefined
          ? {}
          : { ref: managed.source.requestedRef }),
      });
      if (commit.status !== "modified") {
        return yield* new GitHubScriptPackageClientError({
          kind: "unexpected-response",
          detail: "GitHub couldn't resolve the selected Git ref to a commit.",
        });
      }
      const directory = yield* client.resolveDirectory({
        repositoryUrl: managed.source.repositoryUrl,
        ref: commit.commit,
        subdirectory: managed.source.subdirectory,
        ...(managed.source.credentialId === undefined
          ? {}
          : { credentialId: managed.source.credentialId }),
      });
      return {
        checkedAt: (yield* DateTime.nowAsDate).toISOString(),
        commit: commit.commit,
        revision: { kind: "tree", sha: directory.tree },
      } satisfies ResolvedInstallSource;
    });

    const replacePackage = Effect.fn("ScriptPackageManager.replacePackage")(
      function* (
        replacement: ScriptPackageCatalogReplacement,
        expected?: ManagedScriptPackage,
      ): Effect.fn.Return<
        ScriptPackageMutationResult,
        ScriptPackageManagerError
      > {
        const {
          managed,
          rootPath: destination,
          sourceRoot: staging,
        } = replacement;
        const publish = catalog.replacePackage(replacement).pipe(
          Effect.mapError(mapCatalogError),
          Effect.map(
            (nextCatalog): ScriptPackageMutationResult => ({
              status: "completed",
              catalog: nextCatalog,
              packageName: managed.name,
            }),
          ),
        );
        const destinationExists = yield* Effect.tryPromise({
          try: () => pathExists(destination),
          catch: (cause) =>
            managerError(
              "replace",
              "Failed to inspect the package destination.",
              cause,
            ),
        });
        yield* fileSystem
          .makeDirectory(dirname(destination), { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              managerError(
                "replace",
                "Failed to replace the package directory.",
                cause,
              ),
            ),
          );

        if (!destinationExists) {
          yield* movePath(staging, destination).pipe(
            Effect.mapError((cause) =>
              managerError(
                "replace",
                "Failed to replace the package directory.",
                cause,
              ),
            ),
          );
          yield* state
            .save(managed)
            .pipe(
              Effect.catch((cause) =>
                movePath(destination, staging).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    managerError(
                      "replace",
                      `Failed to save package installation state. Check ${destination}.`,
                      cause,
                    ),
                  ),
                ),
              ),
            );
          return yield* publish;
        }

        if (
          expected !== undefined &&
          (yield* inspectIntegrity(destination, expected)) !== "verified"
        ) {
          yield* refreshPackageIntegrity(
            expected.name,
            destination,
            "modified",
          ).pipe(Effect.mapError(mapCatalogError));
          return localModifications(expected.name);
        }
        const backupRoot = yield* fileSystem
          .makeTempDirectory({
            directory: env.workspaceDir,
            prefix: ".lucent-package-backup-",
          })
          .pipe(
            Effect.mapError((cause) =>
              managerError(
                "replace",
                "Failed to prepare the package backup.",
                cause,
              ),
            ),
          );
        const backup = join(backupRoot, basename(destination));
        const discardBackup = fileSystem
          .remove(backupRoot, { recursive: true, force: true })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Failed to delete the package backup",
                Cause.fail(cause),
              ).pipe(
                Effect.annotateLogs({
                  component: "script-packages",
                  data: { path: backupRoot },
                }),
              ),
            ),
          );
        yield* movePath(destination, backup).pipe(
          Effect.catch((cause) =>
            discardBackup.pipe(
              Effect.andThen(
                managerError(
                  "replace",
                  `Failed to move the previous package. Check ${destination}.`,
                  cause,
                ),
              ),
            ),
          ),
        );
        yield* movePath(staging, destination).pipe(
          Effect.andThen(
            state
              .save(managed)
              .pipe(
                Effect.tapError(() =>
                  fileSystem
                    .remove(destination, { recursive: true, force: true })
                    .pipe(Effect.ignore),
                ),
              ),
          ),
          Effect.catch(
            Effect.fnUntraced(function* (cause) {
              yield* movePath(backup, destination).pipe(
                Effect.mapError(() =>
                  managerError(
                    "replace",
                    `Failed to replace the package. The previous package remains at ${backup}. Check ${destination}.`,
                    cause,
                  ),
                ),
              );
              yield* discardBackup;
              return yield* managerError(
                "replace",
                `Failed to replace the package. The previous package was restored at ${destination}.`,
                cause,
              );
            }),
          ),
        );
        yield* discardBackup;
        return yield* publish;
      },
      Effect.uninterruptible,
    );

    const installInternal = Effect.fn("ScriptPackageManager.installInternal")(
      function* (
        input: Parameters<ScriptPackageManagerShape["install"]>[0],
        replacement?: ManagedPackageReplacement,
      ) {
        const repository = yield* Effect.try({
          try: () => normalizeGitHubRepositoryUrl(input.repositoryUrl),
          catch: (cause) =>
            managerError(
              "install",
              "Enter a valid GitHub.com repository URL.",
              cause,
            ),
        });
        const subdirectory =
          input.subdirectory === undefined
            ? undefined
            : yield* Effect.try({
                try: () => decodeRepositorySubdirectory(input.subdirectory),
                catch: (cause) =>
                  managerError(
                    "install",
                    "Enter a valid repository-relative package directory.",
                    cause,
                  ),
              });
        const resolvedSource =
          replacement?.kind === "restore"
            ? {
                ...replacement.source,
                kind: "restore" as const,
                installed: replacement.installed,
              }
            : {
                ...(replacement?.source ??
                  (yield* Effect.gen(function* () {
                    const commit = yield* client
                      .resolveCommit({
                        repositoryUrl: repository.url,
                        ...(input.credentialId === undefined
                          ? {}
                          : { credentialId: input.credentialId }),
                        ...(input.ref === undefined ? {} : { ref: input.ref }),
                      })
                      .pipe(
                        Effect.mapError((cause) =>
                          managerError("install", cause.message, cause),
                        ),
                      );
                    if (commit.status !== "modified") {
                      return yield* managerError(
                        "install",
                        "GitHub couldn't resolve the selected Git ref to a commit.",
                      );
                    }
                    const checkedAt = (yield* DateTime.nowAsDate).toISOString();
                    if (subdirectory === undefined) {
                      return {
                        checkedAt,
                        commit: commit.commit,
                        revision: { kind: "commit", sha: commit.commit },
                        ...(commit.etag === undefined
                          ? {}
                          : { etag: commit.etag }),
                      } satisfies ResolvedInstallSource;
                    }
                    const directory = yield* client
                      .resolveDirectory({
                        repositoryUrl: repository.url,
                        ref: commit.commit,
                        subdirectory,
                        ...(input.credentialId === undefined
                          ? {}
                          : { credentialId: input.credentialId }),
                      })
                      .pipe(
                        Effect.mapError((cause) =>
                          managerError("install", cause.message, cause),
                        ),
                      );
                    return {
                      checkedAt,
                      commit: commit.commit,
                      revision: { kind: "tree", sha: directory.tree },
                    } satisfies ResolvedInstallSource;
                  }))),
                kind: "remote" as const,
              };
        if (
          (subdirectory === undefined &&
            resolvedSource.revision.kind !== "commit") ||
          (subdirectory !== undefined &&
            resolvedSource.revision.kind !== "tree")
        ) {
          return yield* managerError(
            "install",
            "GitHub returned an incomplete package revision.",
          );
        }

        yield* fileSystem
          .makeDirectory(packagesDir, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              managerError(
                "install",
                "Failed to create the package directory.",
                cause,
              ),
            ),
          );
        return yield* Effect.acquireUseRelease(
          fileSystem
            .makeTempDirectory({
              directory: env.workspaceDir,
              prefix: ".lucent-package-install-",
            })
            .pipe(
              Effect.mapError((cause) =>
                managerError(
                  "install",
                  "Failed to create package staging.",
                  cause,
                ),
              ),
            ),
          (temporaryRoot) =>
            Effect.gen(function* () {
              const archive = join(temporaryRoot, "repository.tgz");
              const staging = join(temporaryRoot, "package");
              yield* client
                .downloadArchive({
                  repositoryUrl: repository.url,
                  ref: resolvedSource.commit,
                  targetPath: archive,
                  ...(input.credentialId === undefined
                    ? {}
                    : { credentialId: input.credentialId }),
                })
                .pipe(
                  Effect.mapError((cause) =>
                    managerError(
                      replacement?.kind === "restore" ? "restore" : "install",
                      replacement?.kind === "restore" &&
                        cause.kind === "not-found"
                        ? "GitHub could not provide the installed commit. Check repository access. Check for updates, then use Update to install the latest version."
                        : cause.message,
                      cause,
                    ),
                  ),
                );
              yield* Effect.tryPromise({
                try: () =>
                  extractScriptPackageArchive(archive, staging, subdirectory),
                catch: (cause) =>
                  managerError(
                    "extract",
                    subdirectory === undefined
                      ? "The GitHub archive is not a safe script package."
                      : "The selected package directory could not be safely extracted.",
                    cause,
                  ),
              });

              const inspected = yield* Effect.tryPromise({
                try: () => inspectScriptPackageDirectory(staging),
                catch: (cause) =>
                  managerError(
                    "validate",
                    subdirectory === undefined
                      ? "The repository root is not a valid script package."
                      : "The selected package directory is not a valid script package.",
                    cause,
                  ),
              });
              const packageName = inspected.manifest.name;
              if (
                replacement !== undefined &&
                packageName !== replacement.installed.name
              ) {
                return yield* managerError(
                  replacement.kind,
                  `The downloaded package declares ${JSON.stringify(packageName)} instead of ${JSON.stringify(replacement.installed.name)}.`,
                );
              }

              const discovery = yield* catalog.getDiscovery.pipe(
                Effect.mapError((cause) =>
                  managerError(
                    "validate",
                    "Failed to inspect installed packages.",
                    cause,
                  ),
                ),
              );
              const matchingPackages = discovery.catalog.packages.filter(
                (entry) => entry.name === packageName,
              );
              if (matchingPackages.length > 1) {
                return yield* managerError(
                  "validate",
                  `More than one package folder declares the name ${JSON.stringify(packageName)}.`,
                );
              }
              const matchingPackage = matchingPackages[0];
              const savedPackage =
                replacement?.installed ?? (yield* state.get(packageName));
              const reservedDirectories = new Set(
                (yield* state.getAll).map((entry) => entry.directory),
              );
              const directory = yield* Effect.tryPromise({
                try: async () => {
                  if (savedPackage !== undefined) {
                    return savedPackage.directory;
                  }
                  if (matchingPackage !== undefined) {
                    return decodePackageDirectory(
                      basename(matchingPackage.path),
                    );
                  }
                  return allocatePackageDirectory(
                    packagesDir,
                    packageName,
                    reservedDirectories,
                  );
                },
                catch: (cause) =>
                  managerError(
                    "validate",
                    "Failed to choose a package folder.",
                    cause,
                  ),
              });
              const destination = packageDirectoryPath(packagesDir, directory);
              if (
                matchingPackage !== undefined &&
                resolve(matchingPackage.path) !== resolve(destination)
              ) {
                return yield* managerError(
                  "validate",
                  `Package ${JSON.stringify(packageName)} is not in its saved folder.`,
                );
              }
              const destinationExists = yield* Effect.tryPromise({
                try: () => pathExists(destination),
                catch: (cause) =>
                  managerError(
                    "validate",
                    "Failed to inspect the package destination.",
                    cause,
                  ),
              });
              if (
                destinationExists &&
                savedPackage === undefined &&
                matchingPackage === undefined
              ) {
                return yield* managerError(
                  "validate",
                  `Package folder ${JSON.stringify(directory)} is already in use.`,
                );
              }
              if (destinationExists && input.replaceExisting !== true) {
                return {
                  status: "confirmation-required",
                  packageName,
                  reason: "existing-package",
                } satisfies ScriptPackageMutationResult;
              }

              const files = yield* Effect.tryPromise({
                try: () => hashDirectory(staging),
                catch: (cause) =>
                  managerError(
                    "validate",
                    "Failed to hash the staged package.",
                    cause,
                  ),
              });
              const installedAt = (yield* DateTime.nowAsDate).toISOString();
              const managed: ManagedScriptPackage =
                resolvedSource.kind === "restore"
                  ? {
                      ...resolvedSource.installed,
                      files,
                      installedAt,
                    }
                  : {
                      directory,
                      files,
                      installedAt,
                      name: packageName,
                      remoteRevision: resolvedSource.revision,
                      source:
                        subdirectory === undefined
                          ? {
                              kind: "repository",
                              repositoryUrl: repository.url,
                              resolvedCommit: resolvedSource.commit,
                              ...(input.credentialId === undefined
                                ? {}
                                : { credentialId: input.credentialId }),
                              ...(input.ref?.trim()
                                ? { requestedRef: input.ref.trim() }
                                : {}),
                            }
                          : {
                              kind: "directory",
                              repositoryUrl: repository.url,
                              resolvedCommit: resolvedSource.commit,
                              resolvedTree: resolvedSource.revision.sha,
                              subdirectory,
                              ...(input.credentialId === undefined
                                ? {}
                                : { credentialId: input.credentialId }),
                              ...(input.ref?.trim()
                                ? { requestedRef: input.ref.trim() }
                                : {}),
                            },
                      update: {
                        status: "current",
                        checkedAt: resolvedSource.checkedAt,
                      },
                      ...(resolvedSource.etag === undefined
                        ? {}
                        : { etag: resolvedSource.etag }),
                    };
              return yield* replacePackage(
                {
                  inspected,
                  managed,
                  rootPath: destination,
                  sourceRoot: staging,
                },
                replacement !== undefined &&
                  replacement.kind === "update" &&
                  !replacement.replaceModified
                  ? replacement.installed
                  : undefined,
              );
            }),
          (temporaryRoot) =>
            fileSystem.remove(temporaryRoot, { recursive: true }).pipe(
              Effect.mapError((cause) =>
                managerError(
                  "install",
                  "Failed to clean package staging.",
                  cause,
                ),
              ),
              Effect.catch(() => Effect.void),
            ),
        );
      },
    );

    const install: ScriptPackageManagerShape["install"] = (input) =>
      mutationGate.withPermits(1)(installInternal(input));

    const update: ScriptPackageManagerShape["update"] = (input) =>
      mutationGate.withPermits(1)(
        Effect.gen(function* () {
          const discovery = yield* catalog.getDiscovery.pipe(
            Effect.mapError((cause) =>
              managerError(
                "update",
                "Failed to inspect installed packages.",
                cause,
              ),
            ),
          );
          const summary = discovery.catalog.packages.find(
            (entry) =>
              entry.status === "valid" && entry.name === input.packageName,
          );
          if (summary?.status !== "valid") {
            return yield* managerError(
              "update",
              `Package ${JSON.stringify(input.packageName)} is not installed.`,
            );
          }
          const managed = yield* state.get(input.packageName);
          if (managed === undefined) {
            return yield* managerError(
              "update",
              "This package is unmanaged and has no GitHub source to update.",
            );
          }
          const savedRoot = packageDirectoryPath(
            packagesDir,
            managed.directory,
          );
          if (resolve(summary.path) !== resolve(savedRoot)) {
            return yield* managerError(
              "update",
              `Package ${JSON.stringify(input.packageName)} is not in its saved folder.`,
            );
          }

          const resolution = yield* resolveManagedInstallSource(managed).pipe(
            Effect.mapError((cause) =>
              managerError("update", cause.message, cause),
            ),
          );
          const observed = recordRemoteResolution(managed, resolution);
          yield* state
            .save(observed)
            .pipe(
              Effect.mapError((cause) =>
                managerError(
                  "update",
                  "Failed to save the package update state.",
                  cause,
                ),
              ),
            );
          const integrity = yield* inspectIntegrity(savedRoot, managed);
          const nextCatalog = yield* (
            integrity === summary.integrity
              ? catalog.updateManagedPackage(observed)
              : refreshPackageIntegrity(managed.name, savedRoot, integrity)
          ).pipe(Effect.mapError(mapCatalogError));
          if (integrity !== "verified" && input.replaceModified !== true) {
            return localModifications(input.packageName);
          }
          if (
            integrity === "verified" &&
            revisionsMatch(resolution.revision, installedRevision(managed))
          ) {
            return {
              status: "unchanged",
              catalog: nextCatalog,
              packageName: input.packageName,
            } satisfies ScriptPackageMutationResult;
          }
          return yield* installInternal(
            {
              repositoryUrl: managed.source.repositoryUrl,
              replaceExisting: true,
              ...(managed.source.credentialId === undefined
                ? {}
                : { credentialId: managed.source.credentialId }),
              ...(managed.source.requestedRef === undefined
                ? {}
                : { ref: managed.source.requestedRef }),
              ...(managed.source.kind === "repository"
                ? {}
                : { subdirectory: managed.source.subdirectory }),
            },
            {
              kind: "update",
              installed: managed,
              source: resolution,
              replaceModified: input.replaceModified === true,
            },
          );
        }),
      );

    const restore: ScriptPackageManagerShape["restore"] = (input) =>
      mutationGate.withPermits(1)(
        Effect.gen(function* () {
          const managed = yield* state.get(input.packageName);
          if (managed === undefined) {
            return yield* managerError(
              "restore",
              "This package has no saved GitHub installation to restore.",
            );
          }
          const source = managed.source;
          const restoreCommit = (commit: string) =>
            installInternal(
              {
                repositoryUrl: managed.source.repositoryUrl,
                replaceExisting: true,
                ...(managed.source.credentialId === undefined
                  ? {}
                  : { credentialId: managed.source.credentialId }),
                ...(managed.source.kind === "repository"
                  ? {}
                  : { subdirectory: managed.source.subdirectory }),
              },
              {
                kind: "restore",
                installed: managed,
                source: {
                  commit,
                  revision: installedRevision(managed),
                },
              },
            );
          if (source.kind === "repository")
            return yield* restoreCommit(source.resolvedCommit);
          if (source.resolvedCommit !== undefined)
            return yield* restoreCommit(source.resolvedCommit);
          const unavailable =
            "The installed bundled copy is not available in this app. Check for updates, then use Update to install the latest version.";
          const bundledRoot = join(env.assetsDir, "..", "script-packages");
          const bundledPath = join(env.assetsDir, "..", source.subdirectory);
          if (!isPathInside(bundledRoot, bundledPath))
            return yield* managerError("restore", unavailable);
          return yield* Effect.acquireUseRelease(
            fileSystem
              .makeTempDirectory({
                directory: env.workspaceDir,
                prefix: ".lucent-package-install-",
              })
              .pipe(
                Effect.mapError((cause) =>
                  managerError(
                    "restore",
                    "Failed to create package staging.",
                    cause,
                  ),
                ),
              ),
            (temporaryRoot) =>
              Effect.gen(function* () {
                const staging = join(temporaryRoot, "package");
                const snapshot = yield* Effect.tryPromise({
                  try: () => copyBundledScriptPackage(bundledPath, staging),
                  catch: (cause) => managerError("restore", unavailable, cause),
                });
                if (snapshot.tree !== source.resolvedTree)
                  return yield* managerError("restore", unavailable);
                const inspected = yield* Effect.tryPromise({
                  try: () => inspectScriptPackageDirectory(staging),
                  catch: (cause) =>
                    managerError(
                      "restore",
                      "The bundled copy is not a valid script package.",
                      cause,
                    ),
                });
                if (inspected.manifest.name !== managed.name)
                  return yield* managerError("restore", unavailable);
                const overview = yield* catalog.getOverview.pipe(
                  Effect.mapError(mapCatalogError),
                );
                const matchingPackages = overview.packages.filter(
                  (entry) => entry.name === managed.name,
                );
                if (matchingPackages.length > 1)
                  return yield* managerError(
                    "restore",
                    `More than one package folder declares the name ${JSON.stringify(managed.name)}.`,
                  );
                const destination = packageDirectoryPath(
                  packagesDir,
                  managed.directory,
                );
                const matchingPackage = matchingPackages[0];
                if (
                  matchingPackage !== undefined &&
                  resolve(matchingPackage.path) !== resolve(destination)
                ) {
                  return yield* managerError(
                    "restore",
                    `Package ${JSON.stringify(managed.name)} is not in its saved folder.`,
                  );
                }
                return yield* replacePackage({
                  inspected,
                  managed: {
                    ...managed,
                    files: snapshot.files,
                    installedAt: yield* DateTime.now.pipe(
                      Effect.map(DateTime.formatIso),
                    ),
                  },
                  rootPath: destination,
                  sourceRoot: staging,
                });
              }),
            (temporaryRoot) =>
              fileSystem
                .remove(temporaryRoot, { recursive: true, force: true })
                .pipe(Effect.ignore),
          );
        }),
      );

    const remove: ScriptPackageManagerShape["remove"] = (input) =>
      mutationGate.withPermits(1)(
        Effect.gen(function* () {
          const discovery = yield* catalog.getDiscovery.pipe(
            Effect.mapError((cause) =>
              managerError(
                "remove",
                "Failed to inspect installed packages.",
                cause,
              ),
            ),
          );
          const summary = discovery.catalog.packages.find(
            (entry) =>
              entry.status === "valid" && entry.name === input.packageName,
          );
          if (summary?.status !== "valid") {
            return yield* managerError(
              "remove",
              `Package ${JSON.stringify(input.packageName)} is not installed.`,
            );
          }
          const managed = yield* state.get(input.packageName);
          const directory = yield* Effect.try({
            try: () =>
              managed?.directory ??
              decodePackageDirectory(basename(summary.path)),
            catch: (cause) =>
              managerError(
                "remove",
                "The package folder name is not safe.",
                cause,
              ),
          });
          const root = packageDirectoryPath(packagesDir, directory);
          if (resolve(summary.path) !== resolve(root)) {
            return yield* managerError(
              "remove",
              `Package ${JSON.stringify(input.packageName)} is not in its saved folder.`,
            );
          }
          if (input.confirmModified !== true && managed === undefined) {
            return localModifications(input.packageName);
          }
          return yield* Effect.gen(function* () {
            if (
              input.confirmModified !== true &&
              (yield* inspectIntegrity(root, managed)) !== "verified"
            ) {
              yield* refreshPackageIntegrity(
                input.packageName,
                root,
                "modified",
              ).pipe(Effect.mapError(mapCatalogError));
              return localModifications(input.packageName);
            }
            yield* state
              .remove(input.packageName)
              .pipe(
                Effect.mapError((cause) =>
                  managerError(
                    "remove",
                    "Failed to update package state.",
                    cause,
                  ),
                ),
              );
            yield* fileSystem.remove(root, { recursive: true }).pipe(
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  yield* catalog.refresh.pipe(Effect.ignore);
                  return yield* managerError(
                    "remove",
                    `Failed to delete the package folder at ${root}. It is now unmanaged.`,
                    cause,
                  );
                }),
              ),
            );
            const nextCatalog = yield* catalog
              .removePackage(input.packageName)
              .pipe(Effect.mapError(mapCatalogError));
            return {
              status: "completed",
              catalog: nextCatalog,
              packageName: input.packageName,
            } satisfies ScriptPackageMutationResult;
          }).pipe(Effect.uninterruptible);
        }),
      );

    const checkUpdate: ScriptPackageManagerShape["checkUpdate"] = (input) =>
      Effect.gen(function* () {
        const managed = yield* state.get(input.packageName);
        if (managed === undefined) {
          return yield* managerError(
            "check-update",
            "This package is unmanaged and has no GitHub source to check.",
          );
        }
        const result = yield* resolveManagedRevision(managed).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              logFailure(
                "Failed to check script package updates",
                Cause.fail(error),
                { failure: "warning" },
              ).pipe(
                Effect.annotateLogs({
                  component: "script-packages",
                  repeatKey: error.kind,
                  data: {
                    packageName: managed.name,
                    category: error.kind,
                    ...(error.retryAt === undefined
                      ? {}
                      : { retryAt: error.retryAt }),
                  },
                }),
                Effect.as({ status: "failed", error } as const),
              ),
            onSuccess: (value) =>
              Effect.succeed({ status: "succeeded", value } as const),
          }),
        );

        const lastSuccessfulCheckAt =
          managed.update?.status === "current" ||
          managed.update?.status === "available"
            ? managed.update.checkedAt
            : managed.update?.status === "unknown"
              ? managed.update.checkedAt
              : undefined;
        const next: ManagedScriptPackage =
          result.status === "succeeded"
            ? recordRemoteResolution(managed, result.value)
            : {
                ...managed,
                update:
                  result.error.kind === "rate-limited" &&
                  result.error.retryAt !== undefined
                    ? {
                        status: "rate-limited",
                        message: "GitHub's request limit has been reached.",
                        retryAt: result.error.retryAt,
                      }
                    : {
                        status: "unknown",
                        message: result.error.message,
                        ...(lastSuccessfulCheckAt === undefined
                          ? {}
                          : { checkedAt: lastSuccessfulCheckAt }),
                      },
              };
        return yield* mutationGate.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* state.get(input.packageName);
            if (
              current === undefined ||
              !managedPackagesEquivalent(current, managed)
            ) {
              return yield* catalog.getOverview.pipe(
                Effect.mapError(mapCatalogError),
              );
            }
            yield* state
              .save(next)
              .pipe(
                Effect.mapError((cause) =>
                  managerError(
                    "check-update",
                    "Failed to save update state.",
                    cause,
                  ),
                ),
              );
            return yield* catalog
              .updateManagedPackage(next)
              .pipe(Effect.mapError(mapCatalogError));
          }),
        );
      });

    return ScriptPackageManager.of({
      checkUpdate,
      install,
      remove,
      restore,
      update,
    });
  }),
);
