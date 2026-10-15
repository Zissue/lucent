import { promises as fs } from "fs";
import { basename, dirname, join, resolve } from "path";
import { isDeepStrictEqual } from "util";

import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { list as listTar, extract as extractTar } from "tar";

import type {
  ScriptCatalogOverview,
  ScriptPackageMutationResult,
  ScriptPackageRevision,
} from "@lucent/core/scriptPackages";
import {
  ScriptPackageDirectorySchema,
  ScriptPackageRepositorySubdirectorySchema,
} from "@lucent/core/scriptPackages";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import {
  GitHubScriptPackageClient,
  GitHubScriptPackageClientError,
  normalizeGitHubRepositoryUrl,
} from "./GitHubScriptPackageClient";
import {
  inspectScriptPackageDirectory,
  integrityFor,
  ScriptPackageCatalog,
  type ScriptPackageCatalogReplacement,
} from "./ScriptPackageCatalog";
import { hashDirectory } from "./ScriptPackageFileSystem";
import {
  allocatePackageDirectory,
  packageDirectoryPath,
  pathExists,
} from "./ScriptPackageDirectories";
import {
  ScriptPackageState,
  type ManagedScriptPackage,
} from "./ScriptPackageState";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";
import {
  formatBytes,
  SCRIPT_PACKAGE_ARCHIVE_MAX_ENTRIES,
  SCRIPT_PACKAGE_ARCHIVE_PATH_MAX_BYTES,
  SCRIPT_PACKAGE_MAX_BYTES,
  SCRIPT_PACKAGE_PATH_COMPONENT_MAX_BYTES,
} from "./ScriptLimits";

const decodePackageDirectory = Schema.decodeUnknownSync(
  ScriptPackageDirectorySchema,
);
const decodeRepositorySubdirectory = Schema.decodeUnknownSync(
  ScriptPackageRepositorySubdirectorySchema,
);

const packageManagerOperationSchema = Schema.Literals([
  "check-update",
  "extract",
  "install",
  "remove",
  "replace",
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
  readonly update: (input: {
    readonly packageName: string;
    readonly replaceModified?: boolean;
  }) => Effect.Effect<ScriptPackageMutationResult, ScriptPackageManagerError>;
}

export class ScriptPackageManager extends Context.Service<
  ScriptPackageManager,
  ScriptPackageManagerShape
>()("lucent/desktop/scripting/ScriptPackageManager") {}

interface ArchiveInventory {
  readonly root: string;
}

interface ArchiveValidationOptions {
  readonly subdirectory?: string;
}

interface ResolvedPackageRevision {
  readonly checkedAt: string;
  readonly revision: ScriptPackageRevision;
  readonly etag?: string;
}

interface ResolvedInstallSource extends ResolvedPackageRevision {
  readonly commit: string;
}

interface ManagedPackageUpdate {
  readonly installed: ManagedScriptPackage;
  readonly source: ResolvedInstallSource;
  readonly replaceModified: boolean;
}

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

const managerError = (
  operation: typeof packageManagerOperationSchema.Type,
  detail: string,
  cause?: unknown,
) =>
  new ScriptPackageManagerError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const localModifications = (
  packageName: string,
): ScriptPackageMutationResult => ({
  status: "confirmation-required",
  packageName,
  reason: "local-modifications",
});

const movePath = (from: string, to: string) =>
  Effect.tryPromise(() => fs.rename(from, to));

const archivePath = (rawPath: string): readonly string[] => {
  if (
    rawPath === "" ||
    rawPath.startsWith("/") ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    Buffer.byteLength(rawPath, "utf8") > SCRIPT_PACKAGE_ARCHIVE_PATH_MAX_BYTES
  ) {
    throw new Error(
      `Archive contains an unsafe path: ${JSON.stringify(rawPath)}.`,
    );
  }
  const parts = rawPath.endsWith("/")
    ? rawPath.slice(0, -1).split("/")
    : rawPath.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part, "utf8") >
          SCRIPT_PACKAGE_PATH_COMPONENT_MAX_BYTES,
    )
  ) {
    throw new Error(
      `Archive contains an unsafe path: ${JSON.stringify(rawPath)}.`,
    );
  }
  return parts;
};

export const validateScriptPackageArchive = async (
  path: string,
  options: ArchiveValidationOptions = {},
): Promise<ArchiveInventory> => {
  const caseInsensitivePaths =
    process.platform === "darwin" || process.platform === "win32";
  const subdirectory =
    options.subdirectory === undefined
      ? undefined
      : decodeRepositorySubdirectory(options.subdirectory);
  const subdirectoryPrefix =
    subdirectory === undefined ? undefined : `${subdirectory}/`;
  const platformPaths = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;
  let root: string | undefined;
  let selectedDirectoryFound = subdirectory === undefined;
  let validationError: Error | undefined;

  await listTar({
    file: path,
    strict: true,
    onReadEntry: (entry) => {
      if (validationError !== undefined) return;
      try {
        if (
          entry.type !== "File" &&
          entry.type !== "OldFile" &&
          entry.type !== "Directory"
        ) {
          throw new Error(
            `Archive entry ${JSON.stringify(entry.path)} has unsupported type ${entry.type}.`,
          );
        }
        const [entryRoot, ...relativeParts] = archivePath(entry.path);
        if (entryRoot === undefined) {
          throw new Error("Archive entry has no root directory.");
        }
        root ??= entryRoot;
        if (root !== entryRoot) {
          throw new Error("Archive contains more than one root directory.");
        }
        if (relativeParts.length === 0) return;

        const relativePath = relativeParts.join("/");
        if (relativePath === subdirectory) {
          if (entry.type !== "Directory") {
            throw new Error(
              `Selected package path ${JSON.stringify(subdirectory)} is not a directory.`,
            );
          }
          selectedDirectoryFound = true;
        } else if (
          subdirectoryPrefix !== undefined &&
          relativePath.startsWith(subdirectoryPrefix)
        ) {
          selectedDirectoryFound = true;
        }
        const normalizedPath = relativePath.normalize("NFC");
        const platformPath = caseInsensitivePaths
          ? normalizedPath.toLocaleLowerCase("en-US")
          : normalizedPath;
        if (platformPaths.has(platformPath)) {
          throw new Error(
            `Archive contains a colliding path: ${relativePath}.`,
          );
        }
        platformPaths.add(platformPath);

        entryCount += 1;
        const size = entry.type === "Directory" ? 0 : entry.size;
        if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
          throw new Error(
            `Archive entry ${JSON.stringify(entry.path)} has an invalid size.`,
          );
        }
        extractedBytes += size;
        if (entryCount > SCRIPT_PACKAGE_ARCHIVE_MAX_ENTRIES) {
          throw new Error(
            `Archive contains more than ${SCRIPT_PACKAGE_ARCHIVE_MAX_ENTRIES} entries.`,
          );
        }
        if (extractedBytes > SCRIPT_PACKAGE_MAX_BYTES) {
          throw new Error(
            `Archive expands beyond ${formatBytes(SCRIPT_PACKAGE_MAX_BYTES)}.`,
          );
        }
      } catch (cause) {
        validationError =
          cause instanceof Error
            ? cause
            : new Error("Archive validation failed.");
      }
    },
  });
  if (validationError !== undefined) throw validationError;
  if (root === undefined) throw new Error("Archive is empty.");
  if (!selectedDirectoryFound) {
    throw new Error(
      `Archive does not contain package directory ${JSON.stringify(subdirectory)}.`,
    );
  }
  return { root };
};

export const extractScriptPackageArchive = async (
  archivePath: string,
  targetPath: string,
  subdirectory?: string,
): Promise<void> => {
  const inventory = await validateScriptPackageArchive(
    archivePath,
    subdirectory === undefined ? {} : { subdirectory },
  );
  await fs.mkdir(targetPath, { recursive: true });
  const selectedPrefix =
    subdirectory === undefined
      ? undefined
      : `${inventory.root}/${subdirectory}/`;
  await extractTar({
    cwd: targetPath,
    file: archivePath,
    ...(selectedPrefix === undefined
      ? {}
      : { filter: (path) => path.startsWith(selectedPrefix) }),
    noMtime: true,
    preserveOwner: false,
    preservePaths: false,
    strict: true,
    strip: subdirectory === undefined ? 1 : subdirectory.split("/").length + 1,
    unlink: true,
  });
};

export const layer = Layer.effect(
  ScriptPackageManager,
  Effect.gen(function* () {
    const catalog = yield* ScriptPackageCatalog;
    const client = yield* GitHubScriptPackageClient;
    const env = yield* DesktopEnvironment;
    const state = yield* ScriptPackageState;
    const { packagesDir } = resolveScriptWorkspacePaths(env.workspaceDir);
    const mutationGate = yield* Semaphore.make(1);

    const mapCatalogError = (cause: unknown) =>
      managerError("validate", "Failed to update the script catalog.", cause);

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
          checkedAt: new Date().toISOString(),
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
      const checkedAt = new Date().toISOString();
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
        checkedAt: new Date().toISOString(),
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
        yield* Effect.tryPromise({
          try: () => fs.mkdir(dirname(destination), { recursive: true }),
          catch: (cause) =>
            managerError(
              "replace",
              "Failed to replace the package directory.",
              cause,
            ),
        });

        if (!destinationExists) {
          yield* movePath(staging, destination).pipe(
            Effect.mapError(({ cause }) =>
              managerError(
                "replace",
                "Failed to replace the package directory.",
                cause,
              ),
            ),
          );
          yield* state.save(managed).pipe(
            Effect.catch((cause) =>
              movePath(destination, staging).pipe(
                Effect.matchEffect({
                  onFailure: ({ cause: undoCause }) =>
                    Effect.fail(
                      managerError(
                        "replace",
                        `Failed to save package installation state. The new package was left at ${destination}.`,
                        { cause, undoCause },
                      ),
                    ),
                  onSuccess: () =>
                    Effect.fail(
                      managerError(
                        "replace",
                        "Failed to save package installation state.",
                        cause,
                      ),
                    ),
                }),
              ),
            ),
          );
          return yield* publish;
        }

        const backupRoot = yield* Effect.tryPromise({
          try: () =>
            fs.mkdtemp(join(env.workspaceDir, ".lucent-package-backup-")),
          catch: (cause) =>
            managerError(
              "replace",
              "Failed to prepare the package backup.",
              cause,
            ),
        });
        const backup = join(backupRoot, basename(destination));
        const discardBackup = Effect.tryPromise(() =>
          fs.rm(backupRoot, { recursive: true, force: true }),
        ).pipe(Effect.ignore);
        const removeEmptyBackup = Effect.tryPromise(() =>
          fs.rmdir(backupRoot),
        ).pipe(Effect.ignore);
        const failReplacement = Effect.fnUntraced(function* (
          cause: unknown,
          restoredDetail: string,
          unrestoredDetail = restoredDetail,
        ): Effect.fn.Return<never, ScriptPackageManagerError> {
          const backupExists = yield* Effect.tryPromise(() =>
            pathExists(backup),
          ).pipe(Effect.orElseSucceed(() => true));
          if (!backupExists) yield* removeEmptyBackup;
          return yield* managerError(
            "replace",
            backupExists
              ? `${unrestoredDetail} The previous package is saved at ${backup}.`
              : restoredDetail,
            cause,
          );
        });
        const rollBack = (
          undo: Effect.Effect<void, Cause.UnknownError>,
          cause: unknown,
          restoredDetail: string,
          unrestoredDetail: string,
        ) =>
          undo.pipe(
            Effect.match({
              onFailure: ({ cause: restoreCause }) => ({
                cause,
                restoreCause,
              }),
              onSuccess: () => cause,
            }),
            Effect.flatMap((failureCause) =>
              failReplacement(failureCause, restoredDetail, unrestoredDetail),
            ),
          );

        yield* movePath(destination, backup).pipe(
          Effect.catch(({ cause }) =>
            failReplacement(cause, "Failed to replace the package directory."),
          ),
        );
        if (
          expected !== undefined &&
          (yield* Effect.promise(() => integrityFor(backup, expected))) !==
            "verified"
        ) {
          yield* movePath(backup, destination).pipe(
            Effect.catch(({ cause }) =>
              failReplacement(
                cause,
                "Failed to restore the locally modified package.",
              ),
            ),
          );
          yield* removeEmptyBackup;
          yield* catalog.refresh.pipe(Effect.mapError(mapCatalogError));
          return localModifications(expected.name);
        }
        yield* movePath(staging, destination).pipe(
          Effect.catch(({ cause }) =>
            rollBack(
              movePath(backup, destination),
              cause,
              "Failed to replace the package directory; the previous package was restored.",
              "Failed to replace the package directory and could not restore the previous package.",
            ),
          ),
        );
        yield* state
          .save(managed)
          .pipe(
            Effect.catch((cause) =>
              rollBack(
                movePath(destination, staging).pipe(
                  Effect.andThen(movePath(backup, destination)),
                ),
                cause,
                "Failed to save package installation state.",
                "Package state failed and the previous package could not be restored.",
              ),
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
        update?: ManagedPackageUpdate,
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
        const resolvedSource: ResolvedInstallSource =
          update?.source ??
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
            const checkedAt = new Date().toISOString();
            if (subdirectory === undefined) {
              return {
                checkedAt,
                commit: commit.commit,
                revision: { kind: "commit", sha: commit.commit },
                ...(commit.etag === undefined ? {} : { etag: commit.etag }),
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
          }));
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

        yield* Effect.tryPromise({
          try: () => fs.mkdir(packagesDir, { recursive: true }),
          catch: (cause) =>
            managerError(
              "install",
              "Failed to create the package directory.",
              cause,
            ),
        });
        const temporaryRoot = yield* Effect.tryPromise({
          try: () =>
            fs.mkdtemp(join(env.workspaceDir, ".lucent-package-install-")),
          catch: (cause) =>
            managerError("install", "Failed to create package staging.", cause),
        });

        return yield* Effect.acquireUseRelease(
          Effect.succeed(temporaryRoot),
          () =>
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
                    managerError("install", cause.message, cause),
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
                update !== undefined &&
                packageName !== update.installed.name
              ) {
                return yield* managerError(
                  "update",
                  `The update declares package ${JSON.stringify(packageName)} instead of ${JSON.stringify(update.installed.name)}.`,
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
                update?.installed ?? (yield* state.get(packageName));
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
              const managed: ManagedScriptPackage = {
                directory,
                files,
                installedAt: new Date().toISOString(),
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
                update !== undefined && !update.replaceModified
                  ? update.installed
                  : undefined,
              );
            }),
          () =>
            Effect.tryPromise({
              try: () => fs.rm(temporaryRoot, { recursive: true }),
              catch: (cause) =>
                managerError(
                  "install",
                  "Failed to clean package staging.",
                  cause,
                ),
            }).pipe(Effect.catch(() => Effect.void)),
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
          const integrity = yield* Effect.promise(() =>
            integrityFor(savedRoot, managed),
          );
          const nextCatalog = yield* (
            integrity === summary.integrity
              ? catalog.updateManagedPackage(observed)
              : catalog.refresh
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
              installed: managed,
              source: resolution,
              replaceModified: input.replaceModified === true,
            },
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
            const temporaryRoot = yield* Effect.tryPromise({
              try: () =>
                fs.mkdtemp(join(env.workspaceDir, ".lucent-package-remove-")),
              catch: (cause) =>
                managerError(
                  "remove",
                  "Failed to create removal staging.",
                  cause,
                ),
            });
            const removedPath = join(temporaryRoot, basename(root));
            const removeEmptyStaging = Effect.tryPromise(() =>
              fs.rmdir(temporaryRoot),
            ).pipe(Effect.ignore);
            const failRemoval = Effect.fnUntraced(function* (
              cause: unknown,
              restoredDetail: string,
              unrestoredDetail = restoredDetail,
            ): Effect.fn.Return<never, ScriptPackageManagerError> {
              const location = yield* Effect.tryPromise(() =>
                pathExists(removedPath),
              ).pipe(
                Effect.match({
                  onFailure: () => "unknown" as const,
                  onSuccess: (exists) =>
                    exists ? ("present" as const) : ("absent" as const),
                }),
              );
              if (location === "absent") yield* removeEmptyStaging;
              return yield* managerError(
                "remove",
                location === "unknown"
                  ? `Failed to remove the package. Its location could not be checked. Check ${root} and ${removedPath}.`
                  : location === "present"
                    ? `${unrestoredDetail} The package is saved at ${removedPath}.`
                    : restoredDetail,
                cause,
              );
            });
            yield* Effect.tryPromise({
              try: () => fs.rename(root, removedPath),
              catch: (cause) =>
                managerError(
                  "remove",
                  "Failed to stage the package for removal.",
                  cause,
                ),
            }).pipe(
              Effect.catch((cause) =>
                failRemoval(cause, "Failed to stage the package for removal."),
              ),
            );
            if (
              input.confirmModified !== true &&
              (yield* Effect.promise(() =>
                integrityFor(removedPath, managed),
              )) !== "verified"
            ) {
              yield* Effect.tryPromise({
                try: () => fs.rename(removedPath, root),
                catch: (cause) =>
                  managerError(
                    "remove",
                    "Failed to restore the locally modified package.",
                    cause,
                  ),
              }).pipe(
                Effect.catch((cause) =>
                  failRemoval(
                    cause,
                    "The locally modified package was restored.",
                    "Failed to restore the locally modified package.",
                  ),
                ),
              );
              yield* removeEmptyStaging;
              yield* catalog.refresh.pipe(Effect.mapError(mapCatalogError));
              return localModifications(input.packageName);
            }
            yield* state.remove(input.packageName).pipe(
              Effect.mapError((cause) =>
                managerError(
                  "remove",
                  "Failed to update package state.",
                  cause,
                ),
              ),
              Effect.catch((error) =>
                Effect.tryPromise(() => fs.rename(removedPath, root)).pipe(
                  Effect.match({
                    onFailure: (restoreCause) => ({
                      cause: error,
                      restoreCause,
                    }),
                    onSuccess: () => error,
                  }),
                  Effect.flatMap((cause) =>
                    failRemoval(
                      cause,
                      "Failed to update package state. The package was restored.",
                      "Package state failed and the package could not be restored.",
                    ),
                  ),
                ),
              ),
            );
            yield* Effect.tryPromise({
              try: () => fs.rm(temporaryRoot, { recursive: true }),
              catch: (cause) =>
                managerError(
                  "remove",
                  "Failed to clean removal staging.",
                  cause,
                ),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  `Failed to clean package removal folder at ${temporaryRoot}.`,
                  cause,
                ),
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
          Effect.match({
            onFailure: (error) => ({ status: "failed", error }) as const,
            onSuccess: (value) => ({ status: "succeeded", value }) as const,
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
            if (current === undefined || !isDeepStrictEqual(current, managed)) {
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
      update,
    });
  }),
);
